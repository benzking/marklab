// MakeRoad 站点包。
//
// 取数方式：页面是 Nuxt 3，但只对真浏览器 UA 吐 HTML（node fetch 拿到空响应），
// 而 API 匿名就能用——详情、文件直链、搜索、分类、用户模型都不用登录。
// 文件是公开 OSS 直链，匿名 HEAD 200、content-length 与 size 相等。
// 登录只影响「打包 zip 下载」和积分；元数据一律匿名抓（spec §3.3）。
//
// 对外形状见 docs/spec.md §2：match / loginState / meta / fileLinks / search / userModels。
import * as ch from '../channel.mjs';
import { sanitize, str, num, cookiesFor } from '../lib.mjs';

const HOSTS = ['makeroad.com'];
const SITE = 'https://www.makeroad.com';
const API = `${SITE}/api`;
// 浏览器 UI 实测（2026-11-03）：喜欢=num_like（页面默认）· 下载量=num_download · 最新=publish_time。
// 其它值（num_collect/num_view/create_time）站点不报错，但会静默回落成「不带 sort」的默认序。
const SORT = { likes: 'num_like', downloads: 'num_download', newest: 'publish_time' };
const DEFAULT_SORT = 'likes';
// 说明文档：API 只肯给一个 zip（type=4，要登录），而那个 zip 在 OSS 上是固定名字、匿名可下。
// 真没文档时 OSS 直接 404——所以「有没有文档」不用登录也能问。
const OSS = 'https://makeroad.oss-accelerate.aliyuncs.com/output';
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CDH = 0x02014b50;

/**
 * 网址 → { site, id, url }；认不出返回 null（不猜）。
 * 语言前缀是 2–3 字母（/zh/ /de/ /kor/ /fra/ /spa/ 实测都是真前缀，/en/ 会 404 但 id 仍能解析），
 * 统一重组到 /zh/，丢掉 query 与 fragment。
 */
export function match(raw) {
  let u;
  try {
    u = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    return null;
  }
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!HOSTS.includes(host)) return null;
  const id = /^(?:\/[a-z]{2,3}(?:-[a-z]{2,4})?)?\/printable_3d_model\/(M\d+)\/?$/i.exec(u.pathname)?.[1];
  if (!id) return null;
  return { site: 'makeroad', id, url: `${SITE}/zh/printable_3D_model/${id}` };
}

/** 用户主页是 /zh/<数字 sn>（如 /zh/100012）。 */
export function matchUser(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!HOSTS.includes(u.hostname.toLowerCase().replace(/^www\./, ''))) return null;
  const id = /^(?:\/[a-z]{2,3}(?:-[a-z]{2,4})?)?\/(\d{4,})\/?$/.exec(u.pathname)?.[1];
  return id ? { site: 'makeroad', id } : null;
}

/** X-Token 是普通 cookie（非 HttpOnly），值直接当请求头用。浏览器没连上返回 null，没登录返回 ''。 */
async function token() {
  const all = await ch.cookies();
  if (!all) return null;
  return cookiesFor(all, HOSTS).find((c) => c.name === 'X-Token')?.value || '';
}

/** 只发头、不发 cookie；code!==0 抛带 code 的错（50001 = 无 Token）。 */
async function api(path, t = '') {
  const r = await fetch(`${API}${path}`, {
    headers: { accept: 'application/json', lang: 'zh', ...(t ? { 'X-Token': t } : {}) },
  });
  if (!r.ok) throw new Error(`MakeRoad HTTP ${r.status}`);
  const j = await r.json();
  if (j?.code !== 0) throw Object.assign(new Error(j?.msg || `code ${j?.code}`), { code: j?.code });
  return j.data;
}

/**
 * 只读 zip 尾部的中央目录：文件名 + 原始大小，不下载正文。
 * `start` 是这段 buf 在文件里的起点（服务器忽略 Range 返回整份时是 0）。
 */
export function zipDir(buf, start = 0) {
  const eocd = buf.lastIndexOf(EOCD);
  if (eocd < 0) throw new Error('MakeRoad 文档包不是 zip');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16) - start;
  // shortcut: 只读最后 64KB；目录比这还大（几百份文档）才需要再发一次 Range
  if (p < 0 || p >= buf.length) throw new Error('MakeRoad 文档包目录超过 64KB');
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== CDH) throw new Error('MakeRoad 文档包目录损坏');
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const full = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const name = full.split('/').pop();
    if (!name || full.endsWith('/') || full.includes('__MACOSX/') || name === '.DS_Store') continue;
    out.push({ name, size });
  }
  return out;
}

/** 文档清单。zip 里的文件名是服务端哈希（`87221971781058404155.pdf`），站点没有更好听的名字。 */
async function docsOf(id) {
  const url = `${OSS}/Makeroad_${id}_conf.zip`;
  const h = await fetch(url, { method: 'HEAD' });
  if (h.status === 404) return [];
  if (!h.ok) throw new Error(`MakeRoad 文档包 HTTP ${h.status}`);
  const total = num(h.headers.get('content-length'));
  const r = await fetch(url, { headers: { range: `bytes=${Math.max(0, total - 65536)}-` } });
  if (!r.ok) throw new Error(`MakeRoad 文档包 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return zipDir(buf, total - buf.length);
}

export async function loginState() {
  const t = await token();
  if (t === null) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  if (!t) return { ok: false, status: 'logged-out' };
  try {
    const u = await api('/user', t);
    return { ok: true, status: 'logged-in', name: str(u?.nickname) || `sn ${u?.sn}` };
  } catch (e) {
    return e.code === 50001 ? { ok: false, status: 'logged-out' } : { ok: false, status: 'unknown', reason: e.message };
  }
}

export async function meta(url) {
  const hit = match(url);
  if (!hit) throw new Error('不是 MakeRoad 模型网址');
  const { id } = hit;
  // 详情与文件列表任一失败都抛：吞成 files:[] 会让 grab 把「接口挂了」记成「站点没文件」。
  const [d, files, docs] = await Promise.all([
    api(`/models/detail?id=${id}`),
    api(`/models/file?id=${id}`),
    // 文档是附件：读不到就只丢文档，不拖累整个模型（同 creality 的 fileOtherListPage）
    docsOf(id).catch((e) => {
      console.warn('MakeRoad 文档清单读失败：' + e.message);
      return [];
    }),
  ]);
  if (!d || typeof d !== 'object') throw new Error('MakeRoad 详情返回为空');
  if (!Array.isArray(files)) throw new Error('MakeRoad 文件接口返回里没有 data[]');

  const u = d.user || {};
  const links = files.map((f) => {
    const name = str(f?.name) || `model-${f?.id ?? ''}`;
    return {
      name,
      format: (/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase() || '3mf',
      size: num(f?.size),
      url: str(f?.url) || '',
      origin: 'author',
    };
  });
  const bad = links.find((f) => !/^https?:/.test(f.url));
  if (bad) throw new Error(`MakeRoad 文件 ${bad.name} 没有直链`);

  const out = {
    platform: 'makeroad',
    id,
    sourceUrl: hit.url,
    title: str(d.label) || id,
    author: str(u.nickname) || '',
    description: sanitize(d.desc || ''),
    images: (Array.isArray(d.picList) ? d.picList : []).map(String).filter(Boolean),
    stats: { downloads: num(d.downloadCount) },
    profiles: [], // 站点没有打印配置面板（时间/重量/机型都没有）
    print: null,
    category: '', // 详情没有分类字段，页面也没有面包屑
    tags: (Array.isArray(d.tagList) ? d.tagList : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()),
    picked: false, // 站点没有精选标记；isTop 是活动置顶位（默认序前 5 条都是 1）
    files: links,
    fileIds: links.map((f) => f.url),
  };
  if (docs.length) out.docs = docs;
  if (u.sn != null) out.authorUid = String(u.sn);
  if (str(u.headimgurl)) out.authorAvatar = str(u.headimgurl);
  return out;
}

/**
 * 文件链接。meta() 已把直链拿全；这里只映射，缺 files 说明调用方跳过了 meta，抛错不装空。
 * 有配套文档时多给一条 `kind:'doc'` 的整包链接：grab 下完会解压，与已下文件同 hash 的丢掉，
 * 其余当配套文件（站点不给逐篇链接，只有这一个固定名的 zip）。
 */
export function fileLinks(model) {
  if (!Array.isArray(model?.files)) throw new Error('MakeRoad 模型缺 files（先调 meta()）');
  const links = model.files.map((f) => ({ name: f.name, url: f.url, size: f.size, kind: 'model', origin: f.origin || 'author' }));
  if (model.docs?.length) {
    links.push({ name: `Makeroad_${model.id}_conf.zip`, url: `${OSS}/Makeroad_${model.id}_conf.zip`, kind: 'doc', origin: 'author' });
  }
  return links;
}

/** 搜索结果 → 统一 Item（docs/spec.md §9.5）。缺字段写 null，不猜。 */
export function normalize(raw) {
  const id = raw?.id == null ? '' : String(raw.id);
  return {
    site: 'makeroad',
    id,
    title: str(raw?.label) || '',
    url: id ? `${SITE}/zh/printable_3D_model/${id}` : '',
    cover: str(raw?.cover),
    author: str(raw?.user?.nickname),
    likes: num(raw?.likeCount),
    downloads: num(raw?.downloadCount),
    collects: null, // 列表接口只有 collectStatus，没有收藏数
    comments: null, // 列表接口没有评论数
    picked: false, // 同上：isTop 不是精选
    publishedAt: null, // 列表接口没有发布时间
    tags: [], // 列表接口没有标签
  };
}

/** 拿不到总数写 null，不用 0 冒充（0 会被订阅当成「到底了」）。 */
function totalOf(d) {
  const n = Number(d?.pagination?.total);
  return Number.isFinite(n) ? n : null;
}

export async function search({ keyword, page = 1, pageSize = 20, sort = DEFAULT_SORT } = {}) {
  const q = new URLSearchParams({
    keyword: String(keyword || ''),
    page: String(page),
    rownum: String(pageSize),
    type: '1',
    sort: SORT[sort] || SORT[DEFAULT_SORT],
  });
  const d = await api(`/search?${q}`);
  if (!Array.isArray(d?.list)) throw new Error('MakeRoad 搜索返回里没有 data.list');
  return { total: totalOf(d), items: d.list.map(normalize) };
}

export async function userModels({ uid, page = 1, pageSize = 20 } = {}) {
  const q = new URLSearchParams({ page: String(page), rownum: String(pageSize), sn: String(uid ?? '') });
  const d = await api(`/user/modelList?${q}`);
  if (!Array.isArray(d?.list)) throw new Error('MakeRoad 用户页返回里没有 data.list');
  return { total: totalOf(d), items: d.list.map(normalize) };
}

/** 只有积分，没有签到（全站无「签到」入口，账号中心也没有）。 */
export async function checkinStatus() {
  const t = await token();
  if (!t) return {};
  const d = await api('/user/integralData', t);
  return { points: num(d?.total) };
}

const pack = {
  site: 'makeroad',
  platform: 'makeroad',
  label: 'MakeRoad',
  hosts: HOSTS,
  discover: true,
  categoriesKey: 'makeroad',
  match,
  matchUser,
  loginState,
  meta,
  fileLinks,
  searchOptions: { sorts: ['likes', 'downloads', 'newest'], tags: false },
  search,
  userModels,
  checkinStatus,
};

export default pack;

// 自检：纯函数，不联网、不起浏览器
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'makeroad.mjs') {
  console.assert(match('https://www.makeroad.com/zh/printable_3D_model/M1000122747')?.id === 'M1000122747', '标准模型页');
  console.assert(match('https://makeroad.com/de/printable_3D_model/M1000122747/')?.id === 'M1000122747', '无 www + 语言前缀 + 末尾斜杠');
  console.assert(match('https://www.makeroad.com/kor/printable_3D_model/M1')?.id === 'M1', '三字母语言码');
  console.assert(match('https://www.makeroad.com/zh/search?keyword=benchy') === null, '搜索页不认');
  console.assert(match('https://www.makeroad.com.evil.example/zh/printable_3D_model/M1') === null, '相似域名不认');
  console.assert(match('http://evil/x#https://www.makeroad.com/zh/printable_3D_model/M1') === null, 'fragment 里的网址不认');
  console.assert(
    match('https://www.makeroad.com/zh/printable_3D_model/M1?x=1#y')?.url === 'https://www.makeroad.com/zh/printable_3D_model/M1',
    '重组丢掉 query/fragment',
  );

  console.assert(matchUser('https://www.makeroad.com/zh/100012')?.id === '100012', '用户页');
  console.assert(matchUser('https://www.makeroad.com/kor/223171')?.id === '223171', '三字母前缀的用户页');
  console.assert(matchUser('https://www.makeroad.com/zh/printable_3D_model/M1') === null, '模型页不是用户页');

  const s = normalize({ id: 7, label: '标题', likeCount: 3, downloadCount: 9, user: { nickname: '作者' } });
  console.assert(s.id === '7' && s.likes === 3 && s.downloads === 9, '计数映射');
  console.assert(s.collects === null && s.publishedAt === null && s.picked === false, '缺的写 null/false');
  console.assert(s.url === 'https://www.makeroad.com/zh/printable_3D_model/7', '详情页 URL');

  const links = fileLinks({ files: [{ name: 'a.3mf', url: 'https://x/a.3mf', size: 5 }] });
  console.assert(links.length === 1 && links[0].kind === 'model' && links[0].origin === 'author', '文件链接映射');
  let threw = false;
  try {
    fileLinks({});
  } catch {
    threw = true;
  }
  console.assert(threw, '缺 files 抛错而不是返回空数组');

  // 手工拼一个只有中央目录 + EOCD 的 zip：zipDir 只认这两段
  const nm = Buffer.from('public/file/87221971781058404155.pdf');
  const cd = Buffer.alloc(46 + nm.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt32LE(2518012, 24);
  cd.writeUInt16LE(nm.length, 28);
  nm.copy(cd, 46);
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0);
  eo.writeUInt16LE(1, 10);
  eo.writeUInt32LE(cd.length, 12);
  eo.writeUInt32LE(4096, 16);
  const zd = zipDir(Buffer.concat([Buffer.alloc(4096), cd, eo]), 0);
  console.assert(zd.length === 1 && zd[0].name === '87221971781058404155.pdf' && zd[0].size === 2518012, 'zip 目录：basename + 原始大小');
  threw = false;
  try {
    zipDir(Buffer.from('not a zip'));
  } catch {
    threw = true;
  }
  console.assert(threw, '不是 zip 就抛错，不当成没文档');
  console.log('makeroad pack demo ok');
}

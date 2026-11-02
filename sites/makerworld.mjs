// MakerWorld（拓竹）站点包。
//
// 整站对非浏览器 UA 返 403，详情与 f3mf 都必须在真浏览器页内 fetch。
// 两个特殊处：
//   1. 唯一会出现「他人件」的站——别人也能给同一个模型加打印配置，`instanceCreator.uid`
//      与 `designCreator.uid` 不同时那份 3mf 不算作者件（判重时不比，见 spec §5）。
//   2. f3mf 要登录 + 过人机验证（geetest 点选图，Playwright 过不了），连续下几个就 418，
//      且不会自己恢复。所以 fileLinks 先走 CDN 裸链（见下），f3mf 只做兜底。
import * as ch from '../channel.mjs';
import { sanitize, fmtHours, str, num, iso } from '../lib.mjs';

// 只认 .com.cn。makerworld.com 是**另一套 id 空间**（2026-11-02 实测：同号 1014649/195581/1309981
// 在两域是完全不同的模型），一个包认两个域就会落进同一个库目录、同一个判重键。
// 要接世界站就另开一个包（照 makeronline 的先例），别把它加回这里。
const HOSTS = ['makerworld.com.cn'];
const SITE = 'https://makerworld.com.cn';

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
  const id = /\/models\/(\d+)/.exec(u.pathname)?.[1];
  if (!id) return null;
  // 带 slug 的地址原样保留（站点会用它做 SSR），但只用重组出来的干净串，丢掉 query/fragment
  return { site: 'makerworld', id, url: `https://${u.hostname.toLowerCase()}${u.pathname}` };
}

/** 登录 cookie 是 HttpOnly，且该站挡 TLS 指纹，只能走真浏览器页内 fetch。 */
export async function loginState() {
  const r = await ch.inPage('makerworld', `${SITE}/zh`, async () => {
    const res = await fetch('/api/v1/user-service/my/profile');
    if (!res.ok) return { status: res.status };
    const j = await res.json().catch(() => null);
    return { status: res.status, name: j?.name || j?.userName || j?.data?.name };
  });
  if (!r) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  return r.status === 200 ? { ok: true, status: 'logged-in', name: r.name || '已登录' } : { ok: false, status: 'logged-out' };
}

export async function meta(url) {
  const hit = match(url);
  if (!hit) throw new Error('不是 MakerWorld 模型网址');
  const { id } = hit;
  const js = `(async () => {
    const j = await (await fetch('/api/v1/design-service/design/${id}', { headers: { accept: 'application/json' } })).json();
    const pic = (p) => (p && (p.url || p)) || '';
    const num = (v) => (typeof v === 'string' ? Number(v) : v);
    const filamentsOf = (arr) => (arr || []).map(f => ({ type: f.type, color: f.color, usedG: num(f.usedG), usedM: num(f.usedM) }));
    const platesOf = (mi) => ((mi && mi.plates) || []).map(p => ({
      index: p.index, name: p.name, timeSec: p.prediction, weightG: p.weight,
      thumb: pic(p.thumbnail), filaments: filamentsOf(p.filaments),
    }));
    return {
      title: j.title, author: (j.designCreator && (j.designCreator.name || j.designCreator.handle)) || '',
      authorUid: j.designCreator?.uid || null,
      authorAvatar: (j.designCreator && (j.designCreator.avatar || j.designCreator.avatarUrl)) || '',
      description: j.summary || j.description || '', cover: j.coverUrl || j.coverLandscape || '',
      likes: j.likeCount, downloads: j.downloadCount, collects: j.collectionCount, comments: j.commentCount,
      createTime: j.createTime, updateTime: j.updateTime, tags: (j.tags || []).map(t => t.name || t).filter(Boolean),
      picked: Boolean(j.isStaffPicked),
      category: ((j.categories || [])[0] && (j.categories[0].name || j.categories[0].nameTranslated)) || '',
      instances: (j.instances || []).map(i => {
        const mi = (i.extention && i.extention.modelInfo) || {};
        const compat = mi.compatibility ? [mi.compatibility] : [];
        return {
          id: i.id, title: i.title, cover: pic(i.cover), pictures: (i.pictures || []).map(pic).filter(Boolean),
          downloads: i.downloadCount, prints: i.printCount, isDefault: i.isDefault,
          timeSec: i.prediction, weightG: i.weight, materialCnt: i.materialCnt, needAms: i.needAms,
          instanceCreator: i.instanceCreator ? (i.instanceCreator.name || true) : null,
          creatorUid: i.instanceCreator?.uid || null,
          ratingCount: i.ratingCount, ratingTotal: i.ratingScoreTotal,
          projectSettings: mi.projectSettings || {}, plates: platesOf(mi),
          filaments: filamentsOf(i.instanceFilaments),
          machines: [...compat, ...(mi.otherCompatibility || [])].map(m => ({ name: m.devProductName, code: m.devModelName, nozzle: m.nozzleDiameter })),
        };
      }),
      rawFiles: ((j.designExtension && j.designExtension.model_files) || []).map(f => ({ name: f.modelName, size: f.modelSize, type: f.modelType, origin: 'author' })),
    };
  })()`;
  const { value: d, via } = await ch.evalInPage(hit.url, js, { wait: 6000 });
  const inst = d.instances.find((i) => i.isDefault) || d.instances[0] || {};
  return {
    platform: 'makerworld',
    id,
    sourceUrl: hit.url,
    title: d.title,
    author: d.author,
    authorUid: d.authorUid,
    authorAvatar: d.authorAvatar,
    description: sanitize(d.description),
    images: [d.cover, ...d.instances.flatMap((i) => [i.cover, ...i.pictures])].filter(Boolean),
    stats: { downloads: d.downloads },
    picked: Boolean(d.picked),
    category: d.category || '',
    tags: d.tags,
    publishedAt: d.createTime,
    print: {
      profileTitle: inst.title,
      thumb: inst.cover,
      timeSec: inst.timeSec,
      timeText: fmtHours(inst.timeSec),
      weightG: inst.weightG,
      plates: inst.plates?.length || 0,
      nozzle: inst.machines?.[0]?.nozzle ? `${inst.machines[0].nozzle} mm` : '',
      layerHeight: inst.projectSettings?.layerHeight,
      wallLoops: inst.projectSettings?.wallLoops,
      infill: inst.projectSettings?.sparseInfillDensity,
      filaments: inst.filaments || [],
      plateList: inst.plates || [],
      machines: inst.machines || [],
      source: via,
    },
    // machines 是兼容机型列表（一份文件 14 台机器都能打），不是每机型一个文件
    profiles: d.instances.map((i) => ({
      id: i.id,
      name: i.title,
      machine: i.machines?.[0]?.name || '',
      machines: (i.machines || []).map((x) => x.name),
      plates: i.plates?.length || 0,
      plateList: i.plates || [],
      timeSec: i.timeSec,
      timeText: fmtHours(i.timeSec),
      weightG: i.weightG ? Math.round(i.weightG * 10) / 10 : null,
      nozzle: i.machines?.[0]?.nozzle ? `${i.machines[0].nozzle} mm` : '',
      layerHeight: i.projectSettings?.layerHeight || '',
      wallLoops: i.projectSettings?.wallLoops || '',
      infill: i.projectSettings?.sparseInfillDensity || '',
      bed: '',
      size: 0,
      filaments: i.filaments || [],
      thumbnail: i.cover || '',
      isDefault: i.isDefault,
      creatorUid: i.creatorUid,
      url: `${hit.url}#profileId-${i.id}`,
    })),
    files: d.rawFiles,
    fileIds: d.instances.map((i) => i.id),
    via,
  };
}

/** 预览文件链 → 同一份 3mf 的 CDN 裸链：去掉签名 query，去掉压缩预览那一层目录，文件名换成 `<uuid>.3mf`。
 *  两种压缩预览共用同一个 uuid，所以拿哪个都行。 */
export function threeMfFrom(preview) {
  const p = String(preview || '').split('?')[0];
  const uuid = p.split('/').pop().replace(/\.zip$/i, '');
  return p.replace(/[^/]+\/[^/]+$/, `${uuid}.3mf`);
}

/** 每个 instance 一份 3mf。别人加的配置标 other。
 *
 * 两条路，先甜后苦：
 *   CDN 裸链——3mf 在 CDN 上是公开文件（匿名 200、缓存一年、支持 Range），路径能从
 *   `extention.extensionModelFileList` 的预览文件反推：把 `.../instance/low_compression_glb/<uuid>.zip?at=…`
 *   的 query 去掉、文件名换成 `<uuid>.3mf` 就是同一份 3mf。对得上 `modelInfo.f3mf.size` 才算命中。
 *   f3mf——没生成过 3D 预览的配置反推不出来，只能走这条，要登录 + 过人机验证。 */
export async function fileLinks(model) {
  const info = (model.fileIds || []).map((id, i) => {
    const c = model.profiles?.[i]?.creatorUid;
    const machine = model.profiles?.[i]?.machine || '';
    return { id, machine, mine: !c || !model.authorUid || String(c) === String(model.authorUid) };
  });

  const js = `(async () => {
    const j = await (await fetch('/api/v1/design-service/design/${model.id}', { headers: { accept: 'application/json' } })).json();
    const out = {};
    for (const i of j.instances || []) {
      const ext = i.extention || {};
      const f = (ext.extensionModelFileList || []).find((x) => /compression_glb$/.test(x.compressType));
      const size = (ext.modelInfo && ext.modelInfo.f3mf && ext.modelInfo.f3mf.size) || 0;
      if (!f || !size) continue;
      out[i.id] = { url: (${threeMfFrom.toString()})(f.modelFile), size };
    }
    return out;
  })()`;
  const { value: cdn } = await ch.evalInPage(model.sourceUrl, js, { wait: 6000 });

  const out = [];
  const rest = [];
  for (const it of info) {
    const c = cdn && cdn[it.id];
    // 裸链对不对只认大小：content-length 与 design JSON 给的 f3mf.size 相等才算命中
    const ok =
      c &&
      (await fetch(c.url, { method: 'HEAD' })
        .then((r) => r.ok && Number(r.headers.get('content-length')) === c.size)
        .catch(() => false));
    if (ok) out.push({ name: `${model.title || 'model'}${it.machine ? '-' + it.machine : ''}.3mf`, url: c.url, size: c.size, mine: it.mine });
    else rest.push(it);
  }

  if (rest.length) {
    const js2 = `(async () => {
      const out = [];
      const errs = [];
      for (const [id, mine] of ${JSON.stringify(rest.map((r) => [r.id, r.mine]))}) {
        const r = await fetch('/api/v1/design-service/instance/' + id + '/f3mf', { headers: { accept: 'application/json' } });
        if (!r.ok) {
          let t = '';
          try { t = (await r.json()).error || ''; } catch {}
          errs.push(t || 'HTTP ' + r.status);
          // 未登录（403）与人机验证（418 + geetest）都是整站性的：别再一个个配置试下去
          if (r.status === 403 || r.status === 418 || /登录|forbidden|unauthor|机器人|captcha/i.test(t)) break;
          continue;
        }
        const j = await r.json();
        if (j && j.url) out.push({ name: j.name, url: j.url, size: j.size, mine });
      }
      return { out, errs };
    })()`;
    const { value: res } = await ch.evalInPage(model.sourceUrl, js2, { wait: 6000 });
    if (!res.out.length && res.errs.length) {
      const first = res.errs[0];
      const ids = rest.map((r) => r.id).join(', ');
      // 已经拿到一部分就整批不失败，但把落下的配置点名——它们只能靠手点验证后重抓
      if (out.length) console.warn(`  MakerWorld 少 ${rest.length} 个配置（${ids}）：${first}——它们没有 CDN 预览路径，要在浏览器里手点一次验证`);
      else if (/机器人|captcha|验证/i.test(first)) throw new Error(`MakerWorld 要过人机验证：${first}（配置 ${ids} 没有 CDN 预览路径，只能在浏览器里手点一次验证）`);
      else if (/登录|403|forbidden|unauthor/i.test(first)) throw new Error(`MakerWorld 没登录，拿不到文件：${first}`);
      else throw new Error(first);
    }
    out.push(...res.out);
  }
  if (!out.length) throw new Error('MakerWorld 这个模型没有可下载的 3mf');
  return out.map((r) => ({
    name: r.name || 'model',
    url: r.url,
    size: r.size,
    kind: 'profile',
    origin: r.mine ? 'author' : 'other',
  }));
}

export function normalize(raw) {
  const id = raw?.id == null ? '' : String(raw.id);
  return {
    site: 'makerworld',
    id,
    title: str(raw?.title) || '',
    url: id ? `${SITE}/zh/models/${id}` : '',
    cover: str(raw?.cover),
    author: str(raw?.designCreator?.name),
    likes: num(raw?.likeCount),
    downloads: num(raw?.downloadCount),
    collects: num(raw?.collectionCount),
    comments: num(raw?.commentCount),
    picked: Boolean(raw?.isStaffPicked),
    publishedAt: iso(raw?.createTime),
    // 搜索结果和用户页给的 tag 是对象（{name}），详情接口给的是字符串，两种都收
    tags: Array.isArray(raw?.tags) ? raw.tags.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean) : [],
  };
}

const ORDER = {
  downloads: 'downloadCount',
  likes: 'likeCount',
  newest: 'newUploads',
  hot: 'hotScore',
  score: 'score',
};

const readNextData = () => {
  const text = document.querySelector('#__NEXT_DATA__')?.textContent;
  if (!text) return null;
  const pp = JSON.parse(text)?.props?.pageProps;
  return { total: pp?.total, designs: pp?.designs };
};

// 搜索翻页只能走站点自己的接口：SSR 的 __NEXT_DATA__ 只装第 1 页（URL 里的 page 它不认，
// 1–5 页回同一批 20 条），接口的 offset 才是真翻页（offset=0 与 SSR 第 1 页逐条相同，2026-10-31 实测）。
// 跑在页内：同源带登录态，匿名也能取。
async function readSearchHits({ keyword, orderBy, offset }) {
  const q = new URLSearchParams({
    orderBy,
    designType: '0',
    isFromSearchList: 'false',
    keyword,
    limit: '20',
    offset: String(offset),
    ref_: '0031_07q_yz',
  });
  const r = await fetch(`/api/v1/search-service/select/design2?${q}`, { headers: { accept: 'application/json' } });
  if (!r.ok) return { status: r.status };
  const j = await r.json();
  return { total: j?.total, hits: j?.hits };
}

export async function search({ keyword, page = 1, sort } = {}) {
  const orderBy = ORDER[sort] || 'score';
  // 一页固定 20 条，翻页靠 offset
  const url = `${SITE}/zh/search/models?keyword=${encodeURIComponent(keyword)}&orderBy=${orderBy}&page=${page}`;
  const data = await ch.inPage('makerworld', url, readSearchHits, { keyword, orderBy, offset: (page - 1) * 20 }, { wait: 2000 });
  if (!data || !Array.isArray(data.hits)) {
    throw new Error(`MakerWorld 搜索接口没回 hits（HTTP ${data?.status ?? '没连上浏览器'}；站点改版或浏览器没开）`);
  }
  return { total: num(data.total), items: data.hits.map(normalize) };
}

export async function userModels({ uid, page = 1 } = {}) {
  const url = `${SITE}/zh/@${encodeURIComponent(uid)}/upload?page=${page}`;
  const data = await ch.inPage('makerworld', url, readNextData, undefined, { wait: 2000 });
  if (!data || !Array.isArray(data.designs)) throw new Error('MakerWorld 用户页没拿到 __NEXT_DATA__.designs（浏览器没连上或站点改版）');
  return { total: num(data.total), items: data.designs.map((raw) => normalize({ ...raw, cover: raw.coverUrl })) };
}

/** 用户主页网址 → {site, id}（MakerWorld 的用户标识是用户名，不是数字）。 */
export function matchUser(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!HOSTS.includes(u.hostname.toLowerCase().replace(/^www\./, ''))) return null;
  const id = /^\/(?:[a-z]{2}\/)?@([^/]+)/i.exec(u.pathname)?.[1];
  return id ? { site: 'makerworld', id: decodeURIComponent(id) } : null;
}

/** 一级分类树。整站挡非浏览器 UA，只能在页面里读分类链接（id 的百位段就是一级）。 */
export async function categories() {
  const expr = `JSON.stringify([...document.querySelectorAll('a[href*="/zh/3d-models/"]')]
    .map(a => ({ href: a.getAttribute('href'), name: a.textContent.trim() })))`;
  const { value } = await ch.evalInPage(`${SITE}/zh/3d-models`, expr, { wait: 6000 });
  const links = JSON.parse(value)
    .map(({ href, name }) => {
      const m = /\/zh\/3d-models\/(\d+)-([\w-]+)/.exec(href || '');
      return m && { id: Number(m[1]), slug: m[2], name };
    })
    .filter(Boolean);
  if (!links.length) throw new Error('页面里没读到分类链接（站点结构变了或没登录？）');
  const tops = links.filter((l) => l.id === Math.floor(l.id / 100) * 100);
  return tops.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    children: links
      .filter((l) => l !== t && Math.floor(l.id / 100) * 100 === t.id)
      .map((l) => ({ id: l.id, name: l.name, slug: l.slug })),
  }));
}

export default {
  site: 'makerworld',
  platform: 'makerworld',
  label: 'MakerWorld',
  hosts: HOSTS,
  discover: true,
  categoriesKey: 'makerworld',
  match,
  matchUser,
  loginState,
  meta,
  fileLinks,
  categories,
  searchOptions: { sorts: ['downloads', 'likes', 'newest', 'hot', 'score'], pageSize: 20 },
  search,
  userModels,
};

// 自检：纯函数，不联网、不起浏览器
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'makerworld.mjs') {
  const id = '195581';
  console.assert(match(`https://makerworld.com.cn/zh/models/${id}`)?.id === id, '标准模型页');
  console.assert(match(`https://makerworld.com/zh/models/${id}`) === null, '.com 是另一个站的 id 空间，不认');
  console.assert(match('https://makerworld.com.cn/zh/@someone/upload') === null, '用户页不是模型页');
  console.assert(match('https://makerworld.com.cn.evil.example/zh/models/1') === null, '相似域名不认');

  const n = normalize({ id: 7, title: 'T', tags: ['benchy', 1], designCreator: { name: 'B' }, createTime: '2024-05-23T09:28:27Z' });
  console.assert(n.url === 'https://makerworld.com.cn/zh/models/7', '详情页 URL');
  console.assert(n.publishedAt === '2024-05-23T09:28:27.000Z' && n.tags.length === 1, '时间/标签');
  console.assert(n.author === 'B' && n.collects === 0, '作者/缺字段默认');

  const preview =
    'https://makerworld.bblmw.cn/makerworld/model/CN619f495182e64b/96324739/instance/low_compression_glb/4c981a01-d5bb-469f-b5e0-96ab61a609f4.zip?at=1793378816&exp=1793382416&key=x';
  console.assert(
    threeMfFrom(preview) ===
      'https://makerworld.bblmw.cn/makerworld/model/CN619f495182e64b/96324739/instance/4c981a01-d5bb-469f-b5e0-96ab61a609f4.3mf',
    '预览链反推 3mf 裸链（去签名 query、换扩展名）',
  );

  console.log('makerworld pack demo ok');
}

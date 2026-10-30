// 创想云（Creality Cloud）站点包。
//
// 取数方式：SSR 的 `__NUXT_DATA__` 就是 modelGroupDetail 的完整响应；3mf 版页面额外带
// `3mf-list`（打印配置）。文件清单走 `fileListPage`（匿名可跑），真正的下载链接要
// `memberDownload` 签名，**必须登录**。
// 打印配置的 3mf 本体走 `3mfDownload`（body 只有 `{id: profileId}`）：只认 `__cxy_token_` /
// `__cxy_uid_` 请求头，匿名一律 `code 4 Invalid Token`；回的是 OSS 签名直链（24 小时、匿名可下），
// 不用开浏览器点「下载 3MF」按钮（2026-10-30 实测）。
//
// 对外形状见 docs/spec.md §2。
import * as ch from '../channel.mjs';
import { resolveNuxt, sanitize, fmtHours, str, num, iso } from '../lib.mjs';
import { httpGet } from './_http.mjs';

const HOSTS = ['crealitycloud.cn'];
const SITE = 'https://www.crealitycloud.cn';
const APP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  origin: SITE,
  __cxy_app_id_: 'cxy-gen2',
  __cxy_app_ver_: '7.3.28',
  __cxy_platform_: '2',
  __cxy_brand_: 'creality',
};

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
  const id = /\/model-detail\/([0-9a-f]{24})/i.exec(u.pathname)?.[1];
  if (!id) return null;
  return { site: 'creality', id, url: `${SITE}/model-detail/${id}` };
}

/** 登录态：必须成对带 token + uid，只带 token 会 code:4 Invalid Token（2026-10-29 实测）。 */
export async function loginState() {
  const all = await ch.cookies();
  if (!all) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  const map = {};
  for (const c of all) {
    if (HOSTS.some((h) => c.domain === h || c.domain === `.${h}` || c.domain.endsWith(h))) map[c.name] = c.value;
  }
  if (!map.model_token) return { ok: false, status: 'logged-out' };
  const r = await ch.fetchAs('creality', `${SITE}/api/cxy/v3/user/getInfo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', __cxy_token_: map.model_token, __cxy_uid_: map.model_user_id || '' },
    body: '{}',
  });
  if (!r) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  const j = await r.json().catch(() => null);
  const name = j?.result?.profileUserInfo?.base?.nickName;
  return name ? { ok: true, status: 'logged-in', name } : { ok: false, status: 'logged-out' };
}

async function postJson(path, body, referer) {
  const r = await fetch(`${SITE}${path}`, {
    method: 'POST',
    headers: { ...APP_HEADERS, referer },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function meta(url) {
  const hit = match(url);
  if (!hit) throw new Error('不是创想云模型网址');
  const { id } = hit;
  const canonical = hit.url;
  const { text } = await httpGet(url);
  const raw = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(text)?.[1];
  if (!raw) throw new Error('页面里没有 __NUXT_DATA__（站点结构变了？）');
  const state = resolveNuxt(JSON.parse(raw)).data;
  const result = Object.entries(state).find(([k]) => k.startsWith('model-info'))?.[1]?.result;
  if (!result) throw new Error('__NUXT_DATA__ 里没有 model-info');
  const g = result.groupItem;

  const rawProfiles = Object.entries(state).find(([k]) => k.startsWith('3mf-list'))?.[1]?.list || [];
  const profiles = rawProfiles.map((p) => ({
    id: p.id,
    name: p.secondName || p.name || '打印配置',
    title: p.name || '',
    machine: p.printerName || '',
    machines: p.supportPrinterNames || [],
    plates: p.plateCount || 0,
    timeSec: p.printTime || 0,
    weightG: Math.round((Number(p.filamentWeight) || 0) * 10) / 10,
    lengthM: Number(p.filamentLen) || 0,
    size: p.size || 0,
    layerHeight: p.layerHeight ? String(p.layerHeight) : '',
    wallLoops: p.wallLoops ? String(p.wallLoops) : '',
    infill: p.sparseInfillDensity != null ? String(p.sparseInfillDensity) : '',
    nozzle: (p.nozzleDiameter || [])[0] ? `${(p.nozzleDiameter || [])[0]} mm` : '',
    bed: p.currBedType || '',
    downloads: p.downloadCount || 0,
    thumbnail: p.thumbnail || '',
    isAuth: Boolean(p.isAuth),
    uid: p.userInfo?.userId ?? null,
    filaments: (p.colorFilament || []).map((c) => ({ type: c.type, color: c.color, usedG: Number(c.weight) || null })),
  }));
  // 网址上带的 profileId 优先，其次第一个已认证的（页面上的「作者」徽标就是 isAuth）
  const wanted = /[?&]profileId=([0-9a-f]{24})/i.exec(url)?.[1];
  const active = profiles.find((p) => p.id === wanted) || profiles.find((p) => p.isAuth) || profiles[0] || null;

  // SSR 的 modelList 只有第一页（5 个），站点弹窗走 fileListPage 拉全量，这里对齐
  let allStl = result.modelList || [];
  try {
    const j = await postJson('/api/cxy/v3/model/fileListPage', { modelId: id, page: 1, pageSize: 200 }, canonical);
    if (j.code === 0 && j.result?.list?.length) allStl = j.result.list;
  } catch {}

  const stlFiles = allStl.map((f) => ({
    name: f.fileName + (f.fileFormat || ''),
    format: (f.fileFormat || '').replace('.', ''),
    size: f.fileSize,
    id: f.id,
    kind: 'model',
    origin: 'author',
  }));

  let docs = [];
  try {
    const j = await postJson('/api/cxy/v3/model/fileOtherListPage', { modelId: id, page: 1, pageSize: 50 }, canonical);
    docs = (j.result?.list || []).map((d) => ({
      name: d.fileName + (d.fileFormat || ''),
      size: d.fileSize,
      format: (d.fileFormat || '').replace('.', ''),
      id: d.id,
    }));
  } catch {}

  return {
    platform: 'creality',
    id,
    sourceUrl: canonical,
    docs,
    title: g.groupName,
    author: g.userInfo?.nickName || '',
    authorUid: g.userId || g.userInfo?.userId || null, // 判「这份 3mf 是不是作者传的」用
    authorAvatar: g.userInfo?.avatar || '',
    description: sanitize(g.groupDesc),
    images: [...new Set([...(g.pcCovers || []), ...(g.covers || [])].map((c) => c.url).filter(Boolean))],
    stats: { downloads: g.downloadCount },
    picked: Boolean(g.isPickModel),
    category: g.categoryName || '',
    tags: (g.tags || []).map((t) => t.name || t).filter(Boolean),
    publishedAt: g.createTime,
    print: active
      ? {
          profileTitle: active.name,
          thumb: active.thumbnail || '',
          timeText: fmtHours(active.timeSec),
          timeSec: active.timeSec,
          weightG: active.weightG ? Math.round(active.weightG * 10) / 10 : null,
          plates: active.plates,
          nozzle: active.nozzle,
          layerHeight: active.layerHeight,
          wallLoops: active.wallLoops,
          infill: active.infill,
          filaments: active.filaments,
          plateList: [],
          machines: active.machines.map((n) => ({ name: n })),
          source: 'ssr',
        }
      : null,
    profiles: profiles.map((p) => ({ ...p, url: `${canonical}?profileId=${p.id}` })),
    activeProfileId: active?.id || null,
    files: stlFiles,
    fileIds: stlFiles.map((f) => f.id),
    // 兜底：fileLinks 把 3mf 拿到手就把对应条目删掉；没登录 / 拿不到直链时这行还在，界面标「去站点下载」
    siteOnlyFiles: profiles.map((p) => ({
      name: profileName(p),
      size: p.size,
      kind: 'profile',
      url: `${canonical}?profileId=${p.id}`,
    })),
  };
}

/** 下载链接要签名：memberDownload / 3mfDownload 都要登录态，没登录直接抛（不试匿名，省一次必然失败的请求）。 */
export async function fileLinks(model) {
  if (!model.fileIds.length && !(model.profiles || []).length) return [];
  // 先看 cookie 再发请求：没登录时签名接口只回 code 0 + 空列表，等它回错误反而分不清
  // 「没登录」和「解析没拿到链接」（noFiles 会记错原因）。
  const all = await ch.cookies();
  if (!all) throw new Error('浏览器没连上：先开着 Chromium（9223 端口）再抓');
  const mine = all.filter((c) => HOSTS.some((h) => c.domain === h || c.domain === `.${h}` || c.domain.endsWith(h)));
  const cookieOf = (name) => mine.find((c) => c.name === name)?.value || '';
  if (!cookieOf('model_token')) throw new Error('下载链接要登录：先在浏览器登录创想云');

  const links = [];
  if (model.fileIds.length) links.push(...(await authorFileLinks(model)));
  const { out, missed } = await profileLinks(model, cookieOf('model_token'), cookieOf('model_user_id'));
  links.push(...out);
  // 3mf 拿到手就把「去站点下载」的兜底条目摘掉；拿不到的留着，界面还能给深链
  const left = trimSiteOnly(model.siteOnlyFiles, missed);
  if (left) model.siteOnlyFiles = left;
  else delete model.siteOnlyFiles;
  return links;
}

/** 打印配置的 3mf 直链：一次一个 profileId，签名直链匿名可下；单个失败不拖累其余。 */
async function profileLinks(model, token, uid) {
  const out = [];
  const missed = [];
  let authErr = null;
  for (const p of model.profiles || []) {
    const r = await fetch(`${SITE}/api/cxy/v3/model/3mfDownload`, {
      method: 'POST',
      headers: { ...APP_HEADERS, __cxy_token_: token, __cxy_uid_: uid, referer: model.sourceUrl },
      body: JSON.stringify({ id: p.id }),
    }).catch(() => null);
    const j = await r?.json().catch(() => null);
    const url = j?.code === 0 ? j.result?.downloadUrl : '';
    if (!url) {
      if (j?.code === 4) authErr = j.msg || 'Invalid Token'; // token 过期：整站性的，别一个个配置试完再报「没文件」
      missed.push(p);
      continue;
    }
    const mine = !model.authorUid || String(p.uid) === String(model.authorUid);
    out.push({ name: profileName(p), url, size: p.size, kind: 'profile', origin: mine ? 'author' : 'other' });
  }
  if (!out.length && authErr) throw new Error(`3mfDownload 拒绝（4 ${authErr}）：先在浏览器重新登录创想云`);
  return { out, missed };
}

/** 「0.2mm layer, 2 walls, 15% infill.3mf」——标题已经在目录名里，文件名只留 secondName 区分配置。 */
function profileName(p) {
  return `${p.name || p.id}.3mf`;
}

/** 拿不到直链的配置留在 siteOnlyFiles；全拿到返回 null（grab 会删掉这个字段）。 */
function trimSiteOnly(siteOnlyFiles, missed) {
  const left = (siteOnlyFiles || []).filter((f) => missed.some((p) => f.url.endsWith(p.id)));
  return left.length ? left : null;
}

/** 作者件（STL/CAD/配套文档）：memberDownload 在页内换签名 URL。 */
async function authorFileLinks(model) {
  const js = `(async () => {
    const ck = Object.fromEntries(document.cookie.split('; ').map(s => { const i = s.indexOf('='); return [s.slice(0,i), s.slice(i+1)]; }));
    const h = { 'content-type': 'application/json', '__cxy_app_id_': 'cxy-gen2', '__cxy_app_ver_': '7.3.28',
      '__cxy_platform_': '2', '__cxy_brand_': 'creality', '__cxy_os_ver_': 'Linux',
      '__cxy_os_lang_': ck['model_lang'] || '1', '__cxy_timezone_': '0',
      '__cxy_token_': ck['model_token'] || '', '__cxy_uid_': ck['model_user_id'] || '',
      '__cxy_duid_': ck['model_device_id'] || '', '__cxy_requestid_': crypto.randomUUID() };
    const ids = ${JSON.stringify([...(model.fileIds || []), ...((model.docs || []).map((d) => d.id))])};
    const r = await fetch('/api/cxy/v3/model/memberDownload', { method: 'POST', headers: h,
      body: JSON.stringify({ modelId: ${JSON.stringify(model.id)}, fileIds: ids }) });
    const j = await r.json();
    return { code: j.code, msg: j.msg, urls: (j.result && j.result.downloadUrls) || [] };
  })()`;
  const { value: res } = await ch.evalInPage(model.sourceUrl, js);
  if (res.code !== 0) throw new Error(`memberDownload 拒绝（${res.code} ${res.msg}）：先在浏览器登录创想云`);
  return res.urls.map((u) => {
    const doc = (model.docs || []).find((d) => d.id === u.fileId);
    if (doc) return { name: doc.name, url: u.url, size: u.size, kind: 'doc', origin: 'author' };
    const meta = model.files.find((f) => f.id === u.fileId);
    return { name: `${u.fileName}.${meta?.format || 'stl'}`, url: u.url, size: u.size, kind: 'model', origin: 'author' };
  });
}

export function normalize(raw) {
  const id = raw?.id == null ? '' : String(raw.id);
  return {
    site: 'creality',
    id,
    title: str(raw?.groupName) || '',
    url: id ? `https://www.crealitycloud.cn/model-detail/${id}` : '',
    cover: str(raw?.covers?.[0]?.url),
    author: str(raw?.userInfo?.nickName),
    likes: num(raw?.likeCount),
    downloads: num(raw?.downloadCount),
    collects: num(raw?.collectionCount),
    comments: num(raw?.commentCount),
    picked: Boolean(raw?.isPickModel),
    publishedAt: iso(raw?.createTime),
    tags: [], // 搜索结果只带 categoryName，没有标签
  };
}

export async function search({ keyword, page = 1, pageSize = 20 } = {}) {
  // 只实测过 sortType 10 = 下载量，别的排序不猜
  const r = await fetch(`${SITE}/api/cxy/smart_search/v1/model`, {
    method: 'POST',
    headers: { ...APP_HEADERS, referer: `${SITE}/` },
    body: JSON.stringify({
      page,
      pageSize,
      keyword,
      sortType: 10,
      printers: [],
      promoType: 0,
      isVip: 0,
      trendType: 1,
      multiMark: 0,
    }),
  });
  if (!r.ok) throw new Error(`创想云 HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.result?.list;
  if (!Array.isArray(list)) throw new Error('创想云返回里没有 result.list');
  return { total: num(j.result.count), items: list.map(normalize) };
}

export async function userModels({ uid, page = 1, pageSize = 20 } = {}) {
  if (!/^\d+$/.test(uid)) throw new Error('创想云用户 id 必须是数字');
  const r = await fetch(`${SITE}/api/cxy/v3/model/listSharePage`, {
    method: 'POST',
    headers: { ...APP_HEADERS, referer: `${SITE}/` },
    body: JSON.stringify({ userId: Number(uid), page, pageSize }),
  });
  if (!r.ok) throw new Error(`创想云 HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.result?.list;
  if (!Array.isArray(list)) throw new Error('创想云用户页返回里没有 result.list');
  return { total: num(j.result.count), items: list.map(normalize) };
}

/** 用户主页网址 → {site, id}，认不出返回 null（不猜）。 */
export function matchUser(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!HOSTS.includes(u.hostname.toLowerCase().replace(/^www\./, ''))) return null;
  const id = /^\/user\/(\d+)/.exec(u.pathname)?.[1];
  return id ? { site: 'creality', id } : null;
}

/** 一级分类树（含二级）。站点把分类塞在 __NUXT_DATA__ 的 modelCategoryBaseData 里。 */
export async function categories() {
  const { text } = await httpGet(`${SITE}/model-category/3d-print-all`);
  const raw = /id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(text)?.[1];
  if (!raw) throw new Error('分类页没有 __NUXT_DATA__（站点结构变了？）');
  const cats = resolveNuxt(JSON.parse(raw)).data.modelCategoryBaseData.categories;
  return cats
    .filter((c) => c.urlKey !== '3d-print-all') // 「全部分类」是筛选项不是分类
    .map((c) => ({
      id: c.id,
      name: c.name,
      en: c.en_name || '',
      children: (c.children || []).map((x) => ({ id: x.id, name: x.name, en: x.en_name || '' })),
    }));
}

export default {
  site: 'creality',
  // 这个接口按设计就要登录（签名链接靠登录态算），匿名优先在它身上没意义
  loginOnly: ['/api/cxy/v3/model/memberDownload', '/api/cxy/v3/model/3mfDownload'],
  platform: 'creality',
  label: '创想云',
  hosts: HOSTS,
  discover: true,
  categoriesKey: 'creality',
  match,
  matchUser,
  loginState,
  meta,
  fileLinks,
  categories,
  search,
  userModels,
};

// 自检：纯函数，不联网、不起浏览器
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'creality.mjs') {
  const id = '68fddae0d894ed5f6ce386a7';
  console.assert(match(`https://www.crealitycloud.cn/model-detail/${id}`)?.id === id, '标准模型页');
  console.assert(match(`https://crealitycloud.cn/model-detail/${id}?x=1`)?.url === `https://www.crealitycloud.cn/model-detail/${id}`, '重组掉 query');
  console.assert(match('https://www.crealitycloud.cn/user/8019797136/profile') === null, '用户页不是模型页');
  console.assert(match('http://evil/x#https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7') === null, 'fragment 不认');

  const c = normalize({
    id: 'abc',
    groupName: '小船',
    createTime: 1_700_000_000,
    covers: [{ url: 'https://x/c.webp' }],
    userInfo: { nickName: '作者' },
    likeCount: 3,
    downloadCount: 4,
    collectionCount: 5,
    commentCount: 6,
    isPickModel: true,
  });
  console.assert(c.url === 'https://www.crealitycloud.cn/model-detail/abc', '详情页 URL');
  console.assert(c.publishedAt === '2023-11-14T22:13:20.000Z', '秒级时间戳');
  console.assert(c.likes === 3 && c.downloads === 4 && c.collects === 5 && c.comments === 6, '计数');
  console.assert(c.picked === true && c.author === '作者', '作者/精选');

  // 3mf 打印配置：文件名靠 secondName 区分，拿不到直链的留在 siteOnlyFiles
  const p1 = { id: 'a1', title: '皮卡丘', name: '0.2mm layer', size: 12 };
  const p2 = { id: 'b2', title: '皮卡丘', name: '0.1mm layer', size: 11 };
  console.assert(profileName(p1) === '0.2mm layer.3mf', '3mf 文件名');
  console.assert(profileName({ id: 'c3' }) === 'c3.3mf', '缺字段也不出 undefined');
  const siteOnly = [p1, p2].map((p) => ({ name: profileName(p), url: `https://x/model-detail/abc?profileId=${p.id}` }));
  console.assert(trimSiteOnly(siteOnly, [p2]).length === 1 && trimSiteOnly(siteOnly, [p2])[0].url.endsWith('b2'), '只留没拿到的那条');
  console.assert(trimSiteOnly(siteOnly, []) === null, '全拿到就删字段');
  console.assert(trimSiteOnly(undefined, [p1]) === null, '没有兜底条目也不炸');

  console.log('creality pack demo ok');
}

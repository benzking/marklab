// Snapmaker（快造）站点包。
//
// 取数方式：页面 SSR（必须带 -model 这种 slug，`/model/1695` 与 `/model/1695-model` 内容不一样）
// 里有完整打印配置；模型文件是私链 CDN，匿名 HTTP 直下；没有公开直链的那批要登录态，
// 只能借真浏览器页内 fetch（ADR-0001/0002）。
//
// 对外形状见 docs/spec.md §2：match / loginState / meta / fileLinks / search / userModels。
import * as ch from '../channel.mjs';
import { sanitize, fmtHours, str, num, iso, cookiesFor } from '../lib.mjs';
import { httpGet } from './_http.mjs';

const HOSTS = ['space.snapmaker.cn'];
const SITE = 'https://space.snapmaker.cn';
const API = 'https://api-models.snapmaker.cn';
const CDN = 'https://cdn-model-private.snapmaker.cn';
// 浏览器 UI 实测（2026-10-31）：热门=不传 · 最新=latest · 下载量=downloads · 点赞量=like · 收藏量=collects。
// 点赞是单数 like；写 likes 会被静默忽略、回落默认序。
const SORT = { downloads: 'downloads', likes: 'like', collects: 'collects', newest: 'latest' };

/** 网址 → { name, id, url }；认不出返回 null（不猜）。url 是重组后的干净地址。 */
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
  const id = /^(?:\/[a-z]{2})?\/model\/(\d+)/i.exec(u.pathname)?.[1];
  if (!id) return null;
  return { site: 'snapmaker', id, url: `https://${u.hostname.toLowerCase()}${u.pathname}` };
}

/**
 * RSC flight 载荷里按 key 找它所在的那个对象，大括号配对 + 跳过字符串。
 * 载荷是 `self.__next_f.push([1,"…"])` 拼起来的，不是 JSON，正则取不出来。
 */
function objectAround(text, key) {
  const at = text.indexOf(key);
  if (at < 0) return null;
  let start = -1;
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = text[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  let d = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d === 0) {
        end = k;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const abs = (u) => (!u ? '' : /^https?:/.test(u) ? u : `${CDN}/${u.replace(/^\/+/, '')}`);

/** 登录态：只读本域的 login_access_token，连不上浏览器是 unknown，不是未登录。 */
export async function loginState() {
  const all = await ch.cookies();
  if (!all) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  const map = {};
  for (const c of cookiesFor(all, HOSTS)) map[c.name] = c.value;
  if (!map.login_access_token) return { ok: false, status: 'logged-out' };
  const r = await ch.fetchAs('snapmaker', `${API}/api/user/me`, {
    headers: { authorization: `Bearer ${map.login_access_token}` },
  });
  if (!r) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  const j = await r.json().catch(() => null);
  return j?.code === 200 && j?.data?.id
    ? { ok: true, status: 'logged-in', name: j.data.display_name || `id ${j.data.id}` }
    : { ok: false, status: 'logged-out' };
}

/** 模型页 → 统一模型对象（docs/spec.md §4）。解析失败抛错，不返回半截对象。 */
export async function meta(url) {
  const hit = match(url);
  if (!hit) throw new Error('不是 Snapmaker 模型网址');
  const { id } = hit;
  const canonical = hit.url;

  const { text: html } = await httpGet(canonical);
  const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map((m) => JSON.parse(m[1]))
    .join('');
  const profile = objectAround(flight, '"partitions"');
  const api = await (
    await fetch(`${API}/api/model/detail/${id}`, {
      headers: { accept: 'application/json', origin: 'https://space.snapmaker.cn', referer: 'https://space.snapmaker.cn/' },
    })
  ).json();
  const d = api.data || {};
  // 别人做的打印配置不算作者件（printProfiles[].creatorId 与模型的 creatorId 比）
  const fileOrigin = profile?.creatorId && d.creatorId && String(profile.creatorId) !== String(d.creatorId) ? 'other' : 'author';
  const fileUrl = abs(profile?.fileUrl || d.fileUrl);
  const fileName = profile?.fileName || d.fileName || (fileUrl.split('/').pop() || 'model.3mf');
  return {
    platform: 'snapmaker',
    id,
    sourceUrl: canonical,
    title: (d.translatedLang === 'zh' && d.translatedTitle) || d.title || fileName,
    author: d.creatorName || '',
    authorAvatar: d.creatorAvatar || '',
    description: sanitize((d.translatedLang === 'zh' && d.translatedDescription) || d.description),
    images: [d.coverUrl, ...(d.images || [])].filter(Boolean),
    stats: { downloads: d.downloadCount },
    picked: Boolean(d.isRecommended || d.isPicked || d.isFeatured),
    category: d.categoryNameKey || '',
    tags: (d.tags || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean),
    publishedAt: d.createdAt || d.createTime || null,
    translated: d.translatedLang === 'zh' && Boolean(d.translatedTitle) && d.translatedTitle !== d.title,
    print: profile
      ? {
          profileTitle: profile.translatedTitle || profile.name,
          thumb: (profile.pictures || [])[0],
          timeSec: profile.secs,
          timeText: profile.time || fmtHours(profile.secs),
          weightG: profile.weight,
          plates: profile.plates,
          nozzle: profile.printerType,
          filaments: (profile.filaments || []).map((f) => ({ type: f.type, color: f.color, usedG: f.used_g })),
          plateList: (profile.partitions || []).map((p) => ({
            name: p.name,
            timeSec: p.secs,
            weightG: p.weight,
            thumb: (p.pics || [])[0],
            filaments: (p.filaments || []).map((f) => ({ type: f.type, color: f.color, usedG: f.used_g })),
          })),
          machines: [],
          source: 'ssr',
        }
      : null,
    profiles: profile
      ? [
          {
            id: 'ssr',
            name: profile.translatedTitle || profile.name || '默认打印配置',
            machine: '',
            machines: [],
            plates: profile.plates || 0,
            plateList: (profile.partitions || []).map((pt) => ({
              name: pt.name,
              timeSec: pt.secs,
              weightG: pt.weight,
              thumb: (pt.pics || [])[0],
              filaments: (pt.filaments || []).map((x) => ({ type: x.type, color: x.color, usedG: x.used_g })),
            })),
            timeSec: profile.secs,
            timeText: profile.time || fmtHours(profile.secs),
            weightG: Math.round((profile.weight || 0) * 10) / 10,
            nozzle: profile.printerType || '',
            layerHeight: '',
            wallLoops: '',
            infill: '',
            bed: '',
            size: 0,
            filaments: (profile.filaments || []).map((x) => ({ type: x.type, color: x.color, usedG: x.used_g })),
            thumbnail: (profile.pictures || [])[0] || '',
            isDefault: true,
            url: canonical,
          },
        ]
      : [],
    files: fileUrl
      ? [{ name: fileName, format: (fileName.match(/\.(\w+)$/) || [])[1] || '3mf', size: d.fileSize, url: fileUrl, origin: fileOrigin }]
      : [],
    fileIds: fileUrl ? [fileUrl] : [],
  };
}

/** 文件链接。有公开直链就直接给；没有的（约 17%）要登录态，走页内 fetch。 */
export async function fileLinks(model) {
  if (model.files.length) {
    return model.files.map((f) => ({ name: f.name, url: f.url, size: f.size, kind: 'model', origin: f.origin || 'author' }));
  }

  const js = `(async () => {
    const ck = Object.fromEntries(document.cookie.split('; ').map(s => { const i = s.indexOf('='); return [s.slice(0,i), s.slice(i+1)]; }));
    const tok = ck['login_access_token'] || '';
    if (!tok) return { code: 401, msg: 'no login_access_token' };
    const r = await fetch('${API}/api/model/download/${model.id}', {
      headers: { accept: 'application/json', Authorization: 'Bearer ' + tok }, credentials: 'include',
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { code: j && j.code, msg: j && j.msg, data: (j && j.data) || null };
  })()`;
  const { value } = await ch.evalInPage(model.sourceUrl, js, { wait: 5000 });
  const d = value.data || {};
  const links = [
    ...(d.modelFiles || []).map((f) => ({
      name: f.fileName || f.name || 'model',
      url: f.downloadUrl || f.url || '',
      size: f.fileSize || f.size,
    })),
    ...(d.printProfiles || []).map((p) => ({
      name: p.fileName || 'profile.3mf',
      url: p.downloadUrl || '',
      size: p.fileSize || p.size,
      kind: 'profile',
    })),
  ]
    .filter((x) => x.url)
    .map((x) => ({ ...x, kind: x.kind || 'model', origin: 'author' }));
  if (!links.length) {
    throw new Error(`站点没有公开文件直链，打印配置要登录才能取（${value.msg || value.code}）：先在浏览器登录 Snapmaker`);
  }
  return links;
}

/** 搜索结果 → 统一 Item（docs/spec.md §9.5）。缺字段给安全默认值，不抛。 */
export function normalize(raw) {
  const id = raw?.id == null ? '' : String(raw.id);
  // 列表接口没有 tags，只有中文译名 translatedTags（docs/spec.md §6.2）；有 tags 就用 tags
  const siteTags = Array.isArray(raw?.tags) && raw.tags.length ? raw.tags : Array.isArray(raw?.translatedTags) ? raw.translatedTags : [];
  return {
    site: 'snapmaker',
    id,
    title: str(raw?.translatedTitle) || str(raw?.title) || '',
    url: id ? `https://space.snapmaker.cn/zh/model/${id}` : '',
    cover: str(raw?.cover_url),
    author: str(raw?.creator_name),
    likes: num(raw?.like_count),
    downloads: num(raw?.download_count),
    collects: num(raw?.collect_count),
    comments: null, // 接口没有评论数
    picked: Boolean(raw?.is_official_pick),
    publishedAt: iso(raw?.published_at),
    tags: siteTags.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean),
  };
}

const LIST_HEADERS = { accept: 'application/json', origin: 'https://space.snapmaker.cn', referer: 'https://space.snapmaker.cn/' };

export async function search({ keyword, page = 1, pageSize = 20, sort = 'downloads', filters } = {}) {
  const q = new URLSearchParams({
    keyword,
    page: String(page),
    pageSize: String(pageSize),
    sort: SORT[sort] || 'downloads',
  });
  // 语义值原样就是原生值（colorType=multi|single）；单色的收窄效果未实测，见 site-pack.md §11.4
  if (filters?.color) q.set('colorType', filters.color);
  const r = await fetch(`${API}/api/model/list?${q}`, { headers: LIST_HEADERS });
  if (!r.ok) throw new Error(`Snapmaker HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.data?.list;
  if (!Array.isArray(list)) throw new Error('Snapmaker 返回里没有 data.list');
  return { total: num(j.data.total), items: list.map(normalize) };
}

export async function userModels({ uid, page = 1, pageSize = 20 } = {}) {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize), creatorId: uid });
  const r = await fetch(`${API}/api/model/list?${q}`, { headers: LIST_HEADERS });
  if (!r.ok) throw new Error(`Snapmaker HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.data?.list;
  if (!Array.isArray(list)) throw new Error('Snapmaker 用户页返回里没有 data.list');
  return { total: num(j.data.total), items: list.map(normalize) };
}

/** 用户主页网址 → {site, id}。 */
export function matchUser(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!HOSTS.includes(u.hostname.toLowerCase().replace(/^www\./, ''))) return null;
  const id = /^\/(?:[a-z]{2}\/)?creator\/(\d+)/i.exec(u.pathname)?.[1];
  return id ? { site: 'snapmaker', id } : null;
}

/** 一级分类树。分类在 RSC 载荷的 categories 里（id/parentId/nameKey）。 */
export async function categories() {
  const { text } = await httpGet(`${SITE}/zh/models`);
  const flat = [...text.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)]
    .map((m) => {
      try { return JSON.parse(m[1])[1] || ''; } catch { return ''; }
    })
    .join('');
  const start = flat.indexOf('"categories":[');
  if (start < 0) throw new Error('RSC 载荷里没有 categories（站点结构变了？）');
  const raw = flat.slice(start + '"categories":'.length);
  let depth = 0;
  let end = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '[') depth++;
    else if (raw[i] === ']' && --depth === 0) { end = i + 1; break; }
  }
  const roots = JSON.parse(raw.slice(0, end));
  const pick = (c) => ({ id: c.id, name: c.nameKey, children: (c.children || []).map((x) => ({ id: x.id, name: x.nameKey })) });
  return roots.flatMap((r) => r.children || []).map(pick);
}

const pack = {
  site: 'snapmaker',
  platform: 'snapmaker',
  label: 'Snapmaker',
  hosts: HOSTS,
  discover: true,
  categoriesKey: 'snapmaker',
  match,
  matchUser,
  loginState,
  meta,
  fileLinks,
  categories,
  searchOptions: { sorts: ['downloads', 'likes', 'collects', 'newest'], tags: true },
  filters: { color: ['multi', 'single'] },
  search,
  userModels,
};

export default pack;

// 自检：纯函数，不联网、不起浏览器
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'snapmaker.mjs') {
  console.assert(match('https://space.snapmaker.cn/zh/model/1695-model')?.id === '1695', '带 slug 的模型页');
  console.assert(match('https://space.snapmaker.cn/zh/model/1695')?.id === '1695', '不带 slug 也认');
  console.assert(match('https://space.snapmaker.cn.evil.example/zh/model/1') === null, '相似域名不认');
  console.assert(match('http://evil/x#https://space.snapmaker.cn/zh/model/1') === null, 'fragment 里的网址不认');

  const s = normalize({ id: 9, translatedTitle: '译名', title: 'orig', is_official_pick: true });
  console.assert(s.id === '9' && s.title === '译名' && s.comments === null, '缺字段默认');
  console.assert(s.url === 'https://space.snapmaker.cn/zh/model/9', '详情页 URL');

  const flight = 'abc{"partitions":[{"name":"p1"}],"secs":10}def';
  console.assert(objectAround(flight, '"partitions"')?.secs === 10, 'RSC 括号配对');
  console.assert(objectAround('no key here', '"partitions"') === null, '找不到 key 返回 null');

  console.assert(normalize({ id: 10, translatedTags: ['可爱', '摆件'] }).tags.join() === '可爱,摆件', 'translatedTags 归到 tags');
  console.assert(normalize({ id: 11, tags: ['benchy'], translatedTags: ['可爱'] }).tags.join() === 'benchy', 'raw.tags 有值优先');
  console.assert(pack.searchOptions.tags === true, 'Snapmaker 搜索结果带 tags（译名）');
  console.log('snapmaker pack demo ok');
}

// grab.mjs 的纯函数部分：站点识别、Nuxt 序列化还原、富文本清洗。
// 单独拆出来是为了能被 test.mjs 直接测，不用起浏览器也不用联网。
import { realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 数据根目录。测试用 MARKLAB_ROOT 指到临时目录，生产就是仓库根。
export const ROOT = process.env.MARKLAB_ROOT
  ? path.resolve(process.env.MARKLAB_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const LIB = path.join(ROOT, 'library');
export const DATA = path.join(ROOT, 'data');

/**
 * 先写临时文件再改名：改名是原子的，断电/被杀只会留旧版本，不会留半个 JSON。
 * 库里任何一个 model.json 读到半截，那个模型就会从索引里静默消失。
 */
export async function writeJson(file, value, opts) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2), opts);
  await rename(tmp, file);
}

// 站点识别只认 hostname 完全一致的那几个域名，正则只跑 pathname。
// 整串跑正则的话 `http://坏站/x#https://真站/model-detail/<id>` 会被认成真站，等于把抓取目标交给对方。
const HOSTS = {
  creality: ['crealitycloud.cn'],
  makerworld: ['makerworld.com', 'makerworld.com.cn'],
  snapmaker: ['space.snapmaker.cn'],
  makeronline: ['makeronline.cn', 'makeronline.com'],
};
const PATHS = {
  creality: /\/model-detail\/([0-9a-f]{24})/i,
  makerworld: /\/models\/(\d+)/,
  // 带 slug 的地址才有完整 SSR（/model/1695-model 与 /model/1695 内容不一样）
  snapmaker: /^(?:\/[a-z]{2})?\/model\/(\d+)/i,
  // id 在最后：/zh/model/<slug>/341770.html；本地语前缀可省
  makeronline: /^(?:\/[a-z]{2})?\/model\/.*?(\d+)\.html/i,
};

/** 认站点。返回的 url 是重组出来的干净网址，抓取只许用它，不许用调用方给的原串。 */
export function matchPlatform(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const [name, domains] of Object.entries(HOSTS)) {
    if (!domains.includes(host)) continue;
    const id = PATHS[name].exec(u.pathname)?.[1];
    if (!id) return null;
    return { name, id, url: `https://${u.hostname.toLowerCase()}${u.pathname}` };
  }
  return null;
}

// Nuxt 的 __NUXT_DATA__ 是 devalue 序列化：数组里数字是引用，字符串是字面量，
// ["Reactive", n] 这类是包装器，取第 2 个元素即可。
const MARKERS = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef', 'Date', 'Set', 'Map', 'RegExp', 'BigInt', 'Object', 'null']);

export function resolveNuxt(data) {
  const rv = (i) => {
    const v = data[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && MARKERS.has(v[0])) return rv(v[1]);
      return v.map((x) => (typeof x === 'number' ? rv(x) : x));
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'number' ? rv(x) : x]));
    }
    return v;
  };
  return rv(0);
}

// 站点描述是富文本。黑名单（列危险标签再删）已知能绕过，改成白名单：
// 只放行认识的标签和属性，其余丢弃。抓取侧存干净数据，渲染侧再兜一层（web/app.js 的 safeHtml）。
const OK_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins',
  'sub', 'sup', 'small', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code', 'hr', 'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
]);
const OK_ATTRS = { a: ['href'], img: ['src', 'alt', 'width', 'height'] };
// 带内容的危险块整体删掉；只删标签会把脚本正文留成可见文本
const DROP_BLOCKS = /<(script|style|iframe|object|embed|svg|math|form|noscript|template|boostme)\b[\s\S]*?<\/\1\s*>/gi;
const ENTITY = /&#x([0-9a-f]+);?|&#(\d+);?|&(colon|tab|newline);/gi;
const decodeEntities = (s) =>
  s.replace(ENTITY, (_, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : name === 'colon' ? ':' : '',
  );
// 相对地址放行；带协议的只认 http/https/mailto，img 另放 data:image
function safeUrl(raw, tag) {
  const v = decodeEntities(raw).replace(/[\u0000-\u0020\u007f]+/g, '');
  const colon = v.indexOf(':');
  const slash = v.search(/[/?#]/);
  if (colon < 0 || (slash >= 0 && slash < colon)) return true;
  const scheme = v.slice(0, colon).toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return true;
  return tag === 'img' && scheme === 'data' && /^data:image\//i.test(v);
}
function cleanAttrs(tag, attrs) {
  const allowed = OK_ATTRS[tag] || [];
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let m;
  while ((m = re.exec(attrs))) {
    const name = m[1].toLowerCase();
    if (name.startsWith('on') || (name !== 'title' && !allowed.includes(name))) continue;
    const val = (m[2] || '').replace(/^["']|["']$/g, '');
    if ((name === 'href' || name === 'src') && !safeUrl(val, tag)) continue;
    out.push(` ${name}="${val.replace(/"/g, '&quot;')}"`);
  }
  return out.join('');
}

export function sanitize(html) {
  let s = String(html || '').replace(DROP_BLOCKS, '');
  s = s.replace(/<(?![a-zA-Z/])/g, '&lt;');
  return s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g, (m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!OK_TAGS.has(t)) return '';
    return close ? `</${t}>` : `<${t}${cleanAttrs(t, attrs)}>`;
  });
}

export const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export const slugify = (s) =>
  String(s || 'model')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);

export const fmtSize = (bytes) => {
  if (!bytes) return '';
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
};

export const fmtDate = (ts) => {
  if (!ts) return '';
  const n = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(ts);
  return Number.isFinite(n) ? new Date(n).toLocaleDateString('zh-CN') : '';
};

// 秒 → "64.3 h" / "26.2 h" / "12 分钟"，与站点显示口径一致
export const fmtHours = (sec) => {
  if (!sec) return '';
  const h = sec / 3600;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(sec / 60)} 分钟`;
};

// 站点给的值一律不可信：类型不对就给安全默认值，别把 null 当成 0，也别把 0 当成 1970。
/** 签名链接里的 % 偶尔不合法，decode 抛错不该让整份文件列表失败。 */
export const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return String(s);
  }
};

export const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const iso = (v) => {
  if (!v) return null;
  const n = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};

// 「热门」门槛：按各站体量定的经验值，觉得不合适直接改这里。
// 为什么不用榜单接口：三站的榜单都要登录或没有公开接口，用下载量做相对热度更稳。
export const HOT = { creality: 1000, makerworld: 500, snapmaker: 30, makeronline: 100 };

// 站点自带的「精选」标记 + 下载量过门槛 → 自动标签
export function autoTags(platform, { downloads, picked } = {}) {
  const tags = [];
  if (picked) tags.push('精选');
  const bar = HOT[platform];
  if (bar && downloads != null && downloads >= bar) tags.push('热门');
  return tags;
}

// ── 分类对照 ───────────────────────────────────────────────────
// 把站点自己的分类名映射到 docs/categories/merge.json 的统一分类 id。
// 站点里同名的分类（创想云 9 个「其他」、MakerOnline 两个「服装」）靠站点一级名再筛，
// 仍分不清就返回 null —— 宁可显示「未分类」，也不猜错。
export function catIndex(sites, merge) {
  const byId = {}; // `${site}:${id}` -> {l1, l2}
  for (const l1 of merge.level1) {
    for (const [site, ids] of Object.entries(l1.sites)) for (const id of ids) byId[`${site}:${id}`] = { l1: l1.id, l2: null };
    for (const c of l1.children) {
      for (const [site, ids] of Object.entries(c.sites)) for (const id of ids) byId[`${site}:${id}`] = { l1: l1.id, l2: c.id };
    }
  }
  const map = {}; // site -> 分类名 -> [{l1, l2, parent}]
  for (const [site, tree] of Object.entries(sites)) {
    map[site] = {};
    for (const c of tree) {
      const self = byId[`${site}:${c.id}`];
      if (self) (map[site][c.name] ??= []).push({ ...self, parent: null });
      for (const x of c.children) {
        const hit = byId[`${site}:${x.id}`];
        if (hit) (map[site][x.name] ??= []).push({ ...hit, parent: c.name });
      }
    }
  }
  return map;
}

export function catOf(map, platform, category) {
  const site = platform === 'makeronline-cn' ? 'makeronline' : platform;
  // MakerOnline 存的是「一级 / 二级」，最后一段才是分类名
  const parts = String(category || '').split(' / ').filter(Boolean);
  const hits = map[site]?.[parts.at(-1)] || [];
  if (hits.length === 1) return { l1: hits[0].l1, l2: hits[0].l2 };
  const one = hits.find((h) => h.parent === parts[0]);
  return one ? { l1: one.l1, l2: one.l2 } : null;
}

// 真实路径必须落在 base 里：字符串前缀能被软链接绕过（library/evil.json → /etc/passwd）
export async function inside(base, target) {
  try {
    const [b, t] = await Promise.all([realpath(base), realpath(target)]);
    return t === b || t.startsWith(b + path.sep);
  } catch {
    return false;
  }
}

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

/**
 * 没下到文件的原因（控制台据此说「下一步干什么」）。
 * skipped 是「这次没下」不是失败；有文件列表却没链接 = parse；站点压根没给 = none。
 */
export function noFilesKind({ wantFiles, savedCount, hasFiles, linkErr }) {
  if (!wantFiles) return 'skipped';
  if (savedCount > 0) return null;
  const msg = String(linkErr || '');
  if (/机器人|captcha|人机验证/i.test(msg)) return 'captcha';
  if (/登录|403|unauthor|forbidden/i.test(msg)) return 'login';
  return hasFiles ? 'parse' : 'none';
}

export const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * 打印配置 → 本地已下的 3mf（savedFiles 里的一条）。三档降级，对不上就 null：
 * profileId（新库）→ 文件名与配置名精确相等（创想云）→ 一配置一文件。
 * 宁可不给下载按钮，也不按顺序硬配——配错了比没有更坏（spec §4.2）。
 */
export function profileFile(model, profile) {
  const files = (model?.savedFiles || []).filter((f) => f.kind === 'profile' && f.path && f.exists !== false);
  if (!files.length || !profile) return null;
  const byId = files.find((f) => f.profileId != null && String(f.profileId) === String(profile.id));
  if (byId) return byId;
  const want = `${profile.name || ''}.3mf`.toLowerCase();
  const byName = files.find((f) => String(f.name || '').toLowerCase() === want);
  if (byName) return byName;
  return files.length === 1 && (model.profiles || []).length === 1 ? files[0] : null;
}

/**
 * 这条配置是不是模型作者做的（决定详情页标不标「作者」）。
 * 各站字段不同：创想云 isAuth、MakerOnline isAuthor、MakerWorld 比 creatorUid。
 * 没有这个字段就返回 null —— 不显示，不猜（Snapmaker 就不给）。
 */
export function profileByAuthor(model, profile) {
  const p = profile || {};
  if (p.isAuth != null) return Boolean(p.isAuth);
  if (p.isAuthor != null) return Boolean(p.isAuthor);
  const c = p.creatorUid ?? p.uid;
  if (c != null && model?.authorUid != null) return String(c) === String(model.authorUid);
  return null;
}

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
// cookie 域匹配：同域、子域，以及父域——`.snapmaker.cn` 的 cookie 浏览器会发给 space.snapmaker.cn，
// 不认父域就会把已登录看成未登录。仍只认带点的后缀，evil-crealitycloud.cn 冒充不了 crealitycloud.cn。
export const cookiesFor = (cookies, domains) =>
  (cookies || []).filter((c) => {
    const cd = String(c.domain || '').toLowerCase().replace(/^\./, '');
    return domains.some((d) => {
      const hd = String(d || '').toLowerCase().replace(/^\./, '');
      return cd === hd || cd.endsWith(`.${hd}`) || hd.endsWith(`.${cd}`);
    });
  });
/**
 * 签到结果（CheckinResult）→ 一行中文。文案只在这里，站点包不许拼句子（site-pack.md §11.1）。
 * acted = 这一次真的发了签到请求（不是 dry 探状态）。
 */
export const checkinText = (r, acted = false) => {
  if (!r) return '没拿到签到状态';
  const bits = [acted && r.signed ? '签到成功' : r.signed ? '今天已签' : '可签'];
  if (r.streak) bits.push(`连签 ${r.streak} 天`);
  if (r.signed && r.gain) bits.push(`+${r.gain}`);
  if (r.note) bits.push(r.note);
  return bits.join(' · ');
};

export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const iso = (v) => {
  if (!v) return null;
  const n = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};

// 「热门」门槛：按各站体量定的经验值，觉得不合适直接改这里。
// 为什么不用榜单接口：三站的榜单都要登录或没有公开接口，用下载量做相对热度更稳。
export const HOT = { creality: 1000, makerworld: 500, snapmaker: 30, 'makeronline.cn': 100, makeroad: 100 };

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
  // MakerOnline 存的是「一级 / 二级」，最后一段才是分类名
  const parts = String(category || '').split(' / ').filter(Boolean);
  const hits = map[platform]?.[parts.at(-1)] || [];
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

/** 给搜索结果标上「库里有没有」。库目录名就是 `<platform>-<id>`（server.mjs 的 fwd.of 同款），
 *  所以只需要目录名集合，不用读 model.json——那是几百次读盘的活。纯函数，测试直接喂 Set。 */
export function markInLibrary(items, keys) {
  return items.map((it) => ({ ...it, inLibrary: keys.has(`${it.site}-${it.id}`) }));
}

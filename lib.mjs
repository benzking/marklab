// grab.mjs 的纯函数部分：站点识别、Nuxt 序列化还原、富文本清洗。
// 单独拆出来是为了能被 test.mjs 直接测，不用起浏览器也不用联网。

// 三个站点各自的 id 提取规则
export const PLATFORMS = {
  creality: (u) => /crealitycloud\.cn\/model-detail\/([0-9a-f]{24})/i.exec(u)?.[1],
  makerworld: (u) => /makerworld\.com(?:\.cn)?\/.*?models\/(\d+)/i.exec(u)?.[1],
  snapmaker: (u) => /space\.snapmaker\.cn\/(?:[a-z]{2}\/)?model\/(\d+)/i.exec(u)?.[1],
  // makeronline 的网址里 id 在最后：/zh/model/<slug>/341770.html
  // makeronline 有国内站 .cn 与国际站 .com，结构一样
  makeronline: (u) => /makeronline\.(?:com|cn)\/.*?\/model\/.*?\/(\d+)\.html/i.exec(u)?.[1],
};

export function matchPlatform(url) {
  for (const [name, re] of Object.entries(PLATFORMS)) {
    const id = re(url);
    if (id) return { name, id };
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

// 站点描述是富文本：保留排版，去掉脚本、事件属性和站内促销卡片
export function sanitize(html) {
  return String(html || '')
    .replace(/<boostme>[\s\S]*?<\/boostme>/gi, '')
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
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

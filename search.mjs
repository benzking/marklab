// 四站搜索适配器：统一 Item 形状 + 按站限速（ADR-0005 第 3 节）。
// 网络层和归一化层分开，纯函数能被自检直接跑；字段缺失一律给安全默认值，不抛。
import { siteOf } from './channel.mjs';
import { str, num, iso } from './lib.mjs';
import * as sites from './sites/index.mjs';

export const SITES = ['creality', 'makerworld', 'snapmaker', 'makeronline'];
export const RATE = { perSite: 4, windowMs: 60_000, minGapMs: 15_000 };

/** 纯函数：用户主页网址 → {site, id}。四个站各一种写法，认不出返回 null（不猜）。 */
export function parseUserUrl(input) {
  const raw = String(input || '').trim();
  const site = siteOf(raw);
  if (!site) return null;
  let pathname;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    return null;
  }
  const pick = (re) => (re.exec(pathname) || [])[1];
  const id =
    site === 'creality'
      ? pick(/^\/user\/(\d+)/)
      : site === 'makerworld'
        ? pick(/^\/(?:[a-z]{2}\/)?@([^/]+)/i)
        : site === 'snapmaker'
          ? pick(/^\/(?:[a-z]{2}\/)?creator\/(\d+)/i)
          : site === 'makeronline'
            ? pick(/\/user\/personalInfo\/([0-9a-f-]{36})/i)
            : null;
  return id ? { site, id: decodeURIComponent(id) } : null;
}

// ── 归一化（纯函数） ────────────────────────────────────────────


export function normalizeMakeronline(raw) {
  const id = raw?.mold_id == null ? '' : String(raw.mold_id);
  return {
    site: 'makeronline',
    id,
    title: str(raw?.title) || '',
    url: str(raw?.target_url) || '',
    cover: str(raw?.mold_image),
    author: str(raw?.user_display_name) || str(raw?.user_name),
    likes: num(raw?.like_num),
    downloads: num(raw?.download_num),
    collects: null, // 搜索接口没有收藏数
    comments: null, // 也没有评论数
    picked: Boolean(raw?.is_winner),
    publishedAt: iso(raw?.created_time),
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
  };
}

// ── 限速：按站各自计时，不共享配额 ──────────────────────────────

// 纯函数：给上次放行时间和窗口内的放行时间戳，算出还要等多久
export function rateDelay({ last = 0, recent = [] } = {}, now = Date.now()) {
  const gap = last ? RATE.minGapMs - (now - last) : 0;
  const win = recent.length >= RATE.perSite ? RATE.windowMs - (now - recent[0]) : 0;
  return Math.max(0, gap, win);
}

const lastAt = new Map(); // site -> 上次放行时间
const recent = new Map(); // site -> 窗口内放行时间
const lanes = new Map(); // site -> 串行队列，并发调用也不会同时放行

function waitTurn(site) {
  const now = Date.now();
  const times = (recent.get(site) || []).filter((t) => now - t < RATE.windowMs);
  const ms = rateDelay({ last: lastAt.get(site), recent: times }, now);
  // setTimeout 可能提前一点，递归复查比算一次稳
  if (ms) return new Promise((r) => setTimeout(r, ms)).then(() => waitTurn(site));
  times.push(now);
  recent.set(site, times);
  lastAt.set(site, now);
}

function throttle(site) {
  const next = (lanes.get(site) || Promise.resolve()).then(() => waitTurn(site));
  lanes.set(site, next);
  return next;
}

// ── 网络层 ──────────────────────────────────────────────────────

async function fetchMakeronline(keyword, page, pageSize, sort) {
  // 搜索接口没有排序参数，sort 只保留在返回里
  const r = await fetch('https://www.makeronline.cn/api/search/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword, category_id: '', page, page_size: pageSize, print_type: 0, pure_search: 0 }),
  });
  if (!r.ok) throw new Error(`MakerOnline HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.data?.data;
  if (!Array.isArray(list)) throw new Error('MakerOnline 返回里没有 data.data');
  return { total: num(j.data.page?.total), items: list.map(normalizeMakeronline) };
}

// 还没搬进站点包的站（票 04–05 逐个搬走）
const FETCHERS = {
  makeronline: fetchMakeronline,
};

// ── 用户主页：订阅某个作者发过的全部模型 ────────────────────────
// 四站的主页列表都能匿名取；MakerWorld 照旧只能走真浏览器。

async function fetchMakeronlineUser(uid, page, pageSize) {
  const q = new URLSearchParams({ page: String(page), page_size: String(pageSize), user_id: uid });
  const r = await fetch(`https://www.makeronline.cn/api/user/personal/index?${q}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`MakerOnline HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.data?.data;
  if (!Array.isArray(list)) throw new Error('MakerOnline 用户页返回里没有 data.data');
  return {
    total: num(j.data.page?.total),
    // 用户页列表没有 target_url，按详情页规律拼；标题要编码
    items: list.map((raw) =>
      normalizeMakeronline({
        ...raw,
        mold_image: raw.main_image || raw.main_thumb_image,
        target_url: `https://www.makeronline.cn/zh/model/${encodeURIComponent(raw.title || '')}/${raw.mold_id}.html`,
      }),
    ),
  };
}

const USER_FETCHERS = {
  makeronline: fetchMakeronlineUser,
};

/** 拉某个用户主页上的模型。站点失败给空结果，不拖垮整轮（和 search 一个口径）。 */
export async function userModels(site, uid, { page = 1, pageSize = 20 } = {}) {
  const id = String(uid || '').trim();
  const base = { site, user: id, page, total: 0, items: [] };
  const pack = sites.byName(site);
  const fetcher = USER_FETCHERS[site];
  if (!(pack || fetcher) || !id) return base;
  await throttle(site);
  try {
    const r = pack ? await pack.userModels({ uid: id, page, pageSize }) : await fetcher(id, page, pageSize);
    return { ...base, total: r.total, items: r.items };
  } catch (e) {
    console.error(`[user] ${site} ${id} 失败：${e.message}`);
    return base;
  }
}

/** 搜索一个站。返回统一形状；站点失败时给空结果，不拖垮整轮。 */
export async function search(site, keyword, { page = 1, sort = 'downloads', pageSize = 20 } = {}) {
  const kw = String(keyword || '').trim();
  const base = { site, keyword: kw, page, total: 0, items: [] };
  const pack = sites.byName(site);
  const fetcher = FETCHERS[site];
  if (!(pack || fetcher) || !kw) return base;
  await throttle(site);
  try {
    const r = pack ? await pack.search({ keyword: kw, page, pageSize, sort }) : await fetcher(kw, page, pageSize, sort);
    return { ...base, total: r.total, items: r.items };
  } catch (e) {
    console.error(`[search] ${site} 失败：${e.message}`);
    return base;
  }
}

// ── 自检：纯函数，不联网、不起浏览器 ────────────────────────────

function demo() {
  const o = normalizeMakeronline({ mold_id: 1, title: 'O', target_url: 'https://www.makeronline.cn/model/O/1.html' });
  console.assert(o.id === '1' && o.collects === null && o.comments === null, 'MakerOnline 无收藏/评论');
  console.assert(o.publishedAt === null && o.tags.length === 0, 'MakerOnline 缺字段默认');

  const t0 = 1_000_000;
  console.assert(rateDelay({}, t0) === 0, '首次不等待');
  console.assert(rateDelay({ last: t0 - 5000, recent: [] }, t0) === 10_000, '间隔不足等 15 秒');
  console.assert(rateDelay({ last: t0 - 20_000, recent: [t0 - 50_000, t0 - 40_000, t0 - 30_000, t0 - 20_000] }, t0) === 10_000, '窗口满了等最早一条过期');

  const pu = parseUserUrl;
  console.assert(
    JSON.stringify(pu('https://www.crealitycloud.cn/user/8019797136/profile')) === '{"site":"creality","id":"8019797136"}',
    '创想云用户主页',
  );
  console.assert(
    JSON.stringify(pu('https://makerworld.com.cn/zh/@youngzhen/upload')) === '{"site":"makerworld","id":"youngzhen"}',
    'MakerWorld 用户主页（带子页也算）',
  );
  console.assert(
    JSON.stringify(pu('https://space.snapmaker.cn/zh/creator/11307')) === '{"site":"snapmaker","id":"11307"}',
    'Snapmaker 创作者主页',
  );
  console.assert(
    pu('https://www.makeronline.cn/user/personalInfo/906cb404-2c42-4b4c-8dc1-69c50d5b50dd.html')?.id ===
      '906cb404-2c42-4b4c-8dc1-69c50d5b50dd',
    'MakerOnline 个人主页',
  );
  console.assert(pu('https://makerworld.com.cn/zh/models/1014649') === null, '模型页不是用户主页');
  console.assert(pu('https://example.com/user/1') === null, '不认识的站不猜');

  console.log('search demo ok');
}

if ((process.argv[1] || '').split(/[\\/]/).pop() === 'search.mjs') {
  if (process.argv.includes('--live')) {
    const kw = process.argv[process.argv.indexOf('--live') + 1] || 'benchy';
    // 站点各自限速，互不共享配额，可以并行
    const results = await Promise.all(SITES.map((site) => search(site, kw)));
    for (const r of results) {
      console.log(`\n${r.site} total=${r.total}`);
      for (const it of r.items.slice(0, 3)) {
        console.log(`  ${it.title} | likes=${it.likes} downloads=${it.downloads} | ${it.url}`);
      }
    }
    process.exit(0); // playwright 的 WS 会撑住事件循环
  } else {
    demo();
    process.exit(0);
  }
}

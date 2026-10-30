// 四站搜索适配器：统一 Item 形状 + 按站限速（ADR-0005 第 3 节）。
// 网络层和归一化层分开，纯函数能被自检直接跑；字段缺失一律给安全默认值，不抛。
import { inPage, siteOf } from './channel.mjs';
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


export function normalizeCreality(raw) {
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

export function normalizeMakerworld(raw) {
  const id = raw?.id == null ? '' : String(raw.id);
  return {
    site: 'makerworld',
    id,
    title: str(raw?.title) || '',
    url: id ? `https://makerworld.com.cn/zh/models/${id}` : '',
    cover: str(raw?.cover),
    author: str(raw?.designCreator?.name),
    likes: num(raw?.likeCount),
    downloads: num(raw?.downloadCount),
    collects: num(raw?.collectionCount),
    comments: num(raw?.commentCount),
    picked: Boolean(raw?.isStaffPicked),
    publishedAt: iso(raw?.createTime),
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
  };
}

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

const CREALITY_HEADERS = {
  'content-type': 'application/json',
  __cxy_app_id_: 'cxy-gen2',
  __cxy_app_ver_: '7.3.28',
  __cxy_platform_: '2',
  __cxy_brand_: 'creality',
};

// 只实测过 sortType 10 = 下载量，别的排序不猜
const crealitySort = (sort) => (sort === 'downloads' ? 10 : 10);

const MAKERWORLD_ORDER = {
  downloads: 'downloadCount',
  likes: 'likeCount',
  newest: 'newUploads',
  hot: 'hotScore',
  score: 'score',
};

async function fetchCreality(keyword, page, pageSize, sort) {
  const r = await fetch('https://www.crealitycloud.cn/api/cxy/smart_search/v1/model', {
    method: 'POST',
    headers: CREALITY_HEADERS,
    body: JSON.stringify({
      page,
      pageSize,
      keyword,
      sortType: crealitySort(sort),
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
  return { total: num(j.result.count), items: list.map(normalizeCreality) };
}

async function fetchMakerworld(keyword, page, pageSize, sort) {
  const orderBy = MAKERWORLD_ORDER[sort] || 'score';
  const url = `https://makerworld.com.cn/zh/search/models?keyword=${encodeURIComponent(keyword)}&orderBy=${orderBy}&page=${page}`;
  // pageSize 不可调，站点固定一页 20 条
  const data = await inPage(
    'makerworld',
    url,
    () => {
      const text = document.querySelector('#__NEXT_DATA__')?.textContent;
      if (!text) return null;
      const pp = JSON.parse(text)?.props?.pageProps;
      return { total: pp?.total, designs: pp?.designs };
    },
    undefined,
    { wait: 2000 }, // 首屏 hydrate 完 designs 才挂上
  );
  if (!data || !Array.isArray(data.designs)) throw new Error('MakerWorld 页面没拿到 __NEXT_DATA__.designs（浏览器没连上或站点改版）');
  return { total: num(data.total), items: data.designs.map(normalizeMakerworld) };
}

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

// 还没搬进站点包的三个站（票 02–05 逐个搬走）
const FETCHERS = {
  creality: fetchCreality,
  makerworld: fetchMakerworld,
  makeronline: fetchMakeronline,
};

// ── 用户主页：订阅某个作者发过的全部模型 ────────────────────────
// 四站的主页列表都能匿名取；MakerWorld 照旧只能走真浏览器。

async function fetchCrealityUser(uid, page, pageSize) {
  if (!/^\d+$/.test(uid)) throw new Error('创想云用户 id 必须是数字');
  const r = await fetch('https://www.crealitycloud.cn/api/cxy/v3/model/listSharePage', {
    method: 'POST',
    headers: CREALITY_HEADERS,
    body: JSON.stringify({ userId: Number(uid), page, pageSize }),
  });
  if (!r.ok) throw new Error(`创想云 HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.result?.list;
  if (!Array.isArray(list)) throw new Error('创想云用户页返回里没有 result.list');
  return { total: num(j.result.count), items: list.map(normalizeCreality) };
}

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

async function fetchMakerworldUser(handle, page) {
  const url = `https://makerworld.com.cn/zh/@${encodeURIComponent(handle)}/upload?page=${page}`;
  const data = await inPage(
    'makerworld',
    url,
    () => {
      const text = document.querySelector('#__NEXT_DATA__')?.textContent;
      if (!text) return null;
      const pp = JSON.parse(text)?.props?.pageProps;
      return { total: pp?.total, designs: pp?.designs };
    },
    undefined,
    { wait: 2000 },
  );
  if (!data || !Array.isArray(data.designs)) throw new Error('MakerWorld 用户页没拿到 __NEXT_DATA__.designs（浏览器没连上或站点改版）');
  return { total: num(data.total), items: data.designs.map((raw) => normalizeMakerworld({ ...raw, cover: raw.coverUrl })) };
}

const USER_FETCHERS = {
  creality: fetchCrealityUser,
  makerworld: fetchMakerworldUser,
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
  const c = normalizeCreality({
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
  console.assert(c.site === 'creality', '创想云站点名');
  console.assert(c.url === 'https://www.crealitycloud.cn/model-detail/abc', '创想云详情页 URL');
  console.assert(c.publishedAt === '2023-11-14T22:13:20.000Z', '创想云秒级时间戳');
  console.assert(c.likes === 3 && c.downloads === 4 && c.collects === 5 && c.comments === 6, '创想云计数');
  console.assert(c.picked === true && c.author === '作者', '创想云作者/精选');

  const m = normalizeMakerworld({ id: 7, title: 'T', tags: ['benchy', 1], designCreator: { name: 'B' }, createTime: '2024-05-23T09:28:27Z' });
  console.assert(m.url === 'https://makerworld.com.cn/zh/models/7', 'MakerWorld 详情页 URL');
  console.assert(m.publishedAt === '2024-05-23T09:28:27.000Z' && m.tags.length === 1, 'MakerWorld 时间/标签');

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

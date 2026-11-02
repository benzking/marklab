// 站点搜索：统一 Item 形状 + 按站限速（ADR-0005 第 3 节）。
// 具体怎么搜在站点包里，这里只管限速、兜错、归一化。
import * as sites from './sites/index.mjs';
import { siteConfigGet } from './tasks.mjs';
import * as ch from './channel.mjs';

// 默认进搜索/订阅的站点：站点包自己声明 discover（MakerOnline 的 .com 是同一个站的另一套账号，
// 不默认进，免得把搜索预算翻倍）。
export const SITES = sites.all().filter((p) => p.discover !== false).map((p) => p.site);
// 显式指定时允许的键（含别名），订阅校验用它
// 函数而不是常量：站点包是运行时可注册的（测试里会加假站点），常量会在 import 时就冻住
export const allSites = () => [...new Set(sites.all().flatMap((p) => [p.site, ...(p.aliases || [])]))];
export const RATE = { perSite: 4, windowMs: 60_000, minGapMs: 15_000 };

/** 某站的搜索配额：站点自定义的每分钟次数 > 全局默认。只配次数，最小间隔按均分推出来
 *  （4 次/分 → 15 秒，正好等于默认值，所以不配的时候行为和以前一模一样）。 */
export function rateOf(site) {
  const n = Number(siteConfigGet()[site]?.searchPerMin);
  if (!Number.isFinite(n) || n <= 0) return RATE;
  const perMin = Math.min(Math.round(n), 60);
  return { perSite: perMin, windowMs: RATE.windowMs, minGapMs: Math.floor(RATE.windowMs / perMin) };
}

/** 纯函数：用户主页网址 → {site, id}。每个站点包自己认自己的写法，认不出返回 null（不猜）。 */
export function parseUserUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  for (const pack of sites.all()) {
    const hit = pack.matchUser?.(raw);
    if (hit) return hit;
  }
  return null;
}


// ── 限速：按站各自计时，不共享配额 ──────────────────────────────

// 纯函数：给上次放行时间和窗口内的放行时间戳，算出还要等多久
export function rateDelay({ last = 0, recent = [] } = {}, now = Date.now(), rate = RATE) {
  const gap = last ? rate.minGapMs - (now - last) : 0;
  const win = recent.length >= rate.perSite ? rate.windowMs - (now - recent[0]) : 0;
  return Math.max(0, gap, win);
}

const lastAt = new Map(); // site -> 上次放行时间
const recent = new Map(); // site -> 窗口内放行时间
const lanes = new Map(); // site -> 串行队列，并发调用也不会同时放行

function waitTurn(site) {
  const now = Date.now();
  const rate = rateOf(site);
  const times = (recent.get(site) || []).filter((t) => now - t < rate.windowMs);
  const ms = rateDelay({ last: lastAt.get(site), recent: times }, now, rate);
  // setTimeout 可能提前一点，递归复查比算一次稳
  if (ms) return new Promise((r) => setTimeout(r, ms)).then(() => waitTurn(site));
  times.push(now);
  recent.set(site, times);
  lastAt.set(site, now);
}

// 测试缝：真等 15 秒一条会把测试拖成几分钟，跑测试时关掉节流
const NO_RATE = process.env.MARKLAB_TEST_NORATE === '1';

function throttle(site) {
  if (NO_RATE) return Promise.resolve();
  const next = (lanes.get(site) || Promise.resolve()).then(() => waitTurn(site));
  lanes.set(site, next);
  return next;
}

// ── 用户主页：订阅某个作者发过的全部模型 ────────────────────────
// 四站的主页列表都能匿名取；MakerWorld 照旧只能走真浏览器。

/** 拉某个用户主页上的模型。站点失败给空结果，不拖垮整轮（和 search 一个口径）。 */
export async function userModels(site, uid, { page = 1, pageSize = 20 } = {}) {
  const id = String(uid || '').trim();
  const pack = sites.byName(site);
  // 别名（如 makeronline → makeronline.cn）要换回包的规范键：判重键是 `${platform}:${id}`，
  // 别名留在结果里就和库里的键对不上，同一模型会被当成没下载过再下一遍
  const base = { site: pack?.site || site, user: id, page, total: null, items: [] };
  if (!pack || !id) return base;
  await throttle(site);
  try {
    const r = await pack.userModels({ uid: id, page, pageSize });
    return { ...base, total: r.total ?? null, items: r.items };
  } catch (e) {
    console.error(`[user] ${site} ${id} 失败：${e.message}`);
    return { ...base, error: String(e.message || e).slice(0, 200) };
  }
}

/** 本站实际会用的排序键：不在声明里就回落该站默认序（site-pack.md §11.2）。
 *  纯函数，测试与调用方都能直接用；包里的 `SORT[sort] || 默认` 只当第二道保险。 */
export function sortOf(pack, sort) {
  const sorts = pack?.searchOptions?.sorts || [];
  return sorts.includes(sort) ? sort : (sorts[0] ?? null);
}

/** 某个站声明了哪些排序（控制台下拉、订阅规则校验都用它，别去 import 具体站点包）。 */
export function sortsOf(site) {
  return sites.byName(site)?.searchOptions?.sorts || [];
}

/** 订阅规则里的排序：不在该站能力里就回落该站默认序。 */
export function sortOfSite(site, sort) {
  return sortOf(sites.byName(site), sort);
}

/** 搜索一个站。返回统一形状；站点失败时给空结果，不拖垮整轮。 */
export async function search(site, keyword, { page = 1, sort = 'downloads', pageSize = 20 } = {}) {
  const kw = String(keyword || '').trim();
  const pack = sites.byName(site);
  const used = sortOf(pack, sort);
  if (pack && kw && used !== sort) console.warn(`[search] ${site} 不支持 sort=${sort}，按 ${used || '默认序'} 搜`);
  // total 拿不到就是 null：0 会被订阅当成「到底了」（site-pack.md §11.1）
  const base = { site: pack?.site || site, keyword: kw, page, sort: used, total: null, items: [] };
  if (!pack || !kw) return base;
  await throttle(site);
  try {
    const r = await pack.search({ keyword: kw, page, pageSize, ...(used ? { sort: used } : {}) });
    return { ...base, total: r.total ?? null, items: r.items };
  } catch (e) {
    // 调用方要能分清「搜到 0 条」和「搜索失败」——两者对订阅的含义完全不同
    console.error(`[search] ${site} 失败：${e.message}`);
    return { ...base, error: String(e.message || e).slice(0, 200) };
  }
}

// ── 自检：纯函数，不联网、不起浏览器 ────────────────────────────

function demo() {
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

  // 站点不支持的排序键回落该站默认序，不静默照传
  const fake = { searchOptions: { sorts: ['downloads', 'likes'] } };
  console.assert(sortOf(fake, 'likes') === 'likes', '支持就原样');
  console.assert(sortOf(fake, 'score') === 'downloads', '不支持回落第一项');
  console.assert(sortOf({ searchOptions: { sorts: [] } }, 'downloads') === null, '不声明排序就不带 sort');
  console.assert(sortOf(undefined, 'downloads') === null, '没有包也不炸');

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
    await ch.exit(0); // 关掉本进程开的标签页再退
  } else {
    demo();
    process.exit(0);
  }
}

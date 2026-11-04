// 站点搜索：统一 Item 形状 + 按站限速（ADR-0005 第 3 节）。
// 具体怎么搜在站点包里，这里只管限速、兜错、归一化。
import * as sites from './sites/index.mjs';
import { FILTERS } from './sites/contract.mjs';
import { siteConfigGet } from './tasks.mjs';
import * as ch from './channel.mjs';

// 默认进搜索/订阅的站点：站点包自己声明 discover（MakerOnline 的 .com 是同一个站的另一套账号，
// 不默认进，免得把搜索预算翻倍）。
export const SITES = sites.all().filter((p) => p.discover !== false).map((p) => p.site);
// 显式指定时允许的键（含别名），订阅校验用它
// 函数而不是常量：站点包是运行时可注册的（测试里会加假站点），常量会在 import 时就冻住
export const allSites = () => [...new Set(sites.all().flatMap((p) => [p.site, ...(p.aliases || [])]))];
export const RATE = { perSite: 10, windowMs: 60_000, minGapMs: 6_000 };

/** 某站的搜索配额：站点自定义的每分钟次数 > 全局默认。只配次数，最小间隔按均分推出来
 *  （10 次/分 → 6 秒；改限速只改 RATE.perSite 一个数，ADR-0008 §4）。 */
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
const lanes = new Map(); // site -> [{ priority, resolve }]，每站一条队列

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

/** 纯函数：往队里加一项。手动动作（priority）插到所有普通请求前面，同类先进先出。 */
export function enqueue(q, item) {
  if (!item.priority) {
    q.push(item);
    return q;
  }
  const at = q.findIndex((x) => !x.priority);
  q.splice(at === -1 ? q.length : at, 0, item);
  return q;
}

// 一次只放行一个，放行完才取下一条；队空就把这条队列删掉，别让 Map 长成垃圾场
async function drain(site, q) {
  while (q.length) {
    await waitTurn(site);
    q.shift().resolve();
  }
  if (lanes.get(site) === q) lanes.delete(site);
}

// 测试缝：真等 6 秒一条会把测试拖成几分钟，跑测试时关掉节流
const NO_RATE = process.env.MARKLAB_TEST_NORATE === '1';

/** 排队等这一站的放行。priority = 人手动点的搜索（聚合搜索），永远排下一个（ADR-0008 §5）。 */
function throttle(site, { priority = false } = {}) {
  if (NO_RATE) return Promise.resolve();
  let q = lanes.get(site);
  if (!q) {
    q = [];
    lanes.set(site, q);
  }
  const wait = new Promise((resolve) => enqueue(q, { priority, resolve }));
  if (q.length === 1) drain(site, q); // 队列本来是空的，立刻开工
  return wait;
}

// 站点接口没有自己的超时：卡住就是永远转圈，还占着这一站的闸门名额
const TIMEOUT_MS = 20_000;
function withTimeout(p, what) {
  let timer;
  const boom = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}超时（${TIMEOUT_MS / 1000} 秒）`)), TIMEOUT_MS);
  });
  return Promise.race([p, boom]).finally(() => clearTimeout(timer));
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
    const r = await withTimeout(pack.userModels({ uid: id, page, pageSize }), `${site} 作者主页`);
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

/** 搜索请求最终带哪个排序键：`null` = 不传，让站点给默认序（ADR-0008 §3）。
 *  纯函数：聚合搜索传 null 时这里必须原样给 null，别回落 sorts[0]——那是下拉框顺序，不是默认序。 */
export function resolveSort(pack, sort) {
  return sort == null ? null : sortOf(pack, sort);
}

/** 某个站声明了哪些排序（控制台下拉、订阅规则校验都用它，别去 import 具体站点包）。 */
export function sortsOf(site) {
  return sites.byName(site)?.searchOptions?.sorts || [];
}

/** 这个站的搜索结果带不带标签（tag 匹配能不能用）。 */
export function tagsOf(site) {
  return sites.byName(site)?.searchOptions?.tags === true;
}

/** 订阅规则里的排序：不在该站能力里就回落该站默认序。 */
export function sortOfSite(site, sort) {
  return sortOf(sites.byName(site), sort);
}

/** 纯函数：语义筛选 → 该站真支持的那部分（site-pack.md §11.4）。
 *  词表外的键/值、包没声明的值都丢掉，只记一行日志——筛选失效不该让订阅停摆。 */
export function filterFor(site, filters) {
  const declared = sites.byName(site)?.filters || {};
  const out = {};
  for (const [k, v] of Object.entries(filters || {})) {
    const why = !Object.hasOwn(FILTERS, k)
      ? `词表里没有 ${k}`
      : !FILTERS[k].includes(v)
        ? `${k}=${v} 不在词表`
        : !(declared[k] || []).includes(v)
          ? `${site} 不支持 ${k}=${v}`
          : null;
    if (why) {
      console.warn(`[filter] 丢掉 ${why}`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 某站声明了哪些榜单源（控制台下拉、订阅校验都用它）。 */
export function feedsOf(site) {
  return sites.byName(site)?.feeds || [];
}

/** 榜单取一页。形状与 search() 同构；站点失败给空页 + error，不拖垮整轮。 */
export async function feed(site, key, { page = 1, pageSize = 20 } = {}) {
  const pack = sites.byName(site);
  const base = { site: pack?.site || site, feed: key, page, total: null, items: [] };
  if (!pack || !feedsOf(site).some((f) => f.key === key)) return { ...base, error: `该站没有榜单 ${key}` };
  await throttle(site);
  try {
    const r = await withTimeout(pack.feed({ key, page, pageSize }), `${site} 榜单`);
    // total 一律不采信：榜单是站方的人工流，给 0 会被订阅当成「翻到底」提前收工（site-pack §11.5）
    return { ...base, items: r.items };
  } catch (e) {
    console.error(`[feed] ${site} ${key} 失败：${e.message}`);
    return { ...base, error: String(e.message || e).slice(0, 200) };
  }
}

/** 搜索一个站。返回统一形状；站点失败时给空结果，不拖垮整轮。
 *  `sort == null`（聚合搜索）= 按站点自己的默认序：不解析、不回落，原样透传（ADR-0008 §3）。
 *  `priority` = 人手动点的搜索，插到这一站队头。 */
export async function search(site, keyword, { page = 1, sort = null, pageSize = 20, filters, priority = false } = {}) {
  const kw = String(keyword || '').trim();
  const pack = sites.byName(site);
  const used = resolveSort(pack, sort);
  const clean = filterFor(site, filters);
  if (pack && kw && used !== sort) console.warn(`[search] ${site} 不支持 sort=${sort}，按 ${used || '默认序'} 搜`);
  // total 拿不到就是 null：0 会被订阅当成「到底了」（site-pack.md §11.1）
  const base = { site: pack?.site || site, keyword: kw, page, sort: used, total: null, items: [] };
  if (!pack || !kw) return base;
  await throttle(site, { priority });
  try {
    const r = await withTimeout(
      pack.search({
        keyword: kw,
        page,
        pageSize,
        ...(used ? { sort: used } : {}),
        ...(Object.keys(clean).length ? { filters: clean } : {}),
      }),
      `${site} 搜索`,
    );
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

  // 筛选：只留下词表里有、且该站声明过的值
  const ff = (site, f) => JSON.stringify(filterFor(site, f));
  console.assert(ff('creality', { color: 'multi' }) === '{"color":"multi"}', '声明过的值留下');
  console.assert(ff('creality', { color: 'rainbow' }) === '{}', '词表外的值丢掉');
  console.assert(ff('creality', { nope: 'x' }) === '{}', '词表外的键丢掉');
  console.assert(ff('creality', { badge: 'cyberbrick' }) === '{}', '词表有但该站没声明的值丢掉');
  console.assert(ff('no-such-site', { color: 'multi' }) === '{}', '未知站点不炸');
  console.assert(ff('creality', {}) === '{}' && ff('creality', undefined) === '{}', '没有筛选就是空对象');
  console.assert(ff('snapmaker', { color: 'multi', badge: 'picked' }) === '{"color":"multi"}', '只留该站支持的那部分');
  console.assert(feedsOf('makerworld').length === 0, '没声明 feeds 就是 []');

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

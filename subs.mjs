// 订阅：关键字 / 作者主页 + 站点 + 门槛条件，定时搜索，命中的自动入库（用户口径 Q4=B，ADR-0005）。
// 命中记录按订阅分文件追加写 data/subs/<id>.jsonl，永久保留。
import { readdir, readFile, mkdir, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJson, ROOT } from './lib.mjs';
import * as search from './search.mjs';
import * as tasks from './tasks.mjs';
import * as dup from './dup.mjs';
import * as stats from './stats.mjs';

const DATA = path.join(ROOT, 'data');
const FILE = path.join(DATA, 'subs.json');
const HIT_DIR = path.join(DATA, 'subs');

// 任务「还没跑完」的几个阶段（tasks.mjs 用的是 phase，不是 status）
const ACTIVE = new Set(['queued', 'fetching', 'parsing', 'downloading']);

export const DEFAULTS = {
  keywords: [],
  users: [], // [{site, id, name}]：订阅某个作者主页上的模型
  sites: ['creality', 'makerworld', 'snapmaker', 'makeronline'],
  minLikes: 0,
  minDownloads: 0,
  pickedOnly: false,
  excludeInLibrary: true,
  sort: 'downloads', // downloads（下载量）| newest（发布时间）
  pageLimit: 1,
  roundLimit: 50,
  intervalHours: 8,
  cursor: 0, // 上一轮跑到第几个「站点 × 关键字」，下轮接着跑
  enabled: true,
};

/** 纯函数：该不该跑了。intervalHours 变了立刻生效，不用重启。 */
export function isDue(sub, now = Date.now()) {
  if (!sub.enabled) return false;
  if (!sub.lastRunAt) return true;
  const at = Date.parse(sub.lastRunAt);
  if (!Number.isFinite(at)) return true;
  return now - at >= Math.max(0.1, Number(sub.intervalHours) || 8) * 3600_000;
}

/** 纯函数：一条搜索结果过不过门槛。 */
export function passes(item, sub) {
  if (Number(item.likes || 0) < Number(sub.minLikes || 0)) return false;
  if (Number(item.downloads || 0) < Number(sub.minDownloads || 0)) return false;
  if (sub.pickedOnly && !item.picked) return false;
  return true;
}

/** 纯函数：排序。只对同一批已取回的结果生效。 */
export function sortItems(items, sort) {
  const score = (i) => Number(i.downloads || 0) + Number(i.likes || 0);
  const out = [...items];
  if (sort === 'newest') {
    out.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  } else {
    out.sort((a, b) => score(b) - score(a));
  }
  return out;
}

let cache = null;

export async function load(force = false) {
  if (cache && !force) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    cache = { subs: [] };
  }
  cache.subs ||= [];
  return cache;
}

async function persist() {
  await mkdir(DATA, { recursive: true });
  await writeJson(FILE, cache);
}

export async function list() {
  return (await load()).subs;
}

export async function get(id) {
  return (await load()).subs.find((s) => s.id === id) || null;
}

const cleanKeywords = (v) => [...new Set((Array.isArray(v) ? v : []).map((k) => String(k).trim()).filter(Boolean))];

/** 用户主页：字符串按网址解析（前端只传链接），对象原样收；认不出就报错，别静默丢。 */
function cleanUsers(input) {
  if (!Array.isArray(input)) return [];
  return input.map((u) => {
    if (typeof u === 'string') {
      const p = search.parseUserUrl(u);
      if (!p) throw new Error(`认不出这个用户主页：${u}`);
      return { site: p.site, id: p.id, name: '' };
    }
    if (!u || !search.SITES.includes(u.site) || !String(u.id || '').trim()) throw new Error('用户主页格式不对');
    return { site: u.site, id: String(u.id).trim(), name: String(u.name || '').trim() };
  });
}

export async function create(input = {}) {
  const all = await load();
  const sub = {
    ...DEFAULTS,
    ...input,
    keywords: cleanKeywords(input.keywords),
    users: cleanUsers(input.users),
    sites: (input.sites || DEFAULTS.sites).filter((s) => search.allSites().includes(s)),
    id: `s_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
  };
  if (!sub.users.length && (!sub.keywords.length || !sub.sites.length)) throw new Error('订阅至少要一个关键字或一个用户主页');
  all.subs.push(sub);
  await persist();
  return sub;
}

export async function update(id, patch = {}) {
  const sub = await get(id);
  if (!sub) throw new Error('没有这个订阅');
  const next = { ...sub, ...patch, id: sub.id };
  if (Array.isArray(patch.keywords)) next.keywords = cleanKeywords(patch.keywords);
  if (Array.isArray(patch.users)) next.users = cleanUsers(patch.users);
  if (Array.isArray(patch.sites)) next.sites = patch.sites.filter((s) => search.allSites().includes(s));
  if (!(next.users || []).length && (!(next.keywords || []).length || !next.sites.length)) throw new Error('订阅至少要一个关键字或一个用户主页');
  Object.assign(sub, next);
  await persist();
  return sub;
}

/** 一次把全部订阅开/关：一轮只写一次盘，别让 15 条并发各写一遍。 */
export async function setAllEnabled(enabled) {
  const all = await load();
  for (const s of all.subs) s.enabled = !!enabled;
  await persist();
  return all.subs;
}

export async function remove(id) {
  const all = await load();
  const i = all.subs.findIndex((s) => s.id === id);
  if (i < 0) return false;
  all.subs.splice(i, 1);
  await persist();
  return true;
}

async function appendHits(id, hits) {
  await mkdir(HIT_DIR, { recursive: true });
  const lines = hits.map((h) => JSON.stringify(h)).join('\n');
  await appendFile(path.join(HIT_DIR, `${id}.jsonl`), lines + '\n');
}

/** 读某个订阅的全部命中（新的在前）。 */
export async function hits(id, limit = 200) {
  // 订阅 id 只由 create() 生成（s_xxxxxxxx）；放行 ../ 就能读 data/ 下任何 jsonl
  if (!/^[\w-]+$/.test(id || '')) return [];
  try {
    const text = await readFile(path.join(HIT_DIR, `${id}.jsonl`), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** 所有订阅的命中按时间倒序合成一条流，控制台的「运行日志」页用。 */
export async function allHits(limit = 200) {
  const rows = [];
  for (const s of await list()) {
    for (const h of await hits(s.id, limit)) rows.push({ ...h, subId: s.id, subName: s.name });
  }
  return rows.sort((a, b) => String(b.matchedAt).localeCompare(String(a.matchedAt))).slice(0, limit);
}

// 一次「一个词 × 一个站」大约要 15 秒（最小间隔）+ 开销；预算按这个估，宁少不超
const JOB_MS = 25_000;

/** 本轮能跑多久：间隔的六成留给搜索，剩下四成留给下载（下载自己还有 60–120 秒闸门）。 */
export function budgetMs(sub) {
  const hours = Number(sub.intervalHours) || 8;
  return Math.max(60_000, hours * 3600_000 * 0.6);
}

/** 一轮要跑的活：先「站点 × 关键字」，再「作者主页」。cursor 记着跑到第几个，下轮接着跑。 */
export function planJobs(sub) {
  const jobs = [];
  for (const site of sub.sites || []) for (const kw of sub.keywords || []) jobs.push({ site, kw });
  for (const u of sub.users || []) jobs.push({ site: u.site, user: u });
  return jobs;
}

const running = new Set(); // 同一订阅同时只跑一轮（连点两次「立即跑」不会并发打站点）

/** 跑一轮订阅。命中的自动入队入库（全局串行，下载间隔照旧 60–120 秒）。 */
export async function run(id, { clock = Date.now } = {}) {
  if (running.has(id)) throw new Error('这个订阅正在跑，等它跑完再点');
  running.add(id);
  try {
    return await runOnce(id, clock);
  } finally {
    running.delete(id);
  }
}

async function runOnce(id, clock) {
  const sub = await get(id);
  if (!sub) throw new Error('没有这个订阅');
  const startedAt = new Date().toISOString();
  // 库随时在变（别的进程也在抓）：每轮重建索引，否则 excludeInLibrary 永远看到旧库
  const libKeys = sub.excludeInLibrary ? (await dup.index(true)).keys : new Set();
  // 已在排队/在跑的别再排一遍：一轮跑完前它是「已命中」状态
  const busy = new Set(
    tasks
      .list({ limit: 1000 })
      .filter((t) => ACTIVE.has(t.phase))
      .map((t) => t.url),
  );

  const seen = new Set();
  const matched = [];
  let searched = 0;
  const errors = [];
  const pages = Math.max(1, Number(sub.pageLimit) || 1);
  const at = () => new Date().toISOString();

  const jobs = planJobs(sub);
  // 上一轮没跑完就从上次停的地方接着跑，不从头再来（不然永远只搜前几个词）
  const from = Math.min(Math.max(0, Number(sub.cursor) || 0), jobs.length);
  const budget = budgetMs(sub);
  const t0 = clock();
  let next = from;

  const take = (item, extra) => {
    const key = `${item.site}:${item.id}`;
    if (seen.has(key)) return;
    if (!passes(item, sub)) return;
    if (libKeys.has(key)) return;
    if (busy.has(item.url)) return;
    seen.add(key);
    matched.push({ ...item, ...extra, matchedAt: at() });
  };

  for (; next < jobs.length; next++) {
    if (!sub.enabled) break; // 停用后不再开新活：在跑的这轮到此为止
    if (clock() - t0 > budget) break; // 时间到：剩下的下轮接着跑
    const job = jobs[next];
    sub.progress = { kw: job.kw || `@${job.user?.id || ''}`, site: job.site, searched, planned: jobs.length, from };
    await persist();
    for (let page = 1; page <= pages; page++) {
      const r = job.user
        ? await search.userModels(job.site, job.user.id, { page })
        : await search.search(job.site, job.kw, { page, sort: sub.sort });
      searched++;
      if (r.error) {
        // 搜索失败 ≠ 搜到 0 条：记下来，别当成「后面更空」直接收工
        errors.push(`${job.site}${job.kw ? `「${job.kw}」` : ''}：${r.error}`);
        break;
      }
      for (const item of r.items) {
        take(item, job.user ? { user: job.user.name || job.user.id } : { keyword: job.kw });
      }
      if (!r.items.length) break; // 这一页真的空了，后面更空
    }
  }

  const stopped = !sub.enabled; // 跑到一半被点「停止」：已搜到的照记历史，但不再往库里塞
  const ordered = sortItems(matched, sub.sort);
  const limit = Math.max(1, Number(sub.roundLimit) || 50);
  const truncated = Math.max(0, ordered.length - limit);
  const queued = ordered.slice(0, limit);

  let lastError = errors.length ? `搜索失败 ${errors.length} 次：${errors.slice(0, 2).join('；')}` : null;

  if (!stopped && queued.length) {
    // 磁盘不够就别排了：写一半失败比没排更糟（同一道闸门，手动入队也走它）
    const free = await stats.freeSpace();
    if (free != null && free < 5 * 1024 ** 3) {
      lastError = `磁盘不足：只剩 ${(free / 1024 ** 3).toFixed(1)} GB，本轮不排队`;
    } else {
      for (const hit of queued) {
        const { task } = await tasks.enqueue({ url: hit.url, source: 'subscribe', subId: sub.id });
        hit.taskId = task.id;
      }
    }
  }
  if (queued.length) await appendHits(sub.id, queued);

  // 跑到哪了：下轮从 next 接着跑；跑到头就归零，下一轮重新扫一遍
  sub.cursor = next >= jobs.length ? 0 : next;
  delete sub.progress;
  sub.lastRunAt = new Date().toISOString();
  sub.lastResult = {
    at: sub.lastRunAt,
    startedAt,
    searched,
    matched: queued.length,
    truncated,
    stopped,
    jobs: jobs.length,
    from,
    cursor: sub.cursor,
  };
  if (lastError) sub.lastResult.error = lastError;
  await persist();

  return { sub, hits: queued, truncated, searched };
}

/** 服务端定时器每分钟调一次：到点的订阅挨个跑（订阅之间也串行，别和下载抢带宽）。 */
let ticking = false;
export async function tick(now = Date.now()) {
  if (ticking) return [];
  ticking = true;
  const ran = [];
  try {
    // 别的进程（ipwatch / 手工改文件）可能刚写过 subs.json：每轮重读一次
    await load(true);
    for (const sub of await list()) {
      if (!isDue(sub, now)) continue;
      try {
        ran.push(await run(sub.id));
      } catch (e) {
        delete sub.progress;
        sub.lastRunAt = new Date().toISOString();
        sub.lastResult = { at: sub.lastRunAt, error: String(e.message || e).slice(0, 200) };
        await persist();
        ran.push({ sub, error: sub.lastResult.error });
      }
    }
  } finally {
    ticking = false;
  }
  return ran;
}

/** 每个订阅的待处理数：排队中 + 在跑。控制台首页要显示这个。 */
export async function pending() {
  const active = tasks.list({ limit: 1000 }).filter((t) => t.source === 'subscribe' && ACTIVE.has(t.phase));
  const bySub = {};
  for (const t of active) bySub[t.subId || 'unknown'] = (bySub[t.subId || 'unknown'] || 0) + 1;
  return { total: active.length, bySub };
}

// 自检：纯函数，不联网。
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'subs.mjs') {
  const now = Date.parse('2026-10-29T12:00:00Z');
  console.assert(isDue({ enabled: true, intervalHours: 4, lastRunAt: null }, now) === true, '没跑过就该跑');
  console.assert(isDue({ enabled: false, lastRunAt: null }, now) === false, '关掉的不跑');
  console.assert(isDue({ enabled: true, intervalHours: 4, lastRunAt: '2026-10-29T09:00:00Z' }, now) === false, '才 3 小时不该跑');
  console.assert(isDue({ enabled: true, intervalHours: 4, lastRunAt: '2026-10-29T07:00:00Z' }, now) === true, '5 小时该跑');
  console.assert(isDue({ enabled: true, intervalHours: 0.1, lastRunAt: '2026-10-29T11:50:00Z' }, now) === true, '6 分钟到点');

  const sub = { minLikes: 10, minDownloads: 100, pickedOnly: true };
  console.assert(passes({ likes: 10, downloads: 100, picked: true }, sub) === true, '刚好达标应过');
  console.assert(passes({ likes: 9, downloads: 999, picked: true }, sub) === false, '点赞不够应拦');
  console.assert(passes({ likes: 99, downloads: 99, picked: true }, sub) === false, '下载不够应拦');
  console.assert(passes({ likes: 99, downloads: 999, picked: false }, sub) === false, '不精选应拦');
  console.assert(passes({ likes: 0, downloads: 0, picked: false }, {}) === true, '没门槛就都过');

  const items = [
    { id: 'a', downloads: 10, likes: 5, publishedAt: '2026-10-01T00:00:00Z' },
    { id: 'b', downloads: 100, likes: 1, publishedAt: '2026-10-29T00:00:00Z' },
    { id: 'c', downloads: 0, likes: 0, publishedAt: null },
  ];
  console.assert(sortItems(items, 'downloads')[0].id === 'b', '按下载+点赞排');
  console.assert(sortItems(items, 'newest')[0].id === 'b', '按时间排');
  console.assert(items[0].id === 'a', 'sortItems 不该改原数组');

  console.log('subs demo ok');
  process.exit(0);
}

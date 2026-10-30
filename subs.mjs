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
    sites: (input.sites || DEFAULTS.sites).filter((s) => search.ALL_SITES.includes(s)),
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
  if (Array.isArray(patch.sites)) next.sites = patch.sites.filter((s) => search.ALL_SITES.includes(s));
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

/** 跑一轮订阅。命中的自动入队入库（全局串行，下载间隔照旧 60–150 秒）。 */
export async function run(id) {
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
  const pages = Math.max(1, Number(sub.pageLimit) || 1);
  const at = () => new Date().toISOString();

  // 一轮几十词要跑半小时，不落进度就只能干等：每词写一次，控制台/`ipwatch --status` 看得见跑到哪
  const planned = sub.sites.length * sub.keywords.length * pages;
  for (const site of sub.sites) {
    for (const kw of sub.keywords) {
      if (!sub.enabled) break; // 停用后不再开新词：在跑的这轮到此为止，不再产出命中
      sub.progress = { kw, site, searched, planned };
      await persist();
      for (let page = 1; page <= pages; page++) {
        const r = await search.search(site, kw, { page, sort: sub.sort });
        searched++;
        for (const item of r.items) {
          const key = `${item.site}:${item.id}`;
          if (seen.has(key)) continue;
          if (!passes(item, sub)) continue;
          if (libKeys.has(key)) continue;
          if (busy.has(item.url)) continue;
          seen.add(key);
          matched.push({ ...item, keyword: kw, matchedAt: at() });
        }
        if (!r.items.length) break; // 这一页空了，后面更空
      }
    }
  }

  // 用户主页：主页上的全部模型，门槛/去重口径和关键字完全一样
  for (const u of sub.users || []) {
    if (!sub.enabled) break;
    for (let page = 1; page <= pages; page++) {
      const r = await search.userModels(u.site, u.id, { page });
      searched++;
      for (const item of r.items) {
        const key = `${item.site}:${item.id}`;
        if (seen.has(key)) continue;
        if (!passes(item, sub)) continue;
        if (libKeys.has(key)) continue;
        if (busy.has(item.url)) continue;
        seen.add(key);
        matched.push({ ...item, user: u.name || u.id, matchedAt: at() });
      }
      if (!r.items.length) break;
    }
  }

  let lastError = null;
  const stopped = !sub.enabled; // 跑到一半被点「停止」：已搜到的照记历史，但不再往库里塞
  const ordered = sortItems(matched, sub.sort);
  const limit = Math.max(1, Number(sub.roundLimit) || 50);
  const truncated = Math.max(0, ordered.length - limit);
  const take = ordered.slice(0, limit);

  if (!stopped && take.length) {
    // 磁盘不够就别排了：写一半失败比没排更糟（同一道闸门，手动入队也走它）
    const free = await stats.freeSpace();
    if (free != null && free < 5 * 1024 ** 3) {
      lastError = `磁盘不足：只剩 ${(free / 1024 ** 3).toFixed(1)} GB，本轮不排队`;
    } else {
      for (const hit of take) {
        const { task } = await tasks.enqueue({ url: hit.url, source: 'subscribe', subId: sub.id });
        hit.taskId = task.id;
      }
    }
  }
  if (take.length) await appendHits(sub.id, take);

  delete sub.progress;
  sub.lastRunAt = new Date().toISOString();
  sub.lastResult = { at: sub.lastRunAt, startedAt, searched, matched: take.length, truncated, stopped };
  if (lastError) sub.lastResult.error = lastError;
  await persist();

  return { sub, hits: take, truncated, searched };
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

// 订阅：关键字订阅 / 作者订阅（二选一，spec §6.2），定时搜索，命中的自动入队入库。
// 一轮拆两段：搜索（联网、吃限速）→ 候选判定（纯本地）。命中记录追加写 data/subs/<id>.jsonl。
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJson, ROOT } from './lib.mjs';
import * as events from './events.mjs';
import * as search from './search.mjs';
import * as tasks from './tasks.mjs';
import * as dup from './dup.mjs';
import * as stats from './stats.mjs';

const DATA = path.join(ROOT, 'data');
const FILE = path.join(DATA, 'subs.json');
const HIT_DIR = path.join(DATA, 'subs');

// 任务「还没跑完」的几个阶段（tasks.mjs 用的是 phase，不是 status）
const ACTIVE = new Set(['queued', 'fetching', 'parsing', 'downloading']);

const PAGE = 20; // 站点搜索一页 20 条（site-pack.md）
const AUTHOR_STOP = 20; // 作者订阅：连续一页都在库里就停（spec §6.2「作者订阅的增量」）
const CAND_DAYS = 30; // 候选 30 天没再出现就清
export const MATCH_MODES = ['name', 'tag'];
const KIND_NAME = { author: '作者订阅', feed: '榜单订阅', keyword: '关键字订阅' };

export const DEFAULTS = {
  kind: 'keyword', // 'keyword' | 'author' | 'feed'，三选一，不靠列表空不空推断
  keywords: [],
  users: [], // [{site, id, name}]
  rules: [], // [{site, sort, limit, filters}]：站点 + 排序 + 筛选 + 前 N 条（原始结果条数）
  feeds: [], // [{site, feed, limit}]：榜单订阅专用（站点 + 榜单源 key + 前 N 条）
  matchModes: ['name'], // name / tag，任一命中即算
  minLikes: 0,
  minDownloads: 0,
  pickedOnly: false,
  intervalHours: 8,
  cursor: 0, // 上一轮跑到第几个任务，下轮接着跑
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

/** 纯函数：一条搜索结果过不过门槛（只关键字订阅有门槛）。 */
export function passes(item, sub) {
  if (Number(item.likes || 0) < Number(sub.minLikes || 0)) return false;
  if (Number(item.downloads || 0) < Number(sub.minDownloads || 0)) return false;
  if (sub.pickedOnly && !item.picked) return false;
  return true;
}

export const candidateKey = (site, id) => `${site}:${id}`;

/** 纯函数：这条候选是不是这一轮该入队的那个模型。
 *  sources[] 是同一次搜索里撞上的全部来源（跨站合并过），按 MakerWorld 优先排好。 */
export function pickPrimary(sources = []) {
  const rank = (s) => (s.site === 'makerworld' ? -1 : 0);
  return [...sources].sort((a, b) => rank(a) - rank(b) || Number(a.rank || 0) - Number(b.rank || 0))[0] || null;
}

/** 纯函数：四道闸。返回 decision（queued = 该入队）。
 *  ctx = { libKeys: Set<`site:id`>, busy: Set<url> } */
export function decide(cand, sub, ctx = {}) {
  const libKeys = ctx.libKeys || new Set();
  const busy = ctx.busy || new Set();
  const sources = cand.sources || [];
  if (sources.some((s) => libKeys.has(candidateKey(s.site, s.id)))) return 'in-library';
  if (sources.some((s) => busy.has(s.url))) return 'in-queue';
  if (sub.kind === 'author') return 'queued'; // 作者订阅：他发的我都要，没有门槛也没有匹配
  if (!passes(cand, sub)) return 'threshold';
  const modes = (sub.matchModes || ['name']).filter((m) => MATCH_MODES.includes(m));
  const wantName = modes.includes('name');
  const wantTag = modes.includes('tag');
  const hit = sources.some((s) => {
    const kw = dup.normText(s.kw);
    if (!kw) return false;
    const name = () => dup.normText(cand.title).includes(kw);
    // tag 只用搜索结果自带的标签，不打开详情页（spec §6.2 实测：开详情页换 0 命中）
    const tag = () => (cand.tags || []).some((t) => dup.normText(t).includes(kw));
    // 该站搜索结果不带标签（创想云 / MakerOnline）：tag 那道退回用名字判，不算失败
    if (wantTag && !search.tagsOf(s.site)) return name();
    return (wantName && name()) || (wantTag && tag());
  });
  return hit ? 'queued' : 'no-match';
}

/** 纯函数：把搜索来的原始结果合成候选——先按 site:id，再按「标题+作者」跨站合并。
 *  先排序再合并：四站并行，到达顺序不定，不排序的话「合并键取先到那个」每轮都会变，
 *  台账里同一个模型就会长出两行、firstSeen 反复重置。 */
export function mergeSources(items) {
  const out = new Map(); // 合并键 -> 候选
  const byMeta = new Map(); // metaKey -> 合并键
  const sorted = [...items].sort((a, b) => (candidateKey(a.site, a.id) < candidateKey(b.site, b.id) ? -1 : 1));
  for (const it of sorted) {
    const key = candidateKey(it.site, it.id);
    const mk = dup.metaKey(it.title, it.author);
    const merged = (mk && byMeta.get(mk)) || key;
    let cand = out.get(merged);
    if (!cand) {
      cand = { key: merged, title: it.title, author: it.author, tags: [], sources: [] };
      out.set(merged, cand);
      if (mk) byMeta.set(mk, merged);
    }
    cand.sources.push({ site: it.site, id: it.id, url: it.url, rank: it.rank, kw: it.kw, rule: it.rule });
    for (const t of it.tags || []) if (!cand.tags.includes(t)) cand.tags.push(t);
    // 数值取「主来源」那份，入队也用它，展示和判定才一致
    const primary = pickPrimary(cand.sources);
    if (primary && primary.id === it.id && primary.site === it.site) {
      cand.likes = it.likes;
      cand.downloads = it.downloads;
      cand.picked = it.picked;
      cand.publishedAt = it.publishedAt;
    }
  }
  for (const cand of out.values()) cand.sources = [...cand.sources].sort((a, b) => (a.site === 'makerworld' ? -1 : 0) - (b.site === 'makerworld' ? -1 : 0) || a.rank - b.rank);
  return [...out.values()];
}

/** 老订阅（只有 sites[]，没有 rules[]）→ 按站逐站生成一条规则。spec §6.2「迁移」。 */
export function migrateSub(sub) {
  if (sub.kind !== 'author' && !Array.isArray(sub.rules) && Array.isArray(sub.sites)) {
    const limit = Math.max(1, Number(sub.pageLimit) || 1) * PAGE;
    sub.rules = sub.sites.map((site) => ({ site, sort: search.sortOfSite(site, sub.sort) || null, limit }));
    sub.matchModes = ['name'];
    sub.kind = 'keyword';
  }
  // 老数据没有 kind 仍按 keyword；没有 feeds 补 []（新字段，老订阅不该因此崩）
  if (!sub.kind) sub.kind = 'keyword';
  if (!Array.isArray(sub.feeds)) sub.feeds = [];
  delete sub.sites;
  delete sub.sort;
  delete sub.pageLimit;
  delete sub.roundLimit;
  return sub;
}

let cache = null;

export async function load(force = false) {
  if (cache && !force) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    cache = { subs: [] };
  }
  cache.subs = (cache.subs || []).map(migrateSub);
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
      return { site: p.site, id: p.id, name: '', url: u };
    }
    // 用 allSites() 而不是 SITES：SITES 在 import 时就冻住了，运行期注册的站点（测试假站点）认不出来
    if (!u || !search.allSites().includes(u.site) || !String(u.id || '').trim()) throw new Error('用户主页格式不对');
    return { site: u.site, id: String(u.id).trim(), name: String(u.name || '').trim(), url: String(u.url || '').trim() };
  });
}

/** 候选规则：站点 + 排序 + 筛选 + 前 N 条。排序不在该站能力里就回落该站默认序（不报错，UI 里本来就不出现）。
 *  筛选同理：站点不支持的值直接丢掉（search.filterFor 会记一行日志），订阅照跑。 */
export function cleanRules(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((r) => {
      const site = String(r?.site || '').trim();
      if (!search.allSites().includes(site)) throw new Error(`规则里的站点不认识：${site}`);
      const limit = clampLimit(r?.limit);
      const filters = search.filterFor(site, r?.filters);
      return { site, sort: search.sortOfSite(site, r?.sort) || null, limit, filters: Object.keys(filters).length ? filters : null };
    })
    .filter(Boolean);
}

/** 榜单订阅的榜单行：站点 + 榜单源 + 前 N 条。站点/榜单源认不出、limit 不合法 → 丢掉这一行。 */
export function cleanFeeds(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((f) => {
      const site = String(f?.site || '').trim();
      const feed = String(f?.feed || '').trim();
      if (!search.allSites().includes(site)) return null;
      if (!search.feedsOf(site).some((x) => x.key === feed)) return null;
      return { site, feed, limit: clampLimit(f?.limit) };
    })
    .filter(Boolean);
}

// 前 N 条：1–1000，没给就一页（站点一页 20 条）
const clampLimit = (v) => Math.min(1000, Math.max(1, Math.round(Number(v) || PAGE)));

const cleanModes = (v) => [...new Set((Array.isArray(v) ? v : []).map((m) => String(m).trim()).filter((m) => MATCH_MODES.includes(m)))];

/** 纯函数：一条订阅 → 这一轮要跑的任务（关键字 × 规则，作者主页，或一条榜单）。 */
export function planJobs(sub) {
  if (sub.kind === 'author') return (sub.users || []).map((u) => ({ kind: 'author', site: u.site, user: u }));
  if (sub.kind === 'feed') return (sub.feeds || []).map((f) => ({ kind: 'feed', site: f.site, feed: f.feed, limit: f.limit }));
  const jobs = [];
  for (const rule of sub.rules || []) for (const kw of sub.keywords || []) jobs.push({ kind: 'keyword', site: rule.site, kw, rule });
  return jobs;
}

/** 作者/榜单订阅都不做匹配：没有来源词要配、也没有门槛可量。 */
function noMatch(next) {
  next.matchModes = [];
  next.minLikes = 0;
  next.minDownloads = 0;
  next.pickedOnly = false;
}

/** 校验 + 补默认值。kind 决定哪些字段算数，另一边的残留一律清掉。 */
function shape(input, prev = {}) {
  const next = { ...DEFAULTS, ...prev, ...input };
  // kind 只认显式声明（spec §6.2）：老数据由 migrateSub 补成 keyword，这里不按列表空不空推断
  next.kind = input.kind ?? prev.kind ?? 'keyword';
  if (!['keyword', 'author', 'feed'].includes(next.kind)) throw new Error('订阅类型只能是 keyword、author 或 feed');
  next.keywords = cleanKeywords(next.keywords);
  next.users = cleanUsers(next.users);
  next.rules = cleanRules(next.rules);
  next.feeds = cleanFeeds(next.feeds);
  next.matchModes = cleanModes(next.matchModes);
  if (next.kind === 'author') {
    if (!next.users.length) throw new Error('作者订阅至少要一个用户主页');
    next.keywords = [];
    next.rules = [];
    next.feeds = [];
    noMatch(next);
  } else if (next.kind === 'feed') {
    if (!next.feeds.length) throw new Error('榜单订阅至少要一行（站点 + 榜单 + 前 N 条）');
    next.keywords = [];
    next.users = [];
    next.rules = [];
    noMatch(next);
  } else {
    if (!next.keywords.length) throw new Error('关键字订阅至少要一个关键字');
    if (!next.rules.length) throw new Error('关键字订阅至少要一条候选规则（站点 + 排序 + 前 N 条）');
    if (!next.matchModes.length) throw new Error('关键字订阅至少要一种匹配方式（按名字 / 按标签）');
    next.users = [];
    next.feeds = [];
  }
  return next;
}

export async function create(input = {}) {
  const all = await load();
  const sub = {
    ...shape(input),
    id: `s_${randomUUID().slice(0, 8)}`,
    name: String(input.name || '').trim() || KIND_NAME[input.kind] || '关键字订阅',
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastResult: null,
  };
  // 作者游标：首次全量翻不完就从这页接着翻，翻到底才置 done（spec §6.2「作者订阅的增量」）
  if (sub.kind === 'author') sub.authorCursor = Object.fromEntries(sub.users.map((u) => [`${u.site}:${u.id}`, { page: 1, done: false }]));
  all.subs.push(sub);
  await persist();
  return sub;
}

export async function update(id, patch = {}) {
  const sub = await get(id);
  if (!sub) throw new Error('没有这个订阅');
  const next = { ...shape(patch, sub), id: sub.id, createdAt: sub.createdAt };
  if (patch.name !== undefined) next.name = String(patch.name).trim() || sub.name;
  // 词表或规则一改，cursor 的序号就错位了：从头跑
  const reshaped = ['kind', 'keywords', 'users', 'rules'].some((k) => patch[k] !== undefined);
  if (reshaped) next.cursor = 0;
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

const safeId = (id) => /^[\w-]+$/.test(id || ''); // 订阅 id 只由 create() 生成；放行 ../ 就能读 data/ 下任何文件

async function appendHits(id, hits) {
  await mkdir(HIT_DIR, { recursive: true });
  const lines = hits.map((h) => JSON.stringify(h)).join('\n');
  await appendFile(path.join(HIT_DIR, `${id}.jsonl`), lines + '\n');
}

/** 读某个订阅的全部命中（新的在前）。 */
export async function hits(id, limit = 200) {
  if (!safeId(id)) return [];
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

/** 候选台账里已判定「进队」的条数——首页悬浮栏那个数字。
 *  shortcut: 滞后一轮（decision 是上一轮跑完时算的，读的时候不重判）, 要实时就改成读时重判。 */
export async function candidatesQueued() {
  let n = 0;
  for (const s of await list()) for (const c of (await candidates(s.id)).items) if (c.decision === 'queued') n++;
  return n;
}

/** 候选清单：`{ items: [{ key, sources, title, author, tags, decision, firstSeen, lastSeen }] }` */
export async function candidates(id) {
  if (!safeId(id)) return { items: [] };
  try {
    const j = JSON.parse(await readFile(path.join(HIT_DIR, `${id}.candidates.json`), 'utf8'));
    return { items: Array.isArray(j.items) ? j.items : [] };
  } catch {
    return { items: [] };
  }
}

/** 本轮能跑多久：间隔的六成留给搜索，剩下四成留给下载（下载自己还有 60–120 秒闸门）。 */
export function budgetMs(sub) {
  const hours = Number(sub.intervalHours) || 8;
  return Math.max(60_000, hours * 3600_000 * 0.6);
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
  // 库里有没有：候选来了才读它自己那个目录，不扫全库（spec §6.2「不建索引、不批量重建」）。
  // 没下到文件的空壳不算入库，它得能再抓一次。
  const libKeys = dup.libChecker();
  // 已在排队/在跑的别再排一遍。按 url 比是够的：url 由站点包按 id 重组，真重复了入库那步还有兜底。
  const busy = new Set(
    tasks
      .list({ limit: 1000 })
      .filter((t) => ACTIVE.has(t.phase))
      .map((t) => t.url),
  );

  const jobs = planJobs(sub);
  const from = Math.min(Math.max(0, Number(sub.cursor) || 0), jobs.length);
  const budget = budgetMs(sub);
  const t0 = clock();
  const errors = [];
  const done = new Set(); // 这一轮跑完的任务下标
  let searched = 0;

  const raw = []; // 关键字订阅的原始结果，留给候选调度器
  const hitsFound = []; // 作者订阅直接判定完的结果

  // ── 订阅任务调度器：每站一个运行器，先进先出，吃各站自己的搜索配额 ──
  const groups = new Map();
  for (let i = from; i < jobs.length; i++) {
    const job = jobs[i];
    if (!groups.has(job.site)) groups.set(job.site, []);
    groups.get(job.site).push({ ...job, i });
  }
  await Promise.all(
    [...groups].map(async ([site, list]) => {
      for (const job of list) {
        if (!sub.enabled || clock() - t0 > budget) return; // 停用或到点：剩下的下轮接着跑
        // 进度条上显示这一轮在跑什么：关键字 / @作者 / 站点·榜单源
        const what = job.kw || (job.user ? `@${job.user.name || job.user.id}` : `${job.site}/${job.feed}`);
        sub.progress = { kw: what, site, searched, planned: jobs.length, from };
        const limit = Math.max(1, Number(job.rule?.limit ?? job.limit) || PAGE);
        // 榜单订阅：跟作者订阅一样只过库/队列两道闸，但不翻到底——收满 limit 条就停
        if (job.kind === 'feed') {
          let taken = 0;
          for (let page = 1; taken < limit; page++) {
            if (!sub.enabled || clock() - t0 > budget) return;
            const r = await search.feed(site, job.feed, { page });
            searched++;
            if (r.error) {
              errors.push(`${site}「${job.feed}」：${r.error}`);
              break;
            }
            if (!r.items.length) break; // 这股流翻到底了
            for (const item of r.items) {
              if (taken >= limit) break; // 硬上限：不凑整页
              taken++;
              if (libKeys.has(candidateKey(item.site, item.id)) || busy.has(item.url)) continue;
              hitsFound.push({ ...item, feed: job.feed, matchedAt: new Date().toISOString() });
            }
          }
          done.add(job.i);
          continue;
        }
        // 作者订阅的页码游标：首次全量翻不完就接着翻，翻到底才启用「连续 20 条就停」
        const ukey = job.kind === 'author' ? `${site}:${job.user.id}` : null;
        const ac = ukey ? ((sub.authorCursor ||= {})[ukey] ||= { page: 1, done: false }) : null;
        let stale = 0; // 作者订阅：连续多少条已在库里或队列里
        for (let page = ac?.done ? 1 : (ac?.page ?? 1); ; page++) {
          if (!sub.enabled || clock() - t0 > budget) return;
          if (!ac && page > Math.ceil(limit / PAGE)) break; // 前 N 条是硬上限，不许凑整页
          if (ac && !ac.done) ac.page = page; // 这一页没跑完就还从这页开始
          const r = job.kind === 'author' ? await search.userModels(site, job.user.id, { page }) : await search.search(site, job.kw, { page, sort: job.rule.sort, filters: job.rule.filters });
          searched++;
          if (r.error) {
            // 搜索失败 ≠ 搜到 0 条：记下来，别当成「后面更空」直接收工
            errors.push(`${site}${job.kw ? `「${job.kw}」` : ''}：${r.error}`);
            break;
          }
          if (!r.items.length) {
            if (ac) {
              ac.done = true; // 翻到底了，下一轮起走增量
              ac.page = 1;
            }
            break; // 这一页真的空了，后面更空
          }
          r.items.forEach((item, idx) => {
            const rank = (page - 1) * PAGE + idx + 1;
            if (!ac) {
              if (rank > limit) return; // 第 ceil(N/20) 页多出来的几条丢掉
              raw.push({ ...item, rank, kw: job.kw, rule: `${item.site}/${job.rule.sort || '默认'}/${job.rule.limit}` });
              return;
            }
            // 作者订阅：他发的我都要，只过库和队列两道闸
            if (libKeys.has(candidateKey(item.site, item.id)) || busy.has(item.url)) {
              stale++;
              return;
            }
            stale = 0;
            const cand = { ...item, sources: [{ site: item.site, id: item.id, url: item.url, rank, kw: null }] };
            if (decide(cand, sub, { libKeys, busy }) === 'queued') hitsFound.push({ ...item, user: job.user.name || job.user.id, matchedAt: new Date().toISOString() });
          });
          if (ac && !ac.done) ac.page = page + 1;
          if (ac?.done && stale >= AUTHOR_STOP) break; // 全量已翻完：撞到一页旧的，到此为止
        }
        done.add(job.i);
      }
    }),
  );

  // ── 候选调度器：纯本地，不联网、不占搜索配额 ──
  const stopped = !sub.enabled; // 跑到一半被点「停止」：已搜到的照记候选，但不再往库里塞
  const cands = sub.kind === 'keyword' ? mergeSources(raw) : [];
  const prev = sub.kind === 'keyword' ? await candidates(sub.id) : { items: [] };
  const prevMap = new Map(prev.items.map((c) => [c.key, c]));
  const now = clock();
  const keep = [];
  const queued = [];
  const tally = {}; // 本轮每条候选判成什么：进运行日志的那一行（ADR-0007）

  for (const cand of cands) {
    const old = prevMap.get(cand.key);
    const decision = decide(cand, sub, { libKeys, busy }); // 每轮重判：判定是本地读盘，省不出什么，却会挡住「删了想重下」
    tally[decision] = (tally[decision] || 0) + 1;
    const row = {
      key: cand.key,
      sources: cand.sources,
      title: cand.title,
      author: cand.author,
      tags: cand.tags || [],
      decision,
      firstSeen: old?.firstSeen || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    keep.push(row);
    if (decision !== 'queued') continue;
    const primary = pickPrimary(cand.sources);
    queued.push({ ...cand, url: primary.url, sources: cand.sources, matchedAt: new Date().toISOString() });
  }

  // 30 天没再出现的候选清掉；本轮没搜到的老候选留着（搜索可能被预算截断）
  const seenKeys = new Set(keep.map((c) => c.key));
  for (const old of prev.items) {
    if (seenKeys.has(old.key)) continue;
    if (now - (Date.parse(old.lastSeen) || 0) < CAND_DAYS * 86400_000) keep.push(old);
  }

  const allHits = [...hitsFound, ...queued];
  let lastError = errors.length ? `搜索失败 ${errors.length} 次：${errors.slice(0, 2).join('；')}` : null;

  if (!stopped && allHits.length) {
    // 磁盘不够就别排了：写一半失败比没排更糟（同一道闸门，手动入队也走它）
    const free = await stats.freeSpace();
    if (free != null && free < 5 * 1024 ** 3) {
      lastError = `磁盘不足：只剩 ${(free / 1024 ** 3).toFixed(1)} GB，本轮不排队`;
    } else {
      for (const hit of allHits) {
        const { task } = await tasks.enqueue({ url: hit.url, source: 'subscribe', subId: sub.id });
        hit.taskId = task.id;
      }
    }
  }

  if (sub.kind === 'keyword') {
    await mkdir(HIT_DIR, { recursive: true });
    await writeJson(path.join(HIT_DIR, `${sub.id}.candidates.json`), { items: keep });
  }
  if (allHits.length) await appendHits(sub.id, allHits);
  // 命中逐条进运行日志：候选明细留在订阅详情页，这里只留「谁进了队」（ADR-0007）
  for (const hit of allHits) {
    events.emit('subs-candidate', {
      sub: sub.id,
      subName: sub.name,
      site: hit.site,
      title: hit.title,
      url: hit.url,
      likes: hit.likes || 0,
      downloads: hit.downloads || 0,
      taskId: hit.taskId || null,
    });
  }

  // 跑到哪了：下轮从第一个没跑完的任务接着跑；全跑完就归零
  let cursor = 0;
  for (let i = from; i < jobs.length; i++) if (!done.has(i)) { cursor = i; break; }
  sub.cursor = cursor;
  delete sub.progress;
  sub.lastRunAt = new Date().toISOString();
  sub.lastResult = {
    at: sub.lastRunAt,
    startedAt,
    searched,
    candidates: cands.length,
    matched: allHits.length,
    stopped,
    jobs: jobs.length,
    from,
    cursor,
  };
  if (lastError) sub.lastResult.error = lastError;
  await persist();
  events.emit('subs-run', {
    sub: sub.id,
    subName: sub.name,
    site: (sub.sites || [])[0] || null,
    searched,
    candidates: cands.length,
    matched: allHits.length,
    decisions: tally,
    stopped,
    ms: Math.max(0, Date.now() - (Date.parse(startedAt) || Date.now())),
    error: lastError,
  });

  return { sub, hits: allHits, candidates: cands.length, searched };
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
        events.emit('subs-run', { sub: sub.id, subName: sub.name, searched: 0, candidates: 0, matched: 0, decisions: {}, error: sub.lastResult.error });
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

  const sub = { kind: 'keyword', minLikes: 10, minDownloads: 100, pickedOnly: true, matchModes: ['name'] };
  console.assert(passes({ likes: 10, downloads: 100, picked: true }, sub) === true, '刚好达标应过');
  console.assert(passes({ likes: 9, downloads: 999, picked: true }, sub) === false, '点赞不够应拦');
  console.assert(passes({ likes: 99, downloads: 99, picked: true }, sub) === false, '下载不够应拦');
  console.assert(passes({ likes: 99, downloads: 999, picked: false }, sub) === false, '不精选应拦');

  // 四道闸
  const cand = { key: 'makerworld:1', title: '皮卡丘 Pikachu', tags: [], likes: 99, downloads: 999, picked: true, sources: [{ site: 'makerworld', id: 1, url: 'u1', rank: 3, kw: '皮卡丘' }] };
  const ctx = { libKeys: new Set(), busy: new Set() };
  console.assert(decide(cand, sub, ctx) === 'queued', '名字包含关键字就入队');
  console.assert(decide(cand, sub, { libKeys: new Set(['makerworld:1']) }) === 'in-library', '库里有就不入队');
  console.assert(decide(cand, sub, { busy: new Set(['u1']) }) === 'in-queue', '队列里有就不入队');
  console.assert(decide({ ...cand, title: '妙蛙种子' }, sub, ctx) === 'no-match', '名字不含关键字不算命中');
  console.assert(decide({ ...cand, title: '妙蛙种子' }, { ...sub, matchModes: ['tag'] }, ctx) === 'no-match', 'tag 不含也不算');
  console.assert(decide({ ...cand, title: '妙蛙种子', tags: ['皮卡丘'] }, { ...sub, matchModes: ['tag'] }, ctx) === 'queued', 'tag 命中算');
  console.assert(decide(cand, { ...sub, minLikes: 1000 }, ctx) === 'threshold', '门槛拦得住');
  console.assert(decide(cand, { kind: 'author' }, ctx) === 'queued', '作者订阅没有门槛没有匹配');

  // 跨站合并：同标题同作者合成一条，MakerWorld 优先
  const merged = mergeSources([
    { site: 'snapmaker', id: 9, url: 's9', title: 'Pikachu', author: 'Tom', rank: 1, kw: 'pikachu', downloads: 5 },
    { site: 'makerworld', id: 7, url: 'm7', title: 'pikachu', author: 'TOM', rank: 5, kw: 'pikachu', downloads: 900 },
  ]);
  console.assert(merged.length === 1, '同标题同作者合成一条');
  console.assert(merged[0].sources.length === 2, '两个来源都记下来');
  console.assert(pickPrimary(merged[0].sources).site === 'makerworld', '入队取 MakerWorld 优先');
  console.assert(merged[0].downloads === 900, '数值取主来源那份');

  // 任务展开
  console.assert(planJobs({ kind: 'keyword', keywords: ['a', 'b'], rules: [{ site: 'makerworld', sort: 'score', limit: 100 }] }).length === 2, '关键字 × 规则');
  console.assert(planJobs({ kind: 'author', users: [{ site: 'snapmaker', id: '1' }] }).length === 1, '作者订阅只跑主页');

  console.log('subs demo ok');
  process.exit(0);
}

// 抓取任务队列：一个模型一次入库尝试 = 一条任务（GLOSSARY）。
// 全局串行（ADR-0005）——同一时刻只跑一个 grab.mjs，浏览器标签别抢。
// 进度来自 grab.mjs 打的 `@@TASK {...}` 行，不猜、不解析人类可读输出。
import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, writeJson } from './lib.mjs';
import { all as allPacks, byName, match as matchSite } from './sites/index.mjs';

const TASKS_DIR = path.join(ROOT, 'data', 'tasks');
// 暂停开关存盘：重启后停在暂停，直到人点「继续」（否则 systemd 一重启就把几十条任务全放出来）
const STATE_FILE = path.join(ROOT, 'data', 'queue.json');
// 站点自定义限速（ADR-0006）：控制台改这里，别去改 env
const SITE_CONFIG_FILE = path.join(ROOT, 'data', 'site-config.json');

// 单条任务的墙钟上限（30 分钟）。测试里可以调小，别等半小时
const TIMEOUT_MS = Number(process.env.MARKLAB_TASK_TIMEOUT_MS) || 30 * 60_000;
const MAX_ROUNDS = 3; // 跨轮次失败上限（ADR-0003）；本任务内的重试在 grab.mjs 里
// 模型之间的间隔（AGENTS.md 不可省）：全局串行 + 这条闸门，订阅/批抓/手动都受它管。
// 模型内部每个文件的间隔在 grab.mjs（5–10 秒），两道闸门合起来才是完整限速。
// 60 秒是地板：env/CLI 想调小等于关掉限速，直接按 60 走。
const FLOOR = 60;
const readGap = (v, def) => Math.max(Number(v) || def, FLOOR) * 1000;
let MIN_GAP = readGap(process.env.MARKLAB_MIN_GAP, 60);
let MAX_GAP = Math.max(readGap(process.env.MARKLAB_MAX_GAP, 120), MIN_GAP);
/** 全局默认的模型间隔（毫秒）。控制台拿它当输入框的占位值，测试拿它验地板。 */
export const gapsMs = () => [MIN_GAP, MAX_GAP];
const KEEP = 500; // 内存里留多少条，更老的只在 jsonl 里
// 测试缝：不真的起 grab 子进程（队列语义的测试不该联网、不该开浏览器）
const NO_SPAWN = process.env.MARKLAB_TEST_NOSPAWN === '1';

const tasks = new Map(); // id -> task
const resolvers = new Map(); // id -> done 的 resolve（函数不进 jsonl）
// 每个站点一条队，轮转取：一个站卡住不挡别的站（spec §3.1）
const lanes = new Map(); // site -> [task]
let laneCursor = 0; // 轮转指针，指向上次取过的下一条队
let running = null;
let current = null; // 正在跑的子进程，停止时要 kill
// 每站一个闸门（ADR-0006）：某站间隔没到只推迟这个站，别的站照跑
const gates = new Map(); // site -> 下一次允许开始的时刻
// 站点自定义限速：site -> { modelGapSec: [min, max] }，只收这一个字段
let siteConfig = {};
let fileSeen = 0; // 已并入内存的 jsonl 字节数，用来发现别的进程（bulk.mjs）写进来的任务
// 调试用的总闸：暂停后队列一条都不开跑（在跑的那条跑完为止），只有人手动动作能放行。
let paused = false;

const now = () => new Date().toISOString();
const monthFile = (d = new Date()) => path.join(TASKS_DIR, `${d.toISOString().slice(0, 7)}.jsonl`);

async function persist(task) {
  await mkdir(TASKS_DIR, { recursive: true });
  await appendFile(monthFile(), JSON.stringify(task) + '\n');
}

/** bulk.mjs 的 --min-gap/--max-gap 落到这里，别让两个地方各管一份限速。60 秒是地板，调小等于关掉限速。 */
export function setGap(minSec, maxSec) {
  if (Number(minSec) >= FLOOR) MIN_GAP = Number(minSec) * 1000;
  if (Number(maxSec) >= FLOOR) MAX_GAP = Math.max(Number(maxSec) * 1000, MIN_GAP);
}

/**
 * 某站模型之间的间隔（毫秒）：用户覆盖 > 包里的 rate > 全局默认，三层都过 60 秒地板。
 * 没有覆盖就返回全局那对值，不额外造对象。
 */
function gapOf(site) {
  const own = siteConfig[site || '_']?.modelGapSec;
  const pack = byName(site)?.rate?.modelGapSec;
  const src = (v) => (Array.isArray(v) && v.length === 2 ? v : null);
  const pick = src(own) || src(pack);
  if (!pick) return [MIN_GAP, MAX_GAP];
  const min = readGap(pick[0], MIN_GAP / 1000);
  return [min, Math.max(readGap(pick[1], MAX_GAP / 1000), min)];
}

/** 推这个站的闸门：这一轮打扰过站点，就得等够它自己的间隔。 */
function pushGate(site) {
  const [lo, hi] = gapOf(site);
  gates.set(site || '_', Date.now() + lo + Math.random() * Math.max(0, hi - lo));
}

const gateOpen = (site) => Date.now() >= (gates.get(site || '_') || 0);

/** 还要等多久才有站解禁（没有任务在等就是 0）。 */
function waitMs() {
  let best = Infinity;
  for (const [k, l] of lanes) if (l.length) best = Math.min(best, (gates.get(k) || 0) - Date.now());
  return Number.isFinite(best) ? Math.max(best, 0) : 0;
}

/** 站点自定义限速：读盘 / 写盘。只认三个字段，别的键一律丢。
 *  `modelGapSec: [min, max]` 秒（下载间隔，进来就过 60 秒地板）、
 *  `searchPerMin: N`（每分钟搜几次）、`checkinAuto: bool`（每天自动签到一次）。 */
export async function siteConfigLoad() {
  try {
    siteConfig = JSON.parse(await readFile(SITE_CONFIG_FILE, 'utf8')) || {};
  } catch {} // 没配过就是全跟随全局默认
  return siteConfig;
}

export async function siteConfigSet(next) {
  const clean = {};
  for (const [site, v] of Object.entries(next || {})) {
    if (!byName(site)) continue; // 不认识的站名不落盘，免得配置里长出拼错的键
    const out = {};
    const g = v?.modelGapSec;
    if (Array.isArray(g) && g.length === 2) {
      const min = readGap(g[0], MIN_GAP / 1000);
      out.modelGapSec = [min / 1000, Math.max(readGap(g[1], MAX_GAP / 1000), min) / 1000];
    }
    const n = Number(v?.searchPerMin);
    if (Number.isFinite(n) && n > 0) out.searchPerMin = Math.min(Math.round(n), 60);
    if (typeof v?.checkinAuto === 'boolean') out.checkinAuto = v.checkinAuto;
    if (Object.keys(out).length) clean[site] = out;
  }
  siteConfig = clean;
  await mkdir(path.dirname(SITE_CONFIG_FILE), { recursive: true });
  await writeJson(SITE_CONFIG_FILE, clean);
  return siteConfig;
}

export const siteConfigGet = () => siteConfig;

/** 列表，最新的在前。 */
export function list({ limit = 200 } = {}) {
  return [...tasks.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map((t) => ({ ...t }));
}

/**
 * 别的进程（`bulk.mjs`）也往同一个 jsonl 追加任务，进程内 Map 看不见。
 * 按字节增量并入，控制台轮询时调一次；半行留到下次。
 */
export async function refresh() {
  const f = monthFile();
  let size = 0;
  try {
    size = (await stat(f)).size;
  } catch {
    return;
  }
  if (size <= fileSeen) return;
  let raw = '';
  try {
    const fh = await open(f, 'r');
    const buf = Buffer.alloc(size - fileSeen);
    const { bytesRead } = await fh.read(buf, 0, buf.length, fileSeen);
    await fh.close();
    raw = buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return;
  }
  const cut = raw.lastIndexOf('\n');
  if (cut < 0) return;
  const whole = raw.slice(0, cut + 1);
  fileSeen += Buffer.byteLength(whole);
  for (const line of whole.split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line);
      if (t.id && !tasks.has(t.id)) tasks.set(t.id, t);
    } catch {}
  }
  trim();
}

export function get(id) {
  const t = tasks.get(id);
  return t ? { ...t } : null;
}

const laneKey = (t) => t.site || '_';

function laneOf(t) {
  let l = lanes.get(laneKey(t));
  if (!l) {
    l = [];
    lanes.set(laneKey(t), l);
  }
  return l;
}

/** 插队：把轮转指针指到这条任务所在的站，下一次取就是它（限速闸门照旧生效）。 */
function jumpTo(t) {
  const idx = [...lanes.keys()].indexOf(laneKey(t));
  if (idx >= 0) laneCursor = idx;
}

function queuedCount() {
  let n = 0;
  for (const l of lanes.values()) n += l.length;
  return n;
}

/** 轮转取下一条：从上次取过的下一条队开始，取第一个非空的。 */
function shiftNext() {
  const keys = [...lanes.keys()];
  if (!keys.length) return null;
  for (let i = 0; i < keys.length; i++) {
    const idx = (laneCursor + i) % keys.length;
    const l = lanes.get(keys[idx]);
    if (!l.length) continue;
    // 这个站的间隔还没走完：让它等着，别的站照跑（ADR-0006）
    if (!NO_SPAWN && !gateOpen(keys[idx])) continue;
    laneCursor = (idx + 1) % keys.length;
    const t = l.shift();
    if (!l.length) lanes.delete(keys[idx]);
    return t;
  }
  return null;
}

/** 暂停中只找带 force 的那一条（手动点的），别的一条都不放行。 */
function shiftForce() {
  for (const [k, l] of lanes) {
    // 手动插队也过闸门：连点「开始」不该把间隔撞穿
    if (!NO_SPAWN && !gateOpen(k)) continue;
    const i = l.findIndex((t) => t.force);
    if (i < 0) continue;
    const t = l.splice(i, 1)[0];
    if (!l.length) lanes.delete(k);
    return t;
  }
  return null;
}

function unqueue(t) {
  const l = lanes.get(laneKey(t));
  if (!l) return false;
  const i = l.indexOf(t);
  if (i < 0) return false;
  l.splice(i, 1);
  if (!l.length) lanes.delete(laneKey(t));
  return true;
}

export function queueDepth() {
  return queuedCount() + (running ? 1 : 0);
}

/** 队列状态：控制台那个暂停/继续按钮读它。 */
export function state() {
  return {
    paused,
    queued: queuedCount(),
    running: running ? running.id : null,
    nextOkAt: Math.max(0, ...gates.values()), // 兼容老前端：所有站里最晚的那个
    gates: Object.fromEntries(gates), // 每站各自的解禁时刻
  };
}

async function saveState() {
  const tmp = STATE_FILE + '.tmp';
  try {
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    // queue 只存 id：任务本体在 jsonl 里（审计），恢复时按 id 取回，不抢别的进程的排队任务。
    // 在跑的那条也算（pump 已经把任务从 queue 挪到 running 了）
    const ids = [];
    for (const l of lanes.values()) for (const t of l) ids.push(t.id);
    if (running) ids.push(running.id);
    await writeFile(
      tmp,
      JSON.stringify({ paused, nextOkAt: Math.max(0, ...gates.values()), gates: Object.fromEntries(gates), queued: ids }),
    );
    await rename(tmp, STATE_FILE);
  } catch {}
}

/** 暂停：不再开新任务，正在跑的那条让它跑完（要立刻断就用单条「停止」）。 */
export function pause() {
  paused = true;
  saveState().catch(() => {});
  return state();
}

/** 继续：只有人点这个（或手动开始一个任务）才放行，订阅/批抓都调不动它。 */
export function resume() {
  paused = false;
  saveState().catch(() => {});
  pump();
  return state();
}

/** 工作台要的吞吐：最近 24 小时完成多少、平均多久、失败多少。 */
export function stats() {
  const since = Date.now() - 86400_000;
  const done = [...tasks.values()].filter((t) => t.phase === 'done' && Date.parse(t.endedAt || 0) > since);
  const failed = [...tasks.values()].filter((t) => t.phase === 'failed' && Date.parse(t.endedAt || 0) > since);
  const secs = done.map((t) => (Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000).filter((n) => n > 0);
  return {
    last24h: done.length,
    failed24h: failed.length,
    avgSeconds: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null,
    running: running ? running.id : null,
    queued: queuedCount(),
  };
}

function trim() {
  if (tasks.size <= KEEP) return;
  const old = [...tasks.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const t of old.slice(0, tasks.size - KEEP)) {
    if (t.phase === 'queued' || t.phase === 'fetching' || t.phase === 'parsing' || t.phase === 'downloading') continue;
    tasks.delete(t.id);
  }
}

/**
 * 排一个入库任务。返回 { task, done }：
 *   task 立刻可见（控制台能马上看到「排队中」）
 *   done 在跑完后 resolve，老接口 /api/grab 还在 await 它，行为不变
 */
export function enqueue({ url, source = 'manual', dir = null, subId = null }) {
  // 同一网址不重复排队：排着/在跑 → 拦；24 小时内成功过（done/duplicate）→ 拦。
  // 失败/中断/停止过 → 放行，否则抓失败的网址永远点不动（spec §3.1）
  const nowMs = Date.now();
  for (const t of tasks.values()) {
    if (t.url !== url) continue;
    const fresh = t.phase === 'queued' || t.phase === 'fetching' || t.phase === 'parsing' || t.phase === 'downloading';
    const succeeded = (t.phase === 'done' || t.phase === 'duplicate') && nowMs - Date.parse(t.endedAt || 0) < 86400_000;
    if (fresh || succeeded) return { task: { ...t }, done: Promise.resolve({ ok: t.ok, code: t.ok ? 0 : 1, task: { ...t } }) };
  }
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const task = {
    id,
    url,
    dir,
    // 入队时就认站点：列表/日志要显示站点，等子进程回报太晚
    site: matchSite(url)?.site || null,
    title: null,
    source,
    subId,
    phase: 'queued',
    progress: { done: 0, total: 0, name: '' },
    rounds: 0,
    createdAt: now(),
    startedAt: null,
    endedAt: null,
    ok: null,
    error: null,
    warning: null,
    log: '',
    // 暂停中手动点的那一条：只放行它自己，不动 paused（spec §3.1）
    force: Boolean(source === 'manual' && paused),
  };
  tasks.set(id, task);
  trim();
  saveState().catch(() => {}); // 排队名单也持久化：重启按它恢复，不抢别的进程的排队任务

  let resolve;
  const done = new Promise((r) => (resolve = r));
  resolvers.set(id, resolve);
  const lane = laneOf(task);
  // 手动加的链接插队：挪到本站队首 + 轮转指针指过来，下一个就跑它。
  // 只是排队顺序靠前，闸门（模型间 60–120 秒）照旧等，不会连发（spec §3.2）
  if (task.force || source === 'manual') lane.unshift(task);
  else lane.push(task);
  if (source === 'manual') jumpTo(task);
  persist(task).catch(() => {});
  saveState().catch(() => {});
  pump();
  return { task: { ...task }, done };
}

// 任务收尾的旁听者（server 用它让 /api/models 缓存失效，页面立刻能看见新模型）
const finishHooks = [];
export function onFinish(fn) {
  finishHooks.push(fn);
}

function finish(task, ok, error, phase) {
  task.ok = ok;
  task.phase = phase || (!ok ? (task.rounds >= MAX_ROUNDS ? 'failed' : 'interrupted') : task.phase === 'duplicate' ? 'duplicate' : 'done');
  task.endedAt = now();
  task.error = ok ? null : error || null; // 成功了就别挂着上一轮的报错
  if (ok) {
    task.errorCode = null;
    task.errorDetail = null;
  }
  if ((task.progress || {}).done > 0) {
    pushGate(task.site);
  } else if (task.startedAt) {
    // 上一轮对站点发过请求（抓到元数据也算），闸门照推——没下到文件不是没打扰站点
    pushGate(task.site);
  }
  saveState().catch(() => {}); // 闸门持久化：重启后别立刻放行
  persist(task).catch(() => {});
  for (const fn of finishHooks) {
    try {
      fn(task);
    } catch {}
  }
  const resolve = resolvers.get(task.id);
  resolvers.delete(task.id);
  if (resolve) resolve({ ok, code: ok ? 0 : 1, log: task.log, task: { ...task } });
}

/** 从子进程 stderr 里挑人话：堆栈、`Node.js v20.x` 横幅、「退出码 0」都不算错误串。 */
function humanError(tail, code) {
  const lines = String(tail)
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Node\.js v\d/.test(l) && !l.startsWith('at ') && !/^退出码 \d+$/.test(l));
  const hit = [...lines].reverse().find((l) => /error|失败|没连上|超时|登录|人机验证|captcha|拒绝|forbidden|unauthor/i.test(l));
  const msg = String(hit || lines.pop() || '').replace(/^(?:Uncaught\s+)?(?:Error:\s*)?/i, '').trim();
  return (msg || `抓取进程异常退出（退出码 ${code}）`).slice(0, 200);
}

// 子进程 → 任务记录
function handleLine(task, line) {
  if (!line.startsWith('@@TASK ')) {
    task.log = (task.log + line + '\n').slice(-2000);
    return;
  }
  let ev;
  try {
    ev = JSON.parse(line.slice(7));
  } catch {
    return;
  }
  if (ev.phase === 'failed') {
    // 抓取侧已经分好类（login / captcha / browser / timeout / network / disk / parse / unknown-site）
    task.errorCode = ev.code || 'unknown';
    task.error = ev.text || '抓取失败';
    task.errorDetail = ev.detail || '';
    task.phase = 'failed';
    persist(task).catch(() => {});
    return;
  }
  if (ev.phase === 'warning') {
    task.warning = ev.msg;
    persist(task).catch(() => {});
    return;
  }
  if (ev.phase) task.phase = ev.phase;
  if (ev.site) task.site = ev.site;
  if (ev.title) task.title = ev.title;
  if (ev.dir) task.dir = ev.dir;
  if (ev.done != null || ev.total != null) {
    task.progress = { done: ev.done ?? task.progress.done, total: ev.total ?? task.progress.total, name: ev.name || task.progress.name };
  }
  persist(task).catch(() => {});
}

async function pump() {
  if (running) return;
  // 暂停：只放行手动点的那一条（force），其它一条都不开跑
  if (paused && ![...lanes.values()].some((l) => l.some((t) => t.force))) return;
  const task = paused ? shiftForce() : shiftNext();
  if (!task) {
    // 有任务在等，但闸门都关着：等到最早的那个解禁再试
    const wait = waitMs();
    if (!paused && wait > 0) setTimeout(pump, Math.min(wait, 30_000));
    return;
  }
  running = task;
  task.phase = 'fetching';
  task.startedAt = now();
  task.error = null; // 上一轮的报错别挂着，看着像这次也失败了
  persist(task).catch(() => {});

  let code = 1;
  let tail = '';
  await new Promise((resolve) => {
    if (NO_SPAWN) {
      // 异步收尾：同步置 done 会让 enqueue 返回的快照已经是终态
      setTimeout(() => {
        task.phase = 'done';
        task.progress = { done: 1, total: 1, name: 'test' };
        code = 0;
        resolve();
      }, 5);
      return;
    }
    const child = spawn(process.execPath, [path.join(ROOT, 'grab.mjs'), task.url], {
      cwd: ROOT,
      env: { ...process.env, MARKLAB_TASK: task.id },
    });
    current = child;
    // 墙钟超时：grab 里的 fetch/CDP 都没带超时，卡住会堵死全局串行队列。
    // 先 SIGTERM：grab 收到会 closePages() 关掉浏览器标签页再退；5 秒还没退才 SIGKILL。
    let hardKill = null;
    const killer = setTimeout(() => {
      tail = '抓取超时（30 分钟没跑完），已停止';
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, TIMEOUT_MS);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(task, buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => {
      tail = (tail + d.toString()).slice(-800);
    });
    child.on('error', (e) => {
      tail = String(e.message || e);
      current = null;
      clearTimeout(killer);
      clearTimeout(hardKill);
      resolve();
    });
    child.on('close', (c) => {
      code = c;
      current = null;
      clearTimeout(killer);
      clearTimeout(hardKill);
      if (buf.trim()) handleLine(task, buf);
      resolve();
    });
  });

  running = null;
  task.force = false; // force 只管这一次
  let ok;
  let phase = null;
  let err = null;
  if (task.stopped) {
    // 人点的停止：终态，不重排、不计失败、rounds 不动（spec §10）
    ok = false;
    phase = 'stopped';
    err = '已停止';
  } else if (code === 0 && (task.phase === 'done' || task.phase === 'duplicate')) {
    ok = true; // duplicate 也是成功：抓之前就知道库里有了，不是失败
    phase = task.phase;
  } else if (code === 0) {
    // 成功退出却没走到 done（中途 exit(0)）：单独归类，不写成「退出码 0 的失败」
    ok = false;
    phase = 'incomplete';
    err = '抓取进程正常退出，但没走到 done';
  } else {
    ok = false;
    // 抓取侧给了人话就用它；没给（崩溃、被 OOM 杀）才从 stderr 里猜
    err = task.error || humanError(tail, code);
  }
  if (!ok && phase !== 'stopped') task.rounds += 1;
  finish(task, ok, err, phase);

  // 还有轮次就重排到它那个站的队尾，别立即重撞（ADR-0003 跨轮次）
  if (!ok && phase !== 'stopped' && task.rounds < MAX_ROUNDS) {
    const t = tasks.get(task.id);
    if (t) {
      t.phase = 'queued';
      laneOf(t).push(t);
      persist(t).catch(() => {});
    }
  }
  pump();
}

/**
 * 启动时重建：读本月 jsonl（更老的月份只归档不加载），
 * 上次没跑完的标 interrupted 并重新排队。
 */
export async function restore() {
  await siteConfigLoad(); // 限速覆盖要先读进来，闸门第一次推就得按它算
  let savedQueue = [];
  let hasQueueField = false;
  try {
    const st = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    paused = Boolean(st.paused);
    // 闸门持久化。老档只有一个全局数字（ADR-0006 之前），铺到所有站，别让升级后立刻放行
    if (Number(st.nextOkAt) > Date.now()) {
      for (const p of allPacks()) gates.set(p.site, Number(st.nextOkAt));
      gates.set('_', Number(st.nextOkAt));
    }
    if (st.gates && typeof st.gates === 'object') {
      for (const [k, v] of Object.entries(st.gates)) if (Number(v) > Date.now()) gates.set(k, Number(v));
    }
    if (Array.isArray(st.queued)) {
      savedQueue = st.queued; // 排队的是本进程的，别的进程的不许抢
      hasQueueField = true;
    }
  } catch {} // 没有存档就是没暂停过
  let raw = '';
  try {
    raw = await readFile(monthFile(), 'utf8');
  } catch {
    return { loaded: 0, resumed: 0 };
  }
  fileSeen = Buffer.byteLength(raw);
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line);
      if (t.id) tasks.set(t.id, t);
    } catch {}
  }
  // 迁移兜底：老版本 queue.json 没有 queued 字段，这时按 jsonl 里 phase='queued' 的恢复
  // （新版本每次 enqueue/pump 都会写 queued，不会再走到这里）
  if (!hasQueueField) {
    for (const t of tasks.values()) if (t.phase === 'queued') savedQueue.push(t.id);
  }
  let resumed = 0;
  // 只恢复本进程上次排队/跑到一半的任务；jsonl 里别的进程排队的不碰
  for (const id of savedQueue) {
    const t = tasks.get(id);
    if (!t) continue;
    if (t.phase === 'queued') {
      laneOf(t).push(t);
      resumed++;
      continue;
    }
    if (!['fetching', 'parsing', 'downloading'].includes(t.phase)) continue;
    t.phase = 'queued';
    t.error = '上次没跑完（重启中断）';
    if (t.rounds < MAX_ROUNDS) {
      laneOf(t).push(t);
      resumed++;
    } else {
      t.phase = 'failed';
    }
  }
  trim();
  pump();
  return { loaded: tasks.size, resumed };
}

/** 手工重试一条任务（失败后点重试）。 */
export function retry(id) {
  const t = tasks.get(id);
  if (!t || ['queued', 'fetching', 'parsing', 'downloading'].includes(t.phase)) return null;
  t.rounds = 0;
  t.phase = 'queued';
  t.error = null;
  t.errorCode = null;
  t.errorDetail = null;
  t.force = paused; // 暂停中重试：只放行这一条，不解除暂停
  const lane = laneOf(t);
  if (t.force) lane.unshift(t);
  else lane.push(t);
  jumpTo(t);
  persist(t).catch(() => {});
  saveState().catch(() => {});
  pump();
  return { ...t };
}

// 测试缝：直接触发 finish（正常路径由子进程 close 驱动）；只有 test.mjs 会调
export function _testFinish(id) {
  const t = tasks.get(id);
  if (!t) return;
  finish(t, true, null);
}

/** 插队：把排队中的任务挪到队首，下一个就跑它。 */
export function promote(id) {
  const t = tasks.get(id);
  if (!t) return { ok: false, error: '没这个任务' };
  if (!unqueue(t)) return { ok: false, error: '不在队列里' };
  t.force = paused; // 暂停中插队：只放行这一条，不解除暂停
  laneOf(t).unshift(t);
  jumpTo(t);
  saveState().catch(() => {});
  pump();
  return { ok: true };
}

/** 停止：排队中的直接移出队列；在跑的 kill 掉子进程，不再重排。 */
export function stop(id) {
  const t = tasks.get(id);
  if (!t) return { ok: false, error: '没这个任务' };
  if (unqueue(t)) {
    t.ok = false;
    t.phase = 'stopped'; // 终态，不计失败、不重排
    t.error = '已停止';
    t.endedAt = now();
    saveState().catch(() => {});
    persist(t).catch(() => {});
    const resolve = resolvers.get(t.id);
    resolvers.delete(t.id);
    if (resolve) resolve({ ok: false, code: 1, log: t.log, task: { ...t } });
    return { ok: true };
  }
  if (running === t && current) {
    t.stopped = true;
    current.kill('SIGTERM');
    return { ok: true };
  }
  return { ok: false, error: '任务已经结束' };
}

// 自检：不联网、不起浏览器，只验进度行解析和月份归档。
if (path.basename(process.argv[1] || '') === 'tasks.mjs') {
  const t = { phase: 'fetching', progress: { done: 0, total: 0, name: '' }, log: '' };
  handleLine(t, '@@TASK {"phase":"downloading","done":2,"total":7,"name":"a.3mf"}');
  console.assert(t.phase === 'downloading', '阶段应更新');
  console.assert(t.progress.done === 2 && t.progress.total === 7, '进度应更新');
  console.assert(t.progress.name === 'a.3mf', '文件名应更新');
  handleLine(t, '普通日志行');
  console.assert(t.log.includes('普通日志行'), '非进度行进日志');
  handleLine(t, '@@TASK 这不是 JSON');
  console.assert(t.phase === 'downloading', '坏行不应炸');
  console.assert(monthFile(new Date('2026-10-29T00:00:00Z')).endsWith('2026-10.jsonl'), '按月归档');
  pause();
  console.assert(state().paused === true, '暂停要置位');
  console.assert(paused === true, 'pump 的总闸跟着关');
  await new Promise((r) => setTimeout(r, 150));
  console.assert(JSON.parse(await readFile(STATE_FILE, 'utf8')).paused === true, '暂停要落盘，重启才停得住');
  resume();
  console.assert(state().paused === false, '继续要复位');
  await new Promise((r) => setTimeout(r, 150));
  console.assert(JSON.parse(await readFile(STATE_FILE, 'utf8')).paused === false, '继续也要落盘');
  console.log('tasks demo ok');
  process.exit(0);
}

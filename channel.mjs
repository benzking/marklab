// 浏览器通道：只连本机常驻 Chromium（ADR-0002），进程内复用，不落任何凭据（ADR-0001）。
// 两个能力：① 拿登录态（cookie 只在内存里）② 用真浏览器取页（MakerWorld 只能走这条）。
import { chromium } from 'playwright-core';
import path from 'node:path';

const CDP = process.env.MARKLAB_CDP || 'http://127.0.0.1:9223';
const COOKIE_TTL = 300_000; // 登录态内存缓存 5 分钟；401 时强制重取

// 站点 → cookie 域（.com/.cn 是两套独立登录态，都收）
export const DOMAINS = {
  creality: ['crealitycloud.cn', 'crealitycloud.com'],
  makerworld: ['makerworld.com', 'makerworld.com.cn'],
  snapmaker: ['snapmaker.cn', 'snapmaker.com'],
  // .cn 与 .com 是两套登录态，各自取各自的 cookie，绝不合进同一个请求头（spec §7）
  'makeronline.cn': ['makeronline.cn'],
  'makeronline.com': ['makeronline.com'],
};

const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}超时（${ms / 1000} 秒）`)), ms)),
  ]);

// ── 单写者闸门（spec §8.1）──
// 实测：两个 connectOverCDP 并发就两个都超时，5 个并发时 4/5 的页面 goto 超时，
// 还会把常驻连接拖死。所以所有要浏览器的调用排一条队，全局并发 1，各站轮转。
const waiters = new Map(); // site -> [resolve]
let busy = false;
let gateCursor = 0;

function acquire(site) {
  if (!busy) {
    busy = true;
    return Promise.resolve();
  }
  return new Promise((res) => {
    const l = waiters.get(site) || [];
    l.push(res);
    waiters.set(site, l);
  });
}

function release() {
  const keys = [...waiters.keys()];
  if (!keys.length) {
    busy = false;
    return;
  }
  // 轮转交接：从上次放行的下一个站开始找，别让一个站一直霸着
  for (let i = 0; i < keys.length; i++) {
    const idx = (gateCursor + i) % keys.length;
    const l = waiters.get(keys[idx]);
    if (!l?.length) continue;
    gateCursor = (idx + 1) % keys.length;
    const next = l.shift();
    if (!l.length) waiters.delete(keys[idx]);
    next(); // busy 保持 true，直接把闸门交给它
    return;
  }
  busy = false;
}

/** 所有要浏览器的动作都从这里过：全局并发 1，站间轮转。 */
async function withBrowser(site, fn) {
  await acquire(site);
  try {
    return await fn();
  } finally {
    release();
  }
}

let browser = null;
let connecting = null;
let up = null; // 上次连接结果，给同步的 browserConnected() 用
let cookiesCache = null;
let cookiesAt = 0;
const pages = new Map(); // site -> Page，常驻，被用户关掉就重建

/** 懒连接 + 单飞 + 断线自愈。连不上返回 null，不抛（控制台显示「无法检测」）。 */
export async function connect() {
  if (browser?.isConnected()) return browser;
  if (connecting) return connecting;
  connecting = chromium
    // 5 秒会误杀：Chromium 正忙（页面 hydrate、其它 CDP 客户端）时握手能拖到 5 秒以上，
    // 表现是「明明开着浏览器却说没连上」。20 秒够用，再久就是真没开。
    .connectOverCDP(CDP, { timeout: 20_000 })
    .then((b) => {
      browser = b;
      up = true;
      // 用户关掉整个浏览器时清空，下次调用重新连
      b.on('disconnected', () => {
        browser = null;
        up = false;
        cookiesCache = null;
        pages.clear();
      });
      return b;
    })
    .catch(() => {
      up = false;
      return null;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

export async function isConnected() {
  return !!(await connect());
}

/** 用用户正在用的那个 context（登录态就在里面）。 */
async function context() {
  const b = await connect();
  if (!b) return null;
  const ctx = b.contexts()[0];
  return ctx || null;
}

/** 全量 cookie（含 HttpOnly），内存缓存。force=true 跳过缓存（401 时用）。 */
async function rawCookies(force = false) {
  if (!force && cookiesCache && Date.now() - cookiesAt < COOKIE_TTL) return cookiesCache;
  const ctx = await context();
  if (!ctx) return null;
  cookiesCache = await withTimeout(ctx.cookies(), 15_000, '取 cookie ');
  cookiesAt = Date.now();
  return cookiesCache;
}

export async function cookies(force = false) {
  return withBrowser('_', () => rawCookies(force));
}

/** 某站的 cookie 头，给 node fetch 用。没连上返回 null。 */
async function rawCookieHeader(site, force = false) {
  const all = await rawCookies(force);
  if (!all) return null;
  const domains = DOMAINS[site] || [];
  // 只认同域或子域：`endsWith(d)` 会让 evil-makeronline.cn 也混进来
  const mine = all.filter((c) => domains.some((d) => c.domain === d || c.domain === '.' + d || c.domain.endsWith('.' + d)));
  return mine.map((c) => `${c.name}=${c.value}`).join('; ');
}

export async function cookieHeader(site, force = false) {
  return withBrowser(site, () => rawCookieHeader(site, force));
}

/** 某站的常驻页（同 context 共享登录态）。用户关掉了就重建。 */
async function rawPage(site) {
  const p = pages.get(site);
  if (p && !p.isClosed()) return p;
  const ctx = await context();
  if (!ctx) return null;
  const np = await withTimeout(ctx.newPage(), 20_000, '开标签页 ');
  pages.set(site, np);
  return np;
}

export async function page(site) {
  return withBrowser(site, () => rawPage(site));
}

/** 真浏览器取页：导航 + 等 DOM 就绪 + 取内容。MakerWorld 走这条。 */
export async function goto(site, url, { waitUntil = 'domcontentloaded', timeout = 30000 } = {}) {
  return withBrowser(site, async () => {
    const p = await rawPage(site);
    if (!p) return null;
    const r = await p.goto(url, { waitUntil, timeout });
    return { page: p, status: r?.status() ?? 0, html: await p.content() };
  });
}

/** 在页内跑函数（同源 fetch / 读 window 上的数据），不新开页。fn 可以是函数或 JS 字符串。 */
export async function inPage(site, url, fn, arg, { wait = 0, timeout = 60_000 } = {}) {
  return withBrowser(site, async () => {
    const p = await rawPage(site);
    if (!p) return null;
    if (url && p.url() !== url) {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (wait) await new Promise((r) => setTimeout(r, wait)); // 等 hydrate，数据和按钮才挂上
    }
    return withTimeout(p.evaluate(fn, arg), timeout, '页内执行 ');
  });
}

/** 网址 → 站点 key，认不出来返回 null。 */
export function siteOf(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  for (const [site, domains] of Object.entries(DOMAINS)) {
    if (domains.some((d) => host === d || host.endsWith('.' + d))) return site;
  }
  return null;
}

// ── 旧接口（grab.mjs / cats.mjs 还在用这两个名字，别再复制一份通道） ──
export function browserConnected() {
  return up === true; // 没连过是 unknown，不乐观当连上（spec §7：连不上就显示「无法检测」）
}

/** 上次连接结果：true / false / null（还没试过）。控制台靠它区分「未登录」和「无法检测」。 */
export function connectionState() {
  return up;
}

export async function evalInPage(url, expr, { wait = 0 } = {}) {
  const site = siteOf(url);
  if (!site) throw new Error(`认不出的站点：${url}`);
  if (!(await connect())) throw new Error('浏览器没连上：先开着 Chromium（9223 端口）再抓');
  return { value: await inPage(site, url, expr, undefined, { wait }), via: 'channel' };
}

/** 带登录态的 node fetch：三站走这条，比开浏览器快且不占屏幕。force=true 重取登录态（401 后重试用）。 */
export async function fetchAs(site, url, opts = {}, force = false) {
  // 匿名请求不碰浏览器、不带 cookie：公开 CDN 的文件靠这条活着（Chromium 没开也能下）
  if (opts.anonymous) {
    const { anonymous, ...rest } = opts;
    return fetch(url, rest);
  }
  return withBrowser(site, async () => {
    const cookie = await rawCookieHeader(site, force);
    if (cookie == null) return null; // 浏览器没连上
    const headers = { ...(opts.headers || {}), cookie };
    return fetch(url, { ...opts, headers });
  });
}

/** 只断开我们的引用，绝不关用户的浏览器、绝不关用户开的标签。 */
/** 关掉本进程开的标签页。抓取子进程退出前必须调，否则会往用户 Chrome 里一直堆标签。 */
export async function closePages() {
  return withBrowser('_', () => rawClosePages());
}

async function rawClosePages() {
  const list = [...pages.values()].filter((p) => !p.isClosed());
  pages.clear();
  if (!list.length) return;
  // 关掉最后一个标签页 Chrome 会连着退出，所以先垫一张空白页再关自己的
  try {
    const ctx = list[0].context();
    if (ctx) {
      const alive = ctx.pages().filter((p) => !p.isClosed());
      if (alive.length <= list.length) await withTimeout(ctx.newPage(), 10_000, '垫空白页 ');
    }
  } catch {}
  await Promise.all(list.map((p) => p.close().catch(() => {})));
}

export function forget() {
  browser = null;
  cookiesCache = null;
  pages.clear();
}

// 注意：playwright 的 WS 会撑住事件循环，脚本用完要自己 process.exit(0)。
// server.mjs 是常驻进程，不用管。

// 自检：不联网，只验 cookie 头拼接与站点过滤。真连浏览器在 `node channel.mjs --live`。
function demo() {
  const all = [
    { name: 'a', value: '1', domain: '.crealitycloud.cn' },
    { name: 'b', value: '2', domain: 'makerworld.com' },
    { name: 'c', value: '3', domain: '.makeronline.cn' },
  ];
  const pick = (site) => {
    const ds = DOMAINS[site];
    return all.filter((x) => ds.some((d) => x.domain === d || x.domain === '.' + d || x.domain.endsWith(d)));
  };
  console.assert(pick('creality').length === 1, 'creality 应只收自己域');
  console.assert(pick('makerworld')[0].name === 'b', 'makerworld 命中');
  console.assert(pick('makeronline.cn')[0].name === 'c', 'makeronline 命中');
  console.assert(pick('snapmaker').length === 0, '没登录的站返回空');
  console.log('channel demo ok');
}

/** 自检用：闸门是不是真串行 + 站间轮转（不碰浏览器）。 */
async function demoGate() {
  const order = [];
  const run = async (site, tag) => {
    await acquire(site);
    order.push(tag);
    await new Promise((r) => setTimeout(r, 1));
    release();
  };
  await acquire('a');
  order.push('a1');
  const rest = [run('a', 'a2'), run('b', 'b1'), run('a', 'a3'), run('b', 'b2')];
  release();
  await Promise.all(rest);
  // 一条一个：a1 先占闸门，之后 a/b 交替，不许 a 全跑完才轮到 b
  console.assert(order.length === 5, '五条都要跑到');
  console.assert(order[1] === 'a2' && order[2] === 'b1', '排队里的第一条先上，之后换站');
  console.assert(order.indexOf('b1') < order.indexOf('a3'), 'b 站不该被 a 站饿死');
  console.log('channel gate ok', order.join(' → '));
}

if (path.basename(process.argv[1] || '') === 'channel.mjs') {
  if (process.argv.includes('--live')) {
    const b = await connect();
    console.log('connected:', !!b);
    const h = await cookieHeader('creality');
    console.log('creality cookie names:', h ? h.split('; ').map((s) => s.split('=')[0]).join(',') : '(未连接)');
    forget();
    process.exit(0);
  } else {
    demo();
    await demoGate();
  }
}

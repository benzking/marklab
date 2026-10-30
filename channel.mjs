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
  makeronline: ['makeronline.com', 'makeronline.cn'],
  // .cn 与 .com 是两套登录态，各自取各自的 cookie，绝不合进同一个请求头（spec §7）
  'makeronline.cn': ['makeronline.cn'],
  'makeronline.com': ['makeronline.com'],
};

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
export async function cookies(force = false) {
  if (!force && cookiesCache && Date.now() - cookiesAt < COOKIE_TTL) return cookiesCache;
  const ctx = await context();
  if (!ctx) return null;
  cookiesCache = await ctx.cookies();
  cookiesAt = Date.now();
  return cookiesCache;
}

/** 某站的 cookie 头，给 node fetch 用。没连上返回 null。 */
export async function cookieHeader(site, force = false) {
  const all = await cookies(force);
  if (!all) return null;
  const domains = DOMAINS[site] || [];
  // 只认同域或子域：`endsWith(d)` 会让 evil-makeronline.cn 也混进来
  const mine = all.filter((c) => domains.some((d) => c.domain === d || c.domain === '.' + d || c.domain.endsWith('.' + d)));
  return mine.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** 某站的常驻页（同 context 共享登录态）。用户关掉了就重建。 */
export async function page(site) {
  const p = pages.get(site);
  if (p && !p.isClosed()) return p;
  const ctx = await context();
  if (!ctx) return null;
  const np = await ctx.newPage();
  pages.set(site, np);
  return np;
}

/** 真浏览器取页：导航 + 等 DOM 就绪 + 取内容。MakerWorld 走这条。 */
export async function goto(site, url, { waitUntil = 'domcontentloaded', timeout = 30000 } = {}) {
  const p = await page(site);
  if (!p) return null;
  const r = await p.goto(url, { waitUntil, timeout });
  return { page: p, status: r?.status() ?? 0, html: await p.content() };
}

/** 在页内跑函数（同源 fetch / 读 window 上的数据），不新开页。fn 可以是函数或 JS 字符串。 */
export async function inPage(site, url, fn, arg, { wait = 0 } = {}) {
  const p = await page(site);
  if (!p) return null;
  if (url && p.url() !== url) {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (wait) await new Promise((r) => setTimeout(r, wait)); // 等 hydrate，数据和按钮才挂上
  }
  return p.evaluate(fn, arg);
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
  return up !== false; // 没连过就乐观当连上，真连不上会在 evalInPage 里报错
}

export async function evalInPage(url, expr, { wait = 0 } = {}) {
  const site = siteOf(url);
  if (!site) throw new Error(`认不出的站点：${url}`);
  if (!(await connect())) throw new Error('浏览器没连上：先开着 Chromium（9223 端口）再抓');
  return { value: await inPage(site, url, expr, undefined, { wait }), via: 'channel' };
}

/** 带登录态的 node fetch：三站走这条，比开浏览器快且不占屏幕。force=true 重取登录态（401 后重试用）。 */
export async function fetchAs(site, url, opts = {}, force = false) {
  const cookie = await cookieHeader(site, force);
  if (cookie == null) return null; // 浏览器没连上
  const headers = { ...(opts.headers || {}), cookie };
  return fetch(url, { ...opts, headers });
}

/** 只断开我们的引用，绝不关用户的浏览器、绝不关用户开的标签。 */
/** 关掉本进程开的标签页。抓取子进程退出前必须调，否则会往用户 Chrome 里一直堆标签。 */
export async function closePages() {
  const list = [...pages.values()].filter((p) => !p.isClosed());
  pages.clear();
  if (!list.length) return;
  // 关掉最后一个标签页 Chrome 会连着退出，所以先垫一张空白页再关自己的
  try {
    const ctx = list[0].context();
    if (ctx) {
      const alive = ctx.pages().filter((p) => !p.isClosed());
      if (alive.length <= list.length) await ctx.newPage();
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
  console.assert(pick('makeronline')[0].name === 'c', 'makeronline 命中');
  console.assert(pick('snapmaker').length === 0, '没登录的站返回空');
  console.log('channel demo ok');
}

if (path.basename(process.argv[1] || '') === 'channel.mjs') {
  if (process.argv.includes('--live')) {
    const b = await connect();
    console.log('connected:', !!b);
    const h = await cookieHeader('creality');
    console.log('creality cookie names:', h ? h.split('; ').map((s) => s.split('=')[0]).join(',') : '(未连接)');
    forget();
    process.exit(0);
  } else demo();
}

// 登录态探测：四站各打一个便宜的鉴权接口，返回用户名/uid 才算真登录（用户口径，见 GLOSSARY）。
// 凭据只在内存里过一遍，不落盘、不打印（ADR-0001）。
import * as sites from './sites/index.mjs';
import * as ch from './channel.mjs';

// 一个卡住的请求不能把控制台挂住（以前实测挂 22 秒以上）
const TIMEOUT_MS = Number(process.env.MARKLAB_PROBE_TIMEOUT_MS) || 15_000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`探测超时（${ms / 1000} 秒没响应）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 顺序就是控制台里的显示顺序，由 sites/index.mjs 的登记顺序决定
const ORDER = sites.all().map((p) => p.site);

/** 探测一个站。返回 {site,label,ok,status,name,reason}。站点自己的事都在包里，这里只管调用。 */
export async function probe(site) {
  const pack = sites.byName(site);
  if (!pack) return { site, ok: false, status: 'unknown', reason: '未知站点' };
  try {
    return { site, label: pack.label, ...(await withTimeout(pack.loginState(), TIMEOUT_MS)) };
  } catch (e) {
    return { site, label: pack.label, ok: false, status: 'unknown', reason: String(e.message || e).slice(0, 120) };
  }
}

/** 全部站点，并发探测。 */
export async function probeAll() {
  return Promise.all(ORDER.map(probe));
}

// 探测结果缓存 60 秒：控制台轮询别每次都打站点接口。
let cache = null;
let cacheAt = 0;

/** 请求失败不等于没登录：新结果是 unknown、旧结果已知时，留旧结果并标 stale。 */
export function mergeUnknown(prev, fresh) {
  if (!Array.isArray(prev)) return fresh;
  return fresh.map((r) => {
    if (r.status !== 'unknown') return r;
    const old = prev.find((p) => p.site === r.site);
    if (old && old.status !== 'unknown') return { ...old, stale: true, reason: r.reason };
    return r;
  });
}

export async function state(force = false) {
  if (!force && cache && Date.now() - cacheAt < 60_000) return cache;
  // 点「重新检测」要跳过 300 秒 cookie 缓存：丢掉连接，下次调用自然重连重取
  if (force) ch.forget();
  cache = mergeUnknown(cache, await probeAll());
  cacheAt = Date.now();
  return cache;
}

export const SITES = ORDER.map((site) => ({ site, label: sites.byName(site)?.label || site }));

if ((process.argv[1] || '').split(/[\\/]/).pop() === 'session.mjs') {
  const rows = await state(true);
  for (const r of rows) {
    const mark = r.ok ? '✓' : r.status === 'unknown' ? '?' : '✗';
    console.log(`${mark} ${r.label.padEnd(14)} ${r.ok ? r.name : r.reason || r.status}`);
  }
  process.exit(0);
}

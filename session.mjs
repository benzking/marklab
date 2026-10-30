// 登录态探测：四站各打一个便宜的鉴权接口，返回用户名/uid 才算真登录（用户口径，见 GLOSSARY）。
// 凭据只在内存里过一遍，不落盘、不打印（ADR-0001）。
import * as sites from './sites/index.mjs';

// 顺序就是控制台里的显示顺序；标签优先取站点包自己的
const ORDER = ['creality', 'makerworld', 'snapmaker', 'makeronline.cn', 'makeronline.com'];

/** 探测一个站。返回 {site,label,ok,status,name,reason}。站点自己的事都在包里，这里只管调用。 */
export async function probe(site) {
  const pack = sites.byName(site);
  if (!pack) return { site, ok: false, status: 'unknown', reason: '未知站点' };
  try {
    return { site, label: pack.label, ...(await pack.loginState()) };
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
export async function state(force = false) {
  if (!force && cache && Date.now() - cacheAt < 60_000) return cache;
  cache = await probeAll();
  cacheAt = Date.now();
  return cache;
}

export const SITES = ORDER.map((site) => ({ site, label: sites.byName(site)?.label || site }));

if ((process.argv[1] || '').split(/[\\/]/).pop() === 'session.mjs') {
  const rows = await state(true);
  for (const r of rows) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.label.padEnd(14)} ${r.ok ? r.name : r.reason || r.status}`);
  }
  process.exit(0);
}

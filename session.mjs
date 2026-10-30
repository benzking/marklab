// 登录态探测：四站各打一个便宜的鉴权接口，返回用户名/uid 才算真登录（用户口径，见 GLOSSARY）。
// 凭据只在内存里过一遍，不落盘、不打印（ADR-0001）。
import * as ch from './channel.mjs';
import * as sites from './sites/index.mjs';

// 顺序就是控制台里的显示顺序；标签优先取站点包自己的
const ORDER = ['creality', 'makerworld', 'snapmaker', 'makeronline.cn', 'makeronline.com'];

// 还没搬进站点包的站：token cookie 名 + 鉴权接口。票 05 搬完这张表就空了。
const PROBES = {
  'makeronline.com': {
    label: 'MakerOnline.com',
    host: 'https://www.makeronline.com',
    tokenCookie: 'mo_access_token',
    async run(cookieMap, host) {
      const r = await ch.fetchAs('makeronline', `${host}/api/user/personal/info`, {
        headers: { authorization: cookieMap.mo_access_token || '' },
      });
      if (!r) return offline();
      const j = await r.json().catch(() => null);
      const u = j?.data || j?.result;
      return r.ok && u?.user_name ? { ok: true, name: u.user_display_name || u.user_name } : { ok: false, status: 'logged-out' };
    },
  },
};

const offline = () => ({ ok: false, status: 'unknown', reason: '浏览器未连接' });

/** 探测一个站。返回 {site,label,ok,status,name,reason}。 */
export async function probe(site) {
  const pack = sites.byName(site);
  if (pack) {
    try {
      return { site, label: pack.label, ...(await pack.loginState()) };
    } catch (e) {
      return { site, label: pack.label, ok: false, status: 'unknown', reason: String(e.message || e).slice(0, 120) };
    }
  }
  const cfg = PROBES[site];
  if (!cfg) return { site, ok: false, status: 'unknown', reason: '未知站点' };
  try {
    const all = await ch.cookies();
    if (!all) return { site, label: cfg.label, ...offline() };
    const domains = ch.DOMAINS[site] || [];
    const cookieMap = {};
    for (const c of all) {
      // 只认同域或子域：`.cn` 与 `.com` 是两套登录态，混进来会认错人（spec §7）
      if (domains.some((d) => c.domain === d || c.domain === '.' + d || c.domain.endsWith('.' + d))) cookieMap[c.name] = c.value;
    }
    if (cfg.tokenCookie && !cookieMap[cfg.tokenCookie]) {
      return { site, label: cfg.label, ok: false, status: 'logged-out' };
    }
    const r = await cfg.run(cookieMap, cfg.host);
    return { site, label: cfg.label, ...r };
  } catch (e) {
    return { site, label: cfg.label, ok: false, status: 'error', reason: String(e.message || e).slice(0, 120) };
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

export const SITES = ORDER.map((site) => ({ site, label: sites.byName(site)?.label || PROBES[site]?.label || site }));

if ((process.argv[1] || '').split(/[\\/]/).pop() === 'session.mjs') {
  const rows = await state(true);
  for (const r of rows) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.label.padEnd(14)} ${r.ok ? r.name : r.reason || r.status}`);
  }
  process.exit(0);
}

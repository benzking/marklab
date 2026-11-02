// 签到统一入口。站点自己的事在 `sites/<站>.mjs` 的 `checkin({dry})` 里，这里只负责跑和打印。
// 登录态只从本机浏览器现取，不落盘、不打印（ADR-0001）。
// 用法：node checkin.mjs [站点…] [--dry]
import * as ch from './channel.mjs';
import { checkinText } from './lib.mjs';
import * as sites from './sites/index.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const want = argv.filter((a) => !a.startsWith('--'));

async function main() {
  const packs = sites.all().filter((p) => typeof p.checkin === 'function' && (!want.length || want.includes(p.site)));
  if (!packs.length) {
    const known = sites.all().filter((p) => p.checkin).map((p) => p.site);
    throw new Error(`没有可签到的站点（包里登记了 checkin 的：${known.join(' ') || '无'}）`);
  }
  let bad = 0;
  for (const p of packs) {
    try {
      const r = await p.checkin({ dry });
      console.log(`${p.label || p.site}：${checkinText(r, !dry)}`);
    } catch (e) {
      bad++;
      console.error(`${p.label || p.site}：${e.message}`);
    }
  }
  if (bad) process.exitCode = 1;
}

/**
 * 自动签到：每 10 分钟看一眼，站点开了 `checkinAuto` 且今天（北京时间）还没试过就跑一次。
 * 先 dry 探一次再决定签不签，已签就不发签到请求。只记在内存里——重启后当天会再试一次，
 * 一天一次不算多，也就不必落盘记状态。
 */
export function startAuto(getConfig) {
  const tried = new Map(); // site -> 北京时间日期
  const bjDay = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const tick = async () => {
    const cfg = getConfig() || {};
    const day = bjDay();
    for (const p of sites.all()) {
      if (!cfg[p.site]?.checkinAuto || typeof p.checkin !== 'function') continue;
      if (tried.get(p.site) === day) continue;
      tried.set(p.site, day); // 先占位：失败了也不在同一天反复打站点
      try {
        const st = await p.checkin({ dry: true });
        if (st.signed) continue;
        const r = await p.checkin({});
        console.log(`[自动签到] ${p.label || p.site}：${checkinText(r, true)}`);
      } catch (e) {
        console.error(`[自动签到] ${p.label || p.site}：${e.message}`);
      }
    }
  };
  setTimeout(tick, 30_000); // 等首屏探完登录态再动浏览器
  return setInterval(tick, 10 * 60_000);
}

if ((process.argv[1] || '').split(/[\\/]/).pop() === 'checkin.mjs') {
  // playwright 的 WS 会撑住事件循环，脚本跑完必须自己退（channel.mjs 末尾有同样的提醒）
  main()
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => {
      ch.forget();
      process.exit();
    });
}

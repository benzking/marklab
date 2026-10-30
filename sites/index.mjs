// 站点包登记表。加一个站点 = 新增一个包文件 + 在这里登记一行（docs/spec.md §2）。
// 公共层不许出现 `if (site === ...)`，站点之间的差异都在各自的包里。
import snapmaker from './snapmaker.mjs';
import creality from './creality.mjs';
import makerworld from './makerworld.mjs';
import makeronlineCn from './makeronline-cn.mjs';
import makeronlineCom from './makeronline-com.mjs';

// 顺序 = 控制台里的显示顺序
const PACKS = [creality, makerworld, snapmaker, makeronlineCn, makeronlineCom];
// aliases 让「搜索/订阅沿用旧键」和「.cn/.com 共用一个数据命名空间」都能落到同一个包上
const BY_NAME = new Map(PACKS.flatMap((p) => [p.site, ...(p.aliases || [])].map((k) => [k, p])));

export const all = () => PACKS;
export const byName = (name) => BY_NAME.get(name) || null;

/** 只在测试里用：注册一个假站点包，证明「加站点只碰一个文件」。生产代码不许调。 */
export function registerForTest(pack) {
  PACKS.push(pack);
  for (const k of [pack.site, ...(pack.aliases || [])]) BY_NAME.set(k, pack);
  return pack;
}

/** 网址 → { name, id, url }，认不出返回 null。url 是包重组出来的干净地址，抓取只用它。 */
export function match(raw) {
  for (const p of PACKS) {
    const hit = p.match(raw);
    if (hit) return hit;
  }
  return null;
}

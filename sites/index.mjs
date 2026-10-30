// 站点包登记表。加一个站点 = 新增一个包文件 + 在这里登记一行（docs/spec.md §2）。
// 公共层不许出现 `if (site === ...)`，站点之间的差异都在各自的包里。
import snapmaker from './snapmaker.mjs';
import creality from './creality.mjs';

const PACKS = [snapmaker, creality];
const BY_NAME = new Map(PACKS.map((p) => [p.site, p]));

export const all = () => PACKS;
export const byName = (name) => BY_NAME.get(name) || null;

/** 网址 → { name, id, url }，认不出返回 null。url 是包重组出来的干净地址，抓取只用它。 */
export function match(raw) {
  for (const p of PACKS) {
    const hit = p.match(raw);
    if (hit) return hit;
  }
  return null;
}

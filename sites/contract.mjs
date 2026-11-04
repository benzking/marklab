// 站点包的「抽象类」：成员表 + 返回模型（DTO）+ 能力声明，全是纯数据与纯函数。
//
// 站点包**不 import 这个文件**（每个包要能单文件 `node sites/xxx.mjs` 跑自检），
// 用它的只有 test.mjs 的契约测试和各包 demo() 里的一行断言。
// 文档 docs/site-pack.md §11 是这些形状的人话版；两边冲突时以本文件为准。

// ── 成员表：唯一真相 ───────────────────────────────────────────
// 加一个成员 = 这里加一行 + 文档加一行；改名只改这里，测试自动跟上。
export const PACK_FIELDS = {
  required: ['site', 'platform', 'label', 'hosts', 'discover', 'categoriesKey'],
  optional: ['aliases', 'loginOnly', 'searchOptions', 'rate', 'filters', 'feeds'],
};

export const MEMBERS = {
  required: ['match', 'loginState', 'meta', 'fileLinks', 'search'],
  optional: ['checkin', 'checkinStatus', 'userModels', 'categories', 'feed'],
};

// ── 共用词表 ───────────────────────────────────────────────────
export const LOGIN_STATUS = ['logged-in', 'logged-out', 'unknown'];
export const FILE_KINDS = ['model', 'profile', 'doc'];
export const ORIGINS = ['author', 'other'];
// 排序键的并集。每个包在自己的 searchOptions.sorts 里声明支持哪几个。
// 顺序只决定下拉框排列，**不是**默认序的声明：默认序 = 不传 sort 参数，由站点自己给
// （人话标签见 searchOptions.defaultLabel）。空数组 = 本站不支持排序（只能相关度）。
export const SORTS = ['downloads', 'likes', 'collects', 'newest', 'hot', 'score', 'views', 'prints', 'trend'];
// 筛选词表：键是语义键（公共层只认这个），值是允许的语义值。包声明子集，
// 自己翻译成原生参数——公共层不碰 colorType / multiColor 这些名字。
export const FILTERS = {
  color: ['multi', 'single'],
  badge: ['picked', 'exclusive', 'curated', 'member', 'cyberbrick', 'supply', 'customizable', 'parametric'],
};

// meta() 必须给出的键（fetchedAt / savedFiles / autoTags / dir 由 grab.mjs 补，不在这里）
export const META_KEYS = ['platform', 'id', 'sourceUrl', 'title', 'author', 'description', 'images', 'stats', 'profiles', 'print', 'category', 'tags'];

// ── 返回模型断言 ───────────────────────────────────────────────
const isStr = (v) => typeof v === 'string';
const isNum = (v) => Number.isFinite(v);

/** meta() 的返回值：适配器必写的那些键都在。 */
export const isModelMeta = (m) =>
  !!m && META_KEYS.every((k) => k in m) && isStr(m.platform) && isStr(m.id) && isStr(m.title) && Array.isArray(m.images) && Array.isArray(m.profiles) && Array.isArray(m.tags);

/** fileLinks() 的每一项。 */
export const isFileLink = (l) => !!l && isStr(l.name) && /^https?:/.test(l.url || '') && FILE_KINDS.includes(l.kind) && ORIGINS.includes(l.origin) && (l.size === undefined || isNum(l.size));

/** search() / userModels() 的返回：total 拿不到就是 null，不许用 0 冒充。 */
export const isPage = (p) => !!p && Array.isArray(p.items) && (p.total === null || isNum(p.total));

/** categories() 的返回：一级 [{id, name, children:[{id, name}]}]。 */
export const isCategoryTree = (t) => Array.isArray(t) && t.every((c) => isNum(c?.id) && isStr(c?.name) && Array.isArray(c?.children) && c.children.every((x) => isNum(x?.id) && isStr(x?.name)));

/** loginState() 的返回。 */
export const isLoginState = (s) => !!s && typeof s.ok === 'boolean' && LOGIN_STATUS.includes(s.status) && (s.name === undefined || isStr(s.name)) && (s.reason === undefined || isStr(s.reason));

/** checkin() 与 checkinStatus().checkin 共用的签到结果。没有 text——文案是公共层的事。 */
export const isCheckin = (c) => !!c && typeof c.signed === 'boolean' && c.text === undefined && (c.streak === undefined || isNum(c.streak)) && (c.gain === undefined || isNum(c.gain)) && (c.note === undefined || isStr(c.note));

/** checkinStatus() 的返回。 */
export const isCheckinStatus = (s) => !!s && (s.points === undefined || isNum(s.points)) && (s.checkin === undefined || isCheckin(s.checkin));

/** searchOptions：本站支持哪些排序、页大小是否固定、搜索结果带不带标签。 */
export const isSearchOptions = (o) =>
  !!o && Array.isArray(o.sorts) && o.sorts.every((s) => SORTS.includes(s)) && new Set(o.sorts).size === o.sorts.length && typeof o.tags === 'boolean' && (o.pageSize === undefined || (Number.isInteger(o.pageSize) && o.pageSize > 0)) && (o.defaultLabel === undefined || (typeof o.defaultLabel === 'string' && o.defaultLabel.trim() !== ''));

/** filters：本站支持哪些筛选。键在词表里，值是该键的子集且非空、不重复。 */
export const isFilters = (o) =>
  !!o && Object.keys(o).length > 0 && Object.entries(o).every(([k, vs]) => Object.hasOwn(FILTERS, k) && Array.isArray(vs) && vs.length > 0 && new Set(vs).size === vs.length && vs.every((v) => FILTERS[k].includes(v)));

/** feeds：本站声明了哪些榜单源。key 是稳定 ASCII，包内唯一；label 是给人看的话。 */
export const isFeeds = (f) => Array.isArray(f) && f.length > 0 && f.every((x) => isStr(x?.key) && /^[\x21-\x7e]+$/.test(x.key) && isStr(x?.label) && x.label.trim() !== '') && new Set(f.map((x) => x.key)).size === f.length;

/** 一个包的形状对不对：返回问题列表，空数组就是全对。 */
export function checkPack(p) {
  const bad = [];
  if (!p || typeof p !== 'object') return ['不是对象'];
  for (const f of PACK_FIELDS.required) if (p[f] === undefined) bad.push(`缺字段 ${f}`);
  for (const f of PACK_FIELDS.optional) if (p[f] !== undefined && p[f] === null) bad.push(`${f} 不许是 null（没有就是键不存在）`);
  if (!Array.isArray(p.hosts) || !p.hosts.length) bad.push('hosts 要是非空数组');
  for (const m of MEMBERS.required) if (typeof p[m] !== 'function') bad.push(`缺必需成员 ${m}`);
  for (const m of MEMBERS.optional) if (p[m] !== undefined && typeof p[m] !== 'function') bad.push(`${m} 要么是函数、要么键不存在`);
  if (p.searchOptions !== undefined && !isSearchOptions(p.searchOptions)) bad.push('searchOptions 形状不对');
  if (p.filters !== undefined && !isFilters(p.filters)) bad.push('filters 形状不对（键和值都得在词表里，值非空不重复）');
  if (p.feeds !== undefined && !isFeeds(p.feeds)) bad.push('feeds 形状不对（要非空数组，key 非空 ASCII 且唯一，label 非空）');
  // 同进同退：有 feeds 没 feed()，控制台会给出一个点了就报错的下拉项；反之没人用得上。
  if (p.feeds !== undefined && typeof p.feed !== 'function') bad.push('声明了 feeds 却没有 feed() 成员');
  if (p.feed !== undefined && p.feeds === undefined) bad.push('有 feed() 成员却没声明 feeds');
  if (p.rate !== undefined && !Array.isArray(p.rate?.modelGapSec)) bad.push('rate.modelGapSec 要是 [最小, 最大]');
  return bad;
}

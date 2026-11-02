# 站点包契约

> **本文是站点包的唯一契约**（2026-11-02 定稿）：包该有什么、每个成员收什么返什么、没有的能力怎么写。
> `docs/spec.md` 说要什么，`README.md` 说怎么用，`GLOSSARY.md` 定词，`docs/adr/` 记为什么。
> 这四份与本文冲突时，**以本文为准**，然后改那四份。
> `docs/architecture.md` 里关于站点包的部分是重构前的构想，已作废。

## 0. 一句话

**一个包 = 一个域名 + 一套账号。** 加站点只加一个文件，公共层和前端一行不用改。

## 1. 边界：什么该进包，什么不许进

**进包**（只有这个站知道答案的事）：

- 网址怎么认（host 白名单 + pathname 正则）、页面怎么解析、文件链接怎么签
- cookie 怎么挑、接口要带哪些头、匿名还是必须登录
- 站点固有的默认限速（`rate`）
- 这个站能提供的人类可读状态：登录态、积分、签到

**不许进包**（公共层的事，包里写一份就是第六个副本）：

- 队列调度、闸门推进 → `tasks.mjs`
- 跨站判重、库目录命名 → `grab.mjs` / `dup.mjs`
- 展示文案（「该站不提供积分」这种话由服务端按能力位生成，包里不写）
- cookie 域过滤规则 → `channel.mjs` 一份，包里不许各写一份（`endsWith(h)` 会让
  `evilcrealitycloud.cn` 混进来，正确写法是 `c.domain === h || c.domain === '.' + h || c.domain.endsWith('.' + h)`）

## 2. 数据字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `site` | ✅ | 包键，登录态 / cookie / 请求头按它取。**例外见 §8** |
| `platform` | ✅ | 数据键：库目录、判重键、进度用它。**一个域名一个键** |
| `label` | ✅ | 给人看的名字（`创想云` / `MakerWorld` / `MakerOnline.cn`） |
| `hosts` | ✅ | 精确 host 白名单，`www.` 已在 `match()` 里剥掉 |
| `discover` | ✅ | 是否参与「随便逛逛」的搜索预算 |
| `categoriesKey` | ✅ | 分类 id 空间的键，不是数据键 |
| `aliases` | ⬜ | 历史键 → 本包（`makeronline` → `.cn`）。只在入口认，返回一律用规范键 |
| `loginOnly` | ⬜ | 必须登录的接口路径前缀，给 `authneed.mjs` 的升级链用 |
| `searchOptions` | ⬜ | 本站能怎么搜：支持的排序键、页大小是否固定（§11.2）。**不写 = 只支持默认序** |
| `rate` | ⬜ | 本站固有的模型间隔 `{modelGapSec: [最小, 最大]}`，秒（§6） |

## 3. 必需成员（5 个，缺一个包就不成立）

| 成员 | 签名 | 返回 | 边界 |
|---|---|---|---|
| `match` | `(raw: string)` | `{site, id, url}` 或 `null` | 只认自己的 host + pathname；认不出返 `null`，不猜 |
| `loginState` | `()` | `LoginState`（§11.1） | 连不上浏览器是 `unknown`，**不许报成 `logged-out`** |
| `meta` | `(url: string)` | `ModelMeta`（§11.1，字段见 spec §4.1） | 解析失败抛错，不许返回半截对象 |
| `fileLinks` | `(model)` | `FileLink[]`（§11.1） | 拿不到就抛错并说清原因（要登录 / 站点不给） |
| `search` | `({keyword, page, pageSize, sort})` | `Page<ModelListItem>`（§11.1） | 匿名可跑；失败必须让调用方知道，不许 catch 成空数组 |

`items` 的每一条与 `meta()` 的模型对象同形（归一化后的字段名），额外带 `site`。

## 4. 可选成员（4 个）

| 成员 | 签名 | 返回 | 谁有 |
|---|---|---|---|
| `checkin` | `({dry = false})` | `CheckinResult`（§11.1） | 创想云、MakerOnline.cn |
| `userModels` | `({uid, page, pageSize})` | `Page<ModelListItem>`（§11.1） | 五站都有 |
| `categories` | `()` | `Category[]`（§11.1） | 创想云、MakerWorld、Snapmaker、makeronline.com（**makeronline.cn 没有**，见 §8） |
| `checkinStatus` | `()` | `CheckinStatus`（§11.1） | 创想云、MakerOnline.cn |

形状见 §11.1 的 `CheckinStatus`。`checkin()` 返回的是同一个 `CheckinResult`，
所以「读状态」和「真去签」两条路给的东西一模一样，公共层只需要一套拼文案的代码。

**登录态不从这里出。** `loginState()` 已经是那个口，5 个包都有、`session.mjs` 也在用，
再包一层只是换个名字。服务端 `GET /api/console/sites` 自己把 `session.state()` 和 `checkinStatus()` 拼起来。

**没有额度、没有重置时间。** 参考图里那两样是别人家站点的概念，我们没有，不造字段。
一个口而不是 `points()`/`quota()`/`checkinState()` 三个口：五站里只有两个有积分，
三个口等于写十五个函数、十个是空的。

积分从哪来（都是现成接口，不用另抓）：创想云 `getInfo` 的 `result.walletUserInfo.kwbeans`
（`expPoints` 是累计经验、`coin` 是星标积分，都不是它）；makeronline.cn `/api/user/integral/task` 的 `data.integral`。

## 5. 「没有」怎么写

**键不存在就是没有。** 不写 `categories: null`，不写空函数占位。

- 公共层：`typeof pack.checkinStatus === 'function'` 判断，没这个键就跳过
- 前端：能力位由服务端 `GET /api/console/sites` 现推下发，**前端不许再存一份站点能力表**

## 6. 限速

三层，从下往上覆盖：

| 层 | 在哪 | 值 | 能不能改 |
|---|---|---|---|
| 全局默认 | `tasks.mjs` `MIN_GAP` / `MAX_GAP` | 60–120 秒 | env `MARKLAB_MIN_GAP/MAX_GAP`、CLI `--min-gap/--max-gap` |
| 站点固有 | 包里的 `rate` | 不写就是跟随全局 | 改代码 |
| 用户覆盖 | `data/site-config.json` | 控制台可写、手也能改 | 随时改 |

`data/site-config.json` 的形状（只认这三个键，别的整条丢弃）：

```json
{ "snapmaker": { "modelGapSec": [90, 150], "searchPerMin": 8, "checkinAuto": true } }
```

| 键 | 意思 | 范围 |
|---|---|---|
| `modelGapSec` | 模型之间的间隔（秒），写成 `[最小, 最大]` | 过 60 秒地板 |
| `searchPerMin` | 这个站的搜索频率（次/分），间隔自动算成 `60000/N` | 1–60 |
| `checkinAuto` | 自动签到开关（`checkin.mjs` 每 10 分钟探一次，已签不发请求） | 布尔 |

生效顺序：**用户覆盖 > 包 `rate` > 全局默认**。**60 秒地板对三层都生效**，任何来源都压不到 60 以下
（调小等于关掉限速，见 AGENTS.md「不可省」）。

- 闸门按站独立：某站的间隔没到，只推迟这个站的任务，别的站照跑。
- 模型内部文件之间的 5–10 秒（`grab.mjs`）**不可按站配**：它已经是秒级，按站调收益为零。
- 搜索默认 4 次/分、间隔 ≥15 秒（`search.mjs` `RATE`）；按站调 `searchPerMin` 时
  `perSite = N`、`minGapMs = 60000/N`，填 4 就等于默认值。

## 7. 加一个站点要做什么

1. 新建 `sites/<key>.mjs`，默认导出 §2 的字段 + §3 的必需成员（能提供的 §4 成员一并导出），
   支持的排序键写进 `searchOptions.sorts`（§11.2），没有就留空数组
2. `sites/index.mjs` 的 `PACKS` 加一行
3. `test.mjs` 的站点数断言 +1；`node --test test.mjs` 里 `checkPack()` 必须报空
4. `docs/site-pack.md` §11.3 的能力矩阵加一列
5. **前端不用动**：能力位、标签、颜色、排序键都由服务端下发（`/api/console/sites` 的 `abilities`）

## 8. 例外与已知边界

- **MakerWorld 的键是站名不是域名。** 现在接的是 `makerworld.com.cn`，`site` / `platform` 都叫
  `makerworld`（九个库目录、判重键已用它）。`makerworld.com`（世界站）是**另一个站、另一套账号体系**，
  未接；要接就新开一个包，键用 `makerworld.com`，**不许把 `makerworld.com` 加进现有包的 `hosts`**。
- **MakerOnline 的 `.cn` 和 `.com` 两个包不合并**，接受约 250 行重复：共用会让 `.cn` 的探测带上
  `.com` 的 token（2026-10-30 修过的真 bug）。
- **makeronline.cn 没有 `categories()`**：它的分类 id 和 makeronline.com 不同，硬套 makeronline.com 的分类树是错的，
  它只有 `categoriesKey`。
- **`.cn` / `.com` 是两套账号**：`.cn` 登录了不代表 `.com` 登录了，cookie 永不合并。

## 9. 契约测试

`test.mjs`，纯形状断言，不联网、不开浏览器：

- 每个包：`checkPack()` 返回空数组（`sites/contract.mjs` 里那份成员表是唯一真相，
  文档这张表只是它的人话版）
- 返回模型逐个过断言：`isModelMeta` / `isFileLink` / `isPage` / `isCategoryTree` /
  `isLoginState` / `isCheckin` / `isCheckinStatus` / `isSearchOptions`
- 可选成员要么是函数、要么键不存在（不许 `null` 占位）
- 「加一个站点只碰一个文件」：用 `_fixture.mjs` 注册，断言总数 +1
- cookie 域过滤只认同域与子域：`cookiesFor()` 一条断言，`evil-makeronline.cn` 不许混进来

成员的行为（真去请求站点）不在契约测试里——要联网，靠各包自带的自检（文件直接执行时跑）。

## 10. 与其它文档的关系

| 文档 | 说 | 关于站点包的部分 |
|---|---|---|
| `docs/spec.md` §2 | 要什么（需求） | 指向本文；网址硬规则（§2.1）仍在 spec |
| `README.md` | 现在怎么用 | 能力表是给人看的摘要，改包时跟着改 |
| `GLOSSARY.md` | 叫什么 | 「站点包」「登录状态刷新」两条 |
| `docs/adr/` | 为什么这么定 | ADR-0006 记「闸门从全局变按站」 |
| `docs/architecture.md` | 怎么搭的 | **已作废**，别照它写 |

## 11. 返回模型（DTO）

**成员只许返回下面这八种之一。** 形状定义在 `sites/contract.mjs`，每个配一个断言函数；
测试与各包 `demo()` 用同一个断言，不存在第二份说法。

### 11.1 八种形状

| DTO | 谁返回 | 字段 | 断言 |
|---|---|---|---|
| `ModelMeta` | `meta()` | `platform` `id` `sourceUrl` `title` `author` `description` `images[]` `stats{downloads}` `profiles[]` `print` `category` `tags[]`；条件写：`authorUid` `authorAvatar` `publishedAt` `picked` `docs[]` `files[]` `fileIds[]` `translated` | `isModelMeta` |
| `ModelListItem` | `search().items[]`、`userModels().items[]` | `site` `id` `title` `url` `cover` `author` `likes` `downloads` `collects` `comments` `picked` `publishedAt` `tags[]` —— **13 个键五站逐字相同**，站点没这个数就写 `null` | 无（列表项不单独立断言，靠 `isPage` + 各站 `normalize()` 自检） |
| `Page<T>` | `search()`、`userModels()` | `{ total: number \| null, items: T[] }` —— **拿不到总数写 `null`，不许用 `0` 冒充**（`0` 会被订阅当成「到底了」） | `isPage` |
| `FileLink` | `fileLinks()` | `{ name, url, size?, kind: 'model'\|'profile'\|'doc', origin: 'author'\|'other' }` | `isFileLink` |
| `Category[]` | `categories()` | `[{ id: number, name: string, children: [{ id: number, name: string }] }]`，只到二级 | `isCategoryTree` |
| `LoginState` | `loginState()` | `{ ok: boolean, status: 'logged-in'\|'logged-out'\|'unknown', name?, reason? }` | `isLoginState` |
| `CheckinResult` | `checkin()` **和** `checkinStatus().checkin` | `{ signed: boolean, streak?: number, gain?: number, note?: string }` —— **没有 `text`** | `isCheckin` |
| `CheckinStatus` | `checkinStatus()` | `{ points?: number, checkin?: CheckinResult }` | `isCheckinStatus` |

三条硬规矩：

1. **`null` 只许出现在 `ModelListItem`**（站点没这个数）。其它 DTO 里「没有」= 键不存在（§5）。
2. **文案不进 DTO。** `note` / `reason` 是给人看的诊断串（「浏览器没连上」），不是 UI 文案；
   「今天已签 +10」「连签 3 天」这种由公共层按字段拼，包不许拼中文句子。
3. **一个语义只有一种形状。** 「签到结果」只有 `CheckinResult`，「列表」只有 `Page<T>`；
   新增成员时先找现成 DTO，找不到再商量加，不许各造一个。

### 11.2 搜索能力声明 `searchOptions`

```js
searchOptions: {
  sorts: ['downloads', 'likes', 'collects', 'newest'], // 有序：第一项 = 该站默认序；[] = 本站不支持排序
  pageSize: 20,                                        // 可选：站点页大小固定时写死，调用方别指望改
}
```

- 排序键并集（`contract.mjs` 的 `SORTS`）：`downloads` / `likes` / `collects` / `newest` / `hot` / `score`。
  新增键先加进并集，再用。
- **不写 `searchOptions` = 只支持默认序**，等价于 `sorts: []`。
- **回落是公共层的事**：`search.mjs` 收到本站 `sorts` 里没有的键，换成 `sorts[0]`
  （空数组就不带 sort），并把实际用的 `sort` 放回返回值，调用方和日志都看得见。
  包里的 `SORT[sort] || 默认` 只当第二道保险，不承担语义。
- 展示文案（「按下载量」）在公共层的 `SORT_LABEL` 表里，**不进包**。

### 11.3 能力矩阵

2026-11-02 实测，`✓` 有 / `✗` 没有 / `△` 有条件。改包时同步这张表。

| 能力 | 创想云 | MakerWorld | Snapmaker | makeronline.cn | makeronline.com |
|---|---|---|---|---|---|
| `loginState` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `meta` 匿名 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `fileLinks` 匿名 | ✗ 要登录 | ✓ | ✓ | ✓ | ✓ |
| `search` 匿名 | ✓ | ✓（走浏览器） | ✓ | ✓ | ✓ |
| `searchOptions.sorts` | downloads, likes, collects, newest | downloads, likes, newest, hot, score | downloads, likes, collects, newest | downloads, likes, newest | downloads, likes, newest |
| 页大小固定 | 否 | **20** | 否 | 否 | 否 |
| `userModels` | ✓ | ✓ 走浏览器 | ✓ | ✓ | ✓ |
| `categories` | ✓ | ✓ | ✓ | ✗ | ✓ |
| `checkin` / `checkinStatus` | ✓ / ✓ | ✗ / ✗ | ✗ / ✗ | ✓ / ✓ | ✗ / ✗ |

# MakerWorld 脱离浏览器取数（探测记录）

2026-11-03 探测。目标（用户 m00001）：MakerWorld「匿名搜索」当时做不到，能否脱离真浏览器搜索、减少浏览器占用。

**结论：能。** 搜索/详情/用户列表/分类可全部改用公开 API（纯 node fetch，不碰浏览器）；下载（CDN 裸链部分）本来就不碰浏览器；只有 f3mf 兜底与登录态探测必须保留浏览器。

## 关键事实

- `api.bambulab.cn`（国内）是 MakerWorld 的公开 API 域名，与 `makerworld.com.cn` **同一套 id 空间、同一份数据**：
  - design 195581 两边都是「COC 部落冲突 11级大本营」；
  - 搜索 benchy/小船/dragon/花瓶 total 完全一致（3014/3551/3693/3547），前 20 条 id 逐条相同、翻页相同、五种 orderBy 相同。
- `api.bambulab.com`（全球）是**另一套 id 空间**，别用（benchy total 2808 vs .cn 3014，重叠 0/20）。
- api.bambulab.cn **完全无防护**：不带 UA/cookie 200、curl UA 也 200、20 并发全 200、连续 20 页全 200。

## 各接口结论

| 能力 | 公开 API（node fetch） | 备注 |
|---|---|---|
| 搜索 | ✅ `GET /v1/search-service/select/design2?orderBy&designType=0&isFromSearchList=false&keyword&limit=20&offset&ref_=0031_07q_yz` | 与页面一致（orderBy 映射见站点包 `ORDER`） |
| 详情 | ✅ `GET /v1/design-service/design/<id>` | 与页内 JSON 逐字段一致；`/instances` 也 200 |
| 用户作品列表 | ✅ `GET /v1/design-service/published/<数字uid>/design?limit=20&offset=N` | **要数字 uid**；handle 当 uid 用回 400 |
| 一级分类 | ✅ `GET /v1/search-service/homepage/nav` | **只有一级**，无二级树；二级在搜索接口用 `categories=<id>` |
| CDN 3mf 裸链 | ✅ node HEAD/GET 都行 | `content-length` = `modelInfo.f3mf.size`，缓存一年、支持 Range |
| f3mf 兜底 | ❌ 403 `Please log in to download models.` | 带浏览器全量 cookie 也 403——认的不是 cookie，是另一套鉴权 |
| 登录态探测 | ❌ 无公开端点（`/v1/user-service/my/profile` 401，其余 404） | 必须保留浏览器路径 |
| 用户搜索（handle→uid） | ❌ 无公开端点（6 个候选全 404） | 订阅存的是 handle；published 要数字 uid |

## 筛选参数语义（api 与页面双向验证）

- 真生效：`model_tag=featured`（精选，花瓶 3547→11）、`customizable=true`（→2267）、`makersSupply=true`（→467）、`multiColor=true|false`（带 keyword 时收窄）。
- 无效（被静默忽略，total 不变）：`model_tag=exclusive`、`exclusive=true`、`cb=true`（命中条目 cyberBrickNeeded 也空）。
- 页面点「筛选」面板：筛选进 **URL/SSR**（`?keyword=…&model_tag=featured`），不发额外 select 请求；翻页请求带 `multiColor` 但不带 `model_tag`（SSR 已过滤）。
- `categories=<id>` 在 api 上有效（100-art 461 条、二级 801/805 正确收窄）。无 keyword 时 total 封顶 10000，不可当收窄判据。

## 浏览器为何必须保留（两处）

1. **f3mf 兜底**（没生成 3D 预览的配置）：接口 `instance/<id>/f3mf` 需要登录 + geetest 人机验证，且连续下几个 418 不恢复。CDN 裸链覆盖不到时才走这条。
2. **登录态探测**：api 域无公开端点。

## 作者订阅的 handle→uid 缺口

- 订阅存的是 **handle**（`matchUser` 从 `@<handle>` 提取，页面 URL 也是 handle）。
- published 接口要**数字 uid**，handle→uid 无公开端点。
- 两条路：仍走浏览器页内 `__NEXT_DATA__`（`userInfo.uid` + designs），或让用户直接存数字 uid。
- 搜索接口带作者参数全部无效（uid/designCreatorUid/authorUid/creatorUid/designerUid/userId → total 10000 全站）。

## 落地改造范围（尚未实施，2026-11-03）

- `sites/makerworld.mjs`：`search`/`meta`/`userModels`/`categories` 从 `ch.inPage`/`ch.evalInPage` 改为 node fetch `api.bambulab.cn`（userModels 需先解 handle→uid）；`fileLinks` 的 design JSON 也改 node fetch，CDN HEAD 保持 node。
- 保持浏览器：`loginState`、f3mf 兜底。
- 同步更新 README.md（:78/:192/:211/:214）与 docs/spec.md（:549-552 等）里「MakerWorld 只能在页面里 fetch」的说法。

## 探测脚本

全部 `*.tmp.mjs` 跑完即删；探测结论逐条实测过（见上文数字）。

# marklab · 我的模型库（创想云 / MakerWorld / Snapmaker / MakerOnline 四站合一）

一个本地小站：贴模型页网址 → 抓成统一数据 → 在一个 MakerWorld 风格的库里搜索、筛选、下载。

```sh
node server.mjs                      # 起模型库（:8851；PORT=8890 换端口）
node grab.mjs <网址>                  # 命令行抓，不给网页也行
node bulk.mjs --limit 10             # 按榜单批量抓（详见「批量抓」）
node --test test.mjs                 # 自检（纯函数，不联网）
node fix.mjs [--dry] [--orphans]                 # 一次性维护：按当前白名单重洗库里所有描述
```

## 用起来是什么样

- **首页（列表）**：左侧分类栏（统一一级 / 二级，带数量，点一级展开二级），右边卡片墙，
  每张卡 = 封面 + 站点徽章 + 标题 + 作者 + 耗时/克重/盘数 + 文件数与格式；
  顶部粘贴网址回车即入库；下面搜索、站点筛选、标签筛选（含自动的「热门」「精选」）、格式筛选、排序。
- **详情页**：一个版式吃三个站——大图 + 图集、打印盘列表、介绍正文；右栏标题/作者/来源链接、
  打印配置卡（机型页签 + 配置名 + 耗时/克重/喷嘴/盘数 + 耗材色块克重 + 层高/墙/填充）、文件列表。
- **打印配置**：右侧上方逐条列（配置名 · 机型 · 打印时间 · 耗材总量 · 盘数），四站同一套字段。
  鼠标悬停弹卡，内容取各家之长：盘数 / 打印时间 / 耗材总量与长度 / 喷嘴型号 / 文件大小 /
  层高·墙·填充·底板 / **逐色耗材克重** / 兼容机型 / 去原站打开该配置。
- **打印盘（跟随选中配置）**：右侧配置卡下面，列出该配置的每个盘——盘图、盘名、该盘耗时、该盘克重、
  该盘各色消耗，顶部标喷嘴；点别的配置整块跟着换。
- **配套文档**：创想云的「说明文件」（`fileOtherListPage`）与 MakerOnline 的 `docs[]` 都会抓进
  `docs[]`，登录态下跟模型文件一起下载，没登录就标「去站点下载」。
- **文件选择 + 预览**：多文件模型（比如 MakerWorld 的「上半身完成.3mf / 综合下半身.3mf」）在右栏逐个可选，
  选中就地预览——3mf 抠出包内的打印盘缩略图、盘名、对象数；stl 给三角面数与外形尺寸（mm）；
  下载按钮跟着选中项走。文件不在本地时标「未下载」并给补抓。
- **下载**：直接下本地 `files/` 里的原件；文件不在了会标红并给「补抓」按钮（要浏览器登录态）。

按你的要求，点赞/收藏/评论/关注/评分/许可证这些**不进 `library/`**、详情页不显示；
下载量只用来判断「热门」，不出现在详情界面上。
例外：**订阅按点赞数筛选**，命中的点赞数记在订阅命中记录里（`data/subs/`），
不进 `model.json`，也不改已入库文件（ADR-0005）。

## 数据与目录

`library/<站点>-<id>/`：`model.json`（唯一数据源）+ `files/`（3mf/stl）+ `img/`（封面、图集、打印盘缩略图）。
加新站点只需要在 `grab.mjs` 里加一个适配器，页面不用动。

`model.json` 主要字段：`title/author/description/images/tags/category/picked/autoTags/stats/print{...}/profiles[]/activeProfileId/files/fileIds/siteOnlyFiles/rawFiles/docs/savedFiles`。

文件条目带 `origin`：`author` 是作者自己的件（默认），`other` 是别人给这个模型加的打印配置，
作者自己发布的打印配置也算 `author`；别人给这个模型做的配置才算 `other`。判重只用 `author`（见下「重复模型」）。
`savedFiles` 里另有 `sha256` 文件指纹，跨站确认重复时用它比对。
`profiles[]` 是四站统一的打印配置形状：`name/machine/machines/plates/plateList/timeSec/timeText/weightG/nozzle/layerHeight/wallLoops/infill/bed/filaments/thumbnail/url`。

## 文件预览怎么来的

`inspect.mjs` 自己读 zip（`zlib.inflateRawSync`，不依赖 unzip）：

- 3mf：`Metadata/plate_*.png` 抠出来落到 `files/preview/<文件名>/`，盘名从 `model_settings.config`，
  耗时/克重/耗材从 `slice_info.config`（有切片数据才有，原始上传件没有）
- stl：二进制头里的面数 + 逐面算包围盒 → 三角面数与 `宽 × 深 × 高 mm`

结果缓存在 `library/<模型>/.inspect/<文件名>.json`，同一个文件不会重复解析。

## 分类

左侧栏的一级/二级分类是四站分类体系融合后的统一分类，对照表与归并规则见
[`docs/categories/`](docs/categories/README.md)。模型按**原站自己的分类名**落到统一分类
（`lib.mjs` 的 `catIndex` / `catOf`，服务端每次列模型时算，不改 `library/` 里的文件）；
同名分类（创想云 9 个「其他」）分不清时宁可归到「未分类」，也不猜。

## 自动标签

- **精选**：站点自带的精选标记（MakerWorld `isStaffPicked`、创想云 `isPickModel`、Snapmaker 推荐位字段）。
- **热门**：下载量过门槛（`lib.mjs` 的 `HOT`：创想云 1000 / MakerWorld 500 / Snapmaker 30 / MakerOnline 100，可改）。
  为什么不用榜单接口：四站榜单都要登录或没有公开接口，下载量做相对热度更稳。

## 四个站点的取数方式（实测）

| 站点 | 介绍页 / 打印配置 | 文件 |
| --- | --- | --- |
| Snapmaker Space | 页面 SSR（**必须带 `-model` 这种 slug**）里有完整打印配置；基础信息走 `api-models.snapmaker.cn/api/model/detail/<id>` | 私链 CDN，HTTP 直下 |
| 创想云 | 页面 SSR 的 `__NUXT_DATA__`（注意 SSR 的 `modelList` **只有第一页 5 个 STL**，全量要再打 `/api/cxy/v3/model/fileListPage?pageSize=200`，一个模型常拆出几十个件）：`model-info_*` 是详情，**`3mf-list_*` 是打印配置**（3mf 版页面才有：机型、层高/墙/填充、盘数、耗时、耗材重量与逐色耗材 `colorFilament`、兼容机型表），`3mf-all-printers_*` 是机型表 | STL/文档走 `memberDownload` 换签名 URL，打印配置的 3mf 本体走 `3mfDownload`（body 只有 `{id: profileId}`，只认 `__cxy_token_`/`__cxy_uid_` 请求头，匿名一律 `code 4 Invalid Token`；回 OSS 签名直链，24 小时、匿名可下）——两者都要登录态，都不用开浏览器点按钮 |
| MakerWorld | `/api/v1/design-service/design/<id>`（整站挡非浏览器 UA，必须在页面里 fetch） | **先走 CDN 裸链**：`instances[].extention.extensionModelFileList` 的预览链 `.../instance/low_compression_glb/<uuid>.zip?at=…` 去掉 query、去掉那层目录、换 `<uuid>.3mf` 就是同一份 3mf（匿名 200、缓存一年、支持 Range），大小对得上 `modelInfo.f3mf.size` 才算命中；反推不出来（没生成 3D 预览的配置）才回落 `/api/v1/design-service/instance/<id>/f3mf`（签名 URL，5 分钟有效，要登录 + 过 geetest） |
| MakerOnline（`.com` 国际站 / `.cn` 国内站，结构一样） | 页面里的 `window.__NUXT__` 是 IIFE 打包的数据，`vm` 里求值后取 `modelDetailData`（打印配置 / 逐盘耗时克重 / 逐色耗材 / 说明 PDF；国内站还带原始文件清单） | `POST /api/file/download`，要 access token；页面里点「下载 → 下载全部」截签名链接（链接的 `response-content-disposition` 里有原始文件名） |

浏览器（`channel.mjs`）：`playwright-core` 用 CDP 连上你正在用的那个 Chromium
（`127.0.0.1:9223`），登录态在进程内现取、不落盘（ADR-0001），所以**你在 Chrome 里登录一次就够了**。
三站可以拿登录态直接 fetch；MakerWorld 门口有 Cloudflare，只认真浏览器，取页一律走页面内 fetch。
连不上浏览器就明确报「浏览器没连上」，不假装未登录。

## 批量抓（按榜单，后台跑）

```sh
node bulk.mjs --limit 10              # 抓 10 个新的就停
node bulk.mjs --max-pages 5 --dry-run # 只列会抓哪些，不下载
node bulk.mjs --loop 6h --limit 50    # 长期跑：每 6 小时补一次
```

默认数据源：Snapmaker 精选榜（`api/model/featured?sort=hot`，公开接口，不需要 token）。

规矩：

- **限速**：两道闸门——模型之间随机间隔 60–120 秒（`--min-gap` / `--max-gap` 可调，60 秒是地板），
  模型内部每个文件之间再歇 5–10 秒；站点看到的是一分钟一个模型、模型内慢慢下
- **去重**：链接（站点+id）和「标题+作者」双重校验，库里有的直接跳过
- **日志**：每抓一个立刻写 `library/_bulk-log.md`（表格，人看）和 `library/_bulk-log.csv`（Excel 直接开，带 BOM）
- **可续跑**：中断后重跑会跳过已入库的，接着往下抓

长期跑建议挂成后台：

```sh
setsid nohup node bulk.mjs --loop 6h --limit 50 > logs/bulk.log 2>&1 < /dev/null &
```

批抓（`bulk.mjs`）的每一条也走同一个任务队列，所以控制台的任务页能直接看到它跑到第几个、
失败在哪一步——不用再翻 `library/_bulk-log.md`。

## 控制台（`/console`）

左侧导航可收起，六个分页：

- **数据大屏**：总模型数与各站分布、今日/7 日/30 日入库（**北京时间自然日**）、磁盘占用
  （总量拆模型文件与图片）、待补抓（按「要登录 / 解析没拿到链接 / 站点不给 / 原因未记」分因）、
  数据健康、抓取吞吐、订阅待处理。
- **抓取任务**：队列总闸（暂停/继续）+ 任务表，点一行**行内展开**看日志、错误、原链接与操作
  （插队/停止/重试）。
- **订阅任务**：左边清单、右边详情两栏。详情里有门槛、上次结果、命中记录与**候选清单**
  （每条带 `decision`，看它为什么没进队列），可直接立即跑一轮 / 编辑 / 删除；新建和编辑用同一个表单。
- **运行日志**：抓取队列、订阅命中、智能标签、判重四类事件**合成一条时间轴**，顶部标签筛选。
- **站点包**：每个站一张卡片——红绿灯登录态与账号名、积分、今日签到得分与连签天数、
  自动签到开关（未签才给签到按钮）、库内模型数 + 最近 1 天抓了几个 + 待补抓、
  近 7 天入库柱状图（只数带 3mf 的），以及这个站的下载限速与搜索频率
  （改完失焦就存，留空跟随全局，60 秒地板压不下去）。
  顶上的「登录状态刷新」现取一遍，用完即弃，不落盘。
  现在有五个包（创想云 / MakerWorld / Snapmaker / MakerOnline 国内站 / MakerOnline 海外站）——
  MakerOnline 的两个域名是两套独立系统，各自成包，互不 import。
- **设置**：大模型打标签的 baseUrl / apiKey / model，以及待确认的新词。

- **登录态同步**：不用同步。`session.mjs` 通过 `channel.mjs` 从你本机 Chromium 进程内现取
  （ADR-0001），你在 Chrome 里登录或登出，控制台点「重新检测」就跟着变。失效了就在本机 Chrome
  重新登录一次，再点重新检测——没有中间文件，所以不存在「同步慢半拍」。
- **抓取任务**：一个模型一次入库＝一条任务，状态 `排队 → 取页 → 解析 → 下载文件 → 完成`（另有 `判重命中`、`失败`、`停止`、`中断`、`没走到完成` 几种收尾），
  追加写在 `data/tasks/YYYY-MM.jsonl`（永久保留）。重启时没跑完的标「中断」并续跑，
  本任务内最多试 3 次、跨轮次累计失败 3 次才置「失败」。全局串行，模型之间仍受 60–120 秒限速约束。
- **订阅**：三种，一条只能选一种。**关键字订阅** = 关键字 × 候选规则（站点 + 排序 + 筛选 + 前 N 条）+ 匹配方式
  （`name` 标题含来源词 / `tag` 结果自带标签）+ 门槛（点赞/下载下限、只要精选）；**作者订阅** = 粘主页
  链接，他发的我都要，**没有规则、匹配、门槛、排序**；**榜单订阅** = 站点包声明过的榜（如创想云「本周值得打」）
  × 前 N 条，**没有关键字、规则、匹配、门槛**，站方排出来的流上一条算一条。默认 8 小时一轮，命中的**自动入库**；
  没有每轮名额，积压就慢慢下，节流靠排队闸门。
- **怎么跑**：拆两段——搜索吃站点限速（慢），判定是本地读盘（快），混在一起只会让限速空转。
  **订阅任务调度器**只负责搜（每站一个运行器、先进先出，1 分钟 4 次、间隔 ≥15 秒，四站匿名可用），
  一轮搜完交给**候选调度器**判定：库里有没有 → 队列里有没有 → 门槛 → 名字匹配，通过的进抓取队列。
  候选清单落 `data/subs/<id>.candidates.json`，每条带 `decision`（`queued` / `no-match` / `threshold` /
  `in-library` / `in-queue`），「为什么没进队列」看这里；候选 ≠ 命中，每轮重新判定，不沿用上次结论。
- **作者订阅增量**：作者页四站都最新在前，首次翻到底，之后从新往旧扫、连续 20 条都在库里就停（翻不完
  记页码游标，下轮接着翻）。主页地址：创想云 `…/user/<数字id>`、MakerWorld `…/@<handle>`、
  Snapmaker `space.snapmaker.cn/zh/creator/<数字id>`、MakerOnline `…/user/personalInfo/<uuid>.html`。
  认不出的链接直接报错，不猜。
- **重复模型**：判重看身份，不看文件清单。**同站**网址相同（同一个 `site:id`）或标题+作者相同 →
  直接算重复，不入库。**跨站**标题+作者相同 → 先记「疑似」，照常入库；抓到文件后作者件 sha256
  撞上 → 升级「确认」，删掉新目录、库里只留最早那份。别人加的打印配置（`origin: 'other'`）
  不参与比对。标记记在 `data/duplicates.json`
  （`by` 是 `meta` 或 `hash`，`hashes` 留证据），`library/` 一个字节都不改；
  详情页「文件」下面有「同模型链接」，库内的跳详情、被拦下的跳原帖。
- **大模型打标签**：OpenAI 兼容协议，填 API 地址 / 密钥 / 模型（存 `~/.marklab/llm.json`，600 权限），
  能拉模型列表选一个。规则标签（精选/热门）之外再问一次模型，结果单独存 `llmTags`，不覆盖原字段；
  只给已有标签池里的词，新词进 `data/tag-pending.json` 等你在控制台确认。**这是唯一花钱的地方**，
  所以只在你点按钮时跑，抓取本身 0 消耗。

手动粘链接加进来的任务**自动插队**（挪到它那个站的队首，下一个就跑它，但限速照等，不会连发）。
任务页每条都能操作：排队中的可以**插队**（同上）或**停止**；失败/中断的可以**重试**；在跑的也能停止。
停止是终态（记 `停止`，不重试、不计失败）。暂停期间点「抓这个」只放行这一个，其余继续排着。

任务区块右上角的**暂停抓取**是调试用的总闸：暂停后队列一条都不开跑（正在跑的那条让它跑完，要立刻断就点它那行的「停止」），
订阅、批抓、补抓照常往队列里排，但都叫不醒它；只有人点「继续抓取」，或者手动开始一个任务（手动抓取 / 插队 / 重试），才放行。
暂停状态存在 `data/queue.json`，重启服务后仍停在暂停，直到你点「继续抓取」。

## 常驻

用户单元在仓库里的 `systemd/marklab.service`：

```sh
cp systemd/marklab.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now marklab.service
```

没有 systemd 时用 `setsid nohup node server.mjs > logs/server.log 2>&1 < /dev/null &` 兜底。
批抓（`bulk.mjs --loop 6h`）没有单元，按上面「批量抓」那节的 nohup 起。

## 已知边界

- MakerOnline 的国内站与国际站是**两套登录态**：`.cn` 登录了不代表 `.com` 登录了，工具会按各自域名打开页面。
- **一个站点包只认一个域名**：`.cn` / `.com` 是两套独立 id 空间（同号是不同模型，实测 makerworld 三例），
  数据键（库目录、判重键）就是域名：`makeronline.cn` / `makeronline.com`。
  `makerworld.com`（世界站）**还没接**，贴它的链接会被当成不认识的站——要接就另开一个包，别加进现有 HOSTS。
- 创想云 / MakerWorld / MakerOnline 的**文件**都需要本机 Chromium 连着且已登录对应站点；没连上或没登录时介绍页照抓，文件跳过并明确提示（MakerOnline 会直接说「先在浏览器登录 makeronline」）。例外：MakerWorld 走 CDN 裸链的那部分 3mf 匿名就能下，只要求浏览器连着（design JSON 还得在页内取）。
- **MakerWorld 没有「按机型」的单独 3mf**：`?machine=N2S / O1C2` 返回的还是同一个文件（同名同大小同 URL），
  机型只是一张兼容列表。A1 / H2C 在详情页当页签展示，不再尝试下三份。
- MakerWorld 原始上传件（`designExtension.model_files`）的下载接口还没找到，名字与大小记在 `model.json` 里。
- **MakerWorld 的下载撞人机验证**：`f3mf` 即使已登录也回 `418` + geetest「我们需要确认您不是机器人」，
  而且连续下几个就触发、几十分钟不恢复。所以文件优先走上面的 CDN 裸链（不要登录、不过验证）；
  只有「没生成过 3D 预览」的配置反推不出 uuid，才落到 f3mf，撞验证时记 `noFiles: "captcha"`，
  控制台「待补抓」单独一行，并在日志里点名是哪几个配置。要下就得在浏览器里打开该模型页手点一次验证。
- **MakerOnline 的下载已绕开验证码**：web 通道点「下载」回 `{"code":1003,"message":"showCaptcha"}`（网易易盾），
  但同一个 `POST /api/file/download` 带上 `Platform: ios`（站点给 App 的通道）就直接回签名直链——
  3mf / STL / 文档都通（`file_type` 2 / 1 / 3），纯 node、不开浏览器、不用点按钮。
- 创想云下「模型文件」列表（STL/CAD）+ 每份打印配置的 3mf 本体（`3mfDownload`，登录态换 24 小时签名直链）；配套文档已抓，下载要登录态。
- 站点改版会打断解析：解析点在 `__NUXT_DATA__`、`design-service`、`api-models` + Snapmaker 的 RSC 载荷。
- 控制台**没有鉴权**，服务监听 `0.0.0.0`（用户明确说先不加）——别往公网暴露。
- MakerWorld 天然带登录态（只能走真浏览器），「匿名优先」对它不适用；其余三站列表/详情一律匿名。
- 各站搜索排序参数（哪个值是真正的下载量 / 点赞 / 最新）见 [`docs/搜索排序.md`](docs/搜索排序.md)：创想云是 `sortType` 数字、MakerWorld 是 `orderBy` 字符串，无效值一律**静默回落默认**，不报错。
- 订阅的「按发布时间排序」对 MakerOnline 无效：它的搜索响应里没有发布时间，这些条目排在最后。
- 作者订阅里 MakerWorld 的主页列表只能走真浏览器（`@handle/upload?page=N` 的 `__NEXT_DATA__`），
  浏览器没连上时这一站这轮直接空；其余三站是匿名 HTTP。

## 来历

2026-10-29 从 `/home/gly/3dprint` 拆出来的独立项目：代码原在 `tools/modelgrab/`，数据原在 `library/`。
原仓库不再包含模型库，那边的 `start.sh` / 首页卡片 / `.gitignore` 已同步摘掉。

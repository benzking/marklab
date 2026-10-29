# marklab · 我的模型库（创想云 / MakerWorld / Snapmaker / MakerOnline 四站合一）

一个本地小站：贴模型页网址 → 抓成统一数据 → 在一个 MakerWorld 风格的库里搜索、筛选、下载。

```sh
node server.mjs                      # 起模型库（:8851；PORT=8890 换端口）
node grab.mjs <网址>                  # 命令行抓，不给网页也行
node bulk.mjs --limit 10             # 按榜单批量抓（详见「批量抓」）
node --test test.mjs                 # 自检（纯函数，不联网）
```

## 用起来是什么样

- **首页（列表）**：卡片墙，每张卡 = 封面 + 站点徽章 + 标题 + 作者 + 耗时/克重/盘数 + 文件数与格式；
  顶部粘贴网址回车即入库；下面搜索、站点筛选、标签筛选（含自动的「热门」「精选」和站点分类）、格式筛选、排序。
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

按你的要求，点赞/收藏/评论/关注/评分/许可证这些不抓、不显示；下载量只用来判断「热门」，不出现在界面上。

## 数据与目录

`library/<站点>-<id>/`：`model.json`（唯一数据源）+ `files/`（3mf/stl）+ `img/`（封面、图集、打印盘缩略图）。
加新站点只需要在 `grab.mjs` 里加一个适配器，页面不用动。

`model.json` 主要字段：`title/author/description/images/tags/category/picked/autoTags/stats/print{...}/profiles[]/activeProfileId/files/fileIds/siteOnlyFiles/rawFiles/docs/savedFiles`。
`profiles[]` 是四站统一的打印配置形状：`name/machine/machines/plates/plateList/timeSec/timeText/weightG/nozzle/layerHeight/wallLoops/infill/bed/filaments/thumbnail/url`。

## 文件预览怎么来的

`inspect.mjs` 自己读 zip（`zlib.inflateRawSync`，不依赖 unzip）：

- 3mf：`Metadata/plate_*.png` 抠出来落到 `files/preview/<文件名>/`，盘名从 `model_settings.config`，
  耗时/克重/耗材从 `slice_info.config`（有切片数据才有，原始上传件没有）
- stl：二进制头里的面数 + 逐面算包围盒 → 三角面数与 `宽 × 深 × 高 mm`

结果缓存在 `library/<模型>/.inspect/<文件名>.json`，同一个文件不会重复解析。

## 自动标签

- **精选**：站点自带的精选标记（MakerWorld `isStaffPicked`、创想云 `isPickModel`、Snapmaker 推荐位字段）。
- **热门**：下载量过门槛（`lib.mjs` 的 `HOT`：创想云 1000 / MakerWorld 500 / Snapmaker 30 / MakerOnline 100，可改）。
  为什么不用榜单接口：四站榜单都要登录或没有公开接口，下载量做相对热度更稳。

## 四个站点的取数方式（实测）

| 站点 | 介绍页 / 打印配置 | 文件 |
| --- | --- | --- |
| Snapmaker Space | 页面 SSR（**必须带 `-model` 这种 slug**）里有完整打印配置；基础信息走 `api-models.snapmaker.cn/api/model/detail/<id>` | 私链 CDN，HTTP 直下 |
| 创想云 | 页面 SSR 的 `__NUXT_DATA__`（注意 SSR 的 `modelList` **只有第一页 5 个 STL**，全量要再打 `/api/cxy/v3/model/fileListPage?pageSize=200`，一个模型常拆出几十个件）：`model-info_*` 是详情，**`3mf-list_*` 是打印配置**（3mf 版页面才有：机型、层高/墙/填充、盘数、耗时、耗材重量与逐色耗材 `colorFilament`、兼容机型表），`3mf-all-printers_*` 是机型表 | STL 走 `memberDownload` 换签名 URL（要登录态）；**3mf 打印配置没有公开下载接口**（`3mfDownload` 传 profileId 一律「参数非法」），界面标「去站点下载」并给每个配置带 `?profileId=` 的深链 |
| MakerWorld | `/api/v1/design-service/design/<id>`（整站挡非浏览器 UA，必须在页面里 fetch） | `/api/v1/design-service/instance/<id>/f3mf` 换签名 URL（5 分钟有效） |
| MakerOnline（`.com` 国际站 / `.cn` 国内站，结构一样） | 页面里的 `window.__NUXT__` 是 IIFE 打包的数据，`vm` 里求值后取 `modelDetailData`（打印配置 / 逐盘耗时克重 / 逐色耗材 / 说明 PDF；国内站还带原始文件清单） | `POST /api/file/download`，要 access token；页面里点「下载 → 下载全部」截签名链接（链接的 `response-content-disposition` 里有原始文件名） |

浏览器（`browser.mjs`）：优先 `bsk` 借你已登录的 Chrome（下载要登录态的站必须走这条），
扩展没连上时退到内置无头 chromium + CDP，只够抓公开数据。工具不读 cookie、不落 token。

## 批量抓（按榜单，后台跑）

```sh
node bulk.mjs --limit 10              # 抓 10 个新的就停
node bulk.mjs --max-pages 5 --dry-run # 只列会抓哪些，不下载
node bulk.mjs --loop 6h --limit 50    # 长期跑：每 6 小时补一次
```

默认数据源：Snapmaker 精选榜（`api/model/featured?sort=hot`，公开接口，不需要 token）。

规矩：

- **限速**：两次下载之间随机间隔 60–150 秒（`--min-gap` / `--max-gap` 可调），一分钟最多一个
- **去重**：链接（站点+id）和「标题+作者」双重校验，库里有的直接跳过
- **日志**：每抓一个立刻写 `library/_bulk-log.md`（表格，人看）和 `library/_bulk-log.csv`（Excel 直接开，带 BOM）
- **可续跑**：中断后重跑会跳过已入库的，接着往下抓

长期跑建议挂成后台：

```sh
setsid nohup node bulk.mjs --loop 6h --limit 50 > logs/bulk.log 2>&1 < /dev/null &
```

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
- 创想云 / MakerWorld / MakerOnline 的**文件**都需要浏览器扩展连着且已登录对应站点；没连上或没登录时介绍页照抓，文件跳过并明确提示（MakerOnline 会直接说「先在浏览器登录 makeronline」）。
- **MakerWorld 没有「按机型」的单独 3mf**：`?machine=N2S / O1C2` 返回的还是同一个文件（同名同大小同 URL），
  机型只是一张兼容列表。A1 / H2C 在详情页当页签展示，不再尝试下三份。
- MakerWorld 原始上传件（`designExtension.model_files`）的下载接口还没找到，名字与大小记在 `model.json` 里。
- 创想云只下「模型文件」列表（STL/CAD）；打印配置只抓元数据（3mf 本体没有公开下载接口）；配套文档已抓，下载要登录态。
- 站点改版会打断解析：解析点在 `__NUXT_DATA__`、`design-service`、`api-models` + Snapmaker 的 RSC 载荷。

## 来历

2026-10-29 从 `/home/gly/3dprint` 拆出来的独立项目：代码原在 `tools/modelgrab/`，数据原在 `library/`。
原仓库不再包含模型库，那边的 `start.sh` / 首页卡片 / `.gitignore` 已同步摘掉。

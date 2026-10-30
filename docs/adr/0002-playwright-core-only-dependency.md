# 0002 · 引入 playwright-core 作为项目唯一 npm 依赖

- 状态：已采纳（2026-10-29）
- 推翻了 `AGENTS.md` 的「零依赖：只用 node 内置 + bsk CLI，不引 npm 包」

## 背景

控制台模块要做的三件事都要求**常驻进程内遥控浏览器**：

- 登录态探测（四个站，每 10 秒一轮）
- 订阅定时搜索（MakerWorld 只能走真浏览器）
- 任务队列 + 下载接管（要能 `expect_download`、`waitForResponse`）

现状 `browser.mjs` 用 bsk CLI：每次操作 spawn 一个子进程 + JSON 往返。
单次抓取还能忍，做成常驻队列就是瓶颈；且 bsk 的 download/upload 对远程浏览器不支持。

候选方案对比（2026-10-29 实测）：

| 方案 | 依赖 | 过 Cloudflare | 进程内 | 代码量 | 致命缺点 |
|---|---|---|---|---|---|
| bsk CLI（现状） | 0 | ✓ | ✗ | 中 | 每次 spawn；download/upload 不支持远程浏览器 |
| **playwright-core + CDP** | 14MB | ✓ | ✓ | 小 | 项目第一个依赖 |
| puppeteer-core + CDP | 5MB | ✓ | ✓ | 中 | 等接口/接下载的 API 比 playwright 糙 |
| 手写 CDP WebSocket | 0 | ✓ | ✓ | 大（200+ 行协议） | 自己维护协议，浏览器升级就炸 |
| curl 伪装 TLS 指纹 | 原生库 | 勉强 | ✓ | 大 | 不稳定，Cloudflare 一改就废 |
| `chromium --headless --dump-dom` | 0 | ✓ | ✗ | 小 | 只能拿静态 HTML，不能点、不能等接口、不能接下载 |

## 决策

装 **`playwright-core`**（不是 `playwright`）：

- `playwright-core` 不下浏览器，14MB
- **只许** `chromium.connectOverCDP('http://127.0.0.1:9223')`
- **禁止** `chromium.launch()` / `playwright install` / 任何自带浏览器

`npm i playwright` 会下 ~150MB 的 Chromium 并用自己的 user-data-dir，
那样用户在**自己 Chrome 里的登录态带不过来**，等于把 ADR-0001 做废。

## 实测数字

- `connectOverCDP` 连上 **462ms**（一次启动一次，之后常驻复用）
- `context.cookies()` 一次返回 67 条，含 HttpOnly
- MakerWorld 搜索页经真浏览器 `page.goto`：冷 4.8s / 热 **2.1s**，拿到 `total:3424`
- 热态导航：创想云详情 2806ms、Snapmaker 详情 1309ms
- 进程内 `page.evaluate` 打接口：183–381ms（比 spawn bsk 快一个数量级）

## 后果

- **好处**：进程内遥控；白送 `context.cookies()`（替掉 200 行手搓 CDP 协议）、
  `page.waitForResponse`（精准等接口，不用 sleep 3s）、`page.expect_download`（真下载事件）
- **好处**：MakerWorld 这条死路通了
- **代价**：项目第一次有 `node_modules`。`package.json` + `package-lock.json` 进 git，
  `node_modules/` 已在 `.gitignore`
- **代价**：playwright 大版本要和 Chromium 大版本对齐，升级时得一起验
- **约束**：连接失败**不许阻塞主服务**。控制台显示「浏览器未连接」，抓取排队等它回来
- **约束**：只用 playwright 遥控浏览器；**不许**拿它当「自动测试框架」引进来扩大依赖面

## 为什么不算「破规矩」

「零依赖」的目的是**别为几行代码引一个包**。这里换掉的是一整套浏览器遥控层
（手写 CDP 协议 200+ 行，或永远 spawn 子进程），不是省几行。
`AGENTS.md` 那条改成：「只许 playwright-core 一个依赖，且只许连本机，不许下载浏览器」。

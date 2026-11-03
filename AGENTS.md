# AGENTS.md

模型库：四站（创想云 / MakerWorld / Snapmaker / MakerOnline）抓取 + 本地浏览 + 控制台，
只依赖一个 npm 包 `playwright-core`（见 ADR-0002）。
站点取数细节、字段、已知边界在 `README.md`，这里只放每次动手都要用的东西。

## 动手前：先看懂，再懒

懒 = 效率，不是粗心。最好的代码是没写的代码。先读完要改的文件、把真实流程走一遍
（谁调它、数据从哪来到哪去、会弄坏什么），再爬这个梯子，停在第一个站得住的梯级：

1. **需要存在吗？** 没人要的功能、选项、灵活性：不做，一句话说明。
2. **仓库里已有？** `lib.mjs` 的纯函数、`channel.mjs` 的取页、`inspect.mjs` 的读包 —— 先用现成的。
3. **node 内置能做？** `zlib.inflateRawSync` 代替 unzip、`node:http` 代替框架、`node:test` 代替测试框架。
4. **浏览器原生能做？** CSS 代替 JS，`<dialog>` 代替弹窗库。
5. **本项目只许一个 npm 依赖**（`playwright-core`，ADR-0002），别为几行代码加第二个。
6. **一行能写完、一眼能读懂？** 一行。
7. 都不行：写能跑的最小那份。

- 最小的 diff 要等看懂全部影响面之后才算最小。修 bug 前 grep 所有调用方，把守卫放在共享函数里
  一次修好；只补报错点名的那条路径、放过同类调用方，是第二个 bug。
- 不加没人要的抽象、包装、配置项、「以后再补」的脚手架。删比加优先，无聊胜过聪明。
- 两种写法一样短，选边界情况正确的那个。
- 刻意留了已知上限的捷径，就地写一行 `shortcut: <上限>, <何时升级>`。
- 非平凡逻辑（解析、分支、限速、下载）留一个能跑的检查：`test.mjs` 加一条断言，纯函数、
  不联网、不起浏览器。一行代码不用测。

## 不可省

- **限速**：两道闸门，缺一不可——模型之间 60–120 秒（全局默认，站点可在
  `data/site-config.json` 里覆盖；60 秒是地板，任何来源都调不下去，调小等于关掉限速），
  模型内部每个文件之间再歇 5–10 秒。被封站比慢一天贵。细则见 `docs/site-pack.md` §6。
- **`library/` 是数据不是代码**：不提交、不改已入库文件；新抓取写新目录。
- **登录态不落盘**：只从本机常驻 Chromium 进程内现取（`context.cookies()`，ADR-0001），
  不写盘、不打印、不进日志。连不上就显示「无法检测」，不假装未登录。
- **四个解析点**（`__NUXT_DATA__` / `design-service` / `api-models` / Snapmaker RSC 载荷）是唯一入口，
  站点改版只改这些适配器，不在页面里打补丁。
- 用户点名要的，不做减法。

## 布局

`server.mjs`（:8851，静态 + API）· `grab.mjs`（抓取编排：调站点包 + 落盘）·
`sites/`（**站点包**，一站一文件；契约见 `docs/site-pack.md`，登记表 `sites/index.mjs`；
`contract.mjs` 是成员表与八种返回模型，`test.mjs` 用它）·
`bulk.mjs`（按榜单批量抓）·
`inspect.mjs`（3mf/stl 预览，自读 zip）· `lib.mjs`（纯函数：站点识别 / Nuxt 还原 / 清洗）·
`channel.mjs`（浏览器通道：登录态 + 真浏览器取页，唯一入口；标签页也只在它这里开和关）· `session.mjs`（四站登录态探测）·
`tasks.mjs`（抓取任务队列，全局串行）· `stats.mjs`（工作台数据）· `subs.mjs`（订阅）·
`events.mjs`（运行日志：`data/events.jsonl` 追加写、5 MB 轮转，见 ADR-0007）·
`ipwatch.mjs`（高风控 IP 词表 → 订阅，读 `data/ipwatch.json`）·
`search.mjs`（四站搜索，匿名；频率默认 4 次/分，可按站覆盖；站点不支持的排序键回落该站默认序）· `dup.mjs`（重复检测）· `llm.mjs`（大模型打标签）·
`cats.mjs`（四站 1/2 级分类 + 对照表）· `checkin.mjs`（签到：创想云 + MakerOnline.cn，各站在包里实现 `checkin()` / `checkinStatus()`；`startAuto()` 每 10 分钟探一次自动签）·
`web/`（前端，零构建；`/console` 是控制台）· `fix.mjs`（一次性维护：按当前白名单重洗库里描述）· `library/`（数据，不入库）· `data/`（任务/订阅/标记，不入库）·
`docs/categories/`（分类对照，见该目录 README）·
`docs/spec.md`（需求规格：系统应该怎样，冲突时以它为准）·
`docs/site-pack.md`（**站点包契约**：包该有什么、成员签名、限速三层）·
`GLOSSARY.md`（词表，动手前先对齐用词）· `docs/adr/`（决策记录：0001 登录态 · 0002 依赖 ·
0003 匿名优先 · 0004 重复检测 · 0005 控制台）

## 跑

`node server.mjs`（`PORT=` 换端口）· `node --test test.mjs`（纯函数自检，不联网）·
`node checkin.mjs`（签到，`--dry` 只看状态）

## 约定

- 依赖：只用 node 内置 + **一个** npm 包 `playwright-core` —— 只许 `connectOverCDP` 连本机 9223，
  不许 `launch()`、不许 `playwright install` 下载浏览器（ADR-0002）。其余一律不引。
- 加站点只在 `sites/` 加一个文件（契约见 `docs/site-pack.md`），公共层和 `web/` 都不用动；
  五站共用一套 `profiles[]` 形状，不为单站加分支。
- 只注释代码说不出的「为什么」，一行。

## Agent skills

### Issue tracker

Issue 记在本仓库的 GitHub Issues，用 `gh` CLI 读写。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认五档：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：`docs/spec.md`（要什么）+ 根目录 `GLOSSARY.md`（叫什么）+ `docs/adr/`（为什么这么定）。见 `docs/agents/domain.md`。

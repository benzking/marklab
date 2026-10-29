# AGENTS.md

模型库：四站（创想云 / MakerWorld / Snapmaker / MakerOnline）模型抓取 + 本地浏览，零 npm 依赖。

## 布局

`server.mjs`（:8851，静态 + API）· `grab.mjs`（四站适配器）· `bulk.mjs`（按榜单批量抓）·
`inspect.mjs`（3mf/stl 预览，自读 zip）· `lib.mjs`（纯函数：站点识别 / Nuxt 还原 / 清洗）·
`browser.mjs`（bsk 优先，无头 chromium 兜底）· `web/`（前端，零构建）· `library/`（数据，不入库）

## 跑

`node server.mjs`（`PORT=` 换端口）· `node --test test.mjs` · 批量与站点取数细节见 `README.md`

## 约定

- 零依赖：只用 node 内置 + `bsk` CLI，不引 npm 包。
- 加站点只在 `grab.mjs` 加适配器，`web/` 不用动。
- `library/` 是数据不是代码：不提交、不改已入库文件；新抓取写新目录。
- 解析点只有 4 处（`__NUXT_DATA__` / `design-service` / `api-models` / Snapmaker RSC 载荷），
  站点改版先看 `README.md` 的「已知边界」。

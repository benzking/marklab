# 0001 · 登录态只借本机浏览器，一个字节都不落盘

- 状态：已采纳（2026-10-29）
- 推翻了 `AGENTS.md` 的「不落凭据：不读 cookie、不存 token」

## 背景

要抓的东西里有一部分必须登录：创想云的 `memberDownload`、Snapmaker 的
`/api/model/download`、MakerOnline 的文件接口，匿名一律失败。

原规矩是「登录态一律借浏览器现成的」——即用 bsk CLI 在浏览器里点，不碰 cookie。
但本次要做的三件事（订阅定时搜索、任务队列、下载接管）都需要**常驻进程内**反复
使用登录态，每次 spawn 一个 CLI 子进程扛不住。

2026-10-29 实测出三条硬事实：

1. 本机 Chromium 的 CDP 口 `127.0.0.1:9223` 裸开放无鉴权，`context.cookies()`
   一次返回 67 条，四站相关 41 条，**含 HttpOnly 的 `cf_clearance`/`acw_tc`/`cdn_sec_tc`**。
   不用解密 Chromium 的 cookie 数据库，不用装任何解密库。
2. 拿到 cookie 后，**三站纯 node fetch 就能通**：Snapmaker `Bearer login_access_token`
   → `code:200`；MakerOnline.cn 裸 token（不带 Bearer）→ `code:0`；创想云
   `__cxy_token_` 头 → `code:0`。
3. **MakerWorld 带 `cf_clearance` + 全套浏览器头仍然 403**。它挡的是 TLS 指纹，
   cookie 救不了，只能走真浏览器。

## 决策

登录态的唯一来源是**本机常驻 Chromium**，进程内现取，只放内存：

- 取法：playwright `context.cookies()`（见 ADR-0002）
- 存放：**进程内存**，TTL 300 秒
- 刷新：TTL 到期 / 探测到 401 时强制重取
- 落盘：**不写**。任何 cookie 值不出现在磁盘、日志、`model.json` 里
- 浏览器连不上：显示「无法检测」，**不假装成未登录**

## 为什么不是「落盘成 jar」

原本考虑过 `~/.marklab/cookies.json`。放弃的理由是它会引入一个**陈旧问题**：
用户在 Chrome 里重新登录后，Chrome 里是新票，磁盘上是旧票，于是需要「同步」这个动作
和一套失效检测逻辑。

进程内现取时，「同步」这个动作**根本不存在**——程序用的就是那台浏览器本身。
用户的需求「在本机 Chrome 重新登录后就能同步」变成自动成立：下一次取就是新的。

同时少一个凭据文件，`git status` 永远不会看见它，也不怕哪天 `.gitignore` 被改坏。

## 后果

- **好处**：无凭据落盘；「重新登录即生效」零延迟；省掉一整套同步/失效检测代码
- **代价**：强依赖 `chrome-cdp.service` 在跑。它挂了 → 登录态一律「无法检测」，
  依赖登录的抓取排队等它回来
- **代价**：进程重启后第一次取登录态要多花约 0.5 秒（之后常驻）
- **代价**：我们开的浏览器标签用户屏幕上看得见。规矩：**只关自己开的，绝不碰用户的标签**
- `AGENTS.md` 那条改成：「不落凭据：登录态只从本机浏览器进程内现取，不写盘、不打印、不进日志」

## 另：大模型 API key 不是「登录态凭据」

用户自填的 `LLM_BASE_URL` / `LLM_API_KEY` 是**他买的服务凭据**，不是网站登录态，
性质不同：不填就退回规则打标签，不会导致抓取失败。存 `~/.marklab/llm.json`（chmod 600，
仓库外），同样不进 git、不进日志。

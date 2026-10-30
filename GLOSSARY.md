# GLOSSARY · marklab

本项目的词表。写代码、写界面文案、写 issue 时用这里的词；同一个概念不许有两个名字。
每条只写「是什么」和「不叫什么」，实现细节在 `README.md` 和 `docs/adr/`。

## 站点与模型

**站点 (site)**
四个抓取目标之一：创想云 / MakerWorld / Snapmaker / MakerOnline。
不叫「平台」——`platform` 是 `model.json` 里的字段名（取值 `creality|makerworld|snapmaker|makeronline`），
说的是数据来源的机器可读 id，不是人嘴里的「那个站」。

**模型 (model)**
一个站点上的一个 3D 模型页面，连同它的全部附件（打印配置、3mf/stl、图集、说明文档）。
一个模型在本地对应一个目录 `library/<site>-<id>/`。

**入库 (ingest)**
把一个模型从站点抓成本地目录的**整个动作**：取页 → 解析 → 下载文件 → 写 `model.json`。
不叫「保存」「下载」——下载只是入库的倒数第二步。

**抓取任务 (task)**
**一个模型的一次入库尝试**。粒度是模型，不是文件。
状态机：`queued → fetching → parsing → downloading → done | duplicate | failed | stopped | interrupted | incomplete`。
`duplicate` 算成功；`stopped` 是人点的停止（终态，不计失败）；`incomplete` 是进程正常退出却没走到 `done`（grab 的逻辑问题）。

**失败计数 (failures)**
同一个模型累计失败次数。到 3 次置 `failed`，不再自动重试。

## 登录态

**登录态 (session)**
某站点认得出「是你」的状态。物理载体是浏览器里的 cookie。

**票 / 通行证 (ticket)**
面向非技术读者的说法，指 cookie。**只在界面文案和给用户的解释里用**，
代码、文档、issue 里一律写「登录态」。

**浏览器通道 (browser channel)**
程序遥控本机常驻 Chromium 的那条连接（CDP `127.0.0.1:9223`）。
不叫「爬虫」——爬虫说的是抓取行为，通道说的是连接方式。

**匿名抓取 (anonymous fetch)**
不带登录态发出的请求。能匿名就匿名，见 ADR-0003。

**需登录接口 (auth-required endpoint)**
匿名必然失败、必须带登录态才能成功的接口（主要是各站的下载接口）。
首次撞墙后记进 `data/auth-needs.json`，之后直接带登录态。

**凭据 (credential)**
能冒充用户或花钱的东西：cookie、token、大模型 API key。
本项目对**登录态凭据**的硬约束是「不落盘」，见 ADR-0001。

## 订阅

**订阅 (subscription)**
一条定时搜索规则：`关键字 + 站点 + 门槛条件 + 排序 + 每轮上限`。
默认 8 小时跑一次，间隔可调。

**作者订阅 (author subscription)**
订阅里的另一半：直接盯某个作者的主页，`用户主页链接 + 门槛条件 + 排序 + 每轮上限`。
站点从链接里认出来，不用另勾；命中记「用户：xxx」而不是关键字。
一条订阅可以同时有关键字和作者，至少要有其中一个。

**命中 (hit)**
订阅某一轮搜索出的一条结果。命中后按订阅配置自动入库。

**门槛条件 (threshold)**
订阅的高级筛选：点赞数 ≥ N、下载量 ≥ N、只要精选。
发布时间窗口是可选项，不开就不限。

## 重复

**重复模型 (duplicate)**
同一个作品在本地已有一份，又出现第二份。判重看**身份**，不看文件清单：

- **同站**：网址相同（`site:id` 一样，就是同一个目录重抓）或标题+作者相同 → 直接算重复。
- **跨站**：标题+作者相同 → 先记「**疑似重复**」，不拦；抓到文件后作者件 sha256 撞上 →
  升级为「**确认重复**」，删掉新目录、库里只留最早那份。

**疑似重复 (suspected duplicate)**
跨站标题+作者相同、但还没拿到能对上的文件（没登录、站点不给文件、或文件确实不同）。
两份都留在库里，`duplicates.json` 里 `by: "meta"`，页面「同模型链接」互相指过去。

**确认重复 (confirmed duplicate)**
跨站疑似 + 作者件 sha256 完全一致。字节一样才会撞同一个 hash，所以 3mf 只会和 3mf 撞、
stl 只会和 stl 撞，不用额外判类型。`duplicates.json` 里 `by: "hash"`，本次新目录删掉。

**作者件 (author file)**
模型作者自己的东西，**参与 hash 确认**：创想云 `fileListPage` 的 STL、
MakerWorld 作者本人的 instance 3mf、Snapmaker 的 `fileUrl`、MakerOnline 的 `files[]`。
条目上标 `origin: 'author'`（默认值）。

**他人件 (other file)**
别人给这个模型做的打印配置。四个站都有这个徽标，字段各不相同：
MakerWorld 的 `instanceCreator.uid` ≠ 作者 `designCreator.uid`、
MakerOnline 的 `print_profiles[].is_author === false`（页面上写 Designer）、
Snapmaker 的 `printProfiles[].creatorId` ≠ 模型 `creatorId`、
创想云的 `isAuth === false`（页面上写「作者」的那条才是作者自己的）。
标 `origin: 'other'`，**不参与判重**——那不是原作者上传的。

**站点生成件 (profile file)**
**已废弃**：作者自己发布的打印配置算作者件（`origin: 'author'`），别人做的那份才算他人件（`origin: 'other'`）。站点自己生成的件不再单独标。


## 界面

**控制台 (console)**
`/console`，本次新增的独立页面。含数据大屏、抓取任务、订阅任务、运行日志、站点包、设置六个分页，左侧导航可收起。

**工作台 (workbench)**
控制台首页：登录状态灯、模型总数与各站分布、今日/7日/30日入库数、磁盘占用、
待补抓数、数据健康、抓取吞吐、订阅待处理数。

**暂停队列 (queue pause)**
任务区块右上角的调试总闸：暂停后队列不开新任务（正在跑的那条跑完为止），
订阅 / 批抓 / 补抓照常排队但叫不醒它；只有人点「继续抓取」或手动开始一个任务才放行。
状态存 `data/queue.json`，重启服务后仍停在暂停。

**站点包 (site pack)**
一个站点的全部取数能力打成一个包：网址匹配、登录态探测、抓元数据、取文件链接、搜索。
MakerOnline 的 .cn 和 .com 是两个独立的包。加站点只加包，不改公共层。

**无文件原因 (no-files reason)**
模型抓回来了但一个文件都没下到，分三种：要登录（`login`）、解析没拿到链接（`parse`）、
站点本来就不给（`none`）。三种的处理方式完全不同，不许混成一个「失败」。

## 标签

**规则标签 (autoTags)**
0 消耗的本地规则：精选看站点自带标记，热门看下载量门槛（`lib.mjs` 的 `autoTags`）。

**大模型标签 (llmTags)**
调一次自定义大模型（OpenAI 兼容协议）给模型打标签，结果单独存 `llmTags`，
不覆盖 `autoTags`、也不改站点分类。只能从**标签池**里选词。

**标签池 (tag pool)**
已认可的标签集合，`data/tags.json`。大模型想加池外的新词，先进**待确认队列**
`data/tag-pending.json`，等人到控制台点「接受」才入池——不让模型自由造词污染分类。

# 系统架构（重构基准）

写这份文档的目的：把"站点知识散在 9 个地方、取数通道各写一遍、队列只有一条"的现状，
换成"站点包 + 两个资源池 + 每站队列"的结构。重构时按本文的接口与边界搬代码，
不改变对外行为（HTTP 接口、`library/` 布局、`data/` 语义都不变）。

---

## 1. 现状

### 1.1 站点知识散落在 9 处、7 种形状

| 位置 | 内容 | 形状 |
|---|---|---|
| `lib.mjs:6-12` | 4 条 URL 正则 | 函数表 |
| `lib.mjs:75` | `HOT` 热门门槛 | 常量 |
| `lib.mjs:114` | `makeronline-cn → makeronline` | 三元表达式 |
| `channel.mjs:11-14` | 4 组 cookie 域 | 常量表 |
| `session.mjs:7-80` | 4 站（5 条）登录探测 | 对象表 |
| `search.mjs:5` + 4 组 normalize/search/user | 搜索 | 散落函数 |
| `cats.mjs:32-100` | 4 个分类抓取器 + `SITE_LABEL` | 散落函数 |
| `grab.mjs:98,264,370,520` | 4 个抓取适配器 | 对象表 |
| `bulk.mjs:30-59` | 只有 snapmaker featured | 写死 |

后果：加第五个站要改 7 个文件、7 种写法；AGENTS.md 里"加站点只在 `grab.mjs` 加适配器"
这句话现在是假的。

### 1.2 每个站自己实现了一遍取数通道

`creality` 在页内 `fetch` 并从 `document.cookie` 抠 token（`grab.mjs:242`）；
`snapmaker` 同样（`grab.mjs:536`）；`makerworld` 全程页内 fetch；`makeronline`
直接 monkeypatch `HTMLAnchorElement.prototype.click` 截签名链接（`grab.mjs:660` 起）。

超时、登录态刷新、cookie 域匹配、限速、错误分类，四份各写一遍。
现有 P0 里至少 8 条来自这种重复：cookie 域后缀匹配、`.cn/.com` 串 token、
无 `AbortSignal`、无 SIGTERM 清理、限速器各进程一份、`inPage` 导航判断、
`exit()` 不 await、错误文案不一致。

### 1.3 三个共享资源，目前都没被当作资源管理

| 资源 | 谁在用 | 现状 |
|---|---|---|
| 浏览器（CDP 9223） | grab / session / search / cats | 每个进程各连一次，各开页面，谁都不关 |
| 下载带宽（模型间 60–120s、模型内每文件 5–10s） | grab 子进程 + tasks | 限速器是进程内变量，server 与 bulk 各一份 |
| `data/*.json` | server / ipwatch / bulk | 多进程读改写，整份覆盖，无锁 |

---

## 2. 目标架构

```
┌──────────────────────────── 入口层 ────────────────────────────┐
│  server.mjs (HTTP + 静态)      CLI: grab / bulk / ipwatch / cats │
└───────────────┬───────────────────────────────┬────────────────┘
                │                               │
┌───────────────▼──────────── 领域层 ───────────▼────────────────┐
│  tasks(每站队列)  subs(订阅)  dup(去重)  stats  llm(标签)        │
│  search(跨站搜索聚合)   events(事件流)                          │
└───────────────┬───────────────────────────────┬────────────────┘
                │                               │
┌───────────────▼──────────── 站点层 ───────────▼────────────────┐
│  sites/creality.mjs  sites/makerworld.mjs  sites/snapmaker.mjs  │
│  sites/makeronline-cn.mjs   sites/makeronline-com.mjs           │
│  每个文件一个固定形状的对象：匹配 / 域 / 登录 / 限速 / 六个能力   │
└───────────────┬───────────────────────────────────────────────┘
                │  只通过 ctx 取数，站点文件里不许出现 fetch / cookie
┌───────────────▼──────────── 通道层 ───────────────────────────┐
│  net.mjs      网络池：匿名 fetch，超时 / 重试 / 状态码 / 流式    │
│  channel.mjs  浏览器池：单连接、页面复用、全局并发 1、强制回收   │
└───────────────┬───────────────────────────────────────────────┘
                │
┌───────────────▼──────────── 存储层 ───────────────────────────┐
│  store.mjs   原子写 / 原子读 / 事件追加 / 库目录安全校验         │
│  library/<platform>-<id>/{model.json,files,img}                │
│  data/{subs.json,subs/,events/,tasks/,duplicates.json,tags.json}│
└───────────────────────────────────────────────────────────────┘
```

依赖方向只能从上往下。站点层不许 import 领域层，通道层不认识站点（只认识 hosts）。

---

## 3. 站点包接口

一个站一个文件，默认导出一个对象。**静态 import，不做目录扫描、不做版本号、不做第三方安装。**

```js
// sites/snapmaker.mjs
export default {
  id: 'snapmaker',                       // 入库目录前缀、cookie 归属、队列 lane 前缀
  label: 'Snapmaker',
  hosts: ['space.snapmaker.cn', 'snapmaker.cn'],   // cookie 精确匹配（含子域规则写明）
  match: (url) => /^https:\/\/space\.snapmaker\.cn\/(?:[a-z]{2}\/)?model\/(\d+)/.exec(url)?.[1],
  urlOf: (id) => `https://space.snapmaker.cn/zh/model/${id}`,
  hot: 30,                               // autoTags 热门门槛（原 lib.HOT）
  rate: { modelGapSec: [60, 120], fileGapSec: [5, 10], maxModels: 1 },
  auth: { transport: 'http', url: 'https://api-models.snapmaker.cn/api/user/me',
          check: (j) => j.code === 200 && !!j.data?.id,
          headers: (ck) => ({ authorization: `Bearer ${ck.login_access_token}` }) },

  meta:       { transport: 'http',  run: (id, url, ctx) => ({ ... }) },
  files:      { transport: 'http',  run: (model, ctx) => [...] },
  search:     { transport: 'http',  run: (q, ctx) => ({ items, total }) },
  user:       { transport: 'http',  run: (q, ctx) => ({ items }) },
  categories: { transport: 'http',  run: (ctx) => [...] },
  featured:   { transport: 'http',  run: (ctx) => [...] },   // 没有就不写这个键
};
```

### 3.1 transport 三态

| 值 | 含义 | 谁执行 |
|---|---|---|
| `http` | 匿名 HTTP，不需要登录态、不需要页面 | `net.mjs` |
| `page` | 在站点页面里 `fetch`，自动带该站 cookie | `channel.mjs` |
| `click` | 页面里点按钮/拦截请求，用于截签名链接 | `channel.mjs` |

站点文件里**只允许**调用 `ctx.http(url, opts)` / `ctx.page(url, js, opts)` / `ctx.click(url, steps)`，
不许直接 `fetch(`、不许读 `document.cookie`（cookie 由通道注入）。

### 3.2 四站能力矩阵（现实验证过的差异）

| 能力 | 创想云 | MakerWorld | Snapmaker | MakerOnline(.cn/.com) |
|---|---|---|---|---|
| URL→id | `/model-detail/<24hex>` | `/models/<num>` | `/model/<num>-slug` | `/model/<slug>/<num>.html` |
| 详情来源 | `__NUXT_DATA__`(devalue) | `design-service` API | RSC flight + `api-models` detail | `window.__NUXT__` IIFE(vm) |
| 详情 transport | http + page | **page** | http | http |
| 分类 | `__NUXT_DATA__` | **page**（DOM 链接） | RSC flight | `__NUXT__` IIFE |
| 搜索 | `smart_search/v1/model` | **page**（`#__NEXT_DATA__`） | `api/model/list` | `/api/search/model` |
| 作者作品 | `listSharePage` | **page** | `api/model/list?creator` | `/api/user/personal/index` |
| 榜单/featured | 无 | 无 | `api/model/featured` | 无 |
| 登录探测 | getInfo(cookie) | **page** fetch | `/api/user/me`(Bearer) | `/api/user/personal/info`(裸 token) |
| 文件清单 | `fileListPage`（匿名） | `f3mf`（page，签名 5 分钟） | CDN 直链 | `print_profiles[].files` |
| 文件下载 | `memberDownload`（**page+登录**） | 签名 URL（**page**） | CDN http 匿名 | **click** 下载按钮 |
| 多盘 3mf | `3mfDownload`（登录，body 只有 profileId） | 有 | 有 | 有 |
| 附带文档 | `fileOtherListPage` | `rawFiles` | 无 | `files[]` |

**结论**：`transport` 是这套接口里唯一的真抽象——四站差异 90% 在"怎么取"，不在"取什么"。
`.cn` 与 `.com` 是两套账号、两套 token、细节可能有差异 → **拆成两个独立站点包，
各自实现，不抽公共层**（用户 2026-10-30 决定：宁可重复，也不要"改一处影响两站"）。
代价是两个文件里约有 250 行重复代码，接受。

---

## 4. 通道层：两个资源池

### 4.1 网络池 `net.mjs`

统一封装匿名 HTTP：`AbortSignal.timeout`（默认 20s，下载 120s）、状态码检查、
最多 3 次退避重试、`Content-Length` 校验、流式落盘并同时算 sha256。

### 4.2 浏览器池 `channel.mjs`

**实测数据（本机，3 核，Chromium 里 22–26 个页面）**：

| 场景 | connectOverCDP | 页面加载 |
|---|---|---|
| 1 个客户端 | 19.6 s | 成功（31 s 全程） |
| 2 个客户端并发 | **两个都 120 s 超时** | — |
| 5 个客户端并发 | 37–41 s | 4/5 在 45 s 超时 |
| 服务端自己的常驻连接 | 已连 | MakerWorld `goto` 30 s 超时 |

结论：**这个浏览器只能有一个写者。** 原因有二：

1. `connectOverCDP` 的耗时随浏览器里已有 target 数增长（22 个页面 → 19.6 s），
   `channel.mjs` 的 20 s 超时正好压在临界点 → 间歇性"浏览器没连上"。
2. 3 核跑 5 个 SPA 页面直接把机器打满（实测 1 分钟 load 74）。

而浏览器里现在有 **约 20 个泄漏标签页**（`grab.mjs` 出错路径不调 `closePages()`，
`exit()` 又不 await），这是 connect 越来越慢的根因——一个自我恶化的循环。

**设计**：

- 浏览器操作全部进"浏览器池"，**全局并发 1**，由持有连接的那个进程执行。
- 每个任务结束时强制 `closePages()`（`finally` + 进程退出钩子 + `SIGTERM`）。
- 每次取页前先清理本工具的残留标签（按 URL 前缀识别，不碰用户自己的标签）。
- `connectOverCDP` 超时提到 60 s，连上后常驻，不重复连。

**推论**：每站队列并行时，`http` lane 可以真并行，`page`/`click` lane 必须排队等浏览器池。
所以四站的并行度实际是：snapmaker 随时可跑，creality 详情可跑（下载要排队），
makerworld 全程排队，makeronline 全程排队。

浏览器池的排队策略是**轮转**（round-robin）：`creality → makerworld → makeronline-cn →
makeronline-com → snapmaker → 回到 creality`。一个 lane 用完浏览器后让出，排到队尾，
避免某个站（尤其 MakerWorld，每个任务要开好几个页面）长期霸占浏览器。

### 4.3 限速属于站点包

```js
rate: { modelGapSec: [60, 120],   // 两个模型之间
        fileGapSec:  [5, 10],      // 同一模型的多个文件之间（原先完全没有）
        maxModels:   1 }          // 同时抓几个模型，默认 1
```

队列只负责按 `rate` 调度，不自己写死数字。`MARKLAB_MIN_GAP` 之类的 env 只能**调大**，不能调小。

---

## 5. 队列：每站一条

`tasks.mjs` 从"一个 Map + 一个 queue + 一个 running"改成按 lane 分桶：

```
lane = 'creality' | 'makerworld' | 'snapmaker' | 'makeronline-cn' | 'makeronline-com'

queues:   Map<lane, Task[]>
running:  Map<lane, Task>
nextOkAt: Map<lane, number>       // 只被本 lane 的 finish() 更新
```

- 任务记录加 `lane` 字段；旧 JSONL 没有的按 URL 推断回填（兼容现有 222 行）。
- 插队 / 停止 / 重试按 lane 操作；控制台加"站点"列。
- 同一 lane 内仍严格串行，`maxModels` 默认 1。
- `page`/`click` 类任务额外占用浏览器池（全局 1）。
- 并发上限 `MARKLAB_MAX_LANES`（默认 5，建议先 3）。

**吞吐**：单队列 34 个/小时，5 条 lane ≈ 170 个/小时。当前入队需求 54 个/小时
（ipwatch 34.8 + 订阅 12.5 + bulk 6.7），所以队列积压问题**靠这条设计直接解决**，
不需要砍 ipwatch 的 roundLimit。

---

## 6. 存储层 `store.mjs`

### 6.1 原子写

```js
export async function writeJson(file, obj) {   // 全仓唯一写 JSON 的入口
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try { await fh.writeFile(JSON.stringify(obj, null, 2)); await fh.sync(); }
  finally { await fh.close(); }
  await fs.rename(tmp, file);                  // rename 是原子操作
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    await fs.rename(file, `${file}.bad-${Date.now()}`);   // 坏文件不静默覆盖
    throw new Error(`${file} 解析失败，已改名备查`);
  }
}
```

替换 9 处：`grab.mjs:816`、`subs.mjs:78`、`dup.mjs:94/145`、`llm.mjs:33/53`、
`server.mjs:104/184`、`cats.mjs:115/213`、`bulk.mjs:101`。

### 6.2 订阅：运行期只读

`subs.run(id)` 开头 `load(true)` 取最新一份，深拷贝成快照，整个运行期用快照，
**结束不写回**。写只发生在控制台编辑与 ipwatch 生成，且写前先 `load(true)` 合并。
这条同时解决"两个进程抢着改同一份文件"。

### 6.3 库目录写入政策（写进 AGENTS.md）

- `files/` `img/` 一旦写入不可变；
- `model.json` 只许增补字段（`llmTags`、`autoTags`），不许改抓取字段；
- 派生数据（预览缓存、清洗后的描述）一律放 `data/`，不放库目录。

---

## 7. 事件流

每个子系统一个文件，共享同一个信封：

```
data/events/fetch-2026-10.jsonl
data/events/tag-2026-10.jsonl
data/events/dup-2026-10.jsonl
data/events/sub-2026-10.jsonl
```

```json
{"ts":"2026-10-30T11:00:00+08:00","kind":"fetch","lane":"snapmaker",
 "dir":"snapmaker-1170","url":"…","ms":31200,"attempt":1,"ok":true,
 "msg":"3 个文件 / 12.4 MB"}
```

公共字段：`ts`（入库时间）、`kind`（类型）、`ms`（耗时）、`attempt`（重试次数）、
`ok`（成功/失败）、`msg`（简要信息）、`lane`、`dir`、`url`。其余字段各子系统自定义。

写入用 `fs.appendFile`（Linux 上小行追加是原子的），每月一个文件，读取用
`store.readEvents(kind, { since, limit })`。抓取任务的 JSONL 保持现状，不重复记。

**为什么按子系统分文件**：写频率差两个数量级（fetch 每小时几十行，tag 一次几百行）、
读的人不同（控制台四个 tab 各读一个）、格式确实不一样。共享信封保证"四个 tab 长得一样"。

---

## 8. 流程图

### 8.1 抓取（`grab.mjs`）

```
 URL ──► sites[].match ──► 认不出? exit 2
                              │
                              ▼
                    ctx.http 取详情 ──► normalize ──► dup.check
                                                          │同站：网址/标题+作者 → 重复
                                                          │跨站：标题+作者 → 疑似
                                                          ▼
                                    同站重复? ──是──► 记 duplicates.json + exit 0（不建目录）
                                                          │否（跨站疑似也继续）
                                                          ▼
                     建目录 / 下载图片 / 逐文件下载（fileGapSec 抖动）
                                                          │
                                                          ▼
                                 跨站疑似? ──是──► dup.confirm 比作者件 sha256
                                                          │命中 → 删新目录 + 记 hash + exit 0
                                                          │不中 → 记疑似，继续入库
                                                          ▼
                    writeJson(model.json) ──► 事件 ──► exit 0
                                                   (finally: closePages)
```

### 8.2 订阅（`subs.run`）

```
 tick（每分钟）
   └─ isDue? ──► load(true) 取最新设置 ──► 快照（运行期只读）
        └─ for site × keyword × page:
              search[site]（走该站 rate） ──► 过滤门槛 / 库内 / 在跑
                 └─ tasks.enqueue(lane) ──► 事件 sub-*.jsonl
        └─ 写 lastRunAt / lastResult（唯一一次写回）
```

### 8.3 控制台读取

```
 浏览器 ──► GET /api/console/{workbench,subs,tasks,events} ──► store 读 ──► JSON
                                                                   │
                                        events/*.jsonl 按 kind 分文件，倒序 tail 200 行
```

---

## 9. 重构顺序

每步可单独跑、可单独验证、可单独回滚。

| 步 | 内容 | 验证 |
|---|---|---|
| 0 | 停 bulk、提交当前基线、清理泄漏标签页 | `node --test test.mjs` 12 pass |
| 1 | `store.mjs`：原子写/读，替换 9 处 | 写坏文件不丢数据 |
| 2 | `net.mjs` + `channel.mjs` 收口（超时、closePages、单连接、清理残留） | 连 5 次不泄漏标签 |
| 3 | `sites/` 注册表：先搬 match/hosts/auth/hot | `lib`/`channel`/`session` 改读注册表，行为不变 |
| 4 | 搬 6 个能力，`transport` 生效 | 四站各抓 1 个模型成功 |
| 5 | 每站队列 + 站点限速 | 5 lane 并发跑，浏览器不冲突 |
| 6 | 事件流 + 控制台四页 | 四个 tab 有数据 |

---

## 10. 明确不做

- 不做插件目录扫描 / 动态加载 / 版本号 / 第三方安装 —— 静态 import 足够。
- 不引入第二个 npm 依赖（含 HTML 解析器、模板引擎、前端框架）。
- 不把 `library/` 迁到 SQLite：`model.json` 每模型一份、可 cat、可 diff、可单独搬走，
  这是资产不是状态。
- 不做鉴权（个人项目），但服务默认绑 `127.0.0.1`。
- 不做描述的"抓取时清洗存库"（C 方案）：Node 没有 DOMParser，清洗要自己写解析器，
  而且会不可逆地丢掉原文。改用渲染时 DOMParser 白名单 + CSP 兜底。

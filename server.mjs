// 模型库服务：静态文件 + 接口（列模型 / 分类树 / 抓一个网址 / 补抓文件 / 删模型 / 看文件内容）。
// 零依赖，起在 :8851，前面挂不挂反代都行。
//
//   node server.mjs            # 默认 8851
//   PORT=8890 node server.mjs
//
// 抓取会 spawn `node grab.mjs <url>`，同一时刻只跑一个（浏览器标签别抢）。

import http from 'node:http';
import { readFile, readdir, rm, stat, mkdir } from 'node:fs/promises';
import { inspectFile, PREVIEW_ROOT } from './inspect.mjs';
import { catIndex, catOf, checkinText, inside, writeJson, ROOT } from './lib.mjs';
import { match as matchSite, byName as packOf } from './sites/index.mjs';
import * as tasks from './tasks.mjs';
import * as stats from './stats.mjs';
import * as subs from './subs.mjs';
import * as checkinAuto from './checkin.mjs';
import * as dup from './dup.mjs';
import * as session from './session.mjs';
import * as search from './search.mjs';
import * as llm from './llm.mjs';
import path from 'node:path';

const WEB = path.join(ROOT, 'web');
const LIB = path.join(ROOT, 'library');
// 磁盘低于这个数就不让入队：写一半失败比排队更糟
const MIN_FREE_BYTES = 5 * 1024 ** 3;
const PORT = Number(process.env.PORT || 8851);

// 分类对照（docs/categories/）：模型按原站分类名映射到统一分类，启动时读一次。
// 读不到就当没有分类——临时根（MARKLAB_ROOT）里没拷 docs/ 也要能起服务。
const readJsonOr = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const CATS = await readJsonOr(path.join(ROOT, 'docs/categories/merge.json'), { level1: [] });
const CAT_MAP = catIndex((await readJsonOr(path.join(ROOT, 'docs/categories/sites.json'), { sites: {} })).sites, CATS);

// 积分/签到状态缓存 60 秒：和登录态一个口径。checkinStatus() 每站要打两三个接口，跟着轮询会打穿站点
let statusCache = { at: 0, data: {} };
const withTimeout = (promise, ms, what) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}超时（${ms / 1000} 秒没响应）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

async function siteStatus(force = false) {
  if (!force && Date.now() - statusCache.at < 60_000) return statusCache.data;
  const data = {};
  await Promise.all(
    session.SITES.map(async ({ site }) => {
      const pack = packOf(site);
      if (typeof pack?.checkinStatus !== 'function') return;
      try {
        data[site] = await withTimeout(pack.checkinStatus(), 15_000, '积分探测');
      } catch (e) {
        data[site] = { note: String(e.message || e).slice(0, 120) };
      }
    }),
  );
  statusCache = { at: Date.now(), data };
  return data;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.3mf': 'application/octet-stream',
  '.stl': 'model/stl',
  '.zip': 'application/zip',
};

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
};

async function serveFile(res, file) {
  try {
    const st = await stat(file);
    if (!st.isFile()) return json(res, 404, { error: 'not a file' });
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': file.includes('/library/') ? 'no-cache' : 'no-store',
    });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// 读一个 model.json 并补上派生字段（分类、文件是否还在盘上）
async function hydrate(dirName, model) {
  model.dir = dirName;
  // 分类表的键是「分类 id 空间」不是数据键：MakerOnline 两域共用一张表（以海外站的 id 为准）
  model.cat = catOf(CAT_MAP, packOf(model.platform)?.categoriesKey || model.platform, model.category);
  // 文件可能在磁盘上被删过，按实际存在与否标一下
  for (const f of model.savedFiles || []) {
    try {
      await stat(path.join(LIB, dirName, f.path));
      f.exists = true;
    } catch {
      f.exists = false;
    }
  }
  delete model.fileIds;
  return model;
}

// 同模型链接：库里已有的互相指，被拦下的指回站点原帖（判重只写 data/duplicates.json，不动 library/）
function linkDups(m, dups, byKey) {
  const key = `${m.platform}:${m.id}`;
  const links = [];
  const fwd = dups[key];
  if (fwd) {
    const t = byKey.get(fwd.of);
    if (t) links.push({ key: fwd.of, title: t.title, dir: t.dir, by: fwd.by, scope: fwd.scope, at: fwd.at });
    // 详情页和卡片读同一份数据：以前 duplicateOf 写了没人读，等于白写
    m.duplicateOf = { of: fwd.of, by: fwd.by, scope: fwd.scope, at: fwd.at };
  }
  for (const [k, v] of Object.entries(dups)) {
    if (v.of === key && k !== key) {
      links.push({ key: k, title: v.title, url: v.url, by: v.by, scope: v.scope, at: v.at });
    }
  }
  if (links.length) m.sameModels = links;
  return m;
}

// 判重标记怎么念：同站命中是「确认」，跨站只有撞了 sha256 才算确认，其余是「疑似」
const DUP_LABEL = { same: '同站同标题同作者（确认）', hash: '跨站作者件字节相同（确认）', meta: '跨站标题+作者相同（疑似）' };

// 列表只发卡片字段：641 个模型连 description/rawFiles 一起发是 5.5MB，每次搜索都传一遍太贵。
// 详情页点开时再按 dir 拉一份完整的（GET /api/model?dir=）。
const CARD_FIELDS = [
  'dir', 'id', 'platform', 'site', 'title', 'author', 'category', 'cat',
  'tags', 'autoTags', 'llmTags', 'translated', 'fetchedAt', 'stats', 'sameModels',
  'noFiles', 'duplicateOf', 'picked', 'sourceUrl',
];
function slim(m) {
  const out = {};
  for (const k of CARD_FIELDS) if (m[k] !== undefined) out[k] = m[k];
  out.cover = (m.localImages && m.localImages[0]) || (m.images && m.images[0]) || '';
  // 卡片只数配置和文件，具体内容点开详情再拉
  out.profileCount = (m.profiles || []).length;
  out.print = m.print
    ? { timeSec: m.print.timeSec, timeText: m.print.timeText, weightG: m.print.weightG, plates: m.print.plates }
    : null;
  out.savedFiles = (m.savedFiles || []).map((f) => ({ name: f.name, kind: f.kind, exists: f.exists }));
  return out;
}

// /api/models 的结果缓存：600+ 模型每次全量重算要 0.5–0.9 秒、500 KB。
// 失效靠两条：库目录 mtime 变了（增删模型），或写操作显式调 invalidateModels()（改 model.json）。
let modelsCache = null;
let modelsCacheAt = 0;
let modelsCacheSig = '';
export function invalidateModels() {
  modelsCache = null;
}
// 抓取子进程写完 model.json 时 library/ 的 mtime 不一定变（覆盖已有目录），
// 所以让任务收尾直接踢一脚缓存
tasks.onFinish(() => invalidateModels());

async function listModels() {
  let sig = '';
  try {
    const st = await stat(LIB);
    sig = `${st.mtimeMs}:${st.ino}`;
  } catch {}
  if (modelsCache && Date.now() - modelsCacheAt < 60_000 && sig === modelsCacheSig) return modelsCache;
  const out = [];
  for (const entry of await readdir(LIB, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(await hydrate(entry.name, JSON.parse(await readFile(path.join(LIB, entry.name, 'model.json'), 'utf8'))));
    } catch {}
  }
  const dups = await dup.marks();
  const byKey = new Map(out.map((m) => [`${m.platform}:${m.id}`, m]));
  for (const m of out) linkDups(m, dups, byKey);
  out.sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)));
  modelsCache = out;
  modelsCacheAt = Date.now();
  modelsCacheSig = sig;
  return out;
}


// 智能打标签：规则标签（autoTags）之外再问一次大模型，结果单独存 llmTags，不覆盖原字段。
// 只在用户点了按钮时跑——每模型一次调用，是真花钱的地方。
async function tagOne(dirName, pool) {
  const file = path.join(LIB, dirName, 'model.json');
  const m = JSON.parse(await readFile(file, 'utf8'));
  const { tags, newWords } = await llm.tagModel(
    { dir: dirName, id: m.id, platform: m.platform, title: m.title, description: m.description, category: m.category, tags: m.tags },
    pool,
  );
  if (tags.length) {
    m.llmTags = tags;
    await writeJson(file, m);
  }
  return { dir: dirName, tags, newWords };
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1 << 20) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });

// 目录名只允许 library 下真实存在的模型目录，挡掉路径穿越
/** 磁盘不够就返回一句人话（null = 可以入队）。查不到剩余空间时不拦，别因噎废食。 */
async function diskTooLow() {
  const free = await stats.freeSpace();
  if (free == null || free >= MIN_FREE_BYTES) return null;
  return { error: `磁盘不足：只剩 ${(free / 1024 ** 3).toFixed(1)} GB，至少要留 5 GB 再抓` };
}

async function safeModelDir(name) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name || '')) return null;
  const dir = path.join(LIB, name);
  if (!(await inside(LIB, dir))) return null;
  try {
    const model = JSON.parse(await readFile(path.join(dir, 'model.json'), 'utf8'));
    return { dir, model };
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // 放在 try 里面：畸形的 % 编码会抛 URIError，接不住就是进程直接死
    const p = decodeURIComponent(url.pathname);

    if (p === '/api/models') return json(res, 200, (await listModels()).map(slim));
    if (p === '/api/model' && req.method === 'GET') {
      const found = await safeModelDir(url.searchParams.get('dir'));
      if (!found) return json(res, 404, { error: 'not found' });
      const one = await hydrate(path.basename(found.dir), found.model); // safeModelDir 给的是绝对路径，对外只露目录名
      const dups = await dup.marks();
      const byKey = new Map([[one.platform + ':' + one.id, one]]);
      // 正向链接的目标在库里的话，把它的目录补进索引，前端才能跳过去
      const fwd = dups[one.platform + ':' + one.id];
      if (fwd && !byKey.has(fwd.of)) {
        const dirName = fwd.of.replace(':', '-');
        try {
          await stat(path.join(LIB, dirName, 'model.json'));
          byKey.set(fwd.of, { dir: dirName, title: fwd.title });
        } catch {}
      }
      return json(res, 200, linkDups(one, dups, byKey));
    }

    if (p === '/api/categories')
      return json(res, 200, {
        level1: CATS.level1.map((l) => ({ id: l.id, name: l.name, children: l.children.map((c) => ({ id: c.id, name: c.name })) })),
      });

    if (p === '/api/grab' && req.method === 'POST') {
      const { url: target } = await readBody(req);
      if (!/^https?:/i.test(target || '')) return json(res, 400, { error: '需要 http(s) 网址' });
      if (!matchSite(target)) return json(res, 400, { error: '不认识的站点网址' });
      const low = await diskTooLow();
      if (low) return json(res, 400, low);
      const { task } = tasks.enqueue({ url: target, source: 'manual' });
      // 202：不阻塞请求，入库要排限速闸门（可能几分钟）；进度看 /api/console/tasks
      return json(res, 202, { accepted: true, taskId: task.id });
    }

    if (p === '/api/files' && req.method === 'POST') {
      const { dir } = await readBody(req);
      const found = await safeModelDir(dir);
      if (!found) return json(res, 404, { error: '没有这个模型' });
      if (!matchSite(found.model.sourceUrl)) return json(res, 400, { error: '这个模型没有可识别的来源网址' });
      const low = await diskTooLow();
      if (low) return json(res, 400, low);
      const { task } = tasks.enqueue({ url: found.model.sourceUrl, source: 'refetch' });
      return json(res, 202, { accepted: true, taskId: task.id });
    }

    // 看一个文件里有什么（3mf 的打印盘图/盘名、stl 的面数与尺寸）
    if (p === '/api/inspect') {
      const dir = url.searchParams.get('dir') || '';
      const file = url.searchParams.get('file') || '';
      const found = await safeModelDir(dir);
      if (!found) return json(res, 404, { error: '没有这个模型' });
      // 只认 files/ 下的裸文件名（basename 必须等于原值），挡住路径穿越
      if (path.basename(file) !== file || !/\.(3mf|stl)$/i.test(file)) return json(res, 400, { error: '文件名不合法' });
      const abs = path.join(found.dir, 'files', file);
      if (!(await inside(found.dir, abs))) return json(res, 403, { error: 'forbidden' });
      const cacheFile = path.join(PREVIEW_ROOT, path.basename(found.dir), `${file}.json`);
      try {
        return json(res, 200, JSON.parse(await readFile(cacheFile, 'utf8')));
      } catch {}
      try {
        const info = await inspectFile(abs);
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeJson(cacheFile, info);
        return json(res, 200, info);
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    }

    if (p === '/api/model' && req.method === 'DELETE') {
      const { dir } = await readBody(req);
      const found = await safeModelDir(dir);
      if (!found) return json(res, 404, { error: '没有这个模型' });
      await rm(found.dir, { recursive: true, force: true });
      await rm(path.join(PREVIEW_ROOT, path.basename(found.dir)), { recursive: true, force: true });
      invalidateModels();
      // 标记跟着模型走：删了模型还留着指向它的标记，页面会链到一个不存在的目录
      await dup.forget(`${found.model.platform}:${found.model.id}`);
      return json(res, 200, { ok: true });
    }

    // ── 控制台 ────────────────────────────────────────────────
    if (p === '/console' || p === '/console.html') return serveFile(res, path.join(WEB, 'console.html'));
    if (p === '/console.js' || p === '/console.css') return serveFile(res, path.join(WEB, p.slice(1)));

    if (p === '/api/console/workbench') {
      await tasks.refresh();
      return json(res, 200, await stats.workbench(url.searchParams.get('force') === '1'));
    }

    // 站点包卡片：登录态 + 积分/签到 + 库内数据 + 限速，一次拿全，前端别串四个请求
    if (p === '/api/console/sites') {
      const force = url.searchParams.get('force') === '1';
      const [logins, wb, st] = await Promise.all([session.state(force), stats.workbench(force), siteStatus(force)]);
      const queue = tasks.state();
      const cfg = tasks.siteConfigGet();
      const global = tasks.gapsMs().map((ms) => ms / 1000); // 输入框的占位值：没覆盖时就是这个
      const sites = logins.map((l) => {
        const pack = packOf(l.site);
        const mine = st[l.site] || {};
        const own = cfg[l.site]?.modelGapSec;
        const packRate = pack?.rate?.modelGapSec;
        return {
          site: l.site,
          label: l.label,
          login: l, // {ok,status,name,reason}；stale 表示这次没探到、留着上次的
          points: mine.points ?? null,
          checkin: mine.checkin || null,
          note: mine.note || null,
          models: wb.models.bySite[l.site] || 0,
          lastFetch: wb.models.lastFetch?.[l.site] || null,
          pending: wb.models.pending?.[l.site] || 0,
          last24h: wb.models.last24h?.[l.site] || 0,
          daily: wb.models.daily?.[l.site] || null, // 最近 7 个自然日各抓了多少个带 3mf 的
          rate: {
            modelGapSec: own || packRate || null,
            global,
            source: own ? 'custom' : packRate ? 'pack' : 'global',
            searchPerMin: cfg[l.site]?.searchPerMin || null,
            searchPerMinGlobal: search.RATE.perSite,
          },
          checkinAuto: Boolean(cfg[l.site]?.checkinAuto),
          // 能力位照 site-pack.md §5：typeof 判断，不按站点名判断
          abilities: {
            checkin: typeof pack?.checkin === 'function',
            checkinStatus: typeof pack?.checkinStatus === 'function',
            categories: typeof pack?.categories === 'function',
            userModels: typeof pack?.userModels === 'function',
            sorts: pack?.searchOptions?.sorts ?? [], // 本站支持的搜索排序（site-pack.md §11.2）
            tags: pack?.searchOptions?.tags === true, // 搜索结果带不带标签，订阅端据此灰掉 tag 勾选
          },
        };
      });
      return json(res, 200, {
        at: new Date().toISOString(),
        paused: queue.paused,
        queued: queue.queued,
        running: queue.running,
        days: wb.models.days || null, // 柱状图的 7 个日期标签（最老 → 今天）
        config: cfg, // 前端改限速时整份回传，别让它自己拼
        sites,
      });
    }

    // 签到：复用包里的 checkin()。checkin.mjs 那套 CLI 收尾（process.exit / forget）不能带进来
    if (p === '/api/console/checkin' && req.method === 'POST') {
      const { site, dry } = await readBody(req);
      const pack = packOf(site);
      if (typeof pack?.checkin !== 'function') return json(res, 400, { error: '这个站没有签到' });
      try {
        const r = await pack.checkin({ dry: Boolean(dry) });
        statusCache.at = 0; // 签完了，卡片上的数字立刻重取
        return json(res, 200, { ...r, text: checkinText(r, !dry) });
      } catch (e) {
        return json(res, 500, { error: String(e.message || e).slice(0, 200) });
      }
    }

    // 站点自定义限速（ADR-0006）：只收 modelGapSec，别的字段一律不认
    if (p === '/api/console/site-config') {
      if (req.method === 'POST') return json(res, 200, await tasks.siteConfigSet(await readBody(req)));
      return json(res, 200, tasks.siteConfigGet());
    }

    if (p === '/api/console/tasks') {
      await tasks.refresh(); // 并入 bulk.mjs 这类别的进程写的任务
      return json(res, 200, tasks.list({ limit: Number(url.searchParams.get('limit')) || 100 }));
    }

    if (p === '/api/console/tasks/retry' && req.method === 'POST') {
      const { id } = await readBody(req);
      const t = tasks.retry(id);
      return json(res, t ? 200 : 404, t || { error: '没有这条任务，或者它还在跑' });
    }

    if (p === '/api/console/tasks/promote' && req.method === 'POST') {
      const { id } = await readBody(req);
      const r = tasks.promote(id);
      return json(res, r.ok ? 200 : 409, r);
    }

    if (p === '/api/console/tasks/stop' && req.method === 'POST') {
      const { id } = await readBody(req);
      const r = tasks.stop(id);
      return json(res, r.ok ? 200 : 409, r);
    }

    // 队列总闸：暂停后订阅/批抓/补抓都只排队，只有人点继续或手动开始才放行
    if (p === '/api/console/queue') return json(res, 200, tasks.state());
    if (p === '/api/console/queue/pause' && req.method === 'POST') return json(res, 200, tasks.pause());
    if (p === '/api/console/queue/resume' && req.method === 'POST') return json(res, 200, tasks.resume());

    // 智能打标签：给一个模型打，或给所有还没打过的一批打（后台跑，别让请求等）
    if (p === '/api/console/tags' && req.method === 'POST') {
      const { dir, all } = await readBody(req);
      const pool = await llm.tagPool();
      if (!pool.length) return json(res, 400, { error: '大模型还没配置，先在上面填 API 地址和密钥' });
      if (dir) {
        const found = await safeModelDir(dir);
        if (!found) return json(res, 404, { error: '没有这个模型' });
        return json(res, 200, await tagOne(dir, pool));
      }
      if (!all) return json(res, 400, { error: '要么给 dir，要么给 all:true' });
      const todo = (await listModels()).filter((m) => !m.llmTags).map((m) => m.dir);
      (async () => {
        for (const d of todo) {
          try {
            await tagOne(d, pool);
          } catch (e) {
            console.error('[tags]', d, e.message);
          }
        }
        console.log(`[tags] 打完 ${todo.length} 个`);
      })();
      return json(res, 202, { started: true, queued: todo.length });
    }

    // 待补抓：把「站点有文件但本地一个都没有」的模型排进队列
    if (p === '/api/console/refetch' && req.method === 'POST') {
      const low = await diskTooLow();
      if (low) return json(res, 400, low);
      const models = await listModels();
      const todo = models.filter((m) => !(m.savedFiles || []).length && (m.files || []).length > 0);
      for (const m of todo) tasks.enqueue({ url: m.sourceUrl, source: 'refetch' });
      return json(res, 202, { queued: todo.length });
    }

    if (p === '/api/console/dups') return json(res, 200, await dup.marks());

    // 控制台「运行日志」页：四类事件合成一条时间轴，前端按 type 筛选。
    // 不落单独的日志文件——队列/订阅/判重各自已经有落盘记录，这里只做合并，少一处要维护的真相。
    if (p === '/api/console/events') {
      const type = url.searchParams.get('type') || 'all';
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      const want = (t) => type === 'all' || type === t;
      const out = [];
      if (want('queue')) {
        for (const t of tasks.list({ limit })) {
          out.push({
            at: t.createdAt,
            type: 'queue',
            site: t.site || matchSite(t.url)?.site || null,
            title: t.title || t.url,
            url: t.url,
            state: t.phase,
            detail: t.error || t.warning || (t.progress && t.progress.total ? `${t.progress.done}/${t.progress.total} 个文件` : ''),
          });
        }
      }
      if (want('subscribe')) {
        for (const h of await subs.allHits(limit)) {
          out.push({
            at: h.matchedAt,
            type: 'subscribe',
            site: h.site,
            title: h.title || h.id,
            url: h.url,
            state: h.taskId ? 'queued' : 'hit',
            detail: `${h.subName || h.subId || '订阅'} · 赞 ${h.likes || 0} 下载 ${h.downloads || 0}`,
          });
        }
      }
      if (want('tag')) {
        for (const p2 of await llm.pendingWords()) {
          out.push({ at: p2.at, type: 'tag', site: '', title: p2.word, url: '', state: 'pending', detail: `大模型建议的新词 · ${p2.model || '—'}` });
        }
      }
      if (want('dup')) {
        for (const [k, v] of Object.entries(await dup.marks())) {
          out.push({
            at: v.at,
            type: 'dup',
            site: String(k).split(':')[0],
            title: v.title || k,
            url: v.url || '',
            state: DUP_LABEL[v.scope === 'same' ? 'same' : v.by] || v.by,
            detail: `${DUP_LABEL[v.scope === 'same' ? 'same' : v.by] || v.by} → ${v.of}`,
          });
        }
      }
      out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return json(res, 200, out.slice(0, limit));
    }

    if (p === '/api/console/subs') {
      if (req.method === 'GET') return json(res, 200, await subs.list());
      try {
        if (req.method === 'POST') return json(res, 200, await subs.create(await readBody(req)));
        if (req.method === 'PATCH') {
          const { id, ...patch } = await readBody(req);
          return json(res, 200, await subs.update(id, patch));
        }
        if (req.method === 'DELETE') return json(res, 200, { ok: await subs.remove((await readBody(req)).id) });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    // 全部订阅一起停/开：一次写盘，控制台的「全部停止」用
    if (p === '/api/console/subs/enabled' && req.method === 'POST') {
      const { enabled } = await readBody(req);
      return json(res, 200, await subs.setAllEnabled(enabled === true));
    }

    // 跑一轮订阅要几分钟（搜索限速 + 入库排队），不阻塞请求：立刻返回，进度看 /api/console/tasks
    if (p === '/api/console/subs/run' && req.method === 'POST') {
      const { id } = await readBody(req);
      subs.run(id).catch((e) => console.error('[subs]', e.message));
      return json(res, 202, { started: true });
    }

    if (p === '/api/console/subs/hits')
      return json(res, 200, await subs.hits(url.searchParams.get('id'), Number(url.searchParams.get('limit')) || 200));

    // 本轮候选清单：给控制台看「搜到了什么、为什么没进队列」
    if (p === '/api/console/subs/candidates') return json(res, 200, await subs.candidates(url.searchParams.get('id')));

    if (p === '/api/console/llm') {
      if (req.method === 'GET') {
        const cfg = await llm.loadConfig();
        return json(res, 200, {
          baseUrl: cfg?.baseUrl || '',
          model: cfg?.model || '',
          hasKey: Boolean(cfg?.apiKey),
          tagCount: (await llm.tagPool()).length,
          pending: await llm.pendingWords(),
        });
      }
      const { baseUrl, apiKey, model } = await readBody(req);
      await llm.saveConfig({ baseUrl, apiKey, model });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/console/llm/models' && req.method === 'POST') {
      try {
        return json(res, 200, await llm.listModels());
      } catch (e) {
        return json(res, 502, { error: String(e.message || e) });
      }
    }

    if (p === '/api/console/llm/pending' && req.method === 'POST') {
      const { word, accept } = await readBody(req);
      return json(res, 200, { ok: await llm.resolveWord(word, Boolean(accept)) });
    }

    if (p === '/' || p === '/index.html') return serveFile(res, path.join(WEB, 'index.html'));
    if (p === '/app.js' || p === '/style.css') return serveFile(res, path.join(WEB, p.slice(1)));

    // 派生数据（3mf 盘图）：库目录里不再放，改从这里出
    if (p.startsWith('/preview/')) {
      const file = path.join(PREVIEW_ROOT, p.slice('/preview/'.length));
      if (!(await inside(PREVIEW_ROOT, file))) return json(res, 403, { error: 'forbidden' });
      return serveFile(res, file);
    }

    if (p.startsWith('/library/')) {
      const rel = p.slice('/library/'.length);
      const file = path.join(LIB, rel);
      if (!(await inside(LIB, file))) return json(res, 403, { error: 'forbidden' });
      return serveFile(res, file);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

// 上次没跑完的任务接着跑；订阅每分钟看一次有没有到点；开了自动签到的站每天签一次
const restored = await tasks.restore();
setInterval(() => subs.tick().catch((e) => console.error('[subs]', e.message)), 60_000);
checkinAuto.startAuto(tasks.siteConfigGet);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`模型库  http://127.0.0.1:${PORT}/    (静态目录 ${path.relative(ROOT, LIB)}/)`);
  console.log(`控制台  http://127.0.0.1:${PORT}/console`);
  if (restored.loaded) console.log(`任务    上次 ${restored.loaded} 条，续跑 ${restored.resumed} 条`);
});

// 模型库服务：静态文件 + 接口（列模型 / 分类树 / 抓一个网址 / 补抓文件 / 删模型 / 看文件内容）。
// 零依赖，起在 :8851，前面挂不挂反代都行。
//
//   node server.mjs            # 默认 8851
//   PORT=8890 node server.mjs
//
// 抓取会 spawn `node grab.mjs <url>`，同一时刻只跑一个（浏览器标签别抢）。

import http from 'node:http';
import { readFile, readdir, rm, stat, mkdir } from 'node:fs/promises';
import { inspectFile } from './inspect.mjs';
import { catIndex, catOf, inside, writeJson, ROOT } from './lib.mjs';
import { match as matchSite } from './sites/index.mjs';
import * as tasks from './tasks.mjs';
import * as stats from './stats.mjs';
import * as subs from './subs.mjs';
import * as dup from './dup.mjs';
import * as session from './session.mjs';
import * as llm from './llm.mjs';
import path from 'node:path';

const WEB = path.join(ROOT, 'web');
const LIB = path.join(ROOT, 'library');
const PORT = Number(process.env.PORT || 8851);

// 分类对照（docs/categories/）：模型按原站分类名映射到统一分类，启动时读一次
const CATS = JSON.parse(await readFile(path.join(ROOT, 'docs/categories/merge.json'), 'utf8'));
const CAT_MAP = catIndex(JSON.parse(await readFile(path.join(ROOT, 'docs/categories/sites.json'), 'utf8')).sites, CATS);

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
  model.cat = catOf(CAT_MAP, model.platform, model.category);
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

async function listModels() {
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
  return out.sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)));
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
      const { task } = tasks.enqueue({ url: target, source: 'manual' });
      // 202：不阻塞请求，入库要排限速闸门（可能几分钟）；进度看 /api/console/tasks
      return json(res, 202, { accepted: true, taskId: task.id });
    }

    if (p === '/api/files' && req.method === 'POST') {
      const { dir } = await readBody(req);
      const found = await safeModelDir(dir);
      if (!found) return json(res, 404, { error: '没有这个模型' });
      if (!matchSite(found.model.sourceUrl)) return json(res, 400, { error: '这个模型没有可识别的来源网址' });
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
      const cacheFile = path.join(found.dir, '.inspect', `${file}.json`);
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

    // 登录态单独一个接口：探测要开浏览器标签，几秒才回来，不能拖住首屏
    if (p === '/api/console/login') return json(res, 200, await session.state(url.searchParams.get('force') === '1'));

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

// 上次没跑完的任务接着跑；订阅每分钟看一次有没有到点
const restored = await tasks.restore();
setInterval(() => subs.tick().catch((e) => console.error('[subs]', e.message)), 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`模型库  http://127.0.0.1:${PORT}/    (静态目录 ${path.relative(ROOT, LIB)}/)`);
  console.log(`控制台  http://127.0.0.1:${PORT}/console`);
  if (restored.loaded) console.log(`任务    上次 ${restored.loaded} 条，续跑 ${restored.resumed} 条`);
});

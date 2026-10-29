// 模型库服务：静态文件 + 三个接口（列模型 / 抓一个网址 / 补抓文件 / 删模型）。
// 零依赖，起在 :8851，前面挂不挂反代都行。
//
//   node server.mjs            # 默认 8851
//   PORT=8890 node server.mjs
//
// 抓取会 spawn `node grab.mjs <url>`，同一时刻只跑一个（浏览器标签别抢）。

import http from 'node:http';
import { readFile, readdir, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { inspectFile } from './inspect.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'web');
const LIB = path.join(ROOT, 'library');
const PORT = Number(process.env.PORT || 8851);

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

// 一次只跑一个抓取，避免多个浏览器标签互相抢
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function runGrab(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'grab.mjs'), url], {
      cwd: ROOT,
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, code, log: out.slice(-4000) }));
  });
}

async function listModels() {
  const out = [];
  for (const entry of await readdir(LIB, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const model = JSON.parse(await readFile(path.join(LIB, entry.name, 'model.json'), 'utf8'));
      model.dir = entry.name;
      // 文件可能在磁盘上被删过，按实际存在与否标一下
      for (const f of model.savedFiles || []) {
        try {
          await stat(path.join(LIB, entry.name, f.path));
          f.exists = true;
        } catch {
          f.exists = false;
        }
      }
      delete model.fileIds;
      out.push(model);
    } catch {}
  }
  return out.sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)));
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
  try {
    const model = JSON.parse(await readFile(path.join(dir, 'model.json'), 'utf8'));
    return { dir, model };
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);

  try {
    if (p === '/api/models') return json(res, 200, await listModels());

    if (p === '/api/grab' && req.method === 'POST') {
      const { url: target } = await readBody(req);
      if (!/^https?:/i.test(target || '')) return json(res, 400, { error: '需要 http(s) 网址' });
      const result = await enqueue(() => runGrab(target));
      return json(res, result.ok ? 200 : 500, result);
    }

    if (p === '/api/files' && req.method === 'POST') {
      const { dir } = await readBody(req);
      const found = await safeModelDir(dir);
      if (!found) return json(res, 404, { error: '没有这个模型' });
      const result = await enqueue(() => runGrab(found.model.sourceUrl));
      return json(res, result.ok ? 200 : 500, result);
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
      if (!abs.startsWith(found.dir + path.sep)) return json(res, 403, { error: 'forbidden' });
      const cacheFile = path.join(found.dir, '.inspect', `${file}.json`);
      try {
        return json(res, 200, JSON.parse(await readFile(cacheFile, 'utf8')));
      } catch {}
      try {
        const info = await inspectFile(abs);
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, JSON.stringify(info, null, 2));
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
      return json(res, 200, { ok: true });
    }

    if (p === '/' || p === '/index.html') return serveFile(res, path.join(WEB, 'index.html'));
    if (p === '/app.js' || p === '/style.css') return serveFile(res, path.join(WEB, p.slice(1)));

    if (p.startsWith('/library/')) {
      const rel = p.slice('/library/'.length);
      const file = path.join(LIB, rel);
      if (!file.startsWith(LIB + path.sep)) return json(res, 403, { error: 'forbidden' });
      return serveFile(res, file);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`模型库  http://127.0.0.1:${PORT}/    (静态目录 ${path.relative(ROOT, LIB)}/)`);
});

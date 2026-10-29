#!/usr/bin/env node
// 批量抓取：按站点榜单（默认 Snapmaker 精选·热门）一个个收进模型库。
//
//   node bulk.mjs --limit 10                 # 抓 10 个新的就停
//   node bulk.mjs --max-pages 5 --dry-run    # 只列出会抓哪些
//   node bulk.mjs --loop 6h                  # 长期跑：每 6 小时补一次新模型
//
// 规矩（按需求定的）：
//   · 两次下载之间随机间隔，且不少于 60 秒——1 分钟最多下 1 个
//   · 按「链接」和「标题+作者」双重去重，抓过的直接跳过
//   · 每抓一个立刻写一行日志：library/_bulk-log.md（人看）+ library/_bulk-log.csv（Excel）

import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const LIB = path.join(ROOT, 'library');
const LOG_MD = path.join(LIB, '_bulk-log.md');
const LOG_CSV = path.join(LIB, '_bulk-log.csv');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const site = flag('site', 'snapmaker');
const limit = Number(flag('limit', '20'));
const maxPages = Number(flag('max-pages', '10'));
const minGap = Number(flag('min-gap', '60')) * 1000; // 秒 → 毫秒
const maxGap = Number(flag('max-gap', '150')) * 1000;
const loopEvery = flag('loop', '');
const dryRun = has('dry-run');
const retryEmpty = has('retry-empty'); // 把「有介绍没文件」的再试一次（比如刚登录过）
const summary = has('summary'); // 只看统计（同一个模型以最后一行为准）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

// ── 榜单：Snapmaker 精选 + 热门（公开接口，不需要 token）────────────
async function fetchSnapmakerHot() {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api-models.snapmaker.cn/api/model/featured?page=${page}&pageSize=20&sort=hot`;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) break;
    const j = await r.json();
    const list = j.data?.list || [];
    if (!list.length) break;
    for (const m of list) {
      out.push({
        site: 'snapmaker',
        id: String(m.id),
        title: m.title || '',
        author: m.creator_name || '',
        url: `https://space.snapmaker.cn/zh/model/${m.id}-model`,
        downloads: m.download_count ?? null,
        likes: m.like_count ?? null,
      });
    }
    if (out.length >= (j.data?.total || 0)) break;
  }
  return out;
}

// ── 去重：链接（站点+id）和「标题+作者」两把锁 ────────────────────
async function loadSeen() {
  const byUrl = new Set();
  const byName = new Set();
  const emptyIds = new Set(); // 抓过但没文件的，登录后可以重试
  let dirs = [];
  try {
    dirs = await readdir(LIB, { withFileTypes: true });
  } catch {
    return { byUrl, byName };
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const [platform, id] = d.name.split('-');
    byUrl.add(`${platform}:${id}`);
    try {
      const m = JSON.parse(await readFile(path.join(LIB, d.name, 'model.json'), 'utf8'));
      byName.add(`${String(m.title || '').trim().toLowerCase()}|${String(m.author || '').trim().toLowerCase()}`);
      if (!(m.savedFiles || []).length) emptyIds.add(`${platform}:${id}`);
    } catch {}
  }
  return { byUrl, byName, emptyIds };
}

// ── 日志：md 表格 + csv，抓一个写一行 ─────────────────────────────
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function logRow(row) {
  await mkdir(LIB, { recursive: true });
  try {
    await readFile(LOG_MD);
  } catch {
    await writeFile(
      LOG_MD,
      '# 批量抓取日志\n\n| 时间 | 站点 | id | 标题 | 作者 | 状态 | 文件 | 耗时 | 备注 |\n|---|---|---|---|---|---|---|---|---|\n',
    );
    await writeFile(LOG_CSV, '\uFEFF时间,站点,id,标题,作者,状态,文件数,耗时秒,备注,链接\n');
  }
  const cells = [row.time, row.site, row.id, row.title, row.author, row.status, row.files, row.seconds, row.note];
  await appendFile(LOG_MD, `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |\n`);
  await appendFile(LOG_CSV, `${cells.map(csvCell).join(',')},${csvCell(row.url)}\n`);
}

function runGrab(url) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'grab.mjs'), url], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out, seconds: Math.round((Date.now() - started) / 1000) }));
  });
}

async function round() {
  const list = site === 'snapmaker' ? await fetchSnapmakerHot() : [];
  const seen = await loadSeen();
  const todo = list.filter((m) => {
    const key = `${m.site}:${m.id}`;
    if (retryEmpty && seen.emptyIds.has(key)) return true; // 之前没下到文件的，重试
    if (seen.byUrl.has(key)) return false;
    return !seen.byName.has(`${m.title.trim().toLowerCase()}|${m.author.trim().toLowerCase()}`);
  });
  console.log(`榜单 ${list.length} 个，已入库 ${seen.byUrl.size}，本次待抓 ${todo.length}（上限 ${limit}）`);
  if (dryRun) {
    for (const m of todo.slice(0, limit)) console.log(`  ${m.id} ${m.title} — ${m.author}`);
    return 0;
  }

  let done = 0;
  let lastStart = 0;
  for (const m of todo) {
    if (done >= limit) break;
    const wait = lastStart + rand(minGap, maxGap) - Date.now();
    if (wait > 0) {
      console.log(`  等 ${Math.round(wait / 1000)} 秒再下（保持 1 分钟最多 1 个）`);
      await sleep(wait);
    }
    lastStart = Date.now();
    const r = await runGrab(m.url);
    const files = (r.out.match(/文件\s+(\d+) 个/) || [])[1] || '0';
    const empty = files === '0';
    const note = r.code !== 0
      ? (r.out.match(/文件下载失败：(.+)/) || [])[1] || `退出码 ${r.code}`
      : empty
        ? '站点没有给文件直链'
        : '';
    await logRow({
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      site: m.site,
      id: m.id,
      title: m.title,
      author: m.author,
      status: r.code !== 0 ? 'fail' : empty ? 'empty' : 'ok',
      files,
      seconds: r.seconds,
      note,
      url: m.url,
    });
    const mark = r.code !== 0 ? '✗' : empty ? '·' : '✓';
    console.log(`  ${mark} ${m.title}（${files} 个文件，${r.seconds}s）${note ? ' — ' + note : ''}`);
    done++;
  }
  console.log(`本轮完成 ${done} 个；日志：library/_bulk-log.md`);
  return done;
}

// ── 统计：同一个模型以最后一次为准（重试成功后旧行不算数）──────
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function printSummary() {
  let text = '';
  try {
    text = await readFile(LOG_CSV, 'utf8');
  } catch {
    console.log('还没有日志');
    return;
  }
  const latest = new Map();
  for (const line of text.split('\n').slice(1).filter(Boolean)) {
    const c = parseCsvLine(line);
    const id = c[2]; const title = c[3]; const author = c[4]; const status = c[5]; const n = c[6];
    latest.set(id, { title, author, status, files: Number(n) || 0 });
  }
  // 以磁盘为准：库里真有文件就算 ok（重试成功但没写日志的也算上）
  let dirs = [];
  try { dirs = await readdir(LIB, { withFileTypes: true }); } catch {}
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const [, id] = d.name.split('-');
    try {
      const m = JSON.parse(await readFile(path.join(LIB, d.name, 'model.json'), 'utf8'));
      const n = (m.savedFiles || []).length;
      const cur = latest.get(id) || { title: m.title, author: m.author, status: 'empty', files: 0 };
      latest.set(id, { ...cur, title: cur.title || m.title, author: cur.author || m.author, status: n ? 'ok' : cur.status, files: n || cur.files });
    } catch {}
  }
  const stat = {};
  let files = 0;
  for (const v of latest.values()) {
    stat[v.status] = (stat[v.status] || 0) + 1;
    files += v.files;
  }
  console.log(`模型 ${latest.size} 个：${Object.entries(stat).map(([k, v]) => `${k} ${v}`).join(' · ')}；文件合计 ${files}`);
  const empty = [...latest.entries()].filter(([, v]) => v.status !== 'ok');
  if (empty.length) console.log(`还差的 ${empty.length} 个：` + empty.map(([id, v]) => `${id} ${v.title}`).join(' / '));
}

// ── 主循环 ─────────────────────────────────────────────────────
if (summary) {
  await printSummary();
  process.exit(0);
}
do {
  await round();
  if (loopEvery) {
    const ms = /^(\d+)([hm])$/.exec(loopEvery);
    const every = ms ? Number(ms[1]) * (ms[2] === 'h' ? 3600e3 : 60e3) : 3600e3;
    console.log(`休眠 ${Math.round(every / 60000)} 分钟后继续`);
    await sleep(every);
  }
} while (loopEvery);

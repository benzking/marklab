// 工作台数据：控制台首页要的那几个数（ADR-0005 第 1、2 节定了口径）。
// 时间一律按**北京时间自然日**，不用 UTC、不用 24 小时滑窗——同一批数据换个口径能差 5 倍。
import { readdir, readFile, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import * as tasks from './tasks.mjs';

const LIB = path.join(ROOT, 'library');
const DAY = 86_400_000;
const TTL = 60_000; // 遍历 4.7G 只要 74ms，但别让连点把盘读穿

/** 北京时间今天 00:00 对应的 UTC 毫秒。 */
export function dayStart(now = new Date(), daysAgo = 0) {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - daysAgo) - 8 * 3600_000;
}

/** 纯函数：一批入库时间 → 今日 / 7 日 / 30 日数量。 */
export function windowCount(times, now = new Date()) {
  const t0 = dayStart(now, 0);
  const t7 = dayStart(now, 6);
  const t30 = dayStart(now, 29);
  let today = 0;
  let d7 = 0;
  let d30 = 0;
  for (const raw of times) {
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    if (ms >= t0) today++;
    if (ms >= t7) d7++;
    if (ms >= t30) d30++;
  }
  return { today, d7, d30 };
}

/** 有 3mf 才算「抓成功」：站点给了一堆 stl 和图片但没工程文件，打印的人还是要再切一遍。
 *  纯函数，test.mjs 有断言。返回 `{days: ['10-27'…'11-02'], daily: {site: [7 个计数]}}`，最老 → 今天。 */
export function daily7(models, now = new Date()) {
  const starts = [];
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const ms = dayStart(now, i);
    starts.push(ms);
    const bj = new Date(ms + 8 * 3600_000);
    days.push(`${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`);
  }
  const daily = {};
  for (const m of models) {
    if (!(m.savedFiles || []).some((f) => /\.3mf$/i.test(f.name || ''))) continue;
    const ms = Date.parse(m.fetchedAt);
    if (!Number.isFinite(ms)) continue;
    let idx = -1;
    for (let i = starts.length - 1; i >= 0; i--) if (ms >= starts[i]) { idx = i; break; }
    if (idx < 0) continue; // 7 天以前的老货不上图
    if (!daily[m.platform]) daily[m.platform] = Array(7).fill(0);
    daily[m.platform][idx]++;
  }
  return { days, daily };
}

/** 纯函数：磁盘条目 → 按类别汇总。kind: 'files' | 'img' | 'other' */
export function sumDisk(entries) {
  const out = { total: 0, files: 0, img: 0, other: 0, fileCount: 0 };
  for (const { kind, bytes } of entries) {
    out.total += bytes;
    out[kind] = (out[kind] || 0) + bytes;
    out.fileCount++;
  }
  return out;
}

/** 纯函数：按 model.json 里记的字节数汇总磁盘占用（不再递归 stat 上万个小文件）。 */
export function diskFromModels(models) {
  const out = { total: 0, files: 0, img: 0, other: 0, fileCount: 0 };
  for (const m of models) {
    for (const f of m.savedFiles || []) {
      const b = Number(f.bytes) || 0;
      out.files += b;
      out.fileCount++;
    }
    out.img += Number(m.imgBytes) || 0;
    out.other += Number(m.jsonBytes) || 0;
  }
  out.total = out.files + out.img + out.other;
  return out;
}

/** 剩余空间（字节）。查不到返回 null——不能因为查不到就拒绝入队。 */
export async function freeSpace() {
  try {
    const s = await statfs(ROOT);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

// 解析结果按 mtime+size 缓存：库里 700 多个 model.json 一共 9 MB，每次全解要 300ms 以上，
// 但一分钟内几乎不会变——只重解变过的那个文件。
const modelCache = new Map();

async function readModels() {
  const dirs = [];
  for (const entry of await readdir(LIB, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(entry.name);
  }
  // 并发读：串行读 739 个文件要 500ms，并发读压到 150ms 上下
  const models = await Promise.all(
    dirs.map(async (dir) => {
      const file = path.join(LIB, dir, 'model.json');
      let st;
      try {
        st = await stat(file);
      } catch {
        return null;
      }
      const hit = modelCache.get(dir);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.m;
      try {
        const text = await readFile(file, 'utf8');
        const m = JSON.parse(text);
        m.dir = dir;
        m.jsonBytes = Buffer.byteLength(text);
        modelCache.set(dir, { mtimeMs: st.mtimeMs, size: st.size, m });
        return m;
      } catch {
        return null;
      }
    }),
  );
  // 删掉的模型别在缓存里留尸
  const alive = new Set(dirs);
  for (const k of modelCache.keys()) if (!alive.has(k)) modelCache.delete(k);
  return models.filter(Boolean);
}

let cache = null;
let cacheAt = 0;

/** 控制台首页全部数据。force=true 跳过缓存。
 * 故意不含登录态：探测要开浏览器标签，首屏会被拖到十几秒，登录态走单独接口 /api/console/login。 */
export async function workbench(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;

  const models = await readModels();

  // 每站：库内模型数 + 最近一次入库时间 + 待补抓数（控制台站点包卡片直接读它）
  const bySite = {};
  const lastFetch = {};
  const pending = {};
  const last24h = {};
  const since = Date.now() - DAY;
  for (const m of models) {
    bySite[m.platform] = (bySite[m.platform] || 0) + 1;
    if (m.fetchedAt && (!lastFetch[m.platform] || m.fetchedAt > lastFetch[m.platform])) lastFetch[m.platform] = m.fetchedAt;
    if (m.fetchedAt && Date.parse(m.fetchedAt) >= since) last24h[m.platform] = (last24h[m.platform] || 0) + 1;
    if (!(m.savedFiles || []).length && (m.files || []).length > 0 && m.noFiles !== 'skipped') {
      pending[m.platform] = (pending[m.platform] || 0) + 1;
    }
  }
  const chart = daily7(models);

  const disk = diskFromModels(models);
  disk.free = await freeSpace();

  // 数据健康：只数真缺的，不编指标
  const health = {
    noProfile: models.filter((m) => !(m.profiles || []).length).length,
    noCover: models.filter((m) => !(m.localImages || []).length).length,
    noDesc: models.filter((m) => !String(m.description || '').trim()).length,
    noFiles: models.filter((m) => !(m.savedFiles || []).length).length,
  };
  // 待补抓 = 站点有文件、本地一个都没落下来，而且不是「这次没下」
  const needRefetch = models.filter(
    (m) => !(m.savedFiles || []).length && (m.files || []).length > 0 && m.noFiles !== 'skipped',
  ).length;
  // 没文件的分因：要登录 / 站点本来不给 / 解析坏了。补抓前先看这个，别拿同一个原因重试 100 次
  // skipped 是「这次没下文件」，不是失败；只有真的想下却没下到才进「待补抓」
  const noFilesReason = { login: 0, captcha: 0, parse: 0, none: 0, unknown: 0, skipped: 0 };
  for (const m of models) {
    if ((m.savedFiles || []).length) continue;
    noFilesReason[m.noFiles || 'unknown'] += 1;
  }

  const counts = windowCount(models.map((m) => m.fetchedAt));

  cache = {
    at: new Date().toISOString(),
    models: { total: models.length, bySite, lastFetch, pending, last24h, daily: chart.daily, days: chart.days },
    counts,
    disk,
    health,
    needRefetch,
    noFilesReason,
    tasks: tasks.stats(),
  };
  cacheAt = Date.now();
  return cache;
}

// 自检：不联网、不读盘，只验口径和汇总。
if (path.basename(process.argv[1] || '') === 'stats.mjs') {
  const now = new Date('2026-10-29T20:00:00+08:00');
  const t = (s) => new Date(s).toISOString();
  const w = windowCount(
    [t('2026-10-29T01:00:00+08:00'), t('2026-10-28T23:00:00+08:00'), t('2026-10-25T12:00:00+08:00'), t('2026-09-01T12:00:00+08:00'), 'bad'],
    now,
  );
  console.assert(w.today === 1, `今日应只算北京时间 10-29 的，实际 ${w.today}`);
  console.assert(w.d7 === 3, `7 日应是 3 个（10-29/10-28/10-25），实际 ${w.d7}`);
  console.assert(w.d30 === 3, `30 日应还是 3 个，实际 ${w.d30}`);

  // 北京时间 00:30 属于「今天」，UTC 看还是昨天
  const early = windowCount([t('2026-10-29T00:30:00+08:00')], now);
  console.assert(early.today === 1, '北京凌晨应算今天');

  const d = sumDisk([
    { kind: 'files', bytes: 100 },
    { kind: 'img', bytes: 50 },
    { kind: 'other', bytes: 1 },
  ]);
  console.assert(d.total === 151 && d.files === 100 && d.img === 50 && d.fileCount === 3, '磁盘汇总');
  console.assert(dayStart(now, 0) === Date.parse('2026-10-29T00:00:00+08:00'), 'dayStart 应等于北京零点');
  console.log('stats demo ok');
  process.exit(0);
}

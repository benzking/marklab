// 工作台数据：控制台首页要的那几个数（ADR-0005 第 1、2 节定了口径）。
// 时间一律按**北京时间自然日**，不用 UTC、不用 24 小时滑窗——同一批数据换个口径能差 5 倍。
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import * as tasks from './tasks.mjs';

const LIB = path.join(ROOT, 'library');
const DAY = 86_400_000;
const TTL = 60_000; // 遍历 4.7G 只要 74ms，但别让连点把盘读穿

const SITE_LABEL = { creality: '创想云', makerworld: 'MakerWorld', snapmaker: 'Snapmaker', makeronline: 'MakerOnline' };

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

async function walkDisk(root, rel = '') {
  const out = [];
  let items;
  try {
    items = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of items) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      out.push(...(await walkDisk(root, r)));
      continue;
    }
    try {
      const st = await stat(path.join(root, r));
      const top = r.split(path.sep)[1] || '';
      const kind = top === 'files' ? 'files' : top === 'img' ? 'img' : 'other';
      out.push({ kind, bytes: st.size });
    } catch {}
  }
  return out;
}

async function readModels() {
  const models = [];
  for (const entry of await readdir(LIB, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const m = JSON.parse(await readFile(path.join(LIB, entry.name, 'model.json'), 'utf8'));
      m.dir = entry.name;
      models.push(m);
    } catch {}
  }
  return models;
}

let cache = null;
let cacheAt = 0;

/** 控制台首页全部数据。force=true 跳过缓存。
 * 故意不含登录态：探测要开浏览器标签，首屏会被拖到十几秒，登录态走单独接口 /api/console/login。 */
export async function workbench(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;

  const [models, diskEntries] = await Promise.all([readModels(), walkDisk(LIB)]);

  const bySite = {};
  for (const m of models) bySite[m.platform] = (bySite[m.platform] || 0) + 1;

  const disk = sumDisk(diskEntries);

  // 数据健康：只数真缺的，不编指标
  const health = {
    noProfile: models.filter((m) => !(m.profiles || []).length).length,
    noCover: models.filter((m) => !(m.localImages || []).length).length,
    noDesc: models.filter((m) => !String(m.description || '').trim()).length,
    noFiles: models.filter((m) => !(m.savedFiles || []).length).length,
  };
  // 待补抓 = 站点有文件但本地一个都没落下来
  const needRefetch = models.filter((m) => !(m.savedFiles || []).length && (m.files || []).length > 0).length;
  // 没文件的分因：要登录 / 站点本来不给 / 解析坏了。补抓前先看这个，别拿同一个原因重试 100 次
  const noFilesReason = { login: 0, captcha: 0, parse: 0, none: 0, unknown: 0 };
  for (const m of models) {
    if ((m.savedFiles || []).length) continue;
    noFilesReason[m.noFiles || 'unknown'] += 1;
  }

  const counts = windowCount(models.map((m) => m.fetchedAt));

  cache = {
    at: new Date().toISOString(),
    models: { total: models.length, bySite },
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

export { SITE_LABEL };

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

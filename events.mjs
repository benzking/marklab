// 运行日志：一份 append-only jsonl，满 5 MB 轮转、留一份备份（ADR-0007）。
// 给人扫一眼用，不是审计——审计是 data/tasks/*.jsonl，永久保留。
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './lib.mjs';

// 跟着 lib.mjs 的 ROOT 走（测试用 MARKLAB_ROOT 指到临时目录，别写进真库）
const FILE = path.join(ROOT, 'data', 'events.jsonl');
const CAP = 5 * 1024 * 1024;

/** 追加一条事件。写不进去也不许拖累抓取：日志坏了比没日志更糟。 */
export function emit(kind, data = {}, file = FILE) {
  const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n';
  try {
    if (existsSync(file) && statSync(file).size > CAP) renameSync(file, `${file}.1`);
    appendFileSync(file, line);
  } catch {}
}

/** 最近 limit 条，新的在前。坏行跳过（进程被杀时可能留半行）。 */
export function recent(limit = 200, file = FILE) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    try {
      out.push(JSON.parse(lines[i]));
    } catch {}
  }
  return out;
}

// 自检：写三条、读回最新的两条
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'events.mjs') {
  const f = path.join(os.tmpdir(), `events-selftest-${process.pid}.jsonl`);
  emit('subs-run', { sub: 's1', searched: 3 }, f);
  emit('task-file', { id: 't1', name: 'a.3mf', done: 1, total: 2 }, f);
  emit('task-done', { id: 't1', phase: 'done' }, f);
  const got = recent(2, f);
  console.assert(got.length === 2 && got[0].kind === 'task-done' && got[1].name === 'a.3mf', '事件读回顺序不对');
  console.log(`events 自检通过（${got.length} 条）`);
  rmSync(f, { force: true });
}

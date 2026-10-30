// 一次性维护脚本，做三件「历史数据要补一刀」的事：
//   1. description 用当前白名单重洗（旧的黑名单能被 `<img/src=x/onerror=…>` 绕过）
//   2. 补 imgBytes（磁盘用量按记录累加，不再每次递归 stat 上万个小文件）
//   3. 清掉库目录里的派生数据（`.inspect/` 缓存、`files/preview/` 盘图），它们该在 data/preview/
//   4. 可选 `--orphans`：删掉 files/ 下没被 savedFiles 引用的孤儿文件（中断/重复抓留下的）
// 用法：node fix.mjs [--dry] [--orphans]
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitize, ROOT } from './lib.mjs';

const LIB = path.join(ROOT, 'library');
const dry = process.argv.includes('--dry');
const orphans = process.argv.includes('--orphans');

let total = 0;
let changed = 0;
let sized = 0;
let cleaned = 0;
let orphanCount = 0;
let orphanBytes = 0;

// 目录里所有文件的字节数（只用于一次性回填，不在请求路径上）
async function dirBytes(dir) {
  let sum = 0;
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of items) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sum += await dirBytes(p);
    else {
      try {
        sum += (await stat(p)).size;
      } catch {}
    }
  }
  return sum;
}
for (const name of await readdir(LIB, { withFileTypes: true }).catch(() => [])) {
  if (!name.isDirectory()) continue;
  const file = path.join(LIB, name.name, 'model.json');
  let model;
  try {
    model = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // 没有 model.json 的目录不是模型：中断留下的残骸，白占磁盘
    const dir = path.join(LIB, name.name);
    const bytes = await dirBytes(dir);
    orphanCount++;
    orphanBytes += bytes;
    console.log(`  残骸 ${name.name}（没有 model.json）${(bytes / 1e6).toFixed(0)} MB`);
    if (orphans && !dry) await rm(dir, { recursive: true, force: true });
    continue;
  }
  total++;
  const dir = path.join(LIB, name.name);
  let dirty = false;

  const before = String(model.description || '');
  const after = sanitize(before);
  if (after !== before) {
    changed++;
    console.log(`${changed}. ${name.name}  描述 ${before.length} → ${after.length} 字节`);
    model.description = after;
    dirty = true;
  }

  if (model.imgBytes == null) {
    model.imgBytes = await dirBytes(path.join(dir, 'img'));
    sized++;
    dirty = true;
  }

  for (const junk of [path.join(dir, '.inspect'), path.join(dir, 'files', 'preview')]) {
    try {
      await stat(junk);
    } catch {
      continue; // 没有就跳过
    }
    cleaned++;
    console.log(`${cleaned}. ${name.name}  删掉派生目录 ${path.relative(LIB, junk)}`);
    if (!dry) await rm(junk, { recursive: true, force: true });
  }

  if (orphans) {
    const keep = new Set((model.savedFiles || []).map((f) => path.basename(f.path)));
    let names = [];
    try {
      names = await readdir(path.join(dir, 'files'));
    } catch {}
    for (const n of names) {
      if (keep.has(n)) continue;
      const p = path.join(dir, 'files', n);
      let size = 0;
      try {
        size = (await stat(p)).size;
      } catch {
        continue;
      }
      orphanCount++;
      orphanBytes += size;
      console.log(`  孤儿 ${name.name}/files/${n}  ${(size / 1048576).toFixed(1)} MB`);
      if (!dry) await rm(p, { force: true });
    }
  }

  if (!dirty || dry) continue;
  // 先写临时文件再改名：写一半断电不会留下坏 model.json
  await writeFile(`${file}.tmp`, JSON.stringify(model, null, 2));
  await rename(`${file}.tmp`, file);
}

console.log(
  `\n扫过 ${total} 个模型：描述重洗 ${changed} 个，补 imgBytes ${sized} 个，清派生目录 ${cleaned} 个` +
    (dry ? '（--dry，没有写盘）' : '，已写回'),
);
if (orphanCount) console.log(`孤儿文件 ${orphanCount} 个，共 ${(orphanBytes / 1e9).toFixed(2)} GB${dry ? '（--dry，没删）' : '，已删'}`);

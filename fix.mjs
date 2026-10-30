// 一次性维护脚本：把库里所有 model.json 的 description 用当前白名单重洗一遍。
// 白名单换过一次（旧的 4 条正则黑名单能被 `<img/src=x/onerror=…>` 绕过），老模型存的是旧结果。
// 用法：node fix.mjs [--dry]
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitize, ROOT } from './lib.mjs';

const LIB = path.join(ROOT, 'library');
const dry = process.argv.includes('--dry');

let total = 0;
let changed = 0;
for (const name of await readdir(LIB, { withFileTypes: true }).catch(() => [])) {
  if (!name.isDirectory()) continue;
  const file = path.join(LIB, name.name, 'model.json');
  let model;
  try {
    model = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    continue; // 没有 model.json 的目录不是模型，跳过
  }
  total++;
  const before = String(model.description || '');
  const after = sanitize(before);
  if (after === before) continue;
  changed++;
  console.log(`${changed}. ${name.name}  ${before.length} → ${after.length} 字节`);
  if (dry) continue;
  model.description = after;
  // 先写临时文件再改名：写一半断电不会留下坏 model.json
  await writeFile(`${file}.tmp`, JSON.stringify(model, null, 2));
  await rename(`${file}.tmp`, file);
}

console.log(`\n扫过 ${total} 个模型，${changed} 个的描述需要重洗${dry ? '（--dry，没有写盘）' : '，已写回'}`);

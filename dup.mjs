// 重复模型检测（ADR-0004）。两条规则：
//   同站——标题+作者归一后相同就算重复（同网址是同目录重抓，不算重复，走覆盖）。
//   跨站——标题+作者相同只是「疑似」；作者上传的文件 sha256 有交集才算「确认」。
// 只有字节完全一样才会撞上同一个 hash，所以 3mf 只可能和 3mf 撞、stl 只可能和 stl 撞。
// 命中不入库，只记 data/duplicates.json；library/ 一个字节都不改（AGENTS.md）。
import { readdir, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writeJson, ROOT, LIB } from './lib.mjs';

const DATA = path.join(ROOT, 'data');
const DUP_FILE = path.join(DATA, 'duplicates.json');

/** 纯函数：标题/作者归一——全角转半角、小写、抹掉空格标点符号。 */
export function normText(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 纯函数：元数据比对键。两个站同一作者的同一模型，标题常只差标点。 */
export function metaKey(title, author) {
  const t = normText(title);
  if (!t) return null;
  return `${t}|${normText(author)}`;
}

/** 纯函数：作者件才参与比 hash；别人给这个模型加的打印配置不算。 */
export function authorHashes(savedFiles) {
  return (savedFiles || [])
    .filter((f) => f && f.sha256 && f.origin !== 'other')
    .map((f) => f.sha256);
}

let idx = null;

/** 扫 library/ 建索引。600 个模型 ~150ms，不落盘。libDir 只给测试用。 */
export async function index(force = false, libDir = LIB) {
  if (idx && !force && libDir === LIB) return idx;
  const byMeta = new Map(); // metaKey -> [{ key, at }]，按入库时间升序
  const hashes = new Map(); // "site:id" -> Set<sha256>
  const keys = new Set(); // 已入库的全部 "site:id"，订阅用来排除已入库
  for (const entry of await readdir(libDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let m;
    try {
      m = JSON.parse(await readFile(path.join(libDir, entry.name, 'model.json'), 'utf8'));
    } catch {
      continue;
    }
    const key = `${m.platform}:${m.id}`;
    keys.add(key);
    const at = Date.parse(m.fetchedAt) || 0;
    const mk = metaKey(m.title, m.author);
    if (mk) {
      const arr = byMeta.get(mk) || [];
      arr.push({ key, at });
      byMeta.set(mk, arr);
    }
    const hs = authorHashes(m.savedFiles);
    if (hs.length) hashes.set(key, new Set(hs));
  }
  for (const arr of byMeta.values()) arr.sort((a, b) => a.at - b.at);
  idx = { byMeta, hashes, keys };
  return idx;
}

/**
 * 下载前判重。命中返回 { of, by, same }，否则 null。
 * same=true 是同站（确定重复）；same=false 是跨站（疑似，还要比 hash）。
 * 同一个网址返回 null：那是同目录重抓/补抓，不是重复。
 */
export async function check(model, libDir = LIB) {
  const { keys, byMeta } = await index(false, libDir);
  const self = `${model.platform}:${model.id}`;
  if (keys.has(self)) return null;
  for (const hit of byMeta.get(metaKey(model.title, model.author)) || []) {
    if (hit.key === self) continue;
    return { of: hit.key, by: 'meta', same: hit.key.startsWith(`${model.platform}:`) };
  }
  return null;
}

/** 下载后确认：作者件里有任何一个 hash 撞上，就算同一个模型。 */
export async function confirm(of, saved, libDir = LIB) {
  const { hashes } = await index(false, libDir);
  const have = hashes.get(of);
  if (!have || !have.size) return false;
  return (saved || []).some((f) => f.sha256 && f.origin !== 'other' && have.has(f.sha256));
}

/** 记一条重复标记。重复检测本身不写 library/，只写这个文件。 */
export async function record(platform, id, hit, extra = {}) {
  const key = `${platform}:${id}`;
  let all = {};
  try {
    all = JSON.parse(await readFile(DUP_FILE, 'utf8'));
  } catch {}
  all[key] = {
    of: hit.of,
    by: hit.by,
    at: new Date().toISOString(),
    title: extra.title || '',
    author: extra.author || '',
    url: extra.url || '',
    platform,
    hashes: extra.hashes || [],
  };
  await mkdir(DATA, { recursive: true });
  await writeJson(DUP_FILE, all);
  idx = null; // 标记变了，索引重建一次
  return all[key];
}

/** 全部标记，给页面标「同模型」。 */
export async function marks() {
  try {
    return JSON.parse(await readFile(DUP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// 自检：纯函数，不读盘不联网。
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'dup.mjs') {
  console.assert(normText('  Benchy 小船！') === 'benchy小船', normText('  Benchy 小船！'));
  console.assert(normText('ＢＥＮＣＨＹ') === 'benchy', '全角应转半角小写');
  console.assert(metaKey('Benchy 小船', 'Tom') === metaKey('benchy-小船', 'TOM'), '标点大小写不该影响');
  console.assert(metaKey('', 'Tom') === null, '空标题不给键');
  console.assert(metaKey('benchy', 'Tom') !== metaKey('benchy', 'Jerry'), '作者不同不算重复');
  console.assert(
    authorHashes([{ sha256: 'a' }, { sha256: 'b', origin: 'other' }, { sha256: '' }]).join() === 'a',
    '只有作者件参与比 hash',
  );
  console.log('dup demo ok');
  process.exit(0);
}

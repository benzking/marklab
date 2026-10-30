// ADR-0003 的「匿名优先」：按**接口**记「这个请求要不要登录」。
// 不是安全机制，是少带登录态的机制——能匿名就别带 cookie，带得越少越不容易被风控盯上。
//
//   1 先匿名 → 2 失败退避 2 秒再匿名 → 3 还失败带登录 → 4 还失败刷新登录再试 → 5 本轮结束
//
// 结果记在 data/auth-needs.json（600）：needsLogin 的接口下次直接带登录，
// 连续 3 轮带登录都失败就标 broken（多半是站点改版了），不再白试。

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DATA, writeJson } from './lib.mjs';

export const FILE = path.join(DATA, 'auth-needs.json');
export const MAX_ROUNDS = 3;
export const BACKOFF_MS = 2000;

/** 接口键：站点 + 去掉具体 id 的路径。数字和 24 位 hex 都折成 *，同一类接口算一条。 */
export function epKey(site, url) {
  let p;
  try {
    p = new URL(url).pathname;
  } catch {
    p = String(url || '');
  }
  p = p.replace(/[0-9a-f]{24}/gi, '*').replace(/\d+/g, '*');
  return `${site}|${p}`;
}

export async function load(file = FILE) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {}; // 还没有这个文件是常态，不是错误
  }
}

export async function save(table, file = FILE) {
  await writeJson(file, table, { mode: 0o600 });
}

/** 一条记录：{ needsLogin, attempts, rounds, lastAt, broken? } */
function entryOf(table, key) {
  if (!table[key]) table[key] = { needsLogin: false, attempts: 0, rounds: 0, lastAt: null };
  return table[key];
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 按升级链取一次。anon / login 都是「返回 Response」的异步函数（由调用方决定怎么发）。
 * 成功返回 { res, usedLogin }；失败抛出最后一次的错误。
 * table 由调用方持有并负责 save()——同一个抓取任务里多个文件共用一张表，不反复读盘。
 */
export async function fetchWithLadder({
  key,
  table,
  anon,
  login,
  refreshLogin,
  sleep = defaultSleep,
  file = FILE,
}) {
  const e = entryOf(table, key);
  if (e.broken) {
    throw Object.assign(new Error(`这个接口连续 ${MAX_ROUNDS} 轮带登录都失败，先别再试（多半是站点改了）：${key}`), {
      code: 'parse',
    });
  }

  let lastErr;
  const tryOnce = async (fn) => {
    e.attempts++;
    try {
      const res = await fn();
      if (res && res.ok) return res;
      lastErr = new Error(`HTTP ${res?.status ?? '?'} ${key}`);
      // 403/401 是「要登录」，其它错误先当普通失败
      if (res && (res.status === 401 || res.status === 403)) lastErr.code = 'login';
    } catch (err) {
      lastErr = err;
    }
    return null;
  };

  const done = async (usedLogin) => {
    e.lastAt = new Date().toISOString();
    e.needsLogin = usedLogin;
    e.rounds = 0; // 成功了就重新数
    await save(table, file);
  };

  if (!e.needsLogin) {
    let res = await tryOnce(anon);
    if (res) {
      await done(false);
      return { res, usedLogin: false };
    }
    await sleep(BACKOFF_MS);
    res = await tryOnce(anon);
    if (res) {
      await done(false);
      return { res, usedLogin: false };
    }
  }

  let res = await tryOnce(login);
  if (res) {
    await done(true);
    return { res, usedLogin: true };
  }
  if (refreshLogin) {
    await refreshLogin();
    res = await tryOnce(login);
    if (res) {
      await done(true);
      return { res, usedLogin: true };
    }
  }

  e.rounds = (e.rounds || 0) + 1;
  e.lastAt = new Date().toISOString();
  if (e.rounds >= MAX_ROUNDS) e.broken = true;
  await save(table, file);
  throw lastErr || new Error(`拿不到：${key}`);
}

// 自检：假 fetch 走一遍升级链，不发真请求
if (process.argv[1] && process.argv[1].endsWith('authneed.mjs')) {
  const assert = (c, m) => {
    if (!c) throw new Error('authneed demo 失败：' + m);
  };
  const ok = (status = 200) => ({ ok: status < 400, status });
  const tmp = path.join(DATA, 'auth-needs.demo.json');
  const calls = [];
  const noSleep = async () => {};

  // 匿名就能成：永远不带登录
  let table = {};
  let r = await fetchWithLadder({
    key: 'a|/x',
    table,
    anon: async () => (calls.push('anon'), ok()),
    login: async () => (calls.push('login'), ok()),
    sleep: noSleep,
    file: tmp,
  });
  assert(r.usedLogin === false && calls.join() === 'anon', '匿名成功不该碰登录');
  assert(table['a|/x'].needsLogin === false, '匿名成功要记 needsLogin=false');

  // 匿名两次都挂、登录成：记 needsLogin，下次直接带登录
  calls.length = 0;
  table = {};
  r = await fetchWithLadder({
    key: 'b|/y',
    table,
    anon: async () => (calls.push('anon'), ok(403)),
    login: async () => (calls.push('login'), ok()),
    sleep: noSleep,
    file: tmp,
  });
  assert(r.usedLogin === true, '匿名挂两次后要带登录');
  assert(calls.join() === 'anon,anon,login', `升级链顺序不对：${calls.join()}`);
  assert(table['b|/y'].needsLogin === true, '要记住这个接口需要登录');

  calls.length = 0;
  await fetchWithLadder({
    key: 'b|/y',
    table,
    anon: async () => (calls.push('anon'), ok()),
    login: async () => (calls.push('login'), ok()),
    sleep: noSleep,
    file: tmp,
  });
  assert(calls.join() === 'login', `needsLogin 的接口应直接带登录，实际：${calls.join()}`);

  // 连续 3 轮失败 → broken，第 4 轮不再试
  table = {};
  calls.length = 0;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    await fetchWithLadder({
      key: 'c|/z',
      table,
      anon: async () => (calls.push('anon'), ok(403)),
      login: async () => (calls.push('login'), ok(403)),
      sleep: noSleep,
      file: tmp,
    }).catch(() => {});
  }
  const before = calls.length;
  await fetchWithLadder({
    key: 'c|/z',
    table,
    anon: async () => (calls.push('anon'), ok()),
    login: async () => (calls.push('login'), ok()),
    sleep: noSleep,
    file: tmp,
  }).catch(() => {});
  assert(calls.length === before, 'broken 之后不该再发请求');
  assert(table['c|/z'].broken === true, '连续 3 轮失败要标 broken');

  assert(epKey('creality', 'https://x.cn/api/a/62985bf125fe4b6423ea5fbc/b/12') === 'creality|/api/a/*/b/*', '接口键要把 id 折成 *');
  await rm(tmp, { force: true });
  console.log('authneed demo ok');
}

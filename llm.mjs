// 大模型接入：OpenAI 兼容协议 + 智能打标签（ADR-0005 第 4 节）。
// 凭据只存 ~/.marklab/llm.json（600），不打印、不进仓库（凭据口径见 ADR-0001）。
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { stripTags, writeJson, ROOT } from './lib.mjs';

const LIB = path.join(ROOT, 'library');
const TAGS = path.join(ROOT, 'data', 'tags.json');
const PENDING = path.join(ROOT, 'data', 'tag-pending.json');
const TIMEOUT = 60_000; // 大模型可以慢，但卡住不能挡住入库

// 自检要打假服务，不能碰用户真实的 key
const configPath = () => process.env.MARKLAB_LLM_CONFIG || path.join(os.homedir(), '.marklab', 'llm.json');

// ── 状态文件 ───────────────────────────────────────────────────
// 状态文件被手改成非对象就当没有，别让一次手滑炸掉打标签
async function readJson(file, fallback) {
  try {
    const v = JSON.parse(await readFile(file, 'utf8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

// ── 配置 ───────────────────────────────────────────────────────
export async function loadConfig() {
  const cfg = await readJson(configPath(), null);
  if (!cfg?.baseUrl || !cfg?.apiKey || !cfg?.model) return null;
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model };
}

export async function saveConfig(cfg) {
  const out = {
    baseUrl: String(cfg?.baseUrl || '').trim(),
    apiKey: String(cfg?.apiKey || '').trim(),
    model: String(cfg?.model || '').trim(),
  };
  if (!out.baseUrl || !out.apiKey || !out.model) throw new Error('配置不完整：需要 baseUrl / apiKey / model');
  const file = configPath();
  // 目录 700 + 文件 600：key 只给当前用户读
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJson(file, out, { mode: 0o600 });
  await chmod(file, 0o600); // writeJson 的 mode 只在新建时生效，覆盖已有文件要再 chmod
  return true;
}

// 日志里必须提 key 时只露头尾
const mask = (key) => (key ? `${String(key).slice(0, 3)}***${String(key).slice(-3)}` : '');

// 用户填的 baseUrl 可能带 /v1 也可能不带，两种都要能用；带别的完整路径就照用
function apiBase(baseUrl) {
  const u = new URL(String(baseUrl || '').trim());
  const p = u.pathname.replace(/\/+$/, '');
  u.pathname = /\/(v\d+[a-z]*)$/i.test(p) ? p : `${p}/v1`;
  return u.origin + u.pathname;
}

async function request(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// ── 模型列表 ───────────────────────────────────────────────────
export async function listModels() {
  const cfg = await loadConfig();
  if (!cfg) throw new Error('没有配置大模型：~/.marklab/llm.json');
  try {
    const body = await request(`${apiBase(cfg.baseUrl)}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    });
    return (body?.data || []).filter((m) => m?.id).map((m) => ({ id: m.id, owned_by: m.owned_by ?? null }));
  } catch (e) {
    throw new Error(`拉模型列表失败（key ${mask(cfg.apiKey)}）：${e.message}`); // 打码后说清是哪把 key
  }
}

// ── 打标签 ─────────────────────────────────────────────────────
// shortcut: 全量标签池塞提示词（约 3k token/次），池子破 3000 个再改两级筛选
function buildPrompt(info = {}, existingTags = []) {
  const system = [
    '你是 3D 模型库的打标签助手。',
    '只能从列表里选：列表里没有的词一律放 newWords，不要放进 tags。',
    'tags 最多 5 个，newWords 最多 3 个；实在没有合适的就返回空数组。',
    '只输出 JSON：{"tags":[],"newWords":[]}',
  ].join('\n');
  const user = [
    `已有标签（只能从列表里选）：${existingTags.join('、') || '（空）'}`,
    `标题：${info.title || ''}`,
    `站点：${info.site || ''}　分类：${info.category || ''}`,
    `站点标签：${(info.siteTags || []).join('、') || '（无）'}`,
    `描述：${stripTags(info.description).slice(0, 800)}`,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 模型爱包 ```json 围栏或前后带话，两种都兜住
function parseJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(s);
  } catch {}
  const m = /\{[\s\S]*\}/.exec(s);
  if (!m) throw new Error('返回里没有 JSON');
  return JSON.parse(m[0]);
}

const words = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];

async function queueWords(list, model) {
  const pending = await readJson(PENDING, {});
  const at = new Date().toISOString();
  for (const w of list) pending[w] ??= { at, model }; // 保留第一次出现的来源
  await writeJson(PENDING, pending);
}

async function chat(cfg, messages) {
  const body = await request(`${apiBase(cfg.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });
  return body?.choices?.[0]?.message?.content ?? '';
}

export async function tagModel(info = {}, existingTags = []) {
  const empty = { tags: [], newWords: [] };
  const cfg = await loadConfig();
  if (!cfg) {
    console.error('打标签跳过：没有配置大模型');
    return empty;
  }
  const pool = [...new Set(words(existingTags))];
  const allow = new Set(pool);
  try {
    const raw = parseJson(await chat(cfg, buildPrompt(info, pool)));
    const rawTags = words(raw?.tags);
    const rawNew = words(raw?.newWords);
    // 池子里没有的词一律不收进 tags，转到 newWords 等用户确认
    const tags = [...new Set(rawTags.filter((t) => allow.has(t)))].slice(0, 5);
    const newWords = [...new Set([...rawNew, ...rawTags.filter((t) => !allow.has(t))])]
      .filter((t) => !allow.has(t))
      .slice(0, 3);
    if (!tags.length && !newWords.length && (rawTags.length || rawNew.length)) {
      console.error('打标签：模型返回的词都不在标签池里，全部丢弃');
    }
    // 调用方给了模型标识才记队列；没给就只返回，由调用方自己决定
    if (newWords.length && (info?.dir || info?.id)) await queueWords(newWords, info.dir || info.id);
    return { tags, newWords };
  } catch (e) {
    console.error(`打标签失败（${info?.title || '?'}）：${e.message}`); // 不抛：打标签不能阻断入库
    return empty;
  }
}

// ── 标签池 / 待确认新词 ────────────────────────────────────────
function collectTags(models) {
  const out = new Set();
  for (const m of models || []) {
    for (const t of [...(m?.tags || []), ...(m?.autoTags || [])]) {
      const s = String(t ?? '').trim();
      if (s) out.add(s);
    }
  }
  return [...out];
}

async function readLibrary() {
  const models = [];
  for (const e of await readdir(LIB, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const m = await readJson(path.join(LIB, e.name, 'model.json'), null);
    if (m) models.push(m);
  }
  return models;
}

export async function tagPool() {
  const saved = await readJson(TAGS, null);
  if (Array.isArray(saved)) return saved;
  // 首次：从已入库模型的站点标签 + 自动标签汇总一次，之后只读（已有标签直接复用）
  const pool = collectTags(await readLibrary());
  await writeJson(TAGS, pool);
  return pool;
}

export async function pendingWords() {
  const raw = await readJson(PENDING, {});
  return Object.entries(raw).map(([word, v]) => ({ word, at: v?.at ?? null, model: v?.model ?? null }));
}

export async function resolveWord(word, accept) {
  const w = String(word || '').trim();
  if (!w) return false;
  const pending = await readJson(PENDING, {});
  delete pending[w];
  await writeJson(PENDING, pending);
  if (!accept) return false;
  const pool = await tagPool();
  if (!pool.includes(w)) await writeJson(TAGS, [...pool, w]);
  return true;
}

// ── 自检：node llm.mjs（只连本机假服务，不联网） ────────────────
async function demo() {
  const tmp = path.join(os.tmpdir(), `marklab-llm-${process.pid}`);
  const cfgFile = path.join(tmp, 'llm.json');
  const savedEnv = process.env.MARKLAB_LLM_CONFIG;
  await mkdir(tmp, { recursive: true });
  try {
    // ① 没配置 → 空结果且不抛（打标签失败不能阻断入库）
    process.env.MARKLAB_LLM_CONFIG = path.join(tmp, 'none.json');
    assert.deepEqual(await tagModel({ title: '没配置' }, ['头盔']), { tags: [], newWords: [] });

    // ② 标签池初始化（纯函数）：站点 tags + autoTags 汇总去重
    assert.deepEqual(
      collectTags([{ tags: ['头盔', '工具', '头盔'] }, { autoTags: ['精选'], tags: ['工具'] }, { tags: [] }]),
      ['头盔', '工具', '精选'],
    );

    // ③ 提示词确实限定只能用已有标签
    const msgs = buildPrompt(
      { title: '可动机甲', description: '<p>关节可动</p>', category: '机甲', siteTags: ['机甲'], site: 'snapmaker' },
      ['机甲', '头盔'],
    );
    assert.ok(msgs[0].content.includes('只能从列表里选'), '提示词必须限定只能用已有标签');
    assert.ok(msgs[1].content.includes('机甲、头盔'), '标签池要进提示词');

    // ④ baseUrl 拼接 + key 打码
    assert.equal(apiBase('http://h:1'), 'http://h:1/v1');
    assert.equal(apiBase('http://h:1/'), 'http://h:1/v1');
    assert.equal(apiBase('http://h:1/v1/'), 'http://h:1/v1');
    assert.equal(apiBase('https://h/openai'), 'https://h/openai/v1');
    assert.equal(apiBase('https://h/api/v1'), 'https://h/api/v1');
    assert.equal(mask('sk-123abc'), 'sk-***abc');

    // ⑤ 假 OpenAI 服务：listModels + tagModel 完整往返
    let reply = '{"tags":["头盔","可动关节"],"newWords":["可动关节","磁吸"]}';
    let fail = false;
    const seen = [];
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const send = (o) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/v1/models') {
        if (fail) {
          res.writeHead(500);
          return res.end('{"error":"boom"}');
        }
        return send({ data: [{ id: 'fake-1', owned_by: 'test' }, { id: 'fake-2' }] });
      }
      if (req.url === '/v1/chat/completions') return send({ choices: [{ message: { content: reply } }] });
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      // baseUrl 不带 /v1，模块负责补全
      process.env.MARKLAB_LLM_CONFIG = cfgFile;
      await saveConfig({ baseUrl, apiKey: 'sk-test-abc', model: 'fake-model' });
      assert.equal((await stat(cfgFile)).mode & 0o777, 0o600, '配置文件必须是 600');
      assert.deepEqual(await loadConfig(), { baseUrl, apiKey: 'sk-test-abc', model: 'fake-model' });

      assert.deepEqual(await listModels(), [
        { id: 'fake-1', owned_by: 'test' },
        { id: 'fake-2', owned_by: null },
      ]);
      assert.equal(seen.at(-1).url, '/v1/models');
      assert.equal(seen.at(-1).auth, 'Bearer sk-test-abc');

      const got = await tagModel(
        { title: '可动猫', description: '<p>关节可动</p>', category: '玩具', siteTags: ['猫'], site: 'snapmaker' },
        ['头盔', '工具'],
      );
      assert.deepEqual(got, { tags: ['头盔'], newWords: ['可动关节', '磁吸'] }, '不在池里的词只进 newWords');
      const sent = seen.at(-1);
      assert.equal(sent.url, '/v1/chat/completions');
      assert.equal(sent.body.model, 'fake-model');
      assert.equal(sent.body.temperature, 0.2);
      assert.deepEqual(sent.body.response_format, { type: 'json_object' });
      assert.ok(sent.body.messages[0].content.includes('只能从列表里选'));

      // 非法 JSON → 降级为空，不抛
      reply = '模型今天不想说话';
      assert.deepEqual(await tagModel({ title: '坏返回' }, ['头盔']), { tags: [], newWords: [] });

      // HTTP 错误 → listModels 抛错，且错误里 key 是打码的
      fail = true;
      await assert.rejects(() => listModels(), /HTTP 500/);
      fail = false;
    } finally {
      server.close();
    }

    // 真实 library/ 能汇总多少标签（只读，不落盘）
    console.log(`library 汇总标签：${collectTags(await readLibrary()).length} 个`);
    console.log('llm demo ok');
  } finally {
    if (savedEnv == null) delete process.env.MARKLAB_LLM_CONFIG;
    else process.env.MARKLAB_LLM_CONFIG = savedEnv;
    await rm(tmp, { recursive: true, force: true });
  }
}

if ((process.argv[1] || '').split(/[\\/]/).pop() === 'llm.mjs') {
  await demo();
  process.exit(0);
}

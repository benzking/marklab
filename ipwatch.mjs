// IP 监控订阅：data/ipwatch.json（人工维护的「高风控 IP + 关键词」表）→ 同步成订阅 + 生成可读清单。
// 订阅名固定为 `IP·<组名>`，重跑幂等：改词表再跑一次就更新，lastRunAt/命中记录不动。
// 用法：node ipwatch.mjs [--dry]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const FILE = path.join(ROOT, 'data/ipwatch.json');
const MD = path.join(ROOT, 'data/ipwatch.md');
const SITES = ['creality', 'makerworld', 'snapmaker', 'makeronline'];

const subName = (g) => `IP·${g.name}`;

// 词加多了（177 词 × 4 站 ≈ 3 小时一轮），只能按风险分层间隔，别让全量挤成一条永远跑不完的队。
const INTERVAL = { 5: 4, 4: 6, 3: 12, 2: 24 };

/** 组的风险等级决定跑多勤。 */
const subInput = (g) => ({
  name: subName(g),
  keywords: g.keywords,
  sites: SITES,
  minLikes: 0,
  minDownloads: 0,
  pickedOnly: false,
  excludeInLibrary: true,
  sort: 'downloads', // MakerOnline 没有排序参数、Snapmaker 默认是最新，要稳定就固定用下载量
  pageLimit: 1, // 每个词只取首页 20 条：先保下载量高的那批
  roundLimit: Number(g.roundLimit) || 20,
  intervalHours: INTERVAL[Number(g.risk)] || 12,
  enabled: true,
});

function toMarkdown(doc) {
  const lines = [
    '# 高风控 IP 监控清单',
    '',
    `更新：${doc.updated}　｜　${doc.groups.length} 组 / ${doc.groups.reduce((n, g) => n + g.keywords.length, 0)} 个关键词　｜　由 \`node ipwatch.mjs\` 生成，改词表请改 data/ipwatch.json`,
    '',
    '风险等级：**5** 已发生批量下架　**4** 权利人主动 DMCA　**3** 打假活跃但无公开下架记录　**2** 高概率',
    '',
    '| 组 | 风险 | 权利人 | IP | 关键词 | 下架/维权依据 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const g of doc.groups) {
    const cell = (v) => String(v || '').replace(/\|/g, '\\|');
    const src = g.source ? `[${cell(g.event)}](${g.source})` : cell(g.event);
    lines.push(
      `| ${cell(subName(g))} | ${g.risk} | ${cell(g.holder)} | ${cell((g.ips || []).join('、'))} | ${cell(g.keywords.join(' / '))} | ${src} |`,
    );
  }
  lines.push(
    '',
    '## 关键词怎么用',
    '',
    '- 中英双词都要订：站内标题多是中文，只搜 `labubu` 会漏掉「拉布布 挂件」。',
    '- 下架后常改写标题规避（`la bu bu`、`L@BUBU`、只留「大眼睛 精灵 挂件」），纯关键词订阅对改名无效——命中靠的是新上架的第一时间。',
    '- 权利人名字也订：`泡泡玛特`/`Pop Mart`/`寒木春华` 这类投诉方词命中的模型往往最先被清。',
    '- 进度：`node ipwatch.mjs --status` —— 每组跑到哪个词、下轮什么时候、命中/截断多少、下载队列多长。',
    '- 四站差异极大：2026-10-30 实测 `labubu` 创想云 total=1000、MakerWorld/Snapmaker/MakerOnline 都是 0（已清空）；`库洛米` 反而四站都有。一个站搜不到不等于全网没有。',
    '',
  );
  return lines.join('\n');
}

const dry = process.argv.includes('--dry');
const doc = JSON.parse(await readFile(FILE, 'utf8'));

/** 进度看板：每组上次跑到哪、下轮什么时候、命中多少，外加下载队列。`node ipwatch.mjs --status` */
if (process.argv.includes('--status')) {
  // 队列只在 server 进程里是真队列，这里直接读当月 jsonl：同一个 id 后写的覆盖先写的（tasks.refresh 是首写优先，只适合并外部任务）
  const raw = await readFile(path.join(ROOT, 'data/tasks', `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8').catch(() => '');
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line);
      if (t.id) byId.set(t.id, t);
    } catch {}
  }
  const tl = [...byId.values()];
  const cnt = (p, since = 0) => tl.filter((x) => x.phase === p && Date.parse(x.endedAt || 0) > since).length;
  const risk = new Map(doc.groups.map((g) => [subName(g), g.risk]));
  const all = (await subs.list()).filter((s) => risk.has(s.name));
  const now = Date.now();
  const dayAgo = now - 86400_000;
  const at = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : '—');
  const due = (s) => {
    if (s.progress) return '跑着…';
    if (!s.lastRunAt) return '待跑';
    const left = (Date.parse(s.lastRunAt) + s.intervalHours * 3600_000 - now) / 3600_000;
    return left <= 0 ? '待跑' : `${left.toFixed(1)}h 后`;
  };
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`${pad('组', 24)}${pad('险', 4)}${pad('词', 5)}${pad('上次跑', 13)}${pad('下轮', 10)}${pad('搜索', 6)}${pad('命中', 6)}截断`);
  for (const s of all) {
    const r = s.lastResult || {};
    console.log(
      `${pad(s.name, 24)}${pad(risk.get(s.name), 4)}${pad((s.keywords || []).length, 5)}${pad(at(s.lastRunAt), 13)}${pad(due(s), 10)}${pad(r.searched ?? '—', 6)}${pad(r.matched ?? '—', 6)}${r.truncated ?? '—'}${s.progress ? `  ▶ ${s.progress.kw}（${s.progress.site} ${s.progress.searched}/${s.progress.planned}）` : ''}${r.error ? '  ⚠ ' + r.error : ''}`,
    );
  }
  const hits = all.reduce((n, s) => n + (s.lastResult?.matched || 0), 0);
  // jsonl 里会留上次被 kill 时的半截任务，别数条数，只认 startedAt 最新的那条
  const run = tl
    .filter((x) => !x.endedAt && ['fetching', 'parsing', 'downloading'].includes(x.phase))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  console.log(
    `\n队列：${cnt('queued')} 等 · 正在跑：${run ? `${run.site || ''} ${(run.title || run.url).slice(0, 40)}` : '无'}　24h 入库 ${cnt('done', dayAgo)}、失败 ${cnt('failed', dayAgo)}　末轮命中合计 ${hits}`,
  );
  process.exit(0);
}

// 订阅文件只由 server 进程写（单写者）；ipwatch 改走服务接口，不再直接读改写 subs.json。
// 连不上服务就别动订阅，宁可漏一轮也不两个进程互相覆盖。
const API = `http://127.0.0.1:${process.env.MARKLAB_PORT || 8851}/api/console/subs`;
async function viaApi(method, body) {
  const r = await fetch(API, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`订阅接口 ${method} 失败：${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const existing = await (async () => {
  const r = await fetch(API);
  if (!r.ok) throw new Error(`订阅接口 GET 失败：${r.status}`);
  return r.json();
})();
const rows = [];

for (const g of doc.groups) {
  const name = subName(g);
  const hit = existing.find((s) => s.name === name);
  const input = subInput(g);
  if (dry) {
    rows.push(`${hit ? '更新' : '新建'} ${name}　${input.keywords.length} 词 × ${SITES.length} 站　每 ${input.intervalHours}h`);
    continue;
  }
  if (hit) await viaApi('PATCH', { id: hit.id, ...input });
  else await viaApi('POST', input);
  rows.push(`${hit ? '更新' : '新建'} ${name}　${input.keywords.length} 词 × ${SITES.length} 站　每 ${input.intervalHours}h　${hit ? hit.id : ''}`);
}

if (!dry) await writeFile(MD, toMarkdown(doc));

console.log(rows.join('\n'));
const total = doc.groups.reduce((n, g) => n + g.keywords.length, 0);
console.log(
  `\n共 ${doc.groups.length} 组 / ${total} 词；一轮全量搜索 ≈ ${Math.round((total * SITES.length * 15) / 60)} 分钟（每站每 15 秒一次）。` +
    (dry ? '（--dry，没写盘）' : ` 清单：${path.relative(ROOT, MD)}`),
);

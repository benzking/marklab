#!/usr/bin/env node
// 四站分类抓取：每个站点的 1/2 级分类树 → docs/categories/sites.json
//
//   node cats.mjs            # 抓四个站，覆盖写 sites.json
//
// 四站的分类藏在四个不同地方（实测）：
//   creality   页面 __NUXT_DATA__ 的 data.modelCategoryBaseData.categories（devalue 序列化）
//   snapmaker  RSC 载荷里的 categories（id/parentId/nameKey），根节点「场景分类」
//   makerworld 整站挡非浏览器 UA，只能在页面里读 DOM 链接（/zh/3d-models/<id>-<slug>）
//   makeronline __NUXT__ IIFE 里的 data[0].categoryData（level 1/2 自带）

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveNuxt, writeJson, ROOT } from './lib.mjs';
import { evalInPage } from './channel.mjs';

const OUT = path.join(ROOT, 'docs/categories/sites.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

async function httpGet(target) {
  const r = await fetch(target, {
    headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`${r.status} ${target}`);
  return r.text();
}

const creality = async () => {
  const html = await httpGet('https://www.crealitycloud.cn/model-category/3d-print-all');
  const data = JSON.parse(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
  const cats = resolveNuxt(data).data.modelCategoryBaseData.categories;
  return cats
    .filter((c) => c.urlKey !== '3d-print-all') // 「全部分类」是筛选项不是分类
    .map((c) => ({
      id: c.id,
      name: c.name,
      en: c.en_name || '',
      children: (c.children || []).map((x) => ({ id: x.id, name: x.name, en: x.en_name || '' })),
    }));
};

const snapmaker = async () => {
  const html = await httpGet('https://space.snapmaker.cn/zh/models');
  const chunks = [...html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)].map((m) => {
    try { return JSON.parse(m[1])[1] || ''; } catch { return ''; }
  });
  const flat = chunks.join('');
  const start = flat.indexOf('"categories":[');
  if (start < 0) throw new Error('RSC 载荷里没有 categories（站点结构变了？）');
  const raw = flat.slice(start + '"categories":'.length);
  let depth = 0, end = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '[') depth++;
    else if (raw[i] === ']' && --depth === 0) { end = i + 1; break; }
  }
  const roots = JSON.parse(raw.slice(0, end));
  const pick = (c) => ({ id: c.id, name: c.nameKey, children: (c.children || []).map((x) => ({ id: x.id, name: x.nameKey })) });
  return roots.flatMap((r) => r.children || []).map(pick);
};

const makeronline = async () => {
  // 绝不在服务端求值 __NUXT__（那等于让站点在我们进程里执行任意代码）；改在浏览器页内读出分类树
  const { value } = await evalInPage('https://www.makeronline.com/zh/allModel/all/all/0.html', () =>
    JSON.stringify(window.__NUXT__?.data?.[0]?.categoryData || null),
  );
  if (!value) throw new Error('页面里没有 categoryData（站点结构变了？）');
  return JSON.parse(value).map((c) => ({
    id: c.id,
    name: c.name,
    children: (c.children || []).filter((x) => x.level === 2).map((x) => ({ id: x.id, name: x.name })),
  }));
};

const makerworld = async () => {
  const expr = `JSON.stringify([...document.querySelectorAll('a[href*="/zh/3d-models/"]')]
    .map(a => ({ href: a.getAttribute('href'), name: a.textContent.trim() })))`;
  const { value } = await evalInPage('https://makerworld.com.cn/zh/3d-models', expr, { wait: 6000 });
  const links = JSON.parse(value).map(({ href, name }) => {
    const m = /\/zh\/3d-models\/(\d+)-([\w-]+)/.exec(href || '');
    return m && { id: Number(m[1]), slug: m[2], name };
  }).filter(Boolean);
  if (!links.length) throw new Error('页面里没读到分类链接（站点结构变了或没登录？）');
  // 站点 id 是分段的：百位段就是一级（900/100/2000…），同段其余是它的二级
  const tops = links.filter((l) => l.id === Math.floor(l.id / 100) * 100);
  return tops.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    children: links
      .filter((l) => l !== t && Math.floor(l.id / 100) * 100 === t.id)
      .map((l) => ({ id: l.id, name: l.name, slug: l.slug })),
  }));
};

const sites = { creality, snapmaker, makerworld, makeronline };
const out = { fetchedAt: new Date().toISOString(), sites: {} };
const tableOnly = process.argv.includes('--table');
for (const [name, fn] of Object.entries(tableOnly ? {} : sites)) {
  try {
    out.sites[name] = await fn();
    const n = out.sites[name].reduce((s, c) => s + 1 + c.children.length, 0);
    console.log(`${name.padEnd(12)} ${out.sites[name].length} 个一级 / ${n} 条（含二级）`);
  } catch (e) {
    console.error(`${name.padEnd(12)} 失败: ${e.message}`);
    process.exitCode = 1;
  }
}
if (!tableOnly) {
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeJson(OUT, out);
  console.log(`→ ${path.relative(ROOT, OUT)}`);
}

// ── 对照表 ──────────────────────────────────────────────────────
// node cats.mjs --table  读 sites.json + merge.json，校验覆盖后写 docs/categories/对照表.md
const SITE_LABEL = { creality: '创想云', snapmaker: 'Snapmaker', makerworld: 'MakerWorld', makeronline: 'MakerOnline' };

if (tableOnly) {
  const { readFile } = await import('node:fs/promises');
  const sites = JSON.parse(await readFile(OUT, 'utf8')).sites;
  const merge = JSON.parse(await readFile(path.join(ROOT, 'docs/categories/merge.json'), 'utf8'));

  // 站点分类索引：id → {name, parent}
  const idx = {};
  for (const [site, tree] of Object.entries(sites)) {
    idx[site] = new Map();
    for (const c of tree) {
      idx[site].set(c.id, { name: c.name, parent: null });
      for (const x of c.children) idx[site].set(x.id, { name: x.name, parent: c.id });
    }
  }

  // 覆盖校验：站点里每个分类至少被 merge.json 收一次；同一行里不许重复。
  // 允许一个源分类出现在多行（如创想云「电子与遥控」同时算电子和遥控）。
  const used = {};
  const problems = [];
  const take = (site, id, where) => {
    const k = `${site}:${id}`;
    if (used[k] === where) problems.push(`${k} 在 ${where} 里重复`);
    used[k] ??= where;
    const hit = idx[site]?.get(id);
    if (!hit) problems.push(`${k} 在 ${site} 里不存在（${where}）`);
    return hit;
  };
  for (const l1 of merge.level1) {
    for (const [site, ids] of Object.entries(l1.sites)) ids.forEach((id) => take(site, id, `L1 ${l1.name}`));
    for (const c of l1.children) {
      for (const [site, ids] of Object.entries(c.sites)) ids.forEach((id) => take(site, id, c.name));
    }
  }
  for (const [site, tree] of Object.entries(sites)) {
    for (const c of tree) {
      for (const id of [c.id, ...c.children.map((x) => x.id)]) {
        if (!used[`${site}:${id}`]) problems.push(`${site}:${id} ${c.name} 没被对照表收录`);
      }
    }
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }

  // 站点自己的一级是哪个：单元格里只在这个站的一级被并到别处时才标注
  const cell = (site, l1, parents) => {
    const ids = l1.sites[site] || [];
    return ids.length
      ? ids.map((id) => {
          const hit = idx[site].get(id);
          const cross = hit.parent && !parents.has(hit.parent) ? `（在「${idx[site].get(hit.parent).name}」下）` : '';
          return hit.name + cross;
        }).join('、')
      : '—';
  };
  // parents = 该站这一层「本来应该在」的一级分类 id；二级行用它判断是否被跨一级并过来
  const row = (name, node, parents) =>
    `| ${name} | ${Object.keys(SITE_LABEL).map((s) => cell(s, node, parents)).join(' | ')} |`;

  const lines = [
    '# 四站分类对照表',
    '',
    `抓取时间：${new Date(JSON.parse(await readFile(OUT, 'utf8')).fetchedAt).toLocaleString('zh-CN')}　·　数据源：\`sites.json\`（原站） + \`merge.json\`（人工归并）　·　重新生成：\`node cats.mjs && node cats.mjs --table\``,
    '',
    '口径：左列是归并后的统一分类，右侧单元格是该站在这个统一分类下的原始二级分类名；',
    '标「（在「X」下）」的是原站挂在另一个一级分类下、语义相同被并过来的。',
    '',
    '## 一级分类',
    '',
    '| 统一一级 | 创想云 | Snapmaker | MakerWorld | MakerOnline |',
    '| --- | --- | --- | --- | --- |',
    ...merge.level1.map((l1) => row(l1.name, l1, new Set(Object.values(l1.sites).flat()))),
    '',
    '## 二级分类',
  ];
  for (const [i, l1] of merge.level1.entries()) {
    lines.push('', `### ${i + 1}. ${l1.name}`, '', '| 统一二级 | 创想云 | Snapmaker | MakerWorld | MakerOnline |', '| --- | --- | --- | --- | --- |');
    const parents = new Set(Object.values(l1.sites).flat());
    for (const c of l1.children) lines.push(row(c.name, c, parents));
  }
  // 该站有多少个原站分类被收录：一级数 / 二级数
  const stat = (site) => {
    const n = (list) => list.reduce((s, x) => s + (x.sites[site]?.length || 0), 0);
    return `${n(merge.level1)}/${n(merge.level1.flatMap((l) => l.children))}`;
  };
  lines.push('', '## 覆盖情况', '', `统一分类共 ${merge.level1.length} 个一级、${merge.level1.reduce((s, l) => s + l.children.length, 0)} 个二级。各站被收进对照表的原站分类数（一级/二级）：`, '',
    '| 站点 | 一级 | 二级 |', '| --- | --- | --- |',
    ...Object.entries(SITE_LABEL).map(([s, label]) => `| ${label} | ${stat(s)} |`), '');
  const dest = path.join(ROOT, 'docs/categories/对照表.md');
  await writeFile(dest, lines.join('\n'));
  console.log(`→ ${path.relative(ROOT, dest)}（覆盖校验通过）`);
}

#!/usr/bin/env node
// 四站分类抓取：每个站点包自己给分类树 → docs/categories/sites.json
//
//   node cats.mjs            # 抓四个站，覆盖写 sites.json
//   node cats.mjs --table    # 读 sites.json + merge.json，校验覆盖后写 docs/categories/对照表.md
//
// 分类藏在四个不同地方（页面 __NUXT_DATA__ / RSC 载荷 / 页面 DOM 链接 / __NUXT__ IIFE），
// 所以每个站点包自己实现 `categories()`，这里只负责遍历、写盘、校验——加站点不用改这个文件。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson, ROOT } from './lib.mjs';
import * as sites from './sites/index.mjs';

const OUT = path.join(ROOT, 'docs/categories/sites.json');

const out = { fetchedAt: new Date().toISOString(), sites: {} };
const tableOnly = process.argv.includes('--table');
// 分类 id 空间是「一个站一份」：MakerOnline 两域各有一套 id，对照表以海外站为准（categoriesKey）
for (const pack of tableOnly ? [] : sites.all().filter((p) => p.categoriesKey && p.categories)) {
  const name = pack.categoriesKey;
  try {
    out.sites[name] = await pack.categories();
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
const SITE_LABEL = Object.fromEntries(
  sites.all().filter((p) => p.categoriesKey).map((p) => [p.categoriesKey, p.label]),
);

if (tableOnly) {
  const trees = JSON.parse(await readFile(OUT, 'utf8')).sites;
  const merge = JSON.parse(await readFile(path.join(ROOT, 'docs/categories/merge.json'), 'utf8'));

  // 站点分类索引：id → {name, parent}
  const idx = {};
  for (const [site, tree] of Object.entries(trees)) {
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
  for (const [site, tree] of Object.entries(trees)) {
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

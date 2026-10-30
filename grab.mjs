#!/usr/bin/env node
// 3D 模型抓取器：给一个模型页网址，落地「复刻介绍页 + 模型文件」。
//
//   node grab.mjs <url> [--no-files] [--out library]
//
// 取数方式在 sites/<站点>.mjs 里，这里只管流程：抓元数据 → 判重 → 下文件 → 落盘。
// 站点包只暴露 match / meta / fileLinks 三个口（还有 loginState / search / userModels 给别处用）。
// 借浏览器跑页面内 JS 的站：连的是本机常驻 Chromium（CDP 9223，ADR-0002），不 launch 新浏览器。

import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT, sanitize, slugify, autoTags, writeJson } from './lib.mjs';
import { browserConnected, fetchAs, closePages } from './channel.mjs';
import { UA } from './sites/_http.mjs';
import * as sites from './sites/index.mjs';
import * as dup from './dup.mjs';

// 没下到文件时给控制台看的原因
const NO_FILES_TEXT = {
  login: '文件一个都没下到：站点要求登录态',
  captcha: '文件一个都没下到：站点要过人机验证（在浏览器里打开该模型页过一次，再补抓）',
  parse: '文件一个都没下到：站点给了文件列表但没拿到直链（可能改版了）',
  none: '站点没给文件直链（这类模型只能在站点里下）',
};

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((a) => /^https?:/.test(a));
const outRoot = path.resolve(ROOT, valueOf('--out') || 'library');
const wantFiles = !args.includes('--no-files');

// 结构化进度：只有任务队列（server/tasks.mjs）要，手工跑不加噪音
// playwright 的 WS 会撑住事件循环，抓完必须自己退；先等 stdout 冲干净再退，否则日志会被截断
// 退出前先关掉自己开的标签页（不关就会在用户 Chrome 里越堆越多），最多等 3 秒
// 这个 Promise 故意永不 resolve：调用方必须 await，否则后面的代码会继续跑（曾因此写出幽灵模型）
const exit = (code = 0) =>
  Promise.race([closePages(), new Promise((r) => setTimeout(r, 3000))])
    .catch(() => {}) // 关标签页失败也照退，不然会在这里打转
    .then(() => new Promise(() => process.stdout.write('', () => process.exit(code))));

// 没接住的错误 / 被停止也要先关标签页再退（ADR-0005 补记 11）
const fatal = (e) => {
  console.error(`\n抓取失败：${e?.message || e}`);
  exit(1);
};
process.on('unhandledRejection', fatal);
process.on('uncaughtException', fatal);
process.on('SIGTERM', () => {
  console.error('\n收到停止信号');
  exit(1);
});

const progress = (o) => {
  if (process.env.MARKLAB_TASK) process.stdout.write(`@@TASK ${JSON.stringify(o)}\n`);
};

if (!url) {
  console.error('用法: node grab.mjs <模型页网址> [--no-files] [--out 目录]');
  process.exit(1);
}

// ── 通用工具 ────────────────────────────────────────────────────

// 图片/缩略图走公开 CDN，匿名就够；模型文件要登录态（ADR-0003），所以多一个 site 参数。
// 失败最多试 3 次（本任务内 attempts 上限），第 2 次起强制重取登录态——大概率是登录态过期。
async function download(target, dest, site) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = site
        ? await fetchAs(site, target, { headers: { 'user-agent': UA } }, attempt > 0)
        : await fetch(target, { headers: { 'user-agent': UA } });
      if (!r) throw new Error('浏览器没连上，拿不到登录态');
      if (!r.ok) throw new Error(`下载失败 ${r.status} ${target.slice(0, 80)}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await writeJson(dest, buf);
      // 边写边算：文件级去重要 hash，反正 buf 已经在内存里，多这一步是零额外 I/O
      return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

// ── 主流程 ──────────────────────────────────────────────────────
// 认网址只问站点包（sites/index.mjs）；认不出就拒，不再猜
const hit = sites.match(url);
if (!hit) {
  console.error('暂不支持的站点。目前支持：\n  space.snapmaker.cn / crealitycloud.cn / makerworld.com.cn / makeronline.cn|com');
  process.exit(2);
}

// platform 是数据命名空间（库目录、判重键）：MakerOnline 的 .cn/.com 共用一个；
// site 是站点键（浏览器 cookie、登录态、日志）：两个域各自独立。
const { name: site, id } = hit;
const pack = sites.byName(site);
if (!pack) {
  console.error(`站点包没登记：${site}（sites/index.mjs）`);
  process.exit(2);
}
const platform = pack.platform || site;
progress({ phase: 'fetching', site, id });
const model = await pack.meta(hit.url);
model.fetchedAt = new Date().toISOString();
progress({ phase: 'parsing', title: model.title });

// 判重（ADR-0004）：同站标题+作者相同就是重复，下载前拦；跨站标题+作者只是「疑似」，
// 要等下载完比作者件的 sha256 才算「确认」。同网址是同目录重抓，不算重复。
const dupHit = await dup.check(model);
if (dupHit?.same) {
  await dup.record(platform, id, dupHit, { title: model.title, author: model.author, url: model.sourceUrl });
  progress({ phase: 'duplicate', of: dupHit.of, by: 'meta' });
  console.log(`\n${platform} · ${model.title}\n  跳过：同站已有 ${dupHit.of}（标题+作者相同）`);
  await exit(0);
}

// 目录只认站点+id：标题改了也不会生第二个目录
const dir = path.join(outRoot, `${platform}-${id}`);
const filesDir = path.join(dir, 'files');
const imgDir = path.join(dir, 'img');
await mkdir(filesDir, { recursive: true });
await mkdir(imgDir, { recursive: true });

// 图片落地，页面才能离线看
const localImages = [];
for (const [i, src] of model.images.slice(0, 12).entries()) {
  const ext = (src.match(/\.(png|jpe?g|webp)/i) || [, 'png'])[1].toLowerCase();
  const name = `${String(i + 1).padStart(2, '0')}.${ext}`;
  try {
    await download(src, path.join(imgDir, name));
    localImages.push(`img/${name}`);
  } catch (e) {
    console.warn(`  图片跳过 ${src.slice(0, 60)}：${e.message}`);
  }
}
model.localImages = localImages;

// 打印盘缩略图也落地，否则离线看是空框
if (model.print?.plateList?.length) {
  const platesDir = path.join(imgDir, 'plates');
  await mkdir(platesDir, { recursive: true });
  for (const [i, pl] of model.print.plateList.entries()) {
    if (!pl.thumb) continue;
    const ext = (pl.thumb.match(/\.(png|jpe?g|webp)/i) || [, 'png'])[1].toLowerCase();
    const name = `${String(i + 1).padStart(2, '0')}.${ext}`;
    try {
      await download(pl.thumb, path.join(platesDir, name));
      pl.thumb = `img/plates/${name}`;
    } catch {}
  }
}

// 模型内每个文件之间歇 5–10 秒（AGENTS.md 限速的另一半：模型之间 60–120 秒在 tasks.mjs）。
// 站点看到的是「一分钟一个模型 + 模型内慢慢下」，不是一个模型 48 个文件连珠炮。
const fileGap = () => new Promise((r) => setTimeout(r, 5000 + Math.random() * 5000));

// 文件落地
const saved = [];
let linkErr = '';
if (wantFiles) {
  try {
    const links = await pack.fileLinks(model);
    progress({ phase: 'downloading', done: 0, total: links.length });
    for (const [i, f] of links.entries()) {
      if (i > 0) await fileGap();
      const ext = (f.name.match(/\.(\w+)$/) || [, 'bin'])[1];
      const name = `${String(i + 1).padStart(2, '0')}-${slugify(f.name.replace(/\.\w+$/, ''))}.${ext}`;
      // 单个文件失败不拖累其余：48 个 STL 的模型不能因为第 3 个挂了就全丢
      try {
        const { bytes, sha256 } = await download(f.url, path.join(filesDir, name), site);
        saved.push({ name: f.name, path: `files/${name}`, bytes, sha256, kind: f.kind || 'model', origin: f.origin || 'author' });
        console.log(`  ✓ ${f.name} (${(bytes / 1048576).toFixed(1)} MB)`);
      } catch (e) {
        linkErr = e.message;
        console.warn(`  ✗ ${f.name}：${e.message}`);
      }
      progress({ phase: 'downloading', done: i + 1, total: links.length, name: f.name });
    }
  } catch (e) {
    linkErr = e.message;
    console.warn(`  文件下载失败：${e.message}`);
  }
}

// 跨站疑似：下载完比作者件的 sha256，撞上才算确认重复（同格式才可能撞，天然排除 stl 比 3mf）
if (dupHit && !dupHit.same && saved.length && (await dup.confirm(dupHit.of, saved))) {
  await dup.record(platform, id, { of: dupHit.of, by: 'hash' }, {
    title: model.title,
    author: model.author,
    url: model.sourceUrl,
    hashes: saved.map((f) => f.sha256),
  });
  progress({ phase: 'duplicate', of: dupHit.of, by: 'hash' });
  console.log(`\n${platform} · ${model.title}\n  跳过：与 ${dupHit.of} 是同一个模型（作者件 sha256 相同）`);
  await rm(dir, { recursive: true, force: true });
  await exit(0);
}

// 一个文件都没下到时记下原因：控制台才能分清「要登录」「站点本来就不给」「解析坏了」
if (wantFiles && !saved.length) {
  const hasFiles = (model.files || []).length + (model.rawFiles || []).length > 0;
  model.noFiles = /机器人|captcha|人机验证/i.test(linkErr)
    ? 'captcha'
    : /登录|403|unauthor|forbidden/i.test(linkErr)
      ? 'login'
      : hasFiles
        ? 'parse'
        : 'none';
  progress({ phase: 'warning', msg: NO_FILES_TEXT[model.noFiles] });
}

// --no-files 重跑时不要把上一轮已下好的文件记录抹掉
if (!saved.length) {
  try {
    const prev = JSON.parse(await readFile(path.join(dir, 'model.json'), 'utf8'));
    model.savedFiles = (prev.savedFiles || []).filter((f) => existsSync(path.join(dir, f.path)));
  } catch {}
}
if (saved.length) {
  model.savedFiles = saved;
  delete model.noFiles; // 这次下到了，上一次的「没下到」原因作废
}
model.savedFiles ||= [];

// 跨站标题+作者撞上但 hash 没撞：记「疑似」，照常入库，页面上互相给链接
if (dupHit && !dupHit.same) {
  model.duplicateOf = { of: dupHit.of, by: 'meta' };
  await dup.record(platform, id, dupHit, {
    title: model.title,
    author: model.author,
    url: model.sourceUrl,
    hashes: saved.map((f) => f.sha256),
  });
  progress({ phase: 'warning', msg: `疑似与 ${dupHit.of} 是同一模型（标题+作者相同，文件 hash 不同）` });
}

model.dir = path.basename(dir);
model.autoTags = autoTags(platform, { downloads: model.stats?.downloads, picked: model.picked });
await writeJson(path.join(dir, 'model.json'), model);
progress({ phase: 'done', dir: model.dir, title: model.title, files: model.savedFiles.length });

console.log(`\n${platform} · ${model.title}`);
console.log(`  目录  ${path.relative(ROOT, dir)}`);
console.log(`  文件  ${model.savedFiles.length} 个（本次新下 ${saved.length}）· 图片 ${localImages.length} 张`);
if (model.print) console.log(`  打印  ${model.print.timeText} · ${model.print.weightG} g · ${model.print.plates} 盘 · ${model.print.filaments.length} 种耗材`);
if (model.autoTags?.length) console.log(`  标签  ${model.autoTags.join(' / ')}`);
if (!browserConnected()) console.log('  ⚠ 浏览器没连上：需要登录态的站点下不了文件');
await exit(0);

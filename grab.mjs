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
import { ROOT, matchPlatform, sanitize, slugify, autoTags, writeJson, fmtHours } from './lib.mjs';
import { evalInPage, browserConnected, fetchAs, closePages } from './channel.mjs';
import { UA } from './sites/_http.mjs';
import * as sites from './sites/index.mjs';
import * as dup from './dup.mjs';

// 签名链接里的 % 偶尔不合法，decode 抛错不该让整份文件列表失败
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return String(s);
  }
};

// 没下到文件时给控制台看的原因
const NO_FILES_TEXT = {
  login: '文件一个都没下到：站点要求登录态',
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

// ── 还没搬进站点包的适配器（票 03–05 搬完这张表就空了）────────────────

// MakerWorld：整站对非浏览器 UA 返 403，详情和 f3mf 都得在页面里取
const makerworld = {
  async meta(id) {
    const js = `(async () => {
      const j = await (await fetch('/api/v1/design-service/design/${id}', { headers: { accept: 'application/json' } })).json();
      const pic = (p) => (p && (p.url || p)) || '';
      const num = (v) => (typeof v === 'string' ? Number(v) : v);
      const filamentsOf = (arr) => (arr || []).map(f => ({ type: f.type, color: f.color, usedG: num(f.usedG), usedM: num(f.usedM) }));
      const platesOf = (mi) => ((mi && mi.plates) || []).map(p => ({
        index: p.index, name: p.name, timeSec: p.prediction, weightG: p.weight,
        thumb: pic(p.thumbnail), filaments: filamentsOf(p.filaments),
      }));
      return {
        title: j.title, author: (j.designCreator && (j.designCreator.name || j.designCreator.handle)) || '',
        authorUid: j.designCreator?.uid || null,
        authorAvatar: (j.designCreator && (j.designCreator.avatar || j.designCreator.avatarUrl)) || '',
        description: j.summary || j.description || '', cover: j.coverUrl || j.coverLandscape || '',
        likes: j.likeCount, downloads: j.downloadCount, collects: j.collectionCount, comments: j.commentCount,
        createTime: j.createTime, updateTime: j.updateTime, tags: (j.tags || []).map(t => t.name || t).filter(Boolean),
        picked: Boolean(j.isStaffPicked),
        category: ((j.categories || [])[0] && (j.categories[0].name || j.categories[0].nameTranslated)) || '',
        instances: (j.instances || []).map(i => {
          const mi = (i.extention && i.extention.modelInfo) || {};
          const compat = mi.compatibility ? [mi.compatibility] : [];
          return {
            id: i.id, title: i.title, cover: pic(i.cover), pictures: (i.pictures || []).map(pic).filter(Boolean),
            downloads: i.downloadCount, prints: i.printCount, isDefault: i.isDefault,
            timeSec: i.prediction, weightG: i.weight, materialCnt: i.materialCnt, needAms: i.needAms,
            instanceCreator: i.instanceCreator ? (i.instanceCreator.name || true) : null,
            creatorUid: i.instanceCreator?.uid || null,
            ratingCount: i.ratingCount, ratingTotal: i.ratingScoreTotal,
            projectSettings: mi.projectSettings || {}, plates: platesOf(mi),
            filaments: filamentsOf(i.instanceFilaments),
            machines: [...compat, ...(mi.otherCompatibility || [])].map(m => ({ name: m.devProductName, code: m.devModelName, nozzle: m.nozzleDiameter })),
          };
        }),
        rawFiles: ((j.designExtension && j.designExtension.model_files) || []).map(f => ({ name: f.modelName, size: f.modelSize, type: f.modelType, origin: 'author' })),
      };
    })()`;
    const { value: d, via } = await evalInPage(`https://makerworld.com.cn/zh/models/${id}`, js, { wait: 6000 });
    const inst = d.instances.find((i) => i.isDefault) || d.instances[0] || {};
    return {
      platform: 'makerworld',
      id,
      sourceUrl: `https://makerworld.com.cn/zh/models/${id}`,
      title: d.title,
      author: d.author,
      authorUid: d.authorUid,
      authorAvatar: d.authorAvatar,
      description: sanitize(d.description),
      images: [d.cover, ...d.instances.flatMap((i) => [i.cover, ...i.pictures])].filter(Boolean),
      stats: { downloads: d.downloads },
      picked: Boolean(d.picked),
      category: d.category || '',
      tags: d.tags,
      publishedAt: d.createTime,
      print: {
        profileTitle: inst.title,
        thumb: inst.cover,
        timeSec: inst.timeSec,
        timeText: fmtHours(inst.timeSec),
        weightG: inst.weightG,
        plates: inst.plates?.length || 0,
        nozzle: inst.machines?.[0]?.nozzle ? `${inst.machines[0].nozzle} mm` : '',
        layerHeight: inst.projectSettings?.layerHeight,
        wallLoops: inst.projectSettings?.wallLoops,
        infill: inst.projectSettings?.sparseInfillDensity,
        filaments: inst.filaments || [],
        plateList: inst.plates || [],
        machines: inst.machines || [],
        source: via,
      },
      profiles: d.instances.map((i) => ({
        id: i.id,
        name: i.title,
        machine: i.machines?.[0]?.name || '',
        machines: (i.machines || []).map((x) => x.name),
        plates: i.plates?.length || 0,
        plateList: i.plates || [],
        timeSec: i.timeSec,
        timeText: fmtHours(i.timeSec),
        weightG: i.weightG ? Math.round(i.weightG * 10) / 10 : null,
        nozzle: i.machines?.[0]?.nozzle ? `${i.machines[0].nozzle} mm` : '',
        layerHeight: i.projectSettings?.layerHeight || '',
        wallLoops: i.projectSettings?.wallLoops || '',
        infill: i.projectSettings?.sparseInfillDensity || '',
        bed: '',
        size: 0,
        filaments: i.filaments || [],
        thumbnail: i.cover || '',
        isDefault: i.isDefault,
        creatorUid: i.creatorUid,
        url: `https://makerworld.com.cn/zh/models/${id}#profileId-${i.id}`,
      })),
      files: d.rawFiles,
      fileIds: d.instances.map((i) => i.id),
      via,
    };
  },
  // 打印配置 3mf：每个 instance 一份。别人加的配置（instanceCreator ≠ 作者）标 other，判重时不比。
  async fileLinks(model) {
    const js = `(async () => {
      const out = [];
      const errs = [];
      for (const [id, mine] of ${JSON.stringify(
        (model.fileIds || []).map((id, i) => {
          const c = model.profiles?.[i]?.creatorUid;
          return [id, !c || !model.authorUid || String(c) === String(model.authorUid)];
        }),
      )}) {
        const r = await fetch('/api/v1/design-service/instance/' + id + '/f3mf', { headers: { accept: 'application/json' } });
        if (!r.ok) {
          let t = '';
          try { t = (await r.json()).error || ''; } catch {}
          errs.push(t || 'HTTP ' + r.status);
          // 没登录时整站都不给文件，别再一个个配置试下去，直接放弃等登录后统一补抓
          if (r.status === 403 || /登录|forbidden|unauthor/i.test(t)) break;
          continue;
        }
        const j = await r.json();
        if (j && j.url) out.push({ name: j.name, url: j.url, size: j.size, mine });
      }
      return { out, errs };
    })()`;
    const { value: res } = await evalInPage(model.sourceUrl, js, { wait: 6000 });
    if (!res.out.length && res.errs.length) {
      const first = res.errs[0];
      throw new Error(/登录|403|forbidden|unauthor/i.test(first) ? `MakerWorld 没登录，拿不到文件：${first}` : first);
    }
    return res.out.map((r) => ({
      name: r.name || 'model',
      url: r.url,
      size: r.size,
      kind: 'profile',
      origin: r.mine ? 'author' : 'other',
    }));
  },
};

// MakerOnline（纵维立方）：Nuxt 2，页面里 window.__NUXT__ 是 IIFE 打包的数据。
// 绝不在服务端求值它——那等于让站点在我们的进程里执行任意代码（实测能拿到 process）。
// 改成在浏览器页内读出模型那一段，只把 JSON 结果传回来。
const makeronline = {
  async meta(id, pageUrl) {
    const canonical = pageUrl;
    const { value } = await evalInPage(canonical, () => {
      const m = window.__NUXT__?.data?.[0]?.modelDetailData;
      return m ? JSON.stringify(m) : null;
    });
    if (!value) throw new Error('__NUXT__ 里没有 modelDetailData（站点结构变了，或没登录）');
    const m = JSON.parse(value);

    const profile = (m.print_profiles || [])[0] || {};
    const rgb = (v) =>
      '#' +
      String(v || '0,0,0')
        .split(',')
        .map((x) => Number(x).toString(16).padStart(2, '0'))
        .join('');
    // "26h26m" → 秒
    const secs = (s) => {
      const mm = /(?:(\d+)h)?(?:(\d+)m)?/.exec(String(s || ''));
      return mm && (mm[1] || mm[2]) ? Number(mm[1] || 0) * 3600 + Number(mm[2] || 0) * 60 : null;
    };
    const machines = String(profile.printer_label || '')
      .split(/[、,，]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
    const plateList = (profile.files || []).map((f, idx) => ({
      name: `第 ${idx + 1} 盘`,
      timeText: fmtHours(secs(f.print_time)) || f.print_time || '',
      timeSec: secs(f.print_time),
      weightG: (f.materials || []).reduce((a, x) => a + (Number(x.filament_used_g) || 0), 0) || null,
      thumb: f.thumbnail || null,
      filaments: (f.materials || []).map((x) => ({ type: x.material_type, color: rgb(x.paint_color), usedG: x.filament_used_g })),
    }));
    const downloadName = profile.download?.file_name || `${m.title}.3mf`;
    // 打印配置带 is_author（页面上那个「Designer」徽标）：别人传的配置不算作者件，不参与比 hash
    const profileByAuthor = profile.is_author !== false;
    const fileOrigin = profileByAuthor ? 'author' : 'other';

    const site = /makeronline\.cn/i.test(canonical) ? 'cn' : 'com';
    const rawFiles = (m.files || []).map((f) => ({
      name: f.file_name || 'model',
      size: f.file_size,
      format: (String(f.file_name || '').match(/\.(\w+)$/) || [, ''])[1].toLowerCase(),
      private: true,
      origin: 'author',
    }));

    return {
      platform: 'makeronline',
      site,
      id,
      sourceUrl: canonical,
      title: m.title,
      author: m.user_display_name || m.user_name || '',
      authorAvatar: m.user_avatar || '',
      description: sanitize(m.desc),
      images: (m.images || []).map((x) => x.url).filter(Boolean),
      stats: { downloads: m.download_num },
      picked: Boolean(m.contest_winner?.is_winner),
      category: (m.categories || []).map((c) => c.name).join(' / '),
      tags: m.tags || [],
      publishedAt: m.publish_time || null,
      print: profile.id
        ? {
            profileTitle: profile.title || '默认打印配置',
            thumb: profile.main_thumb_image || profile.main_image || null,
            timeText: fmtHours(secs(profile.print_time_label)) || profile.print_time_label || '',
            timeSec: secs(profile.print_time_label),
            weightG: Math.round((profile.materials_label || []).reduce((a, x) => a + (Number(x.filament_used_g) || 0), 0) * 10) / 10 || null,
            plates: profile.plate_count || plateList.length,
            nozzle: profile.nozzle ? `${profile.nozzle} mm` : '',
            filaments: (profile.materials_label || []).map((x) => ({
              type: x.material_type,
              color: rgb(x.paint_color),
              usedG: x.filament_used_g,
            })),
            plateList,
            machines,
            source: 'ssr',
          }
        : null,
      profiles: profile.id
        ? [{
            id: profile.id,
            name: profile.title || '默认打印配置',
            machine: machines[0]?.name || '',
            machines: machines.map((x) => x.name),
            plates: profile.plate_count || plateList.length,
            plateList,
            timeSec: secs(profile.print_time_label),
            timeText: fmtHours(secs(profile.print_time_label)),
            weightG: Math.round((profile.materials_label || []).reduce((a, x) => a + (Number(x.filament_used_g) || 0), 0) * 10) / 10,
            nozzle: profile.nozzle ? `${profile.nozzle} mm` : '',
            layerHeight: '', wallLoops: '', infill: '', bed: '',
            size: profile.total_size || 0,
            filaments: (profile.materials_label || []).map((x) => ({ type: x.material_type, color: rgb(x.paint_color), usedG: x.filament_used_g })),
            thumbnail: profile.main_thumb_image || '',
            isDefault: true,
            isAuthor: profileByAuthor,
            creatorUid: profile.user_id ?? null,
            url: canonical,
          }]
        : [],
      files: profile.id
        ? [{ name: downloadName, format: (downloadName.match(/\.(\w+)$/) || [])[1] || '3mf', size: profile.total_size, origin: fileOrigin }]
        : [],
      rawFiles,
      docs: (m.docs || []).map((d) => ({
        name: d.file_name,
        size: d.file_size,
        format: (String(d.file_name || '').match(/\.(\w+)$/) || [, ''])[1].toLowerCase(),
        private: true,
      })),
      fileIds: profile.id ? [profile.id] : [],
    };
  },
  // 下载要登录：在页面里点「下载 → 下载全部」，截获它创建的链接
  async fileLinks(model) {
    const js = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const got = [];
      const oc = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.href) got.push(this.href); };
      const ow = window.open;
      window.open = function (u) { if (u) got.push(String(u)); return null; };
      const btn = document.querySelector('.print-download-button button') ||
        [...document.querySelectorAll('button')].find((b) => /下载|Download/i.test(b.innerText || ''));
      if (!btn) { HTMLAnchorElement.prototype.click = oc; window.open = ow; return { error: '页面上找不到下载按钮' }; }
      try {
        btn.click();
        await sleep(1600);
        const all = [...document.querySelectorAll('.el-dialog button')].find((b) => /下载全部|Download all/i.test(b.innerText || ''));
        if (all) { all.click(); await sleep(6000); }
      } finally {
        // 常驻页是共用的，抛错也必须把 monkeypatch 还回去，否则后面所有点击都被劫持
        HTMLAnchorElement.prototype.click = oc; window.open = ow;
      }
      const login = [...document.querySelectorAll('.el-dialog')].some((d) => /登录|Log in|Sign in/i.test(d.innerText || '') && d.offsetParent !== null);
      return { urls: [...new Set(got)].filter((u) => /^https?:/.test(u)), loginRequired: login && got.length === 0 };
    })()`;
    const { value: res } = await evalInPage(model.sourceUrl, js, { wait: 6000 });
    if (res.error) throw new Error(res.error);
    if (!res.urls.length) {
      throw new Error(res.loginRequired ? '下载需要登录：先在浏览器登录 makeronline' : '没截到下载链接（站点可能改了下载流程）');
    }
    return res.urls.map((u, i) => {
      // 签名链接的 response-content-disposition 里带着原始文件名
      const m = /filename=(?:UTF-8'')?([^&;]+)/i.exec(safeDecode(u));
      const name = (m && safeDecode(m[1].replace(/\+/g, ' '))) || `${(model.files[0]?.name || 'model').replace(/\.\w+$/, '')}${i ? '-' + (i + 1) : ''}.3mf`;
      return { name, url: u, size: model.files[0]?.size, kind: 'profile' };
    });
  },
};

// 还没搬进站点包的两个站（票 03–05 逐个搬走，搬完这张表就空了）
const ADAPTERS = { makerworld, makeronline };

// ── 主流程 ──────────────────────────────────────────────────────
// 先问站点包（sites/index.mjs），包不认再退回旧适配器表
const hit = sites.match(url) || matchPlatform(url);
if (!hit) {
  console.error('暂不支持的站点。目前支持：\n  space.snapmaker.cn / crealitycloud.cn / makerworld.com.cn / makeronline.cn|com');
  process.exit(2);
}

const { name: platform, id } = hit;
const pack = sites.byName(platform);
const adapter = pack || ADAPTERS[platform];
progress({ phase: 'fetching', site: platform, id });
const model = pack ? await pack.meta(hit.url) : await ADAPTERS[platform].meta(id, hit.url);
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
    const links = await adapter.fileLinks(model);
    progress({ phase: 'downloading', done: 0, total: links.length });
    for (const [i, f] of links.entries()) {
      if (i > 0) await fileGap();
      const ext = (f.name.match(/\.(\w+)$/) || [, 'bin'])[1];
      const name = `${String(i + 1).padStart(2, '0')}-${slugify(f.name.replace(/\.\w+$/, ''))}.${ext}`;
      // 单个文件失败不拖累其余：48 个 STL 的模型不能因为第 3 个挂了就全丢
      try {
        const { bytes, sha256 } = await download(f.url, path.join(filesDir, name), platform);
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
  model.noFiles = /登录|403|unauthor|forbidden/i.test(linkErr) ? 'login' : hasFiles ? 'parse' : 'none';
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

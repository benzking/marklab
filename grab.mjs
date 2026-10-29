#!/usr/bin/env node
// 3D 模型抓取器：给一个模型页网址，落地「复刻介绍页 + 模型文件」。
//
//   node grab.mjs <url> [--no-files] [--out library]
//
// 三个站点的取数方式各不相同（都是实测出来的）：
//   snapmaker  页面 SSR（必须带 -model 这种 slug）里就有完整打印配置；模型文件是私链 CDN，HTTP 直下
//   creality   页面 SSR 里的 __NUXT_DATA__ 是 modelGroupDetail；文件要登录态
//   makerworld 整站挡非浏览器 UA，详情与 f3mf 都必须在页面里 fetch
// 后两个借浏览器跑页面内 JS：优先 bsk（用户已登录的 Chrome），连不上时退到内置无头 chromium（只够抓公开数据）。

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { matchPlatform, resolveNuxt, sanitize, slugify, autoTags } from './lib.mjs';
import { evalInPage, browserConnected } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((a) => /^https?:/.test(a));
const outRoot = path.resolve(ROOT, valueOf('--out') || 'library');
const wantFiles = !args.includes('--no-files');

if (!url) {
  console.error('用法: node grab.mjs <模型页网址> [--no-files] [--out 目录]');
  process.exit(1);
}

// ── 通用工具 ────────────────────────────────────────────────────
async function httpGet(target) {
  const r = await fetch(target, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'follow',
  });
  return { status: r.status, text: await r.text() };
}

async function download(target, dest) {
  const r = await fetch(target, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`下载失败 ${r.status} ${target.slice(0, 80)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

// 秒 → "64.3 h" / "26.2 h" / "12 分钟"，与站点显示口径一致
const fmtHours = (sec) => {
  if (!sec) return '';
  const h = sec / 3600;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(sec / 60)} 分钟`;
};

// ── 站点适配器 ──────────────────────────────────────────────────

// 创想云：SSR 的 __NUXT_DATA__ 就是 modelGroupDetail 的完整响应；
// 3mf 版页面额外带 3mf-list（打印配置）与 3mf-all-printers（机型表）
const creality = {
  async meta(id, pageUrl) {
    const canonical = `https://www.crealitycloud.cn/model-detail/${id}`;
    const { text } = await httpGet(pageUrl.split('#')[0]);
    const raw = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(text)?.[1];
    if (!raw) throw new Error('页面里没有 __NUXT_DATA__（站点结构变了？）');
    const state = resolveNuxt(JSON.parse(raw)).data;
    const result = Object.entries(state).find(([k]) => k.startsWith('model-info'))?.[1]?.result;
    if (!result) throw new Error('__NUXT_DATA__ 里没有 model-info');
    const g = result.groupItem;

    // 打印配置（3mf 版页面才有）
    const rawProfiles = (Object.entries(state).find(([k]) => k.startsWith('3mf-list'))?.[1]?.list) || [];
    const profiles = rawProfiles.map((p) => ({
      id: p.id,
      name: p.secondName || p.name || '打印配置',
      title: p.name || '',
      machine: p.printerName || '',
      machines: p.supportPrinterNames || [],
      plates: p.plateCount || 0,
      timeSec: p.printTime || 0,
      weightG: Math.round((Number(p.filamentWeight) || 0) * 10) / 10,
      lengthM: Number(p.filamentLen) || 0,
      size: p.size || 0,
      layerHeight: p.layerHeight ? String(p.layerHeight) : '',
      wallLoops: p.wallLoops ? String(p.wallLoops) : '',
      infill: p.sparseInfillDensity != null ? String(p.sparseInfillDensity) : '',
      nozzle: (p.nozzleDiameter || [])[0] ? `${(p.nozzleDiameter || [])[0]} mm` : '',
      bed: p.currBedType || '',
      downloads: p.downloadCount || 0,
      thumbnail: p.thumbnail || '',
      isAuth: Boolean(p.isAuth),
      filaments: (p.colorFilament || []).map((c) => ({ type: c.type, color: c.color, usedG: Number(c.weight) || null })),
    }));
    // 网址上带的 profileId 优先，其次第一个已认证的
    const wanted = /[?&]profileId=([0-9a-f]{24})/i.exec(pageUrl)?.[1];
    const active = profiles.find((p) => p.id === wanted) || profiles.find((p) => p.isAuth) || profiles[0] || null;

    // SSR 的 modelList 只有第一页（5 个），站点弹窗是走 fileListPage 拉全量，这里对齐
    let allStl = result.modelList || [];
    try {
      const r = await fetch('https://www.crealitycloud.cn/api/cxy/v3/model/fileListPage', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: 'https://www.crealitycloud.cn',
          referer: canonical,
          __cxy_app_id_: 'cxy-gen2',
          __cxy_app_ver_: '7.3.28',
          __cxy_platform_: '2',
          __cxy_brand_: 'creality',
        },
        body: JSON.stringify({ modelId: id, page: 1, pageSize: 200 }),
      });
      const j = await r.json();
      if (j.code === 0 && j.result?.list?.length) allStl = j.result.list;
    } catch {}

    const stlFiles = allStl.map((f) => ({
      name: f.fileName + (f.fileFormat || ''),
      format: (f.fileFormat || '').replace('.', ''),
      size: f.fileSize,
      id: f.id,
      kind: 'model',
    }));

    // 说明文件（PDF 等）单独一个接口
    let docs = [];
    try {
      const r = await fetch('https://www.crealitycloud.cn/api/cxy/v3/model/fileOtherListPage', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: 'https://www.crealitycloud.cn',
          referer: canonical,
          __cxy_app_id_: 'cxy-gen2',
          __cxy_app_ver_: '7.3.28',
          __cxy_platform_: '2',
          __cxy_brand_: 'creality',
        },
        body: JSON.stringify({ modelId: id, page: 1, pageSize: 50 }),
      });
      const j = await r.json();
      docs = (j.result?.list || []).map((d) => ({
        name: d.fileName + (d.fileFormat || ''),
        size: d.fileSize,
        format: (d.fileFormat || '').replace('.', ''),
        id: d.id,
      }));
    } catch {}

    return {
      platform: 'creality',
      id,
      sourceUrl: canonical,
      docs,
      title: g.groupName,
      author: g.userInfo?.nickName || '',
      authorAvatar: g.userInfo?.avatar || '',
      description: sanitize(g.groupDesc),
      images: [...new Set([...(g.pcCovers || []), ...(g.covers || [])].map((c) => c.url).filter(Boolean))],
      stats: { downloads: g.downloadCount },
      picked: Boolean(g.isPickModel),
      category: g.categoryName || '',
      tags: (g.tags || []).map((t) => t.name || t).filter(Boolean),
      publishedAt: g.createTime,
      print: active
        ? {
            profileTitle: active.name,
            thumb: active.thumbnail || '',
            timeText: fmtHours(active.timeSec),
            timeSec: active.timeSec,
            weightG: active.weightG ? Math.round(active.weightG * 10) / 10 : null,
            plates: active.plates,
            nozzle: active.nozzle,
            layerHeight: active.layerHeight,
            wallLoops: active.wallLoops,
            infill: active.infill,
            filaments: active.filaments,
            plateList: [],
            machines: active.machines.map((n) => ({ name: n })),
            source: 'ssr',
          }
        : null,
      profiles: profiles.map((p) => ({ ...p, url: `${canonical}?profileId=${p.id}` })),
      activeProfileId: active?.id || null,
      files: stlFiles,
      fileIds: stlFiles.map((f) => f.id),
      // 3mf 打印配置没有公开下载接口，界面上标出来让用户去站点下
      siteOnlyFiles: profiles.map((p) => ({
        name: `${p.title || '打印配置'} · ${p.name}.3mf`,
        size: p.size,
        kind: 'profile',
        url: `${canonical}?profileId=${p.id}`,
      })),
    };
  },
  async fileLinks(model) {
    if (!model.fileIds.length) return [];
    const js = `(async () => {
      const ck = Object.fromEntries(document.cookie.split('; ').map(s => { const i = s.indexOf('='); return [s.slice(0,i), s.slice(i+1)]; }));
      const h = { 'content-type': 'application/json', '__cxy_app_id_': 'cxy-gen2', '__cxy_app_ver_': '7.3.28',
        '__cxy_platform_': '2', '__cxy_brand_': 'creality', '__cxy_os_ver_': 'Linux',
        '__cxy_os_lang_': ck['model_lang'] || '1', '__cxy_timezone_': '0',
        '__cxy_token_': ck['model_token'] || '', '__cxy_uid_': ck['model_user_id'] || '',
        '__cxy_duid_': ck['model_device_id'] || '', '__cxy_requestid_': crypto.randomUUID() };
      const ids = ${JSON.stringify([...(model.fileIds || []), ...((model.docs || []).map((d) => d.id))])};
      const r = await fetch('/api/cxy/v3/model/memberDownload', { method: 'POST', headers: h,
        body: JSON.stringify({ modelId: ${JSON.stringify(model.id)}, fileIds: ids }) });
      const j = await r.json();
      return { code: j.code, msg: j.msg, urls: (j.result && j.result.downloadUrls) || [] };
    })()`;
    const { value: res } = await evalInPage(model.sourceUrl, js);
    if (res.code !== 0) throw new Error(`memberDownload 拒绝（${res.code} ${res.msg}）：先在浏览器登录创想云`);
    return res.urls.map((u) => {
      const doc = (model.docs || []).find((d) => d.id === u.fileId);
      if (doc) return { name: doc.name, url: u.url, size: u.size, kind: 'doc' };
      const meta = model.files.find((f) => f.id === u.fileId);
      return { name: `${u.fileName}.${meta?.format || 'stl'}`, url: u.url, size: u.size, kind: 'model' };
    });
  },
};

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
            ratingCount: i.ratingCount, ratingTotal: i.ratingScoreTotal,
            projectSettings: mi.projectSettings || {}, plates: platesOf(mi),
            filaments: filamentsOf(i.instanceFilaments),
            machines: [...compat, ...(mi.otherCompatibility || [])].map(m => ({ name: m.devProductName, code: m.devModelName, nozzle: m.nozzleDiameter })),
          };
        }),
        rawFiles: ((j.designExtension && j.designExtension.model_files) || []).map(f => ({ name: f.modelName, size: f.modelSize, type: f.modelType })),
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
        url: `https://makerworld.com.cn/zh/models/${id}#profileId-${i.id}`,
      })),
      files: d.rawFiles,
      fileIds: d.instances.map((i) => i.id),
      via,
    };
  },
  // 打印配置 3mf；如果站点对某个机型给了单独文件，一并收下（按名字+大小去重）
  async fileLinks(model) {
    const machines = (model.print?.machines || []).filter((m) => ['A1', 'H2C'].includes(m.name));
    const js = `(async () => {
      const out = [];
      const grab = async (id, q) => {
        const r = await fetch('/api/v1/design-service/instance/' + id + '/f3mf' + q, { headers: { accept: 'application/json' } });
        if (!r.ok) return null;
        const j = await r.json();
        return j && j.url ? { name: j.name, url: j.url, size: j.size } : null;
      };
      for (const id of ${JSON.stringify(model.fileIds)}) out.push(await grab(id, ''));
      for (const [id, code, name] of ${JSON.stringify(machines.map((m) => [model.fileIds[0], m.code, m.name]))}) {
        out.push(Object.assign(await grab(id, '?machine=' + code) || {}, { machine: name }));
      }
      return out.filter(Boolean);
    })()`;
    const { value: res } = await evalInPage(model.sourceUrl, js, { wait: 6000 });
    const seen = new Set();
    const links = [];
    for (const r of res) {
      const key = `${r.name}|${r.size}`;
      if (seen.has(key)) continue; // 站点忽略 machine 参数时会把通用件再给一遍，这里去掉
      seen.add(key);
      const suffix = r.machine ? `-${r.machine}` : '';
      links.push({ name: `${r.name || 'model'}${suffix}`, url: r.url, size: r.size, kind: r.machine ? 'machine' : 'profile' });
    }
    return links;
  },
};

// Snapmaker Space：页面 SSR（带 slug 的地址）里就有完整打印配置，模型文件私链 CDN 直下
function objectAround(text, key) {
  const i = text.indexOf(key);
  if (i < 0) return null;
  let start = -1;
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    const c = text[k];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        start = k;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  let d = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d === 0) {
        end = k;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const snapmaker = {
  async meta(id, pageUrl) {
    // 带 slug 的地址才有完整 SSR（/model/1695-model 与 /model/1695 内容不一样）
    const canonical = pageUrl.split('#')[0].split('?')[0];
    const { text: html } = await httpGet(canonical);
    const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
      .map((m) => JSON.parse(m[1]))
      .join('');
    const profile = objectAround(flight, '"partitions"');
    const api = await (
      await fetch(`https://api-models.snapmaker.cn/api/model/detail/${id}`, {
        headers: { accept: 'application/json', origin: 'https://space.snapmaker.cn', referer: 'https://space.snapmaker.cn/' },
      })
    ).json();
    const d = api.data || {};
    const abs = (u) => (!u ? '' : /^https?:/.test(u) ? u : `https://cdn-model-private.snapmaker.cn/${u.replace(/^\/+/, '')}`);
    const fileUrl = abs(profile?.fileUrl || d.fileUrl);
    const fileName = profile?.fileName || d.fileName || (fileUrl.split('/').pop() || 'model.3mf');
    return {
      platform: 'snapmaker',
      id,
      sourceUrl: canonical,
      title: (d.translatedLang === 'zh' && d.translatedTitle) || d.title || fileName,
      author: d.creatorName || '',
      authorAvatar: d.creatorAvatar || '',
      description: sanitize((d.translatedLang === 'zh' && d.translatedDescription) || d.description),
      images: [d.coverUrl, ...(d.images || [])].filter(Boolean),
      stats: { downloads: d.downloadCount },
      picked: Boolean(d.isRecommended || d.isPicked || d.isFeatured),
      category: d.categoryNameKey || '',
      tags: (d.tags || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean),
      publishedAt: d.createdAt || d.createTime || null,
      translated: d.translatedLang === 'zh' && Boolean(d.translatedTitle) && d.translatedTitle !== d.title,
      print: profile
        ? {
            profileTitle: profile.translatedTitle || profile.name,
            thumb: (profile.pictures || [])[0],
            timeSec: profile.secs,
            timeText: profile.time || fmtHours(profile.secs),
            weightG: profile.weight,
            plates: profile.plates,
            nozzle: profile.printerType,
            filaments: (profile.filaments || []).map((f) => ({ type: f.type, color: f.color, usedG: f.used_g })),
            plateList: (profile.partitions || []).map((p) => ({
              name: p.name,
              timeSec: p.secs,
              weightG: p.weight,
              thumb: (p.pics || [])[0],
              filaments: (p.filaments || []).map((f) => ({ type: f.type, color: f.color, usedG: f.used_g })),
            })),
            machines: [],
            source: 'ssr',
          }
        : null,
      profiles: profile
        ? [{
            id: 'ssr',
            name: profile.translatedTitle || profile.name || '默认打印配置',
            machine: '',
            machines: [],
            plates: profile.plates || 0,
            plateList: (profile.partitions || []).map((pt) => ({
              name: pt.name,
              timeSec: pt.secs,
              weightG: pt.weight,
              thumb: (pt.pics || [])[0],
              filaments: (pt.filaments || []).map((x) => ({ type: x.type, color: x.color, usedG: x.used_g })),
            })),
            timeSec: profile.secs,
            timeText: profile.time || fmtHours(profile.secs),
            weightG: Math.round((profile.weight || 0) * 10) / 10,
            nozzle: profile.printerType || '',
            layerHeight: '', wallLoops: '', infill: '', bed: '',
            size: 0,
            filaments: (profile.filaments || []).map((x) => ({ type: x.type, color: x.color, usedG: x.used_g })),
            thumbnail: (profile.pictures || [])[0] || '',
            isDefault: true,
            url: canonical,
          }]
        : [],
      files: fileUrl ? [{ name: fileName, format: (fileName.match(/\.(\w+)$/) || [])[1] || '3mf', size: d.fileSize, url: fileUrl }] : [],
      fileIds: fileUrl ? [fileUrl] : [],
    };
  },
  async fileLinks(model) {
    if (model.files.length) return model.files.map((f) => ({ name: f.name, url: f.url, size: f.size, kind: 'model' }));

    // 没有公开直链的（约 17%）：文件在「打印配置」里，只有登录态能取
    // 站点自己的做法是 GET /api/model/download/<id>，带 Authorization: Bearer <login_access_token>
    const js = `(async () => {
      const ck = Object.fromEntries(document.cookie.split('; ').map(s => { const i = s.indexOf('='); return [s.slice(0,i), s.slice(i+1)]; }));
      const tok = ck['login_access_token'] || '';
      if (!tok) return { code: 401, msg: 'no login_access_token' };
      const r = await fetch('https://api-models.snapmaker.cn/api/model/download/${model.id}', {
        headers: { accept: 'application/json', Authorization: 'Bearer ' + tok }, credentials: 'include',
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { code: j && j.code, msg: j && j.msg, data: (j && j.data) || null };
    })()`;
    const { value } = await evalInPage(model.sourceUrl, js, { wait: 5000 });
    const d = value.data || {};
    const links = [
      ...(d.modelFiles || []).map((f) => ({ name: f.fileName || f.name || 'model', url: f.downloadUrl || f.url || '', size: f.fileSize || f.size })),
      ...(d.printProfiles || []).map((p) => ({ name: p.fileName || 'profile.3mf', url: p.downloadUrl || '', size: p.fileSize || p.size, kind: 'profile' })),
    ]
      .filter((x) => x.url)
      .map((x) => ({ ...x, kind: x.kind || 'model' }));
    if (!links.length) {
      throw new Error(`站点没有公开文件直链，打印配置要登录才能取（${value.msg || value.code}）：先在浏览器登录 Snapmaker`);
    }
    return links;
  },
};


// MakerOnline（纵维立方）：Nuxt 2，页面里 window.__NUXT__ 是 IIFE 打包的数据，直接在 vm 里求值
const makeronline = {
  async meta(id, pageUrl) {
    const canonical = pageUrl.split('#')[0];
    const { text: html } = await httpGet(canonical);
    const i = html.indexOf('window.__NUXT__=');
    if (i < 0) throw new Error('页面里没有 __NUXT__（站点结构变了？）');
    const j = html.indexOf('</script>', i);
    const expr = html.slice(i + 'window.__NUXT__='.length, j).trim().replace(/;+$/, '');
    const nuxt = vm.runInContext(`(${expr})`, vm.createContext({}), { timeout: 3000 });
    const m = nuxt?.data?.[0]?.modelDetailData;
    if (!m) throw new Error('__NUXT__ 里没有 modelDetailData');

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

    const site = /makeronline\.cn/i.test(canonical) ? 'cn' : 'com';
    const rawFiles = (m.files || []).map((f) => ({
      name: f.file_name || 'model',
      size: f.file_size,
      format: (String(f.file_name || '').match(/\.(\w+)$/) || [, ''])[1].toLowerCase(),
      private: true,
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
            url: canonical,
          }]
        : [],
      files: profile.id
        ? [{ name: downloadName, format: (downloadName.match(/\.(\w+)$/) || [])[1] || '3mf', size: profile.total_size }]
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
      if (!btn) return { error: '页面上找不到下载按钮' };
      btn.click();
      await sleep(1600);
      const all = [...document.querySelectorAll('.el-dialog button')].find((b) => /下载全部|Download all/i.test(b.innerText || ''));
      if (all) { all.click(); await sleep(6000); }
      HTMLAnchorElement.prototype.click = oc; window.open = ow;
      const login = [...document.querySelectorAll('.el-dialog')].some((d) => /登录|Log in|Sign in/i.test(d.innerText || '') && d.offsetParent !== null);
      return { urls: [...new Set(got)].filter((u) => /^https?:/.test(u)), loginRequired: login && got.length === 0, clicked: Boolean(all) };
    })()`;
    const { value: res } = await evalInPage(model.sourceUrl, js, { wait: 6000 });
    if (res.error) throw new Error(res.error);
    if (!res.urls.length) {
      throw new Error(res.loginRequired ? '下载需要登录：先在浏览器登录 makeronline' : '没截到下载链接（站点可能改了下载流程）');
    }
    return res.urls.map((u, i) => {
      // 签名链接的 response-content-disposition 里带着原始文件名
      const m = /filename=(?:UTF-8'')?([^&;]+)/i.exec(decodeURIComponent(u));
      const name = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : `${(model.files[0]?.name || 'model').replace(/\.\w+$/, '')}${i ? '-' + (i + 1) : ''}.3mf`;
      return { name, url: u, size: model.files[0]?.size, kind: 'profile' };
    });
  },
};

const ADAPTERS = { creality, makerworld, snapmaker, makeronline };

// ── 主流程 ──────────────────────────────────────────────────────
const hit = matchPlatform(url);
if (!hit) {
  console.error('暂不支持的站点。目前支持：\n  space.snapmaker.cn / crealitycloud.cn / makerworld.com.cn');
  process.exit(2);
}

const { name: platform, id } = hit;
const adapter = ADAPTERS[platform];
const model = await adapter.meta(id, url);
model.fetchedAt = new Date().toISOString();

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

// 文件落地
const saved = [];
if (wantFiles) {
  try {
    const links = await adapter.fileLinks(model);
    for (const [i, f] of links.entries()) {
      const ext = (f.name.match(/\.(\w+)$/) || [, 'bin'])[1];
      const name = `${String(i + 1).padStart(2, '0')}-${slugify(f.name.replace(/\.\w+$/, ''))}.${ext}`;
      const bytes = await download(f.url, path.join(filesDir, name));
      saved.push({ name: f.name, path: `files/${name}`, bytes, kind: f.kind || 'model' });
      console.log(`  ✓ ${f.name} (${(bytes / 1048576).toFixed(1)} MB)`);
    }
  } catch (e) {
    console.warn(`  文件下载失败：${e.message}`);
  }
}

// --no-files 重跑时不要把上一轮已下好的文件记录抹掉
if (!saved.length) {
  try {
    const prev = JSON.parse(await readFile(path.join(dir, 'model.json'), 'utf8'));
    model.savedFiles = (prev.savedFiles || []).filter((f) => existsSync(path.join(dir, f.path)));
  } catch {}
}
if (saved.length) model.savedFiles = saved;
model.savedFiles ||= [];
if (!model.savedFiles.length && !(model.files || []).length) {
  console.warn('  站点没有给文件直链（这类模型可能只能在站点里下）');
}

model.dir = path.basename(dir);
model.autoTags = autoTags(platform, { downloads: model.stats?.downloads, picked: model.picked });
await writeFile(path.join(dir, 'model.json'), JSON.stringify(model, null, 2));

console.log(`\n${platform} · ${model.title}`);
console.log(`  目录  ${path.relative(ROOT, dir)}`);
console.log(`  文件  ${model.savedFiles.length} 个（本次新下 ${saved.length}）· 图片 ${localImages.length} 张`);
if (model.print) console.log(`  打印  ${model.print.timeText} · ${model.print.weightG} g · ${model.print.plates} 盘 · ${model.print.filaments.length} 种耗材`);
if (model.autoTags?.length) console.log(`  标签  ${model.autoTags.join(' / ')}`);
if (!browserConnected()) console.log('  ⚠ 浏览器扩展没连上，走的是无头兜底：需要登录的站点下不了文件');

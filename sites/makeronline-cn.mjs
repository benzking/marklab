// MakerOnline 国内站（makeronline.cn）站点包。
//
// 与 `makeronline-com.mjs` **各自独立实现**：两个域的字段、登录态、接口都不完全一样，
// 抽公共层省下的那点代码抵不过「改一处弄坏另一处」（spec §2 的显式决定）。
//
// 取数方式：Nuxt 2，数据在页面 `window.__NUXT__` 的 IIFE 里。**绝不在服务端求值**——
// vm 不是安全边界（实测能拿到宿主 process）。改成浏览器页内读出模型那一段，只把 JSON 传回来。
//
// 下载走站点给 App 的那条通道（见 fileLinks）：不开浏览器，纯 node。
import * as ch from '../channel.mjs';
import { sanitize, fmtHours, str, num, iso } from '../lib.mjs';

const HOSTS = ['makeronline.cn'];
const SITE = 'https://www.makeronline.cn';
// 数据命名空间：两个域共用 `makeronline`（库目录、判重键都用它），域只在 site 字段里区分
const PLATFORM = 'makeronline';

export function match(raw) {
  let u;
  try {
    u = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    return null;
  }
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!HOSTS.includes(host)) return null;
  const id = /^(?:\/[a-z]{2})?\/model\/.*?(\d+)\.html/i.exec(u.pathname)?.[1];
  if (!id) return null;
  return { site: 'makeronline.cn', id, url: `${SITE}${u.pathname}` };
}

/** 只认 .cn 自己的 cookie：`.com` 的 mo_access_token 是另一套账号（spec §7）。 */
export async function loginState() {
  const all = await ch.cookies();
  if (!all) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  const mine = all.filter((c) => c.domain === 'makeronline.cn' || c.domain === '.makeronline.cn');
  const token = mine.find((c) => c.name === 'mo_access_token')?.value;
  if (!token) return { ok: false, status: 'logged-out' };
  const r = await ch.fetchAs('makeronline.cn', `${SITE}/api/user/personal/info`, {
    headers: { authorization: token }, // 裸 token，不带 Bearer
  });
  if (!r) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  const j = await r.json().catch(() => null);
  const u = j?.data || j?.result;
  return r.ok && u?.user_name ? { ok: true, status: 'logged-in', name: u.user_display_name || u.user_name } : { ok: false, status: 'logged-out' };
}

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

export async function meta(url) {
  const hit = match(url);
  if (!hit) throw new Error('不是 MakerOnline.cn 模型网址');
  const canonical = hit.url;
  const { value } = await ch.evalInPage(canonical, () => {
    const m = window.__NUXT__?.data?.[0]?.modelDetailData;
    return m ? JSON.stringify(m) : null;
  });
  if (!value) throw new Error('__NUXT__ 里没有 modelDetailData（站点结构变了，或没登录）');
  const m = JSON.parse(value);

  const profile = (m.print_profiles || [])[0] || {};
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
  // is_author 就是页面上那个「Designer」徽标：别人传的配置不算作者件，判重时不比
  const profileByAuthor = profile.is_author !== false;
  const fileOrigin = profileByAuthor ? 'author' : 'other';

  const rawFiles = (m.files || []).map((f) => ({
    name: f.file_name || 'model',
    size: f.file_size,
    format: (String(f.file_name || '').match(/\.(\w+)$/) || [, ''])[1].toLowerCase(),
    private: true,
    origin: 'author',
  }));

  return {
    platform: PLATFORM,
    site: 'cn',
    id: hit.id,
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
      ? [
          {
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
            layerHeight: '',
            wallLoops: '',
            infill: '',
            bed: '',
            size: profile.total_size || 0,
            filaments: (profile.materials_label || []).map((x) => ({ type: x.material_type, color: rgb(x.paint_color), usedG: x.filament_used_g })),
            thumbnail: profile.main_thumb_image || '',
            isDefault: true,
            isAuthor: profileByAuthor,
            creatorUid: profile.user_id ?? null,
            url: canonical,
          },
        ]
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
}

// 下载走 App 通道：带 `Platform: ios` 时站点把请求当成 App 的，直接回私有桶签名 URL。
// web 通道每次都回 1003 showCaptcha（易盾），靠点按钮也绕不过——按钮背后就是这个接口。
// 值必须精确是 `ios`：android / web / `iOS` 大写都被拒（回 code 1 "The system is busy."）。
const APP = { Platform: 'ios' };

async function api(pathname, { method = 'GET', body } = {}) {
  const cookie = await ch.cookieHeader('makeronline.cn');
  if (cookie == null) throw new Error('浏览器没连上：先开着 Chromium（9223 端口）再抓');
  const token = /(?:^|;\s*)mo_access_token=([^;]+)/.exec(cookie)?.[1];
  if (!token) throw new Error('下载需要登录：先在浏览器登录 makeronline');
  const r = await fetch(`${SITE}/${pathname}`, {
    method,
    headers: { cookie, authorization: token, accept: 'application/json', 'content-type': 'application/json', ...APP },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`MakerOnline ${pathname} 返回非 JSON（HTTP ${r.status}）：登录失效或被风控`);
  return j;
}

/** 该下哪些文件（纯函数，好断言）：3mf 打印配置 + STL 模型件 + 文档，各走各的 file_type。 */
export function downloadJobs(detail, id) {
  return [
    ...(detail?.print_profiles || []).flatMap((p) =>
      (p.files || []).map((f) => ({
        name: f.file_name || `${p.title || 'profile'}.3mf`,
        kind: 'profile',
        origin: p.is_author ? 'author' : 'other',
        body: { key: f.key, file_type: 2, is_batch_down: 0, print_profile_id: p.id },
      })),
    ),
    ...(detail?.files || []).map((f) => ({
      name: f.file_name || `${id}.stl`,
      kind: 'model',
      origin: 'author',
      body: { key: f.key, file_type: 1, is_batch_down: 0, mold_id: Number(id) },
    })),
    ...(detail?.docs || []).map((f) => ({
      name: f.file_name || `${id}.pdf`,
      kind: 'doc',
      origin: 'author',
      body: { key: f.key, file_type: 3, is_batch_down: 0, mold_id: Number(id), print_profile_id: 0 },
    })),
  ];
}

/** 一个文件一次 POST，回签名 URL（只签了 GET，HEAD 会 403）。批量接口要建打包任务，不走。 */
export async function fileLinks(model) {
  const detail = (await api(`api/mold/detail?id=${model.id}`)).data;
  const jobs = downloadJobs(detail, model.id);
  if (!jobs.length) throw new Error('站点没给文件直链（这类模型只能在站点里下）');
  const out = [];
  const bad = [];
  const seen = new Set(); // 多个打印配置常指向同一个 3mf：按对象路径去重，别下三遍
  for (const j of jobs) {
    const r = await api('api/file/download', { method: 'POST', body: j.body });
    if (r.code !== 0 || typeof r.data !== 'string') {
      bad.push(`${j.name}：${r.message || `code ${r.code}`}`);
      continue;
    }
    const objectPath = r.data.split('?')[0];
    if (seen.has(objectPath)) continue;
    seen.add(objectPath);
    out.push({ name: j.name, url: r.data, kind: j.kind, origin: j.origin });
  }
  if (bad.length) console.warn(`  文件直链没拿到 ${bad.length} 个：${bad[0]}`);
  if (!out.length) throw new Error(`站点没给文件直链（${bad[0]}）`);
  return out;
}

export function normalize(raw) {
  const id = raw?.mold_id == null ? '' : String(raw.mold_id);
  return {
    site: PLATFORM,
    id,
    title: str(raw?.title) || '',
    url: str(raw?.target_url) || '',
    cover: str(raw?.mold_image),
    author: str(raw?.user_display_name) || str(raw?.user_name),
    likes: num(raw?.like_num),
    downloads: num(raw?.download_num),
    collects: null, // 搜索接口没有收藏数
    comments: null, // 也没有评论数
    picked: Boolean(raw?.is_winner),
    publishedAt: iso(raw?.created_time),
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
  };
}

// 浏览器 UI 实测（2026-10-31）：相关性='' · 最多下载=download_num_desc · 最新上传=submit_at_desc · 最多点赞=like_num_desc。
// 但一传 order 就丢关键词精度（「皮卡丘」+ 下载序只有 1/20 条标题命中，相关性 20/20），
// 所以有关键字时只走相关性序，下载序交给调用方本地重排（subs.mjs 的 sortItems）。
const ORDER = { downloads: 'download_num_desc', likes: 'like_num_desc', newest: 'submit_at_desc' };

export async function search({ keyword, page = 1, pageSize = 20, sort } = {}) {
  const r = await fetch(`${SITE}/api/search/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword, category_id: '', page, page_size: pageSize, print_type: 0, pure_search: 0, order: keyword ? '' : ORDER[sort] || '' }),
  });
  if (!r.ok) throw new Error(`MakerOnline HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.data?.data;
  if (!Array.isArray(list)) throw new Error('MakerOnline 返回里没有 data.data');
  return { total: num(j.data.page?.total), items: list.map(normalize) };
}

export async function userModels({ uid, page = 1, pageSize = 20 } = {}) {
  const q = new URLSearchParams({ page: String(page), page_size: String(pageSize), user_id: uid });
  const r = await fetch(`${SITE}/api/user/personal/index?${q}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`MakerOnline HTTP ${r.status}`);
  const j = await r.json();
  const list = j?.data?.data;
  if (!Array.isArray(list)) throw new Error('MakerOnline 用户页返回里没有 data.data');
  return {
    total: num(j.data.page?.total),
    // 用户页列表没有 target_url，按详情页规律拼；标题要编码
    items: list.map((raw) =>
      normalize({
        ...raw,
        mold_image: raw.main_image || raw.main_thumb_image,
        target_url: `${SITE}/zh/model/${encodeURIComponent(raw.title || '')}/${raw.mold_id}.html`,
      }),
    ),
  };
}

/** 用户主页网址 → {site, id}。MakerOnline 的用户标识是 uuid。 */
export function matchUser(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!HOSTS.includes(u.hostname.toLowerCase().replace(/^www\./, ''))) return null;
  const id = /\/user\/personalInfo\/([0-9a-f-]{36})/i.exec(u.pathname)?.[1];
  return id ? { site: 'makeronline.cn', id } : null;
}

export default {
  site: 'makeronline.cn',
  platform: PLATFORM,
  aliases: ['makeronline'], // 订阅/搜索沿用历史上的 `makeronline` 键，落到国内站
  label: 'MakerOnline.cn',
  hosts: HOSTS,
  discover: true,
  searchKey: 'makeronline',
  match,
  matchUser,
  loginState,
  meta,
  fileLinks,
  search,
  userModels,
};

// 自检：纯函数，不联网、不起浏览器
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'makeronline-cn.mjs') {
  const id = '207581';
  console.assert(match(`https://www.makeronline.cn/zh/model/gu-dai-hun-dun-zhi-ku/${id}.html`)?.id === id, '标准模型页');
  console.assert(match(`https://makeronline.cn/model/x/${id}.html`)?.url === `https://www.makeronline.cn/model/x/${id}.html`, '无 zh 前缀也认');
  console.assert(match(`https://www.makeronline.com/zh/model/x/${id}.html`) === null, '.com 不归这个包');
  console.assert(match(`https://www.makeronline.cn/zh/allModel/all/all/0.html`) === null, '列表页不是模型页');

  const n = normalize({ mold_id: 1, title: 'O', target_url: 'https://www.makeronline.cn/model/O/1.html' });
  console.assert(n.site === 'makeronline' && n.id === '1', '站点名与 id');
  console.assert(n.collects === null && n.comments === null, '无收藏/评论');
  console.assert(n.publishedAt === null && n.tags.length === 0, '缺字段默认');

  // 下载清单的请求形状：file_type 1=STL、2=3mf、3=文档，各带各的 id
  const jobs = downloadJobs(
    {
      print_profiles: [{ id: 9, is_author: 1, files: [{ key: 'k2', file_name: 'a.3mf' }] }],
      files: [{ key: 'k1', file_name: 'b.stl' }],
      docs: [{ key: 'k3', file_name: 'c.pdf' }],
    },
    '42',
  );
  console.assert(jobs.length === 3, '三类文件都进清单');
  console.assert(jobs[0].body.file_type === 2 && jobs[0].body.print_profile_id === 9 && jobs[0].origin === 'author', '3mf 用 print_profile_id');
  console.assert(jobs[1].body.file_type === 1 && jobs[1].body.mold_id === 42, 'STL 用 mold_id');
  console.assert(jobs[2].body.file_type === 3 && jobs[2].kind === 'doc', '文档走 file_type 3');

  console.log('makeronline.cn pack demo ok');
}

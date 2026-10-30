// MakerOnline 海外站（makeronline.com）站点包。
//
// 与国内站 makeronline.cn 是**两套独立系统**：两边的账号、cookie、下载态互不相通。
// 所以这里是独立实现，不 import 国内站的包——共用一个包的结果就是 `.cn` 的探测带上 `.com`
// 的 token（2026-10-30 修掉的那个 bug）。
//
// 取数方式与国内站同源（Nuxt 2 + `__NUXT__`），但域名、cookie 名、接口都按本域自己取。
//
// 对外形状见 docs/spec.md §2。
import * as ch from '../channel.mjs';
import { sanitize, fmtHours, safeDecode, str, num, iso } from '../lib.mjs';

const HOSTS = ['makeronline.com'];
const SITE = 'https://www.makeronline.com';
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
  return { name: 'makeronline.com', id, url: `${SITE}${u.pathname}` };
}

/** 只认 `.com` 自己的 cookie：`.cn` 的 mo_access_token 是另一套账号（spec §7）。 */
export async function loginState() {
  const all = await ch.cookies();
  if (!all) return { ok: false, status: 'unknown', reason: '浏览器未连接' };
  const mine = all.filter((c) => c.domain === 'makeronline.com' || c.domain === '.makeronline.com');
  const token = mine.find((c) => c.name === 'mo_access_token')?.value;
  if (!token) return { ok: false, status: 'logged-out' };
  const r = await ch.fetchAs('makeronline.com', `${SITE}/api/user/personal/info`, {
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
    site: 'com',
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

/** 下载靠点页面按钮：`POST /api/file/download` 拿到签名链接后它自己建 <a> 点一下。
 *
 * 站点加了人机验证（易盾）：接口回 `{"code":1003,"message":"showCaptcha"}`，点按钮不会报错、
 * 只是弹验证码，所以必须读接口返回体才知道为什么没链接——否则会被记成「解析没拿到链接」。
 */
export async function fileLinks(model) {
  const js = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // position:fixed 的元素 offsetParent 是 null，不能拿它判可见
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const got = [];
    const xhrs = [];
    const oc = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.href) got.push(this.href); };
    const ow = window.open;
    window.open = function (u) { if (u) got.push(String(u)); return null; };
    // axios 走 XHR 不走 fetch，盯 fetch 是盯不到的
    const OX = XMLHttpRequest.prototype.open;
    const OS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return OX.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('loadend', () => {
        if (/\\/api\\/file\\/download/.test(this.__u || '')) xhrs.push(String(this.responseText || '').slice(0, 300));
      });
      return OS.apply(this, arguments);
    };
    let out;
    try {
      const findBtn = () => [...document.querySelectorAll('.print-download-button button, button')].find((b) => /^(下载|Download)$/i.test((b.innerText || '').trim()) && vis(b));
      let btn = findBtn();
      for (let i = 0; i < 20 && !btn; i++) { await sleep(250); btn = findBtn(); }
      if (!btn) return { error: '页面上找不到下载按钮' };
      // 服务端渲染的按钮先出现、Vue 后挂事件：连点几次直到它真的有反应
      for (let i = 0; i < 8 && !xhrs.length && !got.length; i++) { btn.click(); await sleep(1500); }
      if (!xhrs.length && !got.length) return { error: '点了下载但站点没有任何反应（可能要登录，或改了下载流程）' };
      if (xhrs.some((t) => /showCaptcha|captcha/i.test(t))) {
        return { captcha: xhrs.find((t) => /showCaptcha|captcha/i.test(t)).slice(0, 120) };
      }
      const all = [...document.querySelectorAll('button')].find((b) => /下载全部|Download all/i.test(b.innerText || '') && vis(b));
      if (all) { all.click(); await sleep(9000); }
      const needLogin = [...document.querySelectorAll('.el-dialog, .el-drawer')]
        .filter(vis).some((d) => /登录|Log in|Sign in/i.test(d.innerText || ''));
      out = { urls: [...new Set(got)].filter((u) => /^https?:/.test(u)), needLogin, xhrs };
    } finally {
      // 常驻页是共用的，抛错也必须把 monkeypatch 还回去，否则后面所有点击都被劫持
      HTMLAnchorElement.prototype.click = oc;
      window.open = ow;
      XMLHttpRequest.prototype.open = OX;
      XMLHttpRequest.prototype.send = OS;
    }
    return out;
  })()`;
  const { value: res } = await ch.evalInPage(model.sourceUrl, js, { wait: 5000 });
  if (res.error) throw new Error(res.error);
  if (res.captcha) throw new Error(`下载要过人机验证（${res.captcha}）：在浏览器里打开这个模型点一次下载，再补抓`);
  if (!res.urls.length) {
    throw new Error(res.needLogin ? '下载需要登录：先在浏览器登录 makeronline' : '没截到下载链接（站点可能改了下载流程）');
  }
  return res.urls.map((u, i) => {
    // 签名链接的 response-content-disposition 里带着原始文件名
    const m = /filename=(?:UTF-8'')?([^&;]+)/i.exec(safeDecode(u));
    const name = (m && safeDecode(m[1].replace(/\+/g, ' '))) || `${(model.files[0]?.name || 'model').replace(/\.\w+$/, '')}${i ? '-' + (i + 1) : ''}.3mf`;
    return { name, url: u, size: model.files[0]?.size, kind: 'profile', origin: 'author' };
  });
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

export async function search({ keyword, page = 1, pageSize = 20 } = {}) {
  // 搜索接口没有排序参数，sort 只保留在返回里
  const r = await fetch(`${SITE}/api/search/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword, category_id: '', page, page_size: pageSize, print_type: 0, pure_search: 0 }),
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

export default {
  site: 'makeronline.com',
  platform: PLATFORM,
  label: 'MakerOnline.com',
  hosts: HOSTS,
  match,
  loginState,
  meta,
  fileLinks,
  search,
  userModels,
};

// 自检：纯函数，不联网、不起浏览器
if ((process.argv[1] || '').split(/[\\/]/).pop() === 'makeronline-com.mjs') {
  const id = '207581';
  console.assert(match(`https://www.makeronline.com/zh/model/bench-y/${id}.html`)?.id === id, '标准模型页');
  console.assert(match(`https://makeronline.com/model/x/${id}.html`)?.url === `https://www.makeronline.com/model/x/${id}.html`, '无 zh 前缀也认');
  console.assert(match(`https://www.makeronline.cn/zh/model/x/${id}.html`) === null, '.cn 不归这个包');
  console.assert(match(`https://www.makeronline.com/zh/allModel/all/all/0.html`) === null, '列表页不是模型页');

  const n = normalize({ mold_id: 1, title: 'O', target_url: 'https://www.makeronline.com/model/O/1.html' });
  console.assert(n.site === 'makeronline' && n.id === '1', '站点名与 id');
  console.assert(n.collects === null && n.comments === null, '无收藏/评论');
  console.assert(n.publishedAt === null && n.tags.length === 0, '缺字段默认');

  console.log('makeronline.com pack demo ok');
}

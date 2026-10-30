// 模型库前端：一个列表 + 一个详情。列表用 /api/models 的卡片字段，点开详情再拉 /api/model 的完整数据。
// 没有框架、没有构建，改完刷新就见效。

const SITE = {
  creality: { label: '创想云', color: '#2f6bff' },
  makerworld: { label: 'MakerWorld', color: '#00b96b' },
  snapmaker: { label: 'Snapmaker', color: '#1a7cff' },
  makeronline: { label: 'MakerOnline', color: '#ff7d00' },
  'makeronline-cn': { label: 'MakerOnline 国内', color: '#ff7d00' },
};

const ICON = {
  clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.3 1.4" stroke-linecap="round"/></svg>',
  weight: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 6h10l1.4 7H1.6L3 6Z" stroke-linejoin="round"/><circle cx="8" cy="3.6" r="1.6"/></svg>',
  nozzle: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2v6" stroke-linecap="round"/><path d="M5.2 8h5.6l-2.8 6-2.8-6Z" stroke-linejoin="round"/></svg>',
  plate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1.4"/><path d="M2 6.4h12"/></svg>',
  box: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.8 14 5v6l-6 3.2L2 11V5l6-3.2Z" stroke-linejoin="round"/><path d="M2 5l6 3.2L14 5M8 8.2v6" stroke-linejoin="round"/></svg>',
  ruler: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 10.2 10.2 1.8l4 4-8.4 8.4-4-4Z" stroke-linejoin="round"/><path d="M4.6 7.4l1.6 1.6M6.8 5.2l1.6 1.6M9 3l1.6 1.6" stroke-linecap="round"/></svg>',
  download: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2.4v7.2" stroke-linecap="round"/><path d="M4.8 6.8 8 10l3.2-3.2" stroke-linejoin="round" stroke-linecap="round"/><path d="M2.8 12.6h10.4" stroke-linecap="round"/></svg>',
  arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.4 8h9.2M8.8 4.2 12.6 8l-3.8 3.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  grid: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.2" y="2.2" width="5.6" height="5.6" rx="1.4"/><rect x="10.2" y="2.2" width="5.6" height="5.6" rx="1.4"/><rect x="2.2" y="10.2" width="5.6" height="5.6" rx="1.4"/><rect x="10.2" y="10.2" width="5.6" height="5.6" rx="1.4"/></svg>',
  folder: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.4 5.2c0-.8.6-1.4 1.4-1.4h3l1.6 1.8h6.4c.8 0 1.4.6 1.4 1.4v6.4c0 .8-.6 1.4-1.4 1.4H3.8c-.8 0-1.4-.6-1.4-1.4V5.2Z" stroke-linejoin="round"/></svg>',
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 描述入库时已按白名单洗过（lib.mjs sanitize），这里再兜一层：库里的旧数据是旧黑名单洗的，
// 不能只信入库结果。用 DOMParser 走一遍白名单，不认识的标签拆掉只留文字。
const SAFE_TAGS = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'INS',
  'SUB', 'SUP', 'SMALL', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'A', 'IMG', 'FIGURE', 'FIGCAPTION',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
]);
const SAFE_ATTRS = { A: ['href'], IMG: ['src', 'alt', 'width', 'height'] };
const SAFE_URL = /^(https?:|mailto:|\/|#|data:image\/)/i;

function safeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const clean = (node) => {
    let child = node.firstChild;
    while (child) {
      const next = child.nextSibling;
      if (child.nodeType === 1) {
        const tag = child.tagName;
        if (!SAFE_TAGS.has(tag)) {
          const frag = document.createDocumentFragment();
          while (child.firstChild) frag.appendChild(child.firstChild);
          child.replaceWith(frag);
          clean(node); // 拆出来的孩子也要过一遍
          return;
        }
        const allowed = SAFE_ATTRS[tag] || [];
        for (const attr of [...child.attributes]) {
          const name = attr.name.toLowerCase();
          const keep = name === 'title' || allowed.includes(name);
          if (!keep || ((name === 'href' || name === 'src') && !SAFE_URL.test(attr.value.trim()))) {
            child.removeAttribute(attr.name);
          }
        }
        if (tag === 'A') {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        clean(child);
      } else if (child.nodeType !== 3) {
        child.remove(); // 注释、CDATA 之类
      }
      child = next;
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

const fmtG = (g) => (g == null || g === '' ? '' : `${Math.round(Number(g) * 10) / 10} g`);
const fmtH = (sec) => {
  if (!sec) return '';
  const h = sec / 3600;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(sec / 60)} 分钟`;
};
const fmtSize = (b) => {
  if (!b) return '';
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`;
  if (b >= 1 << 10) return `${Math.round(b / (1 << 10))} KB`;
  return `${b} B`;
};
const fmtN = (n) => {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
};
// 作者头像只存了外链，站外图片经常挂；用名字首字 + 稳定色相代替
const avaHue = (s) => [...String(s || '?')].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7);
function readableText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#3c414d';
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return lum > 0.45 ? '#2a2e37' : '#fff';
}

let models = [];
let cats = [];
const filters = { q: '', site: '', tag: '', format: '', sort: 'new', cat: '', sub: '' };
const FILTER_KEYS = ['q', 'site', 'cat', 'sub', 'tag', 'format', 'sort'];

// 筛选条件写进 hash：刷新不丢、后退能回到上一组条件
function filtersToHash() {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (filters[k] && !(k === 'sort' && filters[k] === 'new')) p.set(k, filters[k]);
  const q = p.toString();
  return q ? `#${q}` : '';
}

function filtersFromHash(h) {
  const p = new URLSearchParams(String(h || '').replace(/^#/, ''));
  for (const k of FILTER_KEYS) filters[k] = p.get(k) || '';
  if (!filters.sort) filters.sort = 'new';
}

function syncHash() {
  const h = filtersToHash();
  if (location.hash !== h) location.hash = h; // 进历史，后退能回上一组
}

// 表单控件跟着 hash 走（刷新/后退时把输入框也还原）
function syncControls() {
  const q = $('#q');
  if (q && q.value !== filters.q) q.value = filters.q;
  const f = $('#format');
  if (f) f.value = filters.format;
  const s = $('#sort');
  if (s) s.value = filters.sort;
}

// ── 数据 ───────────────────────────────────────────────────────
async function load() {
  const [r, c] = await Promise.all([fetch('/api/models'), fetch('/api/categories')]);
  models = await r.json();
  cats = (await c.json()).level1 || [];
  renderChips();
  renderSide();
  renderHero();
  render();
}

// 分类对照在服务端按原站分类名算好，model.cat = {l1, l2}（未匹配为 null）
const inCat = (m, l1, l2) => (l1 === '_' ? !m.cat : !!m.cat && m.cat.l1 === l1 && (!l2 || m.cat.l2 === l2));

function renderSide() {
  const n = (l1, l2) => models.filter((m) => inCat(m, l1, l2)).length;
  const html = [`<button type="button" class="item${filters.cat ? '' : ' on'}" data-l1="">${ICON.grid}<span>全部模型</span><em>${models.length}</em></button>`];
  for (const l1 of cats) {
    const total = n(l1.id);
    if (!total) continue;
    html.push(
      `<button type="button" class="item${filters.cat === l1.id ? ' on' : ''}" data-l1="${esc(l1.id)}">${ICON.folder}<span>${esc(l1.name)}</span><em>${total}</em></button>`,
    );
    if (filters.cat !== l1.id) continue;
    const subs = l1.children.filter((c) => n(l1.id, c.id));
    if (!subs.length) continue;
    html.push(
      `<div class="subs"><span class="sub${filters.sub ? '' : ' on'}" data-l2="">全部</span>${subs
        .map((c) => `<button type="button" class="sub${filters.sub === c.id ? ' on' : ''}" data-l2="${esc(c.id)}">${esc(c.name)}<em>${n(l1.id, c.id)}</em></button>`)
        .join('')}</div>`,
    );
  }
  if (models.some((m) => !m.cat)) html.push(`<button type="button" class="item${filters.cat === '_' ? ' on' : ''}" data-l1="_">${ICON.folder}<span>未分类</span><em>${n('_')}</em></button>`);
  html.push(
    `<div class="side-foot"><b>数据来源</b><span>创想云 · MakerWorld<br>Snapmaker · MakerOnline</span><span>${models.length} 个模型，文件存在本地</span></div>`,
  );
  $('#side').innerHTML = html.join('');
}

function onSideClick(e) {
  const sub = e.target.closest('[data-l2]');
  if (sub) {
    filters.sub = sub.dataset.l2;
    renderSide();
    render();
    syncHash();
    return;
  }
  const l1 = e.target.closest('[data-l1]');
  if (!l1) return;
  const id = l1.dataset.l1;
  filters.cat = filters.cat === id ? '' : id;
  filters.sub = '';
  renderSide();
  render();
  syncHash();
}

function siteOf(m) {
  if (m.platform === 'makeronline' && m.site === 'cn') return SITE['makeronline-cn'];
  return SITE[m.platform] || { label: m.platform, color: '#666' };
}
function allTags() {
  const set = new Map();
  for (const m of models) {
    for (const t of [...(m.autoTags || []), ...(m.tags || [])].filter(Boolean)) {
      set.set(t, (set.get(t) || 0) + 1);
    }
  }
  return [...set.entries()].sort((a, b) => b[1] - a[1]);
}
function formatsOf(m) {
  return new Set((m.savedFiles || []).map((f) => (f.name.match(/\.(\w+)$/) || [, ''])[1].toLowerCase()).filter(Boolean));
}
function matches(m) {
  if (filters.cat && !inCat(m, filters.cat, filters.sub)) return false;
  if (filters.site && m.platform !== filters.site) return false;
  if (filters.tag) {
    const tags = new Set([...(m.autoTags || []), ...(m.tags || []), m.category].filter(Boolean));
    if (!tags.has(filters.tag)) return false;
  }
  if (filters.format && !formatsOf(m).has(filters.format)) return false;
  if (filters.q) {
    const hay = [m.title, m.author, ...(m.tags || []), m.category, ...(m.autoTags || [])].join(' ').toLowerCase();
    if (!hay.includes(filters.q.toLowerCase())) return false;
  }
  return true;
}
function sorted(list) {
  const arr = [...list];
  if (filters.sort === 'title') arr.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
  else if (filters.sort === 'time') arr.sort((a, b) => (b.print?.timeSec || 0) - (a.print?.timeSec || 0));
  else if (filters.sort === 'weight') arr.sort((a, b) => (b.print?.weightG || 0) - (a.print?.weightG || 0));
  else arr.sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)));
  return arr;
}

// ── 列表 ───────────────────────────────────────────────────────
// 一条可横向滚动的胶囊条：站点 + 标签，跟 MakerWorld 首页的分类条一个用法
function renderChips() {
  const sites = [...new Set(models.map((m) => m.platform))];
  const sitePills = [{ k: '', label: '全部站点' }, ...sites.map((s) => ({ k: s, label: siteOf({ platform: s }).label }))]
    .map((x) => `<button class="chip${filters.site === x.k ? ' on' : ''}" data-site="${esc(x.k)}">${esc(x.label)}</button>`)
    .join('');

  const tags = allTags().slice(0, 12);
  const tagPills = [{ k: '', label: '全部标签' }, ...tags.map(([t]) => ({ k: t, label: t }))]
    .map((x) => {
      const cls = x.k === '热门' ? ' hot' : x.k === '精选' ? ' pick' : '';
      return `<button class="chip${cls}${filters.tag === x.k ? ' on' : ''}" data-tag="${esc(x.k)}">${esc(x.label)}</button>`;
    })
    .join('');

  $('#pills').innerHTML = `${sitePills}<i class="sep"></i>${tagPills}`;
}

function card(m) {
  const s = siteOf(m);
  const cover = m.cover || ''; // 列表只带一张封面，详情页再拉全套图
  const fmts = [...formatsOf(m)].map((f) => f.toUpperCase());
  const nFiles = (m.savedFiles || []).length;
  const spec = [
    m.print?.timeText,
    m.print?.weightG ? fmtG(m.print.weightG) : '',
    m.print?.plates ? `${m.print.plates} 盘` : '',
    !m.print && nFiles ? `${nFiles} 个文件` : '',
  ].filter(Boolean).join(' · ');
  const ava = `<span class="ava" style="--a:${avaHue(m.author)}">${esc(String(m.author || '?').slice(0, 1))}</span>`;
  return `<a class="card" href="#m=${encodeURIComponent(m.dir)}" title="${esc(m.title)}">
    <div class="cover">${cover ? `<img src="${cover.startsWith('http') ? esc(cover) : `/library/${esc(m.dir)}/${esc(cover)}`}" alt="${esc(m.title || '')}" loading="lazy">` : ''}
      <span class="site" style="--c:${s.color}"><i></i>${esc(s.label)}</span>
      ${fmts.length ? `<span class="fmt">${esc(fmts.join(' / '))}</span>` : ''}</div>
    <div class="body">
      <div class="title">${esc(m.title)}</div>
      ${spec ? `<div class="spec">${esc(spec)}</div>` : ''}
      <div class="meta">${ava}<span class="aname">${esc(m.author || '未知作者')}</span>
        ${m.stats?.downloads ? `<span class="stat">${ICON.download}${fmtN(m.stats.downloads)}</span>` : ''}
        <span class="go">${ICON.arrow}</span></div>
    </div>
  </a>`;
}

// 首页头图：下载量最高的几个模型轮播 + 四站入口（对应 MakerWorld 的 banner + 探索更多）
let heroTimer = 0;
function renderHero() {
  const pool = models
    .filter((m) => m.cover && (m.cover.startsWith('img/') || m.cover.startsWith('http')))
    .sort((a, b) => (b.stats?.downloads || 0) - (a.stats?.downloads || 0))
    .slice(0, 5);
  if (!pool.length) return;
  const slides = pool
    .map(
      (m, i) => `<a class="slide${i ? '' : ' on'}" href="#m=${encodeURIComponent(m.dir)}">
      <img src="${m.cover.startsWith('http') ? esc(m.cover) : `/library/${esc(m.dir)}/${esc(m.cover)}`}" alt="${esc(m.title || '')}" ${i ? 'loading="lazy"' : ''}>
      <span class="cap"><b>${esc(m.title)}</b><span>${esc(siteOf(m).label)} · ${fmtN(m.stats?.downloads)} 次下载 · ${esc(
        m.author || '未知作者',
      )}</span></span></a>`,
    )
    .join('');
  const tiles = [...new Set(models.map((m) => m.platform))]
    .map((p) => {
      const s = siteOf({ platform: p });
      return `<button class="tile" data-site="${esc(p)}" style="--c:${s.color}"><b>${esc(s.label)}</b><span>${
        models.filter((m) => m.platform === p).length
      } 个模型</span></button>`;
    })
    .join('');
  const el = $('#hero');
  el.hidden = false;
  el.innerHTML = `<div class="banner">${slides}<div class="dots">${pool
      .map((_, i) => `<button type="button" class="${i ? '' : 'on'}" data-i="${i}" aria-label="第 ${i + 1} 张"></button>`)
      .join('')}</div></div>
    <div class="explore"><h3>探索更多</h3><div class="tiles">${tiles}</div></div>`;

  let i = 0;
  const go = (k) => {
    i = (k + pool.length) % pool.length;
    el.querySelectorAll('.slide').forEach((n, j) => n.classList.toggle('on', j === i));
    el.querySelectorAll('.dots i').forEach((n, j) => n.classList.toggle('on', j === i));
  };
  el.querySelector('.dots').addEventListener('click', (e) => {
    const d = e.target.closest('[data-i]');
    if (d) go(Number(d.dataset.i));
  });
  clearInterval(heroTimer);
  heroTimer = setInterval(() => go(i + 1), 5000);
}

function render() {
  const list = sorted(models.filter(matches));
  $('#grid').innerHTML = list.map(card).join('');
  $('#empty').hidden = models.length > 0;
  $('#count').textContent = `${list.length} / ${models.length} 个`;
}

// ── 详情 ───────────────────────────────────────────────────────
function filaments(list) {
  return (list || [])
    .map((f) => {
      const bg = f.color || '#e5e7eb';
      const fg = readableText(bg);
      return `<span class="fchip" style="background:${esc(bg)};color:${fg};border-color:${fg === '#2a2e37' ? '#d8dbe2' : 'transparent'}">${esc(
        f.type,
      )}${f.usedG ? ` ${fmtG(f.usedG)}` : ''}</span>`;
    })
    .join('');
}

function detail(m) {
  const s = siteOf(m);
  const imgs = (m.localImages && m.localImages.length ? m.localImages : m.images || []).map(
    (p) => (p.startsWith('http') ? p : `/library/${m.dir}/${p}`),
  );
  const files = (m.savedFiles || []).length
    ? m.savedFiles
    : (m.files || []).map((f) => ({ name: f.name, bytes: f.size, exists: false }));
  const primary = files.find((f) => f.kind !== 'machine') || files[0];
  const p = m.print;

  return `<a class="back" href="#">← 返回模型库</a>
  <div class="dgrid">
    <div>
      <section class="hero">
        ${imgs[0] ? `<img class="dhero" src="${esc(imgs[0])}" alt="${esc(m.title || '')}">` : ''}
        ${imgs.length > 1 ? `<div class="thumbs">${imgs
          .map((src, i) => `<img src="${esc(src)}" data-src="${esc(src)}" class="${i === 0 ? 'on' : ''}" alt="">`)
          .join('')}</div>` : ''}
      </section>
      <section class="panel"><h2>模型介绍</h2>
        ${m.translated ? '<div class="transnote">内容由站点自动翻译</div>' : ''}
        <div class="detail">${m.description ? safeHtml(m.description) : '<span class="sub">原页面没有介绍正文</span>'}</div>
      </section>
    </div>
    <aside>
      <section class="panel">
        <h1 class="dt">${esc(m.title)}</h1>
        <div class="author"><span class="ava" style="--a:${avaHue(m.author)}">${esc(String(m.author || '?').slice(0, 1))}</span><span>${esc(m.author || '未知作者')}</span></div>
        ${[...(m.autoTags || []), m.category].filter(Boolean).length
          ? `<div class="badges" style="margin-top:12px">${[...(m.autoTags || []), m.category]
              .filter(Boolean)
              .map((t) => `<span class="tag${t === '热门' ? ' hot' : t === '精选' ? ' pick' : ''}">${esc(t)}</span>`)
              .join('')}</div>`
          : ''}
        ${(m.tags || []).length
          ? `<div class="badges" style="margin-top:6px">${m.tags
              .slice(0, 8)
              .map((t) => `<span class="tag">${esc(t)}</span>`)
              .join('')}${m.tags.length > 8 ? `<span class="tag">+${m.tags.length - 8}</span>` : ''}</div>`
          : ''}
        ${(m.llmTags || []).length
          ? `<div class="badges" style="margin-top:6px">${m.llmTags
              .slice(0, 10)
              .map((t) => `<span class="tag ai">${esc(t)}</span>`)
              .join('')}</div>`
          : ''}
      </section>
      ${m.profiles?.length ? profilesCard(m) : ''}
      ${platesPanel(m)}
      ${docsCard(m)}
      ${p && !m.profiles?.length ? `<section class="panel">
        <h2>打印配置</h2>
        ${(p.machines || []).length
          ? `<div class="tabs"><span class="tab on">全部</span>${p.machines
              .map((x) => `<span class="tab${['A1', 'H2C'].includes(x.name) ? ' hot' : ''}">${esc(x.name)}</span>`)
              .join('')}</div>`
          : ''}
        <div class="prow">
          <div class="pthumb">${p.thumb ? `<img src="${esc(p.thumb.startsWith('http') ? p.thumb : `/library/${m.dir}/${p.thumb}`)}" alt="">` : ''}</div>
          <div class="ptitle">${esc(p.profileTitle || '默认打印配置')}</div>
        </div>
        <div class="metrics">
          ${p.timeText || p.timeSec ? `<span>${ICON.clock}${esc(p.timeText || fmtH(p.timeSec))}</span>` : ''}
          ${p.weightG ? `<span>${ICON.weight}${esc(fmtG(p.weightG))}</span>` : ''}
          ${p.nozzle ? `<span>${ICON.nozzle}${esc(p.nozzle)}</span>` : ''}
          ${p.plates ? `<span>${ICON.plate}${p.plates} 盘</span>` : ''}
        </div>
        ${(p.filaments || []).length ? `<div class="fchips">${filaments(p.filaments)}</div>` : ''}
        ${[p.layerHeight ? `层高 ${p.layerHeight} mm` : '', p.wallLoops ? `${p.wallLoops} 层墙` : '', p.infill ? `${p.infill} 填充` : ''].filter(Boolean).length
          ? `<div class="pmeta">${[p.layerHeight ? `层高 ${p.layerHeight} mm` : '', p.wallLoops ? `${p.wallLoops} 层墙` : '', p.infill ? `${p.infill} 填充` : '']
              .filter(Boolean).map(esc).join(' · ')}</div>`
          : ''}
      </section>` : ''}
      <section class="panel">
        <h2>文件 · ${files.length}</h2>
        <div class="filepick">
          ${files
            .map(
              (f, i) => `<button class="fpick${i === 0 ? ' on' : ''}" data-file="${esc(f.path || '')}" data-name="${esc(f.name)}" ${
                f.path && f.exists ? '' : 'data-missing="1"'
              }>
              <span class="fname">${esc(f.name)}</span>
              <span class="fmeta">${esc((f.name.match(/\.(\w+)$/) || [, ''])[1].toUpperCase())} · ${esc(fmtSize(f.bytes))}${
                f.path && f.exists ? '' : ' · 未下载'
              }</span>
            </button>`,
            )
            .join('')}
        </div>
        ${(m.siteOnlyFiles || []).length
          ? `<div class="siteonly">${m.siteOnlyFiles
              .map(
                (f) => `<div class="file"><span>${esc(f.name)}</span><small>${esc(fmtSize(f.size))} · <a href="${esc(
                  f.url || m.sourceUrl,
                )}" target="_blank" rel="noreferrer">去站点下载 ↗</a></small></div>`,
              )
              .join('')}</div>`
          : ''}
        <div id="file-preview" class="fpreview"><span class="sub">选一个文件看内容…</span></div>
        <div class="fdload" id="fdload"></div>
        ${(m.sameModels || []).length
          ? `<div class="same"><h3>同模型链接</h3>${m.sameModels
              .map((s) => {
                const label = `${s.by === 'hash' ? '确认重复' : '疑似重复'}${s.title ? ' · ' + esc(s.title) : ''}`;
                return s.dir
                  ? `<a href="#m=${esc(s.dir)}">${label} · 库里已有</a>`
                  : `<a href="${esc(s.url || m.sourceUrl)}" target="_blank" rel="noreferrer">${label} · 原帖 ↗</a>`;
              })
              .join('')}</div>`
          : ''}
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <a class="btn-ghost" href="${esc(m.sourceUrl)}" target="_blank" rel="noreferrer">原页面 ↗</a>
          <button class="btn-ghost" data-refetch="${esc(m.dir)}">重新抓取</button>
          <button class="btn-ghost danger" data-del="${esc(m.dir)}">从库里删除</button>
        </div>
      </section>
    </aside>
  </div>`;
}

async function showDetail(dir) {
  const m = models.find((x) => x.dir === dir);
  if (!m) {
    location.hash = '';
    return;
  }
  // 列表只拿卡片字段，详情要的 description/plateList/filaments 在这里补一次，补完就不再拉
  if (!m.full) {
    try {
      const r = await fetch(`/api/model?dir=${encodeURIComponent(dir)}`);
      const full = await r.json();
      if (full && !full.error) {
        Object.assign(m, full);
        m.full = true;
      }
    } catch {}
  }
  $('#list-view').hidden = true;
  $('#detail-view').hidden = false;
  $('#detail-view').innerHTML = detail(m);
  window.scrollTo(0, 0);
  wireFilePicker(m);
  wireProfileSwitch(m);
  wireMachineFilter();
  document.querySelectorAll('#detail-view .thumbs img').forEach((t) => {
    t.addEventListener('click', () => {
      const hero = document.querySelector('#detail-view img.dhero');
      if (hero) hero.src = t.dataset.src;
      document.querySelectorAll('#detail-view .thumbs img').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
    });
  });
}

// ── 动作 ───────────────────────────────────────────────────────
function setStatus(text, busy, retryUrl) {
  const el = $('#status');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `${busy ? '<span class="spin"></span>' : ''}<span id="status-text">${esc(text)}</span>${
    retryUrl ? ` <button class="btn-ghost" data-retry="${esc(retryUrl)}">再试一次</button>` : ''
  }`;
}

// 轮询某个任务直到终态（done/duplicate/failed/interrupted/stopped），超时返回 false
async function waitTask(taskId, ms) {
  const until = Date.now() + ms;
  const end = new Set(['done', 'duplicate', 'failed', 'interrupted', 'stopped']);
  while (Date.now() < until) {
    const r = await fetch('/api/console/tasks');
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.tasks || [];
    const t = list.find((x) => x.id === taskId);
    if (t && end.has(t.phase)) return t.phase === 'done' || t.phase === 'duplicate';
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  return false;
}

async function addModel(url) {
  $('#add-btn').disabled = true;
  setStatus('已收到，排队中…（抓取要排限速闸门，可能几分钟，进度看控制台）', true);
  try {
    const r = await fetch('/api/grab', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const j = await r.json();
    // 202 = 已入队；等它跑完再刷列表
    if (r.status === 202) {
      $('#add-url').value = '';
      setStatus('已入队，抓完自动进库（速度受限速闸门限制）', false);
    } else {
      setStatus(`没抓成：${j.error || ''}`.slice(0, 1200), false, url);
    }
  } catch (e) {
    setStatus(`请求失败：${e.message}`, false, url);
  } finally {
    $('#add-btn').disabled = false;
  }
}

async function refetch(dir) {
  const m = models.find((x) => x.dir === dir);
  if (!m) return;
  setStatus('已收到，排队补抓中…', true);
  const r = await fetch('/api/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  const j = await r.json();
  if (r.status !== 202) {
    setStatus(`失败：\n${j.error || ''}`.slice(0, 1200), false);
    return;
  }
  // 轮询任务，done 后刷新详情
  const done = await waitTask(j.taskId, 5 * 60 * 1000);
  setStatus(done ? '已更新' : '还在排队，稍后刷一下', false);
  await load();
  if (location.hash.startsWith('#m=')) showDetail(dir);
}

async function removeModel(dir) {
  if (!confirm('把这个模型（含已下载文件）从库里删掉？')) return;
  await fetch('/api/model', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  location.hash = '';
  await load();
}

// ── 事件 ───────────────────────────────────────────────────────
$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#add-url').value.trim();
  if (url) addModel(url);
});
$('#q').addEventListener('input', (e) => {
  filters.q = e.target.value.trim();
  render();
  syncHash();
});
$('#format').addEventListener('change', (e) => {
  filters.format = e.target.value;
  render();
  syncHash();
});
$('#sort').addEventListener('change', (e) => {
  filters.sort = e.target.value;
  render();
  syncHash();
});
$('#side').addEventListener('click', onSideClick);
document.addEventListener('click', (e) => {
  const site = e.target.closest('[data-site]');
  if (site) {
    filters.site = site.dataset.site;
    renderChips();
    render();
    syncHash();
    return;
  }
  const tag = e.target.closest('[data-tag]');
  if (tag) {
    filters.tag = tag.dataset.tag;
    renderChips();
    render();
    syncHash();
    return;
  }
  const retry = e.target.closest('[data-retry]');
  if (retry) return addModel(retry.dataset.retry);
  const re = e.target.closest('[data-refetch]');
  if (re) return refetch(re.dataset.refetch);
  const del = e.target.closest('[data-del]');
  if (del) return removeModel(del.dataset.del);
});
window.addEventListener('hashchange', route);

function route() {
  const h = location.hash;
  if (h.startsWith('#m=')) {
    showDetail(decodeURIComponent(h.slice(3)));
    return;
  }
  $('#detail-view').hidden = true;
  $('#list-view').hidden = false;
  filtersFromHash(h);
  syncControls();
  renderChips();
  renderSide();
  render();
  window.scrollTo(0, 0);
}

load().then(route);


// ── 文件选择 + 预览 ────────────────────────────────────────────
function wireFilePicker(m) {
  const files = m.savedFiles || [];
  const pick = document.querySelector('.fpick');
  if (!pick) return;
  const select = (btn) => {
    document.querySelectorAll('.fpick').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    const rel = btn.dataset.file;
    const name = btn.dataset.name;
    const entry = files.find((f) => (f.path || '') === rel);
    const dl = document.getElementById('fdload');
    if (entry && entry.exists) {
      dl.innerHTML = `<div class="split"><a href="/library/${m.dir}/${entry.path}" download>${ICON.download}<span>下载 ${esc(
        (entry.name.match(/\.(\w+)$/) || [, ''])[1].toUpperCase(),
      )}</span></a></div>`;
      showPreview(m, rel ? rel.split('/').pop() : name);
    } else {
      dl.innerHTML = `<button class="btn-ghost" data-refetch="${esc(m.dir)}">这个文件不在本地，点这里补抓</button>`;
      const box = document.getElementById('file-preview');
      if (box) box.innerHTML = '<span class="sub">文件还没下到本地，补抓之后就能预览</span>';
    }
  };
  document.querySelectorAll('.fpick').forEach((b) => b.addEventListener('click', () => select(b)));
  select(pick);
}

async function showPreview(m, fileName) {
  const box = document.getElementById('file-preview');
  if (!box) return;
  box.innerHTML = '<span class="sub"><span class="spin"></span> 读文件…</span>';
  try {
    const r = await fetch(`/api/inspect?dir=${encodeURIComponent(m.dir)}&file=${encodeURIComponent(fileName)}`);
    const info = await r.json();
    if (info.error) throw new Error(info.error);
    box.innerHTML = renderPreview(m, fileName, info);
  } catch (e) {
    box.innerHTML = `<span class="sub">读不出来：${esc(e.message)}</span>`;
  }
}

function renderPreview(m, fileName, info) {
  // 3mf 盘图是派生数据，在 /preview/ 下；不是派生数据才回落到库目录
  const thumbUrl = (t) => (String(t).startsWith('/') ? esc(t) : `/library/${m.dir}/files/${esc(t)}`);
  if (info.kind === '3mf') {
    const plates = info.plates || [];
    return `<div class="pstats">
        <span>${ICON.plate}${plates.length} 个打印盘</span>
        ${info.objects ? `<span>${ICON.box}${info.objects} 个对象</span>` : ''}
        ${info.layerHeight ? `<span>${ICON.clock}层高 ${info.layerHeight} mm</span>` : ''}
      </div>
      ${plates.length
        ? `<div class="pgrid">${plates
            .map(
              (pl) => `<figure class="pitem">
                ${pl.thumb ? `<img src="${thumbUrl(pl.thumb)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
                <figcaption><b>${esc(pl.name || '打印盘 ' + pl.index)}</b>
                <span>${[fmtH(pl.timeSec), fmtG(pl.weightG)].filter(Boolean).map(esc).join(' · ') || `第 ${pl.index} 盘`}</span>
                ${pl.filaments?.length ? `<div class="fchips small">${filaments(pl.filaments)}</div>` : ''}
                </figcaption></figure>`,
            )
            .join('')}</div>`
        : '<span class="sub">这个 3mf 里没有打印盘预览图</span>'}`;
  }
  if (info.kind === 'stl') {
    return `<div class="pstats">
        ${info.triangles ? `<span>${ICON.box}${info.triangles.toLocaleString('en-US')} 个三角面</span>` : ''}
        ${info.sizeMm ? `<span>${ICON.ruler}${info.sizeMm.map((v) => v + ' mm').join(' × ')}</span>` : ''}
      </div>
      ${info.note ? `<span class="sub">${esc(info.note)}</span>` : ''}`;
  }
  return `<span class="sub">${esc(info.kind)} 文件，没有可预览的内容</span>`;
}


// ── 打印配置列表（创想云 3mf 版）＋悬浮窗 ──────────────────────
function profilesCard(m) {
  const all = [...new Set(m.profiles.flatMap((p) => p.machines || []))].sort();
  const pick = localStorage.getItem('machine') || '';
  const rows = m.profiles
    .map((p, i) => {
      const on = p.id === m.activeProfileId || (!m.activeProfileId && i === 0);
      return `<button type="button" class="prow2${on ? ' on' : ''}" data-profile="${esc(p.id)}" data-machines="${esc((p.machines || []).join('|'))}">
        <div class="pthumb">${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" loading="lazy">` : ''}</div>
        <div class="pinfo">
          <div class="pname">${esc(p.name)}</div>
          <div class="psub">
            ${p.machine ? `<span>${esc(p.machine)}</span>` : ''}
            ${p.timeSec ? `<span>${ICON.clock}${esc(fmtH(p.timeSec))}</span>` : ''}
            ${p.plates ? `<span>${ICON.plate}${p.plates} 盘</span>` : ''}
            ${p.weightG ? `<span>${ICON.weight}${esc(fmtG(p.weightG))}</span>` : ''}
          </div>
        </div>
        <div class="pop">
          <div class="pop-h"><b>${esc(p.name)}</b><span>${esc(p.machine || '')}${p.plates ? ` · ${p.plates} 盘` : ''}</span></div>
          <div class="pop-metrics">
            ${p.timeSec ? `<span>${ICON.clock}${esc(fmtH(p.timeSec))}</span>` : ''}
            ${p.weightG ? `<span>${ICON.weight}${esc(fmtG(p.weightG))}</span>` : ''}
            ${p.lengthM ? `<span>${ICON.ruler}${p.lengthM.toFixed(1)} m</span>` : ''}
            ${p.nozzle ? `<span>${ICON.nozzle}${esc(p.nozzle)}</span>` : ''}
            ${p.size ? `<span>${ICON.box}${esc(fmtSize(p.size))}</span>` : ''}
          </div>
          ${[p.layerHeight ? `层高 ${p.layerHeight} mm` : '', p.wallLoops ? `${p.wallLoops} 层墙` : '', p.infill ? `${p.infill} 填充` : '', p.bed || '']
            .filter(Boolean).length
            ? `<div class="pop-meta">${[p.layerHeight ? `层高 ${p.layerHeight} mm` : '', p.wallLoops ? `${p.wallLoops} 层墙` : '', p.infill ? `${p.infill} 填充` : '', p.bed || '']
                .filter(Boolean).map(esc).join(' · ')}</div>`
            : ''}
          ${p.filaments?.length ? `<div class="fchips">${filaments(p.filaments)}</div>` : ''}
          ${p.url ? `<a class="pop-link" href="${esc(p.url)}" target="_blank" rel="noreferrer">在原站打开这个配置 ↗</a>` : ''}
          ${p.machines?.length
            ? `<div class="pop-machines"><span class="lbl">兼容机型 ${p.machines.length}</span>${p.machines
                .slice(0, 8)
                .map((n) => `<span class="machine">${esc(n)}</span>`)
                .join('')}${p.machines.length > 8 ? `<span class="machine more">+${p.machines.length - 8}</span>` : ''}</div>`
            : ''}
        </div>
      </button>`;
    })
    .join('');

  return `<section class="panel">
    <h2>打印配置 · ${m.profiles.length}${all.length
      ? `<select id="mf" class="mfilter" aria-label="按机型筛选"><option value="">全部机型</option>${all
          .map((n) => `<option value="${esc(n)}"${n === pick ? ' selected' : ''}>${esc(n)}</option>`)
          .join('')}</select>`
      : ''}</h2>
    <div class="plist">${rows}</div>
    <div class="sub" style="margin-top:8px">鼠标悬停看配置详情；3mf 需去站点下载</div>
  </section>`;
}


// ── 打印盘：跟随选中的打印配置 ─────────────────────────────────
function activeProfile(m, id) {
  const list = m.profiles || [];
  return list.find((x) => x.id === id) || list.find((x) => x.isDefault) || list[0] || null;
}

function platesPanel(m, profileId) {
  const prof = activeProfile(m, profileId);
  const plates = prof?.plateList?.length ? prof.plateList : m.print?.plateList || [];
  if (!plates.length) return '';
  const nozzle = prof?.nozzle || m.print?.nozzle || '';
  return `<section class="panel" id="plates-panel">
    <h2>打印盘 · ${plates.length}${prof ? ` · ${esc(prof.name)}` : ''}</h2>
    ${nozzle ? `<div class="pmeta" style="margin:-4px 0 10px">喷嘴 ${esc(nozzle)}</div>` : ''}
    <div class="plates">${plates
      .map(
        (pl) => `<div class="plate">
          ${pl.thumb ? `<img src="${esc(pl.thumb.startsWith('http') ? pl.thumb : `/library/${m.dir}/${pl.thumb}`)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
          <div class="pb">
            <div class="pt">${esc(pl.name || '打印盘')}</div>
            <div class="pm">${[fmtH(pl.timeSec), fmtG(pl.weightG)].filter(Boolean).map(esc).join(' · ') || '—'}</div>
            <div class="fchips">${filaments(pl.filaments)}</div>
          </div>
        </div>`,
      )
      .join('')}</div>
  </section>`;
}

// ── 文档（配套组装说明）────────────────────────────────────────
function docsCard(m) {
  const docs = m.docs || [];
  if (!docs.length) return '';
  return `<section class="panel">
    <h2>配套文档 · ${docs.length}</h2>
    ${docs
      .map((d) => {
        const saved = (m.savedFiles || []).find((f) => f.kind === 'doc' && f.name === d.name);
        const href = saved?.exists ? `/library/${m.dir}/${saved.path}` : m.sourceUrl;
        return `<div class="file"><a href="${esc(href)}" ${saved?.exists ? 'download' : 'target="_blank" rel="noreferrer"'}>${esc(d.name)}</a>
          <small>${esc(fmtSize(d.size))}${saved?.exists ? '' : ' · 去站点下载 ↗'}</small></div>`;
      })
      .join('')}
  </section>`;
}

// 机型筛选：只留能在选中机型上打的配置，选择记在 localStorage
function wireMachineFilter() {
  const sel = document.getElementById('mf');
  if (!sel) return;
  const apply = () => {
    const want = sel.value;
    document.querySelectorAll('.prow2[data-machines]').forEach((row) => {
      row.hidden = Boolean(want) && !row.dataset.machines.split('|').includes(want);
    });
  };
  sel.addEventListener('change', () => {
    localStorage.setItem('machine', sel.value);
    apply();
  });
  apply();
}

// 点配置行 → 只换打印盘面板
function wireProfileSwitch(m) {
  document.querySelectorAll('.prow2[data-profile]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const id = row.dataset.profile;
      document.querySelectorAll('.prow2').forEach((r) => r.classList.toggle('on', r === row));
      const panel = document.getElementById('plates-panel');
      const html = platesPanel(m, id);
      if (panel) panel.outerHTML = html || '';
    });
  });
}

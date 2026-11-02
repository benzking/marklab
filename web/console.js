// 控制台前端：左侧导航 + 六个分页，零框架、零构建，改完刷新就见效。
// 每个分页各自 try/catch：哪个接口挂了就只在它自己的框里显示红字，不拖白整页。

const SITE = { creality: '创想云', makerworld: 'MakerWorld', snapmaker: 'Snapmaker', 'makeronline.cn': 'MakerOnline 国内', 'makeronline.com': 'MakerOnline 国际' };
const SITE_COLOR = { creality: '#2f6bff', makerworld: '#00b96b', snapmaker: '#1a7cff', 'makeronline.cn': '#ff7d00', 'makeronline.com': '#ff7d00' };
const PHASE = { queued: '排队中', fetching: '取页中', parsing: '解析中', downloading: '下载中', done: '已完成', failed: '失败', interrupted: '中断', duplicate: '重复' };
const SOURCE = { manual: '手动', refetch: '补抓', subscribe: '订阅', bulk: '批抓' };
const ACTIVE = new Set(['queued', 'fetching', 'parsing', 'downloading']);
// 搜索排序键 → 人话（键的并集见 sites/contract.mjs SORTS）
const SORT_LABEL = { downloads: '按下载', likes: '按点赞', collects: '按收藏', newest: '按最新', hot: '按热门', score: '按评分' };
const sortName = (s) => SORT_LABEL[s] || s || '默认序';
const MATCH_LABEL = { name: '按名字', tag: '按标签' };
const DECISION = { queued: '已入队', 'no-match': '名字没命中', threshold: '没过门槛', 'in-library': '库里已有', 'in-queue': '已在队列' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtNum = (n) => (Number(n) || 0).toLocaleString('zh-CN');

// 字节自动换算：控制台看的是 4.74 GB 这种量级，不用管 B/KB 的零头
const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
  return `${n} B`;
};

// 时间一律按北京时间显示成 10-29 15:47，跟工作台的「自然日」口径一致
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtTime = (v) => {
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return '—';
  const parts = TIME_FMT.formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
};

const fmtDur = (sec) => {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
  return `${(sec / 3600).toFixed(1)} 小时`;
};

const siteName = (s) => SITE[s] || s || '—';
// 老任务（jsonl 里恢复的）没记站点，从网址认一次；认不出就显示「—」
const siteOfUrl = (url) => {
  const u = String(url || '');
  if (/crealitycloud\.cn/.test(u)) return 'creality';
  if (/makerworld\.com/.test(u)) return 'makerworld';
  if (/snapmaker\.cn/.test(u)) return 'snapmaker';
  if (/makeronline\.com/.test(u)) return 'makeronline.com';
  if (/makeronline\.cn/.test(u)) return 'makeronline.cn';
  return null;
};
const siteDot = (s) => `<i class="sd" style="background:${SITE_COLOR[s] || '#c8ccd4'}"></i>`;

// ── 通用：请求 / 错误显示 / 短暂提示 ─────────────────────────────
async function api(path, opts = {}) {
  const init = { ...opts };
  if (init.body != null && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
    init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('连不上服务，看看 server 还在不在跑');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error((data && data.error) || `接口返回 ${res.status}`);
  return data;
}

const fail = (sel, e) => {
  const el = $(sel);
  if (!el) return;
  el.hidden = false;
  el.textContent = `加载失败：${(e && e.message) || e}`;
};
const clearFail = (sel) => {
  const el = $(sel);
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
};
const flash = (sel, text, bad) => {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  el.className = bad ? 'note bad' : 'note';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.textContent = ''; }, 4000);
};

// ── 导航：hash 路由 + 可收起侧栏 ────────────────────────────────
const PAGES = ['dash', 'tasks', 'subs', 'logs', 'sites', 'settings'];
let currentPage = '';

function showPage(name) {
  if (!PAGES.includes(name)) name = 'dash';
  currentPage = name;
  for (const p of PAGES) {
    const el = $(`#page-${p}`);
    if (el) el.hidden = p !== name;
  }
  for (const a of document.querySelectorAll('.nav-item')) {
    a.classList.toggle('on', a.dataset.page === name);
  }
  document.title = `${$(`#page-${name} h1`)?.textContent || '控制台'} · 控制台`;
  loadPage(name);
}

function loadPage(name) {
  if (name === 'dash') loadWorkbench();
  else if (name === 'tasks') loadTasks();
  else if (name === 'subs') loadSubs();
  else if (name === 'logs') loadEvents();
  else if (name === 'sites') loadSites();
  else if (name === 'settings') loadLlm();
}

function route() {
  const name = (location.hash || '').replace('#', '') || 'dash';
  showPage(name);
}

// 侧栏收起状态存 localStorage：屏小的时候默认收起
const SIDE_KEY = 'console.side.collapsed';
function setSide(collapsed) {
  $('#shell').classList.toggle('collapsed', collapsed);
  $('#side-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#side-toggle').title = collapsed ? '展开导航' : '收起导航';
  try { localStorage.setItem(SIDE_KEY, collapsed ? '1' : '0'); } catch { /* 隐私模式就算了 */ }
}

// ── 数据大屏 ──────────────────────────────────────────────────
let wbData = null;
let tasksData = [];

function renderWorkbench(w) {
  wbData = w;
  const by = (w.models && w.models.bySite) || {};
  const counts = w.counts || {};
  const disk = w.disk || {};
  const health = w.health || {};
  const t = w.tasks || {};

  const siteRows = ['creality', 'makerworld', 'snapmaker', 'makeronline.cn']
    .map((s) => `<div class="kv"><em>${siteDot(s)}${siteName(s)}</em><b>${fmtNum(by[s])}</b></div>`)
    .join('');

  $('#wb').innerHTML = `
    <div class="stat">
      <h3>模型总数</h3>
      <div class="big">${fmtNum((w.models || {}).total)}</div>
      ${siteRows}
    </div>
    <div class="stat">
      <h3>入库（北京时间自然日）</h3>
      <div class="triple">
        <div><b>${fmtNum(counts.today)}</b><span>今日</span></div>
        <div><b>${fmtNum(counts.d7)}</b><span>近 7 日</span></div>
        <div><b>${fmtNum(counts.d30)}</b><span>近 30 日</span></div>
      </div>
      <div class="kv" style="margin-top:10px"><em>订阅待处理</em><b id="wb-sub-pending">—</b></div>
    </div>
    <div class="stat">
      <h3>磁盘占用</h3>
      <div class="big">${fmtBytes(disk.total)}</div>
      <div class="kv"><em>模型文件</em><b>${fmtBytes(disk.files)}</b></div>
      <div class="kv"><em>图片</em><b>${fmtBytes(disk.img)}</b></div>
      <div class="kv"><em>其它</em><b>${fmtBytes(disk.other)}</b></div>
      <div class="kv"><em>文件数</em><b>${fmtNum(disk.fileCount)}</b></div>
      ${disk.free != null ? `<div class="kv${disk.free < 10 * 1024 ** 3 ? ' warn' : ''}"><em>剩余空间</em><b>${fmtBytes(disk.free)}</b></div>` : ''}
    </div>
    <div class="stat">
      <h3>待补抓</h3>
      <div class="big">${fmtNum(w.needRefetch)}</div>
      <div class="kv"><em>站点有文件，本地一个都没落下来</em></div>
      ${(() => {
        const r = w.noFilesReason || {};
        const row = (k, label) => (r[k] ? `<div class="kv"><em>${label}</em><b>${fmtNum(r[k])}</b></div>` : '');
        const need = (r.login || 0) + (r.captcha || 0) + (r.parse || 0) + (r.none || 0) + (r.unknown || 0);
        return (
          row('login', '要登录才有文件') +
          row('captcha', '要过人机验证') +
          row('parse', '解析没拿到链接') +
          row('none', '站点本来就不给') +
          row('unknown', '原因未记（老数据）') +
          (r.skipped ? `<div class="kv"><em>这次没下文件（--no-files，不算失败）</em><b>${fmtNum(r.skipped)}</b></div>` : '') +
          `<div class="kv"><em>合计</em><b>${fmtNum(need)}</b></div>`
        );
      })()}
    </div>
    <div class="stat">
      <h3>数据健康（缺的条数）</h3>
      <div class="kv"><em>无打印配置</em><b>${fmtNum(health.noProfile)}</b></div>
      <div class="kv"><em>无封面</em><b>${fmtNum(health.noCover)}</b></div>
      <div class="kv"><em>无简介</em><b>${fmtNum(health.noDesc)}</b></div>
      <div class="kv"><em>无文件</em><b>${fmtNum(health.noFiles)}</b></div>
    </div>
    <div class="stat">
      <h3>抓取吞吐（24 小时）</h3>
      <div class="kv"><em>完成</em><b>${fmtNum(t.last24h)}</b></div>
      <div class="kv"><em>失败</em><b>${fmtNum(t.failed24h)}</b></div>
      <div class="kv"><em>平均耗时</em><b>${fmtDur(t.avgSeconds)}</b></div>
      <div class="kv"><em>排队中</em><b>${fmtNum(t.queued)}</b></div>
    </div>`;

  $('#wb-at').textContent = w.at ? `更新于 ${fmtTime(w.at)}` : '';
  updateSubPending();
  if (currentPage === 'sites') renderSites();
}

async function loadWorkbench(force = false) {
  clearFail('#wb-err');
  try {
    renderWorkbench(await api(`/api/console/workbench${force ? '?force=1' : ''}`));
  } catch (e) {
    $('#wb').innerHTML = '';
    fail('#wb-err', e);
  }
}

// 订阅待处理数从任务列表里算：排队 + 在跑、来源是订阅的那些
function updateSubPending() {
  const n = tasksData.filter((t) => t.source === 'subscribe' && ACTIVE.has(t.phase)).length;
  const el = $('#wb-sub-pending');
  if (el) el.textContent = fmtNum(n);
}

// ── 抓取任务（行内展开）────────────────────────────────────────
const openTasks = new Set();
let taskSig = '';

function taskRow(t) {
  const p = t.progress || {};
  const done = Number(p.done) || 0;
  const total = Number(p.total) || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : t.phase === 'done' ? 100 : 0;
  const started = t.startedAt ? Date.parse(t.startedAt) : null;
  const ended = t.endedAt ? Date.parse(t.endedAt) : started && ACTIVE.has(t.phase) ? Date.now() : null;
  const dur = started && ended ? (ended - started) / 1000 : null;
  const tagCls = t.phase === 'done' ? 'ok' : t.phase === 'failed' ? 'bad' : ACTIVE.has(t.phase) ? 'run' : '';
  const title = t.title || t.url || '(无标题)';
  const barCls = t.phase === 'failed' ? 'bar fail' : 'bar';
  const id = t.id ? esc(t.id) : '';
  const open = id && openTasks.has(t.id);
  const err = t.error ? `<div class="why" title="${esc(t.error)}">${esc(t.error)}</div>` : '';
  const warn = !err && t.warning ? `<div class="why" title="${esc(t.warning)}">${esc(t.warning)}</div>` : '';
  const row = `<tr class="task-row${open ? ' open' : ''}" data-task="${id}" tabindex="0" role="button" aria-expanded="${open ? 'true' : 'false'}">
    <td class="time">${fmtTime(t.createdAt)}</td>
    <td>${siteDot(t.site || siteOfUrl(t.url))}${esc(siteName(t.site || siteOfUrl(t.url)))}</td>
    <td><div class="tt" title="${esc(title)}">${esc(title)}</div></td>
    <td>
      <div class="pg">${esc(PHASE[t.phase] || t.phase || '—')}${total && (done > 0 || ACTIVE.has(t.phase)) ? ` · ${done}/${total}` : ''}</div>
      <div class="${barCls}"><i style="width:${pct}%"></i></div>
    </td>
    <td><span class="tag">${esc(SOURCE[t.source] || t.source || '—')}</span></td>
    <td><span class="tag ${tagCls}">${esc(PHASE[t.phase] || t.phase || '—')}</span>${err}${warn}</td>
    <td class="time">${fmtDur(dur)}</td>
  </tr>`;
  return open ? row + taskDetailRow(t) : row;
}

function taskDetailRow(t) {
  const id = esc(t.id || '');
  const btns = [];
  if (t.phase === 'queued') btns.push(`<button class="btn sm" data-promote="${id}" type="button" title="挪到队列最前，下一个就跑它">插队</button>`);
  if (t.phase === 'queued' || ACTIVE.has(t.phase)) btns.push(`<button class="btn sm danger" data-stop="${id}" type="button">停止</button>`);
  if (t.phase === 'failed' || t.phase === 'interrupted') btns.push(`<button class="btn sm" data-retry="${id}" type="button">重试</button>`);
  const log = (t.log || '').trim();
  const url = t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.url)}</a>` : '';
  return `<tr class="task-detail"><td colspan="7">
    <div class="tdgrid">
      <div><em>任务</em> ${id} · 第 ${fmtNum(t.rounds || 0)} 轮${t.subId ? ` · 订阅 ${esc(t.subId)}` : ''}</div>
      ${url ? `<div><em>原链接</em> ${url}</div>` : ''}
      ${t.error ? `<div class="why"><em>错误</em> ${esc(t.error)}${t.errorCode ? ` <span class="muted small">（${esc(ERR_CODE[t.errorCode] || t.errorCode)}）</span>` : ''}</div>` : ''}
      ${t.errorDetail ? `<details class="why"><summary class="muted small">原文</summary><pre class="tlog">${esc(t.errorDetail)}</pre></details>` : ''}
      ${t.warning ? `<div class="why"><em>提示</em> ${esc(t.warning)}</div>` : ''}
      <div><em>日志</em>${log ? `<pre class="tlog">${esc(log)}</pre>` : '<span class="muted small">没有日志</span>'}</div>
      <div class="tdacts">${btns.join(' ')}</div>
    </div>
  </td></tr>`;
}

// 抓取侧的错误分类（grab.mjs 的 ERR_TEXT 同一套口径）
const ERR_CODE = {
  login: '要登录',
  captcha: '要过人机验证',
  browser: '浏览器没连上',
  timeout: '超时',
  network: '网络错误',
  disk: '磁盘写不进去',
  parse: '解析失败',
  'unknown-site': '不认识的站点',
  unknown: '未知原因',
};

// 队列总闸：暂停后订阅/批抓/补抓都只排队，只有这里点「继续」或手动开始才放行
let queueState = { paused: false, queued: 0, running: null };

function renderTasks(list) {
  tasksData = Array.isArray(list) ? list : [];
  // 5 秒轮询如果内容没变就别重画：重画会吞掉焦点、把正在点的按钮换掉
  const sig = tasksData.map((t) => `${t.id}:${t.phase}:${(t.progress || {}).done}:${t.endedAt || ''}`).join('|');
  if (sig !== taskSig) {
    taskSig = sig;
    $('#task-rows').innerHTML = tasksData.length
      ? tasksData.map(taskRow).join('')
      : '<tr><td colspan="7" class="muted small">还没有抓取任务</td></tr>';
  }
  const queued = tasksData.filter((t) => t.phase === 'queued').length;
  const running = tasksData.filter((t) => ACTIVE.has(t.phase) && t.phase !== 'queued').length;
  const parts = [`共 ${tasksData.length} 条`];
  if (queued) parts.push(`排队 ${queued}`);
  if (running) parts.push(`在跑 ${running}`);
  $('#task-note').textContent = `${queueState.paused ? '已暂停 · ' : ''}${parts.join('，')} · 5 秒自动刷新`;
  updateSubPending();
}

function renderQueue() {
  const on = !queueState.paused;
  const tag = $('#queue-state');
  if (tag) {
    tag.textContent = on ? '运行中' : '已暂停';
    tag.className = `tag ${on ? 'ok' : 'bad'}`;
  }
  const btn = $('#queue-toggle');
  if (btn) {
    btn.textContent = on ? '暂停抓取' : '继续抓取';
    btn.classList.toggle('primary', !on);
  }
  const foot = $('#side-foot');
  if (foot) foot.textContent = on ? '抓取队列运行中' : '抓取队列已暂停';
}

async function toggleQueue(btn) {
  const path = queueState.paused ? '/api/console/queue/resume' : '/api/console/queue/pause';
  btn.disabled = true;
  try {
    queueState = (await api(path, { method: 'POST' })) || queueState;
    renderQueue();
    clearFail('#task-err');
    await loadTasks();
  } catch (e) {
    fail('#task-err', e);
  }
  btn.disabled = false;
}

async function loadTasks() {
  if (document.hidden) return; // 标签页在后台就别空转
  try {
    const [list, q] = await Promise.all([api('/api/console/tasks?limit=100'), api('/api/console/queue')]);
    if (q) queueState = q;
    renderQueue();
    renderTasks(list);
    clearFail('#task-err');
  } catch (e) {
    if (!tasksData.length) $('#task-rows').innerHTML = '';
    fail('#task-err', e);
  }
}

function toggleTaskRow(id) {
  if (!id) return;
  if (openTasks.has(id)) openTasks.delete(id);
  else openTasks.add(id);
  taskSig = ''; // 强制重画一次
  renderTasks(tasksData);
}

async function taskAction(id, btn, path, busyText, doneText) {
  btn.disabled = true;
  btn.textContent = busyText;
  try {
    await api(path, { method: 'POST', body: { id } });
    clearFail('#task-err');
    await loadTasks();
  } catch (e) {
    fail('#task-err', e);
  }
  btn.disabled = false;
  btn.textContent = doneText;
}

const retryTask = (id, btn) => taskAction(id, btn, '/api/console/tasks/retry', '排队中…', '重试');
const promoteTask = (id, btn) => taskAction(id, btn, '/api/console/tasks/promote', '插队中…', '插队');
const stopTask = (id, btn) => taskAction(id, btn, '/api/console/tasks/stop', '停止中…', '停止');

// ── 订阅任务（清单 + 详情两栏）─────────────────────────────────
let subsData = [];
let selectedSub = null;
let detailHits = null; // { id, rows }
let detailCands = null; // { id, items }，候选清单是台账，跟命中记录分开缓存

function thresholdText(s) {
  if (s.kind === 'author') return '作者订阅：他发的全下';
  const parts = [];
  if (Number(s.minLikes) > 0) parts.push(`点赞 ≥ ${fmtNum(s.minLikes)}`);
  if (Number(s.minDownloads) > 0) parts.push(`下载 ≥ ${fmtNum(s.minDownloads)}`);
  if (s.pickedOnly) parts.push('只要精选');
  return parts.length ? parts.join(' · ') : '无门槛';
}

/** 作者订阅的翻页游标：首次全量没翻完就从这页接着翻，翻完才走增量。 */
function authorCursorText(s) {
  const cur = s.authorCursor || {};
  const keys = Object.keys(cur);
  if (!keys.length) return '还没跑过';
  return keys
    .map((k) => {
      const i = k.indexOf(':');
      const site = k.slice(0, i);
      const id = k.slice(i + 1);
      const u = (s.users || []).find((x) => x.site === site && x.id === id);
      const c = cur[k] || {};
      const page = c.done ? '首次全量已翻完' : `第 ${fmtNum(c.page || 1)} 页`;
      return `${siteName(site)} ${u?.name || id} ${page}`;
    })
    .join(' · ');
}

function lastResultText(s) {
  if (!s.lastRunAt) return '还没跑过';
  const r = s.lastResult || {};
  if (r.error) return `上次有问题：${r.error}`;
  if (r.matched == null) return '上次结果未记录';
  const truncated = Number(r.truncated) > 0 ? `，截断 ${fmtNum(r.truncated)}` : '';
  // 一轮没跑完：说清跑到哪了，下轮会接着跑
  const where =
    r.jobs && r.cursor > 0 ? `，本轮跑到第 ${fmtNum(r.cursor)}/${fmtNum(r.jobs)} 个词（下轮接着跑）` : '';
  return `命中 ${fmtNum(r.matched)}${truncated}${where}${r.stopped ? '（中途停止，未入库）' : ''}`;
}

function subListItem(s) {
  const on = selectedSub === s.id;
  return `<button type="button" class="sub-item${on ? ' on' : ''}" data-pick="${esc(s.id)}">
    <div class="sub-item-top">
      <span class="sub-name">${esc(s.name || s.id)}</span>
      <span class="tag ${s.enabled ? 'ok' : ''}">${s.enabled ? '启用' : '停用'}</span>
    </div>
    <div class="sub-line dim">${esc(lastResultText(s))} · ${s.lastRunAt ? fmtTime(s.lastRunAt) : '还没跑过'}</div>
  </button>`;
}

function renderSubs() {
  const anyOn = subsData.some((s) => s.enabled);
  const all = $('#sub-stop-all');
  if (all) {
    all.textContent = anyOn ? '全部停止' : '全部启用';
    all.classList.toggle('danger', anyOn);
  }
  $('#sub-list').innerHTML = subsData.length
    ? subsData.map(subListItem).join('')
    : '<p class="muted small">还没有订阅。点右上角新建一条。</p>';
  renderSubDetail();
}

function renderSubDetail() {
  const box = $('#sub-detail');
  const s = subsData.find((x) => x.id === selectedSub);
  if (!s) {
    box.innerHTML = '<p class="muted small">左边点一条订阅看详情，或点右上角新建。</p>';
    return;
  }
  const author = s.kind === 'author';
  const kws = (s.keywords || []).join('、');
  const users = (s.users || []).map((u) => `${siteName(u.site)} ${u.name || u.id}`).join('、');
  const rules = (s.rules || [])
    .map((r) => `<span class="tag">${esc(siteName(r.site))} · ${esc(sortName(r.sort))} · 前 ${fmtNum(r.limit)} 条</span>`)
    .join(' ');
  const modes = (s.matchModes || []).map((m) => MATCH_LABEL[m] || m).join('、');
  const prog = s.progress ? `<div class="sub-line">正在跑：${esc(s.progress.site || '')} · ${esc(s.progress.kw || '')} · 已搜 ${fmtNum(s.progress.searched)}/${fmtNum(s.progress.planned)}</div>` : '';
  const hits = detailHits && detailHits.id === s.id ? detailHits.rows : null;
  const cands = detailCands && detailCands.id === s.id ? detailCands.items : null;
  box.innerHTML = `
    <div class="detail-head">
      <h2>${esc(s.name || s.id)}</h2>
      <div class="right">
        <button class="btn sm" data-run="${esc(s.id)}" type="button">立即跑一轮</button>
        <button class="btn sm${s.enabled ? ' danger' : ''}" data-toggle="${esc(s.id)}" type="button">${s.enabled ? '停止' : '启用'}</button>
        <button class="btn sm" data-edit="${esc(s.id)}" type="button">编辑</button>
        <button class="btn sm danger" data-del="${esc(s.id)}" type="button">删除</button>
      </div>
    </div>
    <div class="kvline"><em>类型</em>${author ? '作者订阅（他发的全下）' : '关键字订阅'}</div>
    <div class="kvline"><em>状态</em><span class="tag ${s.enabled ? 'ok' : ''}">${s.enabled ? '启用' : '停用'}</span></div>
    ${author ? '' : `<div class="kvline"><em>关键字</em>${kws ? esc(kws) : '—'}</div>`}
    ${author ? `<div class="kvline"><em>作者</em>${users ? esc(users) : '—'}</div>` : ''}
    ${author ? '' : `<div class="kvline"><em>规则</em>${rules || '—'}</div>`}
    ${author ? '' : `<div class="kvline"><em>匹配</em>${esc(modes || '—')}</div>`}
    <div class="kvline"><em>门槛</em>${esc(thresholdText(s))}</div>
    ${author ? `<div class="kvline"><em>游标</em>${esc(authorCursorText(s))}</div>` : ''}
    <div class="kvline"><em>间隔</em>每 ${s.intervalHours || 8} 小时</div>
    <div class="kvline"><em>上次</em>${s.lastRunAt ? fmtTime(s.lastRunAt) : '还没跑过'} · ${esc(lastResultText(s))}</div>
    ${prog}
    ${
      author
        ? ''
        : `<h3 class="sub-h">本轮候选 <span class="muted small">这是本轮搜到的全部候选，最后一列是它为什么没进抓取队列</span></h3>
    <div class="cands">${cands === null ? '<p class="muted small">加载中…</p>' : cands.length ? candTable(cands) : '<p class="muted small">还没跑过</p>'}</div>`
    }
    <h3 class="sub-h">命中记录</h3>
    <div class="hits">${hits === null ? '<p class="muted small">加载中…</p>' : hits.length ? hits.map(hitRow).join('') : '<p class="muted small">还没有命中</p>'}</div>`;
  if (!hits) loadHits(s.id);
  if (!author && !cands) loadCandidates(s.id);
}

async function loadCandidates(id) {
  try {
    const r = await api(`/api/console/subs/candidates?id=${encodeURIComponent(id)}`);
    detailCands = { id, items: Array.isArray(r?.items) ? r.items : [] };
  } catch (e) {
    detailCands = { id, items: [] };
    fail('#subs-err', e);
  }
  if (selectedSub === id) renderSubDetail();
}

function candTable(items) {
  return `<div class="tablewrap"><table>
    <thead><tr><th>标题</th><th>站点</th><th>名次</th><th>来源词</th><th>为什么没进队列</th></tr></thead>
    <tbody>${items.map(candRow).join('')}</tbody>
  </table></div>`;
}

function candRow(c) {
  const sources = c.sources || [];
  const src = sources[0] || {};
  const sites = [...new Set(sources.map((x) => x.site))].map(siteName).join('、');
  const kws = [...new Set(sources.map((x) => x.kw).filter(Boolean))].join('、');
  const label = DECISION[c.decision] || c.decision || '—';
  return `<tr>
    <td><a class="tt" href="${esc(src.url || '')}" target="_blank" rel="noreferrer" title="${esc(c.title)}">${esc(c.title || c.key)}</a></td>
    <td>${src.site ? siteDot(src.site) + esc(sites) : '—'}</td>
    <td>${src.rank != null ? fmtNum(src.rank) : '—'}</td>
    <td>${kws ? esc(kws) : '—'}</td>
    <td><span class="tag ${c.decision === 'queued' ? 'ok' : ''} cand-decision">${esc(label)}</span></td>
  </tr>`;
}

async function loadHits(id) {
  try {
    const rows = await api(`/api/console/subs/hits?id=${encodeURIComponent(id)}&limit=200`);
    detailHits = { id, rows: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    detailHits = { id, rows: [] };
    fail('#subs-err', e);
  }
  if (selectedSub === id) renderSubDetail();
}

function hitRow(h) {
  const cover = h.cover
    ? `<img src="${esc(h.cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACEAAAAAAAIAAAAAACwAAAAAAQABAAACAkQBADs=">';
  const status = [
    h.picked ? '<span class="tag ok">精选</span>' : '<span class="tag">普通</span>',
    h.taskId ? '<span class="tag run">已入队</span>' : '<span class="tag">未入队</span>',
  ].join(' ');
  return `<div class="hit">
    ${cover}
    <div class="hbody">
      <a class="ht" href="${esc(h.url)}" target="_blank" rel="noreferrer" title="${esc(h.title)}">${esc(h.title || h.id)}</a>
      <div class="hm">
        <span>${siteDot(h.site)}${esc(siteName(h.site))}</span>
        <span>点赞 ${fmtNum(h.likes)}</span>
        <span>下载 ${fmtNum(h.downloads)}</span>
        <span>${h.user ? `用户：${esc(h.user)}` : `关键字：${esc(h.keyword || '—')}`}</span>
        <span>${fmtTime(h.matchedAt)}</span>
      </div>
    </div>
    <div>${status}</div>
  </div>`;
}

async function loadSubs() {
  clearFail('#subs-err');
  try {
    const rows = await api('/api/console/subs');
    subsData = Array.isArray(rows) ? rows : [];
    if (selectedSub && !subsData.some((s) => s.id === selectedSub)) selectedSub = null;
    renderSubs();
  } catch (e) {
    $('#sub-list').innerHTML = '';
    fail('#subs-err', e);
  }
}

async function runSub(id, btn) {
  btn.disabled = true;
  btn.textContent = '已排上…';
  try {
    await api('/api/console/subs/run', { method: 'POST', body: { id } });
    flash('#sub-note', '这一轮已排上，几分钟后看命中');
    setTimeout(() => { btn.disabled = false; btn.textContent = '立即跑一轮'; }, 4000);
  } catch (e) {
    flash('#sub-note', `跑不动：${(e && e.message) || e}`, true);
    btn.disabled = false;
    btn.textContent = '立即跑一轮';
  }
}

// 停一条：停用后到点不跑，在跑的那一轮也会在下个词之前收手（不再往库里塞）
async function toggleSub(id, btn) {
  const s = subsData.find((x) => x.id === id);
  if (!s) return;
  btn.disabled = true;
  try {
    await api('/api/console/subs', { method: 'PATCH', body: { id, enabled: !s.enabled } });
    flash('#sub-note', s.enabled ? '已停止' : '已启用');
    await loadSubs();
  } catch (e) {
    flash('#sub-note', `改不了：${(e && e.message) || e}`, true);
    btn.disabled = false;
  }
}

async function toggleAllSubs(btn) {
  const anyOn = subsData.some((s) => s.enabled);
  btn.disabled = true;
  try {
    await api('/api/console/subs/enabled', { method: 'POST', body: { enabled: !anyOn } });
    flash('#sub-note', anyOn ? `已停止全部 ${fmtNum(subsData.length)} 条订阅` : '已全部启用');
    await loadSubs();
  } catch (e) {
    flash('#sub-note', `改不了：${(e && e.message) || e}`, true);
  } finally {
    btn.disabled = false;
  }
}

// 删除要点两下：第一下只把按钮变成「确认删除」，3 秒后自己复原（不用 confirm 弹窗）
async function delSub(id, btn) {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '确认删除';
    setTimeout(() => {
      if (btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        btn.textContent = '删除';
      }
    }, 3000);
    return;
  }
  btn.dataset.armed = '';
  btn.disabled = true;
  btn.textContent = '删除中…';
  try {
    await api('/api/console/subs', { method: 'DELETE', body: { id } });
    flash('#sub-note', '已删除');
    if (selectedSub === id) selectedSub = null;
    await loadSubs();
  } catch (e) {
    flash('#sub-note', `删不掉：${(e && e.message) || e}`, true);
    btn.disabled = false;
    btn.textContent = '删除';
  }
}

// ── 新建 / 编辑订阅（同一个表单）────────────────────────────────
const RULE_LIMIT = 20; // 站点搜索一页 20 条（site-pack.md），新规则默认取一页

const sitesList = () => (sitesData && Array.isArray(sitesData.sites) ? sitesData.sites : []);
// 后端只存 {site,id,name}，编辑时按站点把主页链接拼回来
const userUrl = (u) =>
  u.url ||
  {
    creality: `https://www.crealitycloud.cn/user/${u.id}/profile`,
    makerworld: `https://makerworld.com.cn/zh/@${u.id}/upload`,
    snapmaker: `https://space.snapmaker.cn/zh/creator/${u.id}`,
    'makeronline.cn': `https://www.makeronline.cn/user/personalInfo/${u.id}.html`,
    'makeronline.com': `https://www.makeronline.com/user/personalInfo/${u.id}.html`,
  }[u.site] ||
  '';
const abilitiesOf = (site) => sitesList().find((s) => s.site === site)?.abilities || {};

/** 一条候选规则：站点 + 排序 + 前 N 条 + 删。排序项只列该站 abilities.sorts 里有的。 */
function ruleRow(rule = {}) {
  const row = document.createElement('div');
  row.className = 'rule-row';
  const site = rule.site || sitesList()[0]?.site || '';
  row.innerHTML = `
    <select class="r-site">${sitesList()
      .map((s) => `<option value="${esc(s.site)}"${s.site === site ? ' selected' : ''}>${esc(siteName(s.site))}</option>`)
      .join('')}</select>
    <select class="r-sort"></select>
    <input class="r-limit" type="number" min="1" max="1000" step="1" value="${Math.max(1, Math.round(Number(rule.limit) || RULE_LIMIT))}"> 条
    <button class="btn sm" type="button" data-del-rule>删</button>
    <span class="r-hint"></span>`;
  $('#rule-rows').appendChild(row);
  fillSort(row, rule.sort);
  return row;
}

/** 站点换了就重排排序项；站点不带标签时在行尾说一句（tag 勾了也只按名字判）。 */
function fillSort(row, want) {
  const ab = abilitiesOf(row.querySelector('.r-site').value);
  const sorts = Array.isArray(ab.sorts) ? ab.sorts : [];
  const sel = row.querySelector('.r-sort');
  sel.innerHTML = sorts.length
    ? sorts.map((k) => `<option value="${esc(k)}">${esc(sortName(k))}</option>`).join('')
    : '<option value="">默认序</option>';
  sel.value = sorts.includes(want) ? want : sorts[0] || '';
  row.querySelector('.r-hint').textContent = ab.tags === false ? '该站不带标签' : '';
}

function applyKind() {
  const kind = $('#f-kind').value;
  for (const el of document.querySelectorAll('#sub-form [data-kind]')) el.hidden = el.dataset.kind !== kind;
}

async function openSubForm(sub) {
  const f = $('#sub-form');
  f.hidden = false;
  f.reset();
  if (!sitesData) await loadSites(); // 规则行的站点/排序来自站点包能力位
  $('#f-id').value = sub ? sub.id : '';
  $('#sub-submit').textContent = sub ? '保存修改' : '新建订阅';
  $('#f-kind').value = sub?.kind || 'keyword';
  applyKind();
  $('#rule-rows').innerHTML = '';
  for (const rule of sub?.rules?.length ? sub.rules : [{}]) ruleRow(rule);
  const modes = sub ? sub.matchModes || [] : ['name'];
  for (const box of f.querySelectorAll('input[name="match"]')) box.checked = modes.includes(box.value);
  if (sub) {
    $('#f-name').value = sub.name || '';
    $('#f-kw').value = (sub.keywords || []).join(', ');
    $('#f-users').value = (sub.users || []).map(userUrl).filter(Boolean).join('\n');
    $('#f-likes').value = sub.minLikes || 0;
    $('#f-dl').value = sub.minDownloads || 0;
    $('#f-int').value = sub.intervalHours || 8;
    f.elements.pickedOnly.checked = Boolean(sub.pickedOnly);
    f.elements.enabled.checked = sub.enabled !== false;
  }
  f.scrollIntoView({ block: 'nearest' });
}

function formRules(f) {
  return [...f.querySelectorAll('#rule-rows .rule-row')]
    .map((row) => ({
      site: row.querySelector('.r-site').value,
      sort: row.querySelector('.r-sort').value || null,
      limit: Math.max(1, Math.round(Number(row.querySelector('.r-limit').value) || RULE_LIMIT)),
    }))
    .filter((r) => r.site);
}

async function submitSub(e) {
  e.preventDefault();
  const f = e.target;
  const el = (n) => f.elements[n];
  const id = $('#f-id').value;
  const kind = el('kind').value;
  const name = String(el('name').value || '').trim();
  const intervalHours = Number(el('intervalHours').value) || 8;
  const enabled = el('enabled').checked;
  let body;
  if (kind === 'author') {
    const users = String(el('users').value || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (!users.length) return flash('#sub-note', '作者订阅至少填一个作者主页链接', true);
    body = { name: name || '作者订阅', kind, users, intervalHours, enabled };
  } else {
    const keywords = String(el('keywords').value || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const rules = formRules(f);
    const matchModes = [...f.querySelectorAll('input[name="match"]:checked')].map((i) => i.value);
    if (!keywords.length) return flash('#sub-note', '关键字订阅至少填一个关键字', true);
    if (!rules.length) return flash('#sub-note', '关键字订阅至少要一条候选规则（站点 + 排序 + 前 N 条）', true);
    if (!matchModes.length) return flash('#sub-note', '至少勾一种匹配方式（按名字 / 按标签）', true);
    body = {
      name: name || keywords[0],
      kind,
      keywords,
      rules,
      matchModes,
      minLikes: Number(el('minLikes').value) || 0,
      minDownloads: Number(el('minDownloads').value) || 0,
      pickedOnly: el('pickedOnly').checked,
      intervalHours,
      enabled,
    };
  }
  const btn = $('#sub-submit');
  btn.disabled = true;
  try {
    if (id) await api('/api/console/subs', { method: 'PATCH', body: { id, ...body } });
    else await api('/api/console/subs', { method: 'POST', body });
    flash('#sub-note', id ? '已保存' : '订阅已建好');
    f.hidden = true;
    f.reset();
    await loadSubs();
  } catch (err) {
    flash('#sub-note', `存不了：${(err && err.message) || err}`, true);
  } finally {
    btn.disabled = false;
  }
}

// ── 运行日志（四类事件一条时间轴）──────────────────────────────
let logType = 'all';
const LOG_TAG = { queue: '抓取队列', subscribe: '订阅命中', tag: '智能标签', dup: '判重' };

function logRow(e) {
  const title = e.url
    ? `<a href="${esc(e.url)}" target="_blank" rel="noreferrer">${esc(e.title || e.url)}</a>`
    : `<span>${esc(e.title || '—')}</span>`;
  const state = e.state ? `<span class="tag">${esc(PHASE[e.state] || e.state)}</span>` : '';
  return `<div class="log-row">
    <span class="log-time">${fmtTime(e.at)}</span>
    <span class="log-type t-${esc(e.type)}">${esc(LOG_TAG[e.type] || e.type)}</span>
    <span class="log-site">${e.site ? siteDot(e.site) + esc(siteName(e.site)) : '—'}</span>
    <span class="log-main">${title} ${state}</span>
    <span class="log-detail muted small">${esc(e.detail || '')}</span>
  </div>`;
}

async function loadEvents() {
  clearFail('#log-err');
  try {
    const rows = await api(`/api/console/events?type=${encodeURIComponent(logType)}&limit=200`);
    $('#log-list').innerHTML = rows.length
      ? rows.map(logRow).join('')
      : '<p class="muted small">这一类还没有记录</p>';
    $('#log-note').textContent = `${fmtNum(rows.length)} 条 · 更新于 ${fmtTime(new Date().toISOString())}`;
  } catch (e) {
    $('#log-list').innerHTML = '';
    fail('#log-err', e);
  }
}

// ── 站点包 ────────────────────────────────────────────────────
let loginRows = [];
let sitesData = null; // /api/console/sites 的原样响应：卡片、登录态列表、限速设置都读它

function renderSites() {
  const rows = sitesData && Array.isArray(sitesData.sites) ? sitesData.sites : [];
  if (!rows.length) {
    $('#site-cards').innerHTML = '<p class="muted small">加载中…</p>';
    return;
  }
  const days = (sitesData && sitesData.days) || [];
  $('#site-cards').innerHTML = rows
    .map((r) => {
      const l = r.login || {};
      // 第一行右侧：红绿灯 + 账号名。unknown 是灰灯——「不知道」不是「没登录」
      const light = l.ok ? 'ok' : l.status === 'unknown' ? 'unk' : 'bad';
      const name = l.ok ? esc(l.name || '已登录') : l.status === 'unknown' ? '无法检测' : '未登录';
      const head = `<div class="site-head">${siteDot(r.site)}<b>${esc(r.label || siteName(r.site))}</b>
        <span class="login-tag" title="${esc(l.reason || '')}"><i class="light ${light}"></i>${name}</span></div>`;

      // 第二行：积分 + 签到 + 连签；右边自动签到开关（包里没 checkin 的站不给开关）
      const c = r.checkin || null;
      const bits = [];
      if (r.points != null) bits.push(`<span><em>积分</em>${fmtNum(r.points)}</span>`);
      if (c) {
        bits.push(
          c.signed
            ? `<span class="ok">今日已签${c.gain ? ` +${c.gain}` : ''}</span>`
            : '<span class="bad">今日未签</span>',
        );
        if (c.streak) bits.push(`<span><em>连签</em>${c.streak} 天</span>`);
      } else if (r.note) {
        bits.push(`<span class="muted small">${esc(r.note)}</span>`);
      }
      const canCheckin = r.abilities && r.abilities.checkin;
      const toggle = canCheckin
        ? `<label class="auto-in"><input type="checkbox" data-auto="${esc(r.site)}"${r.checkinAuto ? ' checked' : ''}>自动签到</label>`
        : '';
      const checkinRow = `<div class="kvline">${bits.join('<i class="sep">·</i>') || '<span class="muted small">这个站没有签到</span>'}${
        c && !c.signed && canCheckin ? `<button class="btn sm" type="button" data-checkin="${esc(r.site)}">签到</button>` : ''
      }${toggle}</div>`;

      // 第三行：库内 + 最近 24 小时 + 待补抓
      const libRow = `<div class="kvline">
        <span><em>库内</em>${fmtNum(r.models)} 个</span><i class="sep">·</i>
        <span><em>最近 1 天</em>抓 ${fmtNum(r.last24h || 0)} 个</span>${
          r.pending > 0 ? `<i class="sep">·</i><span><em>待补抓</em><span class="bad">${fmtNum(r.pending)}</span></span>` : ''
        }</div>`;

      // 第四行：最近 7 个自然日（含今天）带 3mf 的入库数。柱高按本卡最大值归一，别跨站比
      const daily = Array.isArray(r.daily) ? r.daily : [];
      const peak = Math.max(1, ...daily);
      const bars = daily.length
        ? `<div class="bars">${daily
            .map(
              (n, i) =>
                `<i style="height:${Math.max(2, Math.round((n / peak) * 100))}%" title="${esc(days[i] || '')}：${n} 个"></i>`,
            )
            .join('')}</div><div class="bars-x">${days.map((d) => `<span>${esc(d)}</span>`).join('')}</div>`
        : '<span class="muted small">还没有数据</span>';
      const chartRow = `<div class="kvline chart"><em>近 7 天</em><div class="chart-body">${bars}</div></div>`;

      // 第五行：两个限速，改完离开输入框就存，没有保存按钮
      const rate = r.rate || {};
      const gap = (rate.global || [60, 120]).join('-');
      const own = rate.modelGapSec ? rate.modelGapSec.join('-') : '';
      const perMin = rate.searchPerMin ? String(rate.searchPerMin) : '';
      const rateRow = `<div class="kvline">
        <em>下载限速</em><input class="rate-in" type="text" data-gap="${esc(r.site)}" value="${esc(own)}" placeholder="${esc(gap)}" inputmode="numeric"><span class="muted small">秒</span>
        <em class="ml">搜索限速</em><input class="rate-in" type="text" data-permin="${esc(r.site)}" value="${esc(perMin)}" placeholder="${esc(String(rate.searchPerMinGlobal || 4))}" inputmode="numeric"><span class="muted small">次/分</span>
      </div>`;

      return `<div class="site-card">${head}${checkinRow}${libRow}${chartRow}${rateRow}</div>`;
    })
    .join('');
}

// 批量动作：后端早就有了，界面以前没有入口
function wireBatch() {
  const tagAll = $('#llm-tag-all');
  if (tagAll) {
    tagAll.addEventListener('click', async () => {
      const note = $('#batch-note');
      tagAll.disabled = true;
      note.textContent = '已开始，后台一个个打…';
      try {
        const r = await api('/api/console/tags', { method: 'POST', body: { all: true } });
        note.textContent = `已开始，${fmtNum(r.queued || 0)} 个模型排队打标签（进度看运行日志）`;
      } catch (e) {
        note.textContent = `没打成：${e.message}`;
      } finally {
        tagAll.disabled = false;
      }
    });
  }
  const refetchAll = $('#refetch-all');
  if (refetchAll) {
    refetchAll.addEventListener('click', async () => {
      const note = $('#batch-note');
      refetchAll.disabled = true;
      try {
        const r = await api('/api/console/refetch', { method: 'POST', body: {} });
        note.textContent = `已排进队列 ${r.queued ?? 0} 个（去「抓取任务」看进度）`;
        loadTasks();
      } catch (e) {
        note.textContent = `没排成：${e.message}`;
      } finally {
        refetchAll.disabled = false;
      }
    });
  }
}

function renderLogin(rows) {
  loginRows = Array.isArray(rows) ? rows : [];
  if (!loginRows.length) {
    $('#login-list').innerHTML = '<p class="muted small">没有可检测的站点</p>';
  } else {
    $('#login-list').innerHTML = loginRows
      .map((r) => {
        const st = r.ok
          ? `<span class="ok">✓ ${esc(r.name || '已登录')}</span>`
          : r.status === 'unknown'
            ? '<span class="unk">无法检测</span>'
            : '<span class="bad">✗ 未登录</span>';
        const reason = r.reason ? `<span class="muted small">${esc(r.reason)}</span>` : '';
        const hint = r.ok
          ? ''
          : r.status === 'unknown'
            ? '<div class="hint">连不上本机 Chrome，先把 9223 上的常驻浏览器起起来</div>'
            : '<div class="hint">在本机 Chrome 打开该站登录后，点重新检测</div>';
        return `<div class="login-row">
          <div class="login-main"><b>${esc(r.label || siteName(r.site))}</b><span class="dot">·</span>${st}${reason}</div>
          ${hint}
        </div>`;
      })
      .join('');
  }
  renderSites();
}

async function loadSites(force = false) {
  clearFail('#login-err');
  if (force) $('#login-note').textContent = '正在打开浏览器标签探测…';
  try {
    sitesData = await api(`/api/console/sites${force ? '?force=1' : ''}`);
    renderLogin((sitesData.sites || []).map((s) => s.login || { site: s.site, label: s.label }));
    renderSites();
    $('#login-note').textContent = `检测于 ${fmtTime(sitesData.at)}`;
  } catch (e) {
    fail('#login-err', e);
  }
}

/** 卡片上的签到按钮：走包的 checkin()，回来重取一遍卡片。 */
async function cardAction(btn) {
  const site = btn.dataset.checkin;
  btn.disabled = true;
  try {
    const r = await api('/api/console/checkin', { method: 'POST', body: { site } });
    await loadSites();
    $('#login-note').textContent = `${siteName(site)}：${r.text || '已签到'}`;
  } catch (e) {
    fail('#login-err', e);
  } finally {
    btn.disabled = false;
  }
}

/** 合并一处改动进站点配置再整份回传（后端只认 modelGapSec / searchPerMin / checkinAuto）。
 *  null 表示「这一项跟随全局」，合并时删掉这个键。 */
async function saveSite(site, patch) {
  const cfg = { ...(sitesData.config || {}) };
  const mine = { ...(cfg[site] || {}), ...patch };
  for (const k of Object.keys(mine)) if (mine[k] == null) delete mine[k];
  if (Object.keys(mine).length) cfg[site] = mine;
  else delete cfg[site];
  sitesData.config = await api('/api/console/site-config', { method: 'POST', body: cfg });
  await loadSites();
}

/** 限速输入框：change = 失焦或回车，改完直接存，没有保存按钮。留空 = 跟随全局。 */
async function saveRate(el) {
  const site = el.dataset.gap || el.dataset.permin;
  const raw = String(el.value || '').trim();
  const patch = {};
  try {
    if (el.dataset.gap) {
      const nums = raw ? raw.split(/[-~到\s]+/).map(Number).filter((n) => Number.isFinite(n)) : [];
      if (raw && nums.length !== 2) throw new Error('下载限速写两个数，像 90-150（秒）');
      patch.modelGapSec = nums.length === 2 ? nums : null;
    } else {
      const n = raw ? Number(raw) : NaN;
      if (raw && !(Number.isFinite(n) && n > 0)) throw new Error('搜索限速写个正整数，像 4（次/分）');
      patch.searchPerMin = Number.isFinite(n) && n > 0 ? n : null;
    }
    await saveSite(site, patch);
  } catch (e) {
    await loadSites(); // 先打回服务器上的值，别让错的数字留在框里
    fail('#login-err', e); // 再报错：loadSites 开头会清空错误框
  }
}

/** 自动签到开关。 */
async function saveAuto(el) {
  try {
    await saveSite(el.dataset.auto, { checkinAuto: el.checked });
  } catch (e) {
    await loadSites();
    fail('#login-err', e);
  }
}

// ── 设置：大模型打标签 ────────────────────────────────────────
function renderPending(list) {
  $('#llm-pending').innerHTML = list.length
    ? list
        .map(
          (p) => `<div class="word">
        <b>${esc(p.word)}</b>
        <span class="wmeta">${esc(p.model || '—')} · ${fmtTime(p.at)}</span>
        <div class="wbtns">
          <button class="btn sm" data-word="${esc(p.word)}" data-accept="1" type="button">接受</button>
          <button class="btn sm danger" data-word="${esc(p.word)}" data-accept="0" type="button">丢弃</button>
        </div>
      </div>`,
        )
        .join('')
    : '<p class="muted small">没有待确认的新词</p>';
}

async function loadLlm() {
  clearFail('#llm-err');
  try {
    const c = await api('/api/console/llm');
    $('#llm-base').value = c.baseUrl || '';
    $('#llm-model').value = c.model || '';
    $('#llm-key').value = '';
    $('#llm-key').placeholder = c.hasKey ? '已保存，留空不改' : '填 API key';
    $('#llm-tags').textContent = `标签池 ${fmtNum(c.tagCount)} 个`;
    renderPending(Array.isArray(c.pending) ? c.pending : []);
  } catch (e) {
    fail('#llm-err', e);
  }
}

async function saveLlm() {
  const btn = $('#llm-save');
  btn.disabled = true;
  try {
    await api('/api/console/llm', {
      method: 'POST',
      body: { baseUrl: $('#llm-base').value.trim(), apiKey: $('#llm-key').value, model: $('#llm-model').value.trim() },
    });
    flash('#llm-note', '已保存');
    await loadLlm();
  } catch (e) {
    flash('#llm-note', `存不了：${(e && e.message) || e}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function fetchModels() {
  const btn = $('#llm-models');
  btn.disabled = true;
  btn.textContent = '获取中…';
  try {
    const rows = await api('/api/console/llm/models', { method: 'POST' });
    $('#llm-model-list').innerHTML = (rows || []).map((m) => `<option value="${esc(m.id)}"></option>`).join('');
    if (!$('#llm-model').value && rows && rows.length) $('#llm-model').value = rows[0].id;
    flash('#llm-note', rows && rows.length ? `拿到 ${rows.length} 个模型，点 model 输入框选` : '这个服务没返回模型');
  } catch (e) {
    flash('#llm-note', `拉不到：${(e && e.message) || e}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '获取模型列表';
  }
}

async function resolveWord(word, accept, btn) {
  btn.disabled = true;
  try {
    await api('/api/console/llm/pending', { method: 'POST', body: { word, accept } });
    flash('#llm-note', accept ? `已接受「${word}」` : `已丢弃「${word}」`);
    await loadLlm();
  } catch (e) {
    flash('#llm-note', `处理不了：${(e && e.message) || e}`, true);
    btn.disabled = false;
  }
}

// ── 事件 ──────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    selectedSub = pick.dataset.pick;
    detailHits = null;
    detailCands = null;
    renderSubs();
    return;
  }
  const tr = e.target.closest('tr.task-row');
  if (tr && !e.target.closest('button')) return toggleTaskRow(tr.dataset.task);
  const chip = e.target.closest('.chip');
  if (chip) {
    logType = chip.dataset.type;
    for (const c of document.querySelectorAll('#log-chips .chip')) c.classList.toggle('on', c === chip);
    return loadEvents();
  }
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'queue-toggle') return toggleQueue(t);
  if (t.id === 'side-toggle') return setSide(!$('#shell').classList.contains('collapsed'));
  if (t.id === 'sub-new') { selectedSub = null; renderSubs(); return openSubForm(null); }
  if (t.id === 'sub-stop-all') return toggleAllSubs(t);
  if (t.dataset.toggle) return toggleSub(t.dataset.toggle, t);
  if (t.id === 'sub-cancel') { $('#sub-form').hidden = true; return; }
  if (t.dataset.checkin) return cardAction(t);
  if (t.dataset.retry) return retryTask(t.dataset.retry, t);
  if (t.dataset.promote) return promoteTask(t.dataset.promote, t);
  if (t.dataset.stop) return stopTask(t.dataset.stop, t);
  if (t.dataset.run) return runSub(t.dataset.run, t);
  if (t.dataset.del) return delSub(t.dataset.del, t);
  if (t.dataset.edit) {
    const sub = subsData.find((s) => s.id === t.dataset.edit);
    return openSubForm(sub || null);
  }
  if (t.dataset.word != null && t.dataset.accept != null) {
    return resolveWord(t.dataset.word, t.dataset.accept === '1', t);
  }
});

// 站点包卡片：输入框改完就存，开关一拨就存
$('#site-cards').addEventListener('change', (e) => {
  const t = e.target;
  if (!t.dataset) return;
  if (t.dataset.gap || t.dataset.permin) return saveRate(t);
  if (t.dataset.auto) return saveAuto(t);
});

// 任务行是 <tr>，键盘要能展开：Enter / 空格当成点击
$('#task-rows').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.task-row');
  if (!row) return;
  e.preventDefault();
  row.click();
});
$('#login-recheck').addEventListener('click', () => loadSites(true));
$('#refresh').addEventListener('click', () => reloadAll());
$('#sub-form').addEventListener('submit', submitSub);
$('#f-kind').addEventListener('change', applyKind);
$('#rule-add').addEventListener('click', () => ruleRow({}));
$('#rule-rows').addEventListener('change', (e) => {
  if (e.target.classList.contains('r-site')) fillSort(e.target.closest('.rule-row'));
});
$('#rule-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del-rule]');
  if (!btn) return;
  if ($('#rule-rows').querySelectorAll('.rule-row').length <= 1) {
    flash('#sub-note', '关键字订阅至少留一条规则', true);
    return;
  }
  btn.closest('.rule-row').remove();
});
$('#llm-save').addEventListener('click', saveLlm);
$('#llm-models').addEventListener('click', fetchModels);
window.addEventListener('hashchange', route);
wireBatch();

async function reloadAll() {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    await Promise.all([loadWorkbench(true), loadTasks(), loadSubs(), loadLlm()]);
    if (currentPage === 'sites') loadSites(true); // 登录态最慢，不 await，先显示「检测中…」
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新';
  }
}

// 首屏：只加载当前分页要的数据，其它分页点过去再拉
try {
  setSide(localStorage.getItem(SIDE_KEY) === '1');
} catch {
  setSide(false);
}
route();
loadTasks(); // 侧栏脚注要显示队列状态，任务列表常驻轮询
setInterval(loadTasks, 5000);

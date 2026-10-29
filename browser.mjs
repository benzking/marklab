// 在浏览器里跑一段 JS，返回结果。两条路：
//   1) bsk —— 借用户已登录的 Chrome（下载要登录态的站点必须走这条）
//   2) 内置无头 chromium + CDP —— 扩展没连上时的兜底，只够抓公开数据
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── bsk ────────────────────────────────────────────────────────
function bskRaw(argv) {
  const r = spawnSync('bsk', [...argv, '--json'], { encoding: 'utf8', maxBuffer: 128 << 20 });
  if (r.error) return null;
  return (r.stdout || '').trim();
}

function bskSession() {
  const out = bskRaw(['session', 'list']);
  if (!out) return null;
  try {
    const list = JSON.parse(out);
    if (Array.isArray(list) && list.length) return list[0].session_id;
  } catch {}
  const started = bskRaw(['session', 'start', '--no-focus']);
  try {
    return JSON.parse(started).session_id;
  } catch {
    return null;
  }
}

export function browserConnected() {
  const out = bskRaw(['browsers']);
  return Boolean(out && !/no_browser_connected/.test(out) && /chrome|edge|chromium|brave/i.test(out));
}

async function viaBsk(url, expr, wait = 4000) {
  const session = bskSession();
  if (!session) return undefined;
  const tabOut = bskRaw(['tab', 'create', '--session', session, '--url', url]);
  let tabId;
  try {
    tabId = JSON.parse(tabOut).tab_id;
  } catch {
    return undefined;
  }
  try {
    await sleep(wait); // 新标签要等页面 hydrate，不然按钮还没挂上
    const res = bskRaw(['evaluate', '--session', session, '--tab-id', String(tabId), expr]);
    const parsed = JSON.parse(res);
    if (parsed.ok === false) throw new Error(`页面脚本失败: ${JSON.stringify(parsed).slice(0, 300)}`);
    return parsed.value;
  } finally {
    bskRaw(['tab', 'close', '--session', session, String(tabId)]);
  }
}

// ── 无头 chromium + CDP ────────────────────────────────────────
async function viaCdp(url, expr, { wait = 4000, port } = {}) {
  const chromePath = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => {
    try {
      return spawnSync('test', ['-x', p]).status === 0;
    } catch {
      return false;
    }
  });
  if (!chromePath) throw new Error('本机找不到 chromium，装一个或把 bsk 扩展连上');
  const dbg = port || 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(path.join(tmpdir(), 'modelgrab-'));
  const chrome = spawn(
    chromePath,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-crash-reporter',
     `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--window-size=1280,1000', 'about:blank'],
    { stdio: 'ignore' },
  );
  try {
    let wsUrl;
    for (let i = 0; i < 80 && !wsUrl; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
        wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
      } catch {}
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('无头 chromium 没起来');

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const n = ++seq;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      });

    await send('Page.enable');
    // 无头默认 UA 带 HeadlessChrome，会被站点 WAF 拦
    await send('Emulation.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Linux x86_64' });
    await send('Page.navigate', { url });
    await sleep(wait);
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    ws.close();
    if (res.result?.exceptionDetails) throw new Error(`页面脚本异常: ${res.result.exceptionDetails.text} ${res.result.exceptionDetails.exception?.description || ''}`.slice(0, 400));
    return res.result?.result?.value;
  } finally {
    chrome.kill('SIGKILL');
  }
}

// 先试 bsk（有登录态），不行再退到无头
export async function evalInPage(url, expr, opts = {}) {
  if (browserConnected()) {
    const v = await viaBsk(url, expr, opts.wait ?? 4000);
    if (v !== undefined) return { value: v, via: 'bsk' };
  }
  return { value: await viaCdp(url, expr, opts), via: 'cdp' };
}

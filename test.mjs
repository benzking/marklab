// 自检：node --test test.mjs
// 只测纯函数（站点识别 / Nuxt 反序列化 / 富文本清洗 / 判重规则），不联网不起浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { matchPlatform, resolveNuxt, sanitize, slugify, autoTags, catIndex, catOf, inside } from './lib.mjs';
import * as dup from './dup.mjs';

test('认得出三个站点的网址，并抽出 id', () => {
  assert.deepEqual(matchPlatform('https://space.snapmaker.cn/zh/model/1695-model?from=recommend#profileId-1773'), {
    name: 'snapmaker',
    id: '1695',
    url: 'https://space.snapmaker.cn/zh/model/1695-model',
  });
  assert.deepEqual(
    matchPlatform('https://makerworld.com.cn/zh/models/2250933-1mi-zhuang-jia-du-jiao-shou-wan-zheng-ban-shi-yan#profileId-2531474'),
    { name: 'makerworld', id: '2250933', url: 'https://makerworld.com.cn/zh/models/2250933-1mi-zhuang-jia-du-jiao-shou-wan-zheng-ban-shi-yan' },
  );
  assert.deepEqual(
    matchPlatform('https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7?source=1&recReqId=pr_x'),
    { name: 'creality', id: '68fddae0d894ed5f6ce386a7', url: 'https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7' },
  );
  assert.equal(matchPlatform('https://example.com/model/1'), null);
});

test('Nuxt 的 devalue 数组能还原成对象', () => {
  // ["ShallowReactive", {data: ref1}] / ref1 = ["Reactive", ref2] / ref2 = {name: ref3} / ref3 = "哥斯拉"
  const payload = [
    ['ShallowReactive', 1],
    { data: 2 },
    ['Reactive', 3],
    { name: 4, count: 5, list: 6 },
    '哥斯拉',
    42,
    [4, 4],
  ];
  assert.deepEqual(resolveNuxt(payload), { data: { name: '哥斯拉', count: 42, list: ['哥斯拉', '哥斯拉'] } });
});

test('清洗富文本：去脚本、去事件属性、去助力卡片', () => {
  const dirty =
    '<boostme><boosttitle>为我助力</boosttitle></boostme><p onclick="steal()">正文<script>alert(1)</script></p><a href="javascript:x()">链接</a>';
  const clean = sanitize(dirty);
  assert.ok(!clean.includes('boostme'), '促销卡片应被去掉');
  assert.ok(!clean.includes('<script'), '脚本应被去掉');
  assert.ok(!clean.includes('onclick'), '事件属性应被去掉');
  assert.ok(!clean.includes('javascript:'), 'javascript: 链接应被去掉');
  assert.ok(clean.includes('正文'), '正文要保留');
});

test('清洗走白名单：无空格的 on* 、实体编码的 javascript: 、陌生标签都过不去', () => {
  // 黑名单时代这四条全都能绕过，白名单必须挡死
  const slash = sanitize('<img/src=x/onerror=alert(1)>');
  assert.ok(!/\sonerror\s*=/i.test(slash), '斜杠分隔的 onerror 不能变成属性');
  assert.ok(/^<img src="/.test(slash), '图片标签本身留下');
  assert.ok(!/javascript/i.test(sanitize('<a href="javas&#99;ript:alert(1)">x</a>')), '实体编码协议');
  assert.ok(!/javascript/i.test(sanitize('<a href="jav&#x61;script:alert(1)">x</a>')), '十六进制实体协议');
  assert.equal(sanitize('<svg><animate onbegin=alert(1)></svg>后'), '后', 'svg 整块丢掉');
  assert.equal(sanitize('<iframe src=//evil></iframe>hi'), 'hi', 'iframe 整块丢掉');
  assert.equal(sanitize('<div style="position:fixed" title="t">x</div>'), '<div title="t">x</div>', 'style 丢掉、title 留下');
  assert.equal(sanitize('<img src="data:image/png;base64,AA" alt="图">'), '<img src="data:image/png;base64,AA" alt="图">', '图片 data URI 放行');
  assert.ok(!/href/.test(sanitize('<a href="data:text/html,<script>">x</a>')), '链接上的 data URI 不放行');
  assert.equal(sanitize('游离 < 符号'), '游离 &lt; 符号', '游离尖括号转义成文本');
});

test('文件名 slug 去掉路径与空格', () => {
  assert.equal(slugify('1b_Atom_红'), '1b_Atom_红');
  assert.equal(slugify('Mecha T-Rex / by: Melting Point'), 'Mecha-T-Rex-by-Melting-Point');
  assert.equal(slugify(''), 'model');
});

test('自动标签：精选看站点标记，热门看下载量门槛', () => {
  assert.deepEqual(autoTags('makerworld', { downloads: 1138, picked: false }), ['热门']);
  assert.deepEqual(autoTags('makerworld', { downloads: 10, picked: true }), ['精选']);
  assert.deepEqual(autoTags('creality', { downloads: 909 }), []);
  assert.deepEqual(autoTags('snapmaker', { downloads: 21 }), []);
});

test('STL 预览：三角面数与外形尺寸', async () => {
  const { inspectFile } = await import('./inspect.mjs');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'stl-'));
  // 一个 1×2×3 的三角形（3 个顶点，n=1）
  const buf = Buffer.alloc(84 + 50);
  buf.writeUInt32LE(1, 80);
  const verts = [[0, 0, 0], [1, 0, 0], [0, 2, 3]];
  verts.forEach((v, i) => v.forEach((x, a) => buf.writeFloatLE(x, 84 + i * 12 + a * 4)));
  const file = path.join(dir, 'a.stl');
  await writeFile(file, buf);
  const info = await inspectFile(file);
  assert.equal(info.kind, 'stl');
  assert.equal(info.triangles, 1);
  assert.deepEqual(info.sizeMm, [1, 2, 3]);
});

test('不是 zip 的文件要报错而不是崩', async () => {
  const { readZip } = await import('./inspect.mjs');
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /EOCD|zip/);
});

test('MakerOnline 的网址能认出 id', () => {
  const u = 'https://www.makeronline.com/zh/model/Panther%20Tankhead%20Mech,%20easy%20to%20print%20and%20assemble,%20movable%20gun%20barrel,%20gear%20joints,%20World%20War%20II/341770.html?trackModuleType=4';
  assert.deepEqual(matchPlatform(u), { name: 'makeronline', id: '341770', url: 'https://www.makeronline.com/zh/model/Panther%20Tankhead%20Mech,%20easy%20to%20print%20and%20assemble,%20movable%20gun%20barrel,%20gear%20joints,%20World%20War%20II/341770.html' });
  // 搜索结果里给的网址没有 /zh/ 前缀，标题直接进路径：漏了这条 15 个命中全被当「不支持的站点」丢掉
  const a = matchPlatform('https://www.makeronline.cn/model/皮卡丘/239813.html');
  assert.equal(a.name, 'makeronline'); assert.equal(a.id, '239813');
  assert.ok(a.url.startsWith('https://www.makeronline.cn/model/'), '重组网址带原路径');
  const b = matchPlatform('https://www.makeronline.cn/zh/model/古代混浊-341770.html');
  assert.equal(b.name, 'makeronline'); assert.equal(b.id, '341770');
  assert.ok(b.url.startsWith('https://www.makeronline.cn/zh/model/'), '重组网址带原路径');
});

test('创想云带 profileId 的 3mf 版网址也能认出 id', () => {
  const u = 'https://www.crealitycloud.cn/model-detail/6a8ab5076a693e6edad42a03?source=8&profileId=6a8ab5096a693eedad42a6c';
  assert.deepEqual(matchPlatform(u), { name: 'creality', id: '6a8ab5076a693e6edad42a03', url: 'https://www.crealitycloud.cn/model-detail/6a8ab5076a693e6edad42a03' });
});

test('MakerOnline 国内站 .cn 也认', () => {
  const u = 'https://www.makeronline.cn/zh/model/%E5%8F%A4%E4%BB%A3%E6%B7%B7%E6%B2%8C%E4%B9%8B%E5%BA%93/207581.html';
  assert.deepEqual(matchPlatform(u), { name: 'makeronline', id: '207581', url: 'https://www.makeronline.cn/zh/model/%E5%8F%A4%E4%BB%A3%E6%B7%B7%E6%B2%8C%E4%B9%8B%E5%BA%93/207581.html' });
});

test('分类对照表把四站每个分类都收进来', () => {
  const sites = JSON.parse(readFileSync(new URL('./docs/categories/sites.json', import.meta.url), 'utf8')).sites;
  const merge = JSON.parse(readFileSync(new URL('./docs/categories/merge.json', import.meta.url), 'utf8'));
  const used = new Set();
  for (const l1 of merge.level1) {
    for (const node of [l1, ...l1.children]) {
      for (const [site, ids] of Object.entries(node.sites)) {
        assert.equal(new Set(ids).size, ids.length, `${site} 在 ${node.name} 里重复列了 id`);
        for (const id of ids) used.add(`${site}:${id}`);
      }
    }
  }
  for (const [site, tree] of Object.entries(sites)) {
    for (const c of tree) {
      for (const id of [c.id, ...c.children.map((x) => x.id)]) {
        assert.ok(used.has(`${site}:${id}`), `${site}:${id} ${c.name} 没被对照表收录`);
      }
    }
  }
});

test('模型能按原站分类名落到统一分类，同名歧义不硬猜', () => {
  const sites = JSON.parse(readFileSync(new URL('./docs/categories/sites.json', import.meta.url), 'utf8')).sites;
  const merge = JSON.parse(readFileSync(new URL('./docs/categories/merge.json', import.meta.url), 'utf8'));
  const map = catIndex(sites, merge);
  // 唯一名字直接落
  assert.deepEqual(catOf(map, 'snapmaker', '面具与头盔'), { l1: 'cosplay', l2: 'cosplay.mask' });
  assert.deepEqual(catOf(map, 'creality', '机器人与机甲'), { l1: 'hobby', l2: 'hobby.robot' });
  // MakerOnline 的「一级 / 二级」用一级名排歧义：两处「服装」分属时尚和角色扮演
  assert.deepEqual(catOf(map, 'makeronline', '时尚 / 服装'), { l1: 'fashion', l2: 'fashion.clothes' });
  assert.deepEqual(catOf(map, 'makeronline', '服装与角色扮演 / 服装'), { l1: 'cosplay', l2: 'cosplay.costume' });
  // 创想云 9 个「其他」分不清是哪一个 → 宁可留空
  assert.equal(catOf(map, 'creality', '其他'), null);
  assert.equal(catOf(map, 'makeronline', 'Hobby&DIY / Automotive'), null);
});

test('路径校验认真实位置，软链接指出去的一律不算', async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const base = await mkdtemp(path.join(os.tmpdir(), 'marklab-inside-'));
  try {
    const lib = path.join(base, 'library');
    await mkdir(path.join(lib, 'm-1'), { recursive: true });
    await writeFile(path.join(lib, 'm-1', 'model.json'), '{}');
    await writeFile(path.join(base, 'outside.txt'), 'SECRET');
    // 词法上都在 library 里，只有跟到真实路径才看得出是外面
    await symlink(path.join(base, 'outside.txt'), path.join(lib, 'evil.json'));
    await symlink(base, path.join(lib, 'evil-dir'));

    assert.equal(await inside(lib, path.join(lib, 'm-1', 'model.json')), true);
    assert.equal(await inside(lib, lib), true);
    assert.equal(await inside(lib, path.join(lib, 'evil.json')), false);
    assert.equal(await inside(lib, path.join(lib, 'evil-dir', 'outside.txt')), false);
    assert.equal(await inside(lib, path.join(lib, '..', 'outside.txt')), false);
    assert.equal(await inside(lib, path.join(lib, '不存在')), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('判重：同站标题+作者即重复，跨站要先撞 hash，同网址重抓不算重复', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'marklab-dup-'));
  const lib = path.join(base, 'library');
  const put = async (dir, model) => {
    await mkdir(path.join(lib, dir), { recursive: true });
    await writeFile(path.join(lib, dir, 'model.json'), JSON.stringify(model));
  };
  try {
    await put('creality-aaa', {
      platform: 'creality', id: 'aaa', title: 'Benchy 小船', author: 'Tom', fetchedAt: '2026-01-01T00:00:00Z',
      savedFiles: [{ name: 'a.stl', sha256: 'h1', origin: 'author' }, { name: 'b.stl', sha256: 'h2' }],
    });
    const model = (platform, id, title, author) => ({ platform, id, title, author });

    // 同网址：同目录重抓/补抓，不算重复
    assert.equal(await dup.check(model('creality', 'aaa', 'Benchy 小船', 'Tom'), lib), null);
    // 同站、id 不同、标题+作者相同 → 确定重复
    const same = await dup.check(model('creality', 'bbb', 'benchy-小船！', 'TOM'), lib);
    assert.deepEqual([same.of, same.by, same.same], ['creality:aaa', 'meta', true]);
    // 跨站、标题+作者相同 → 只是疑似
    const cross = await dup.check(model('snapmaker', '9', 'Benchy 小船', 'Tom'), lib);
    assert.deepEqual([cross.of, cross.by, cross.same], ['creality:aaa', 'meta', false]);
    // 作者不同 → 不是重复（两个人都叫 Benchy 也不算）
    assert.equal(await dup.check(model('snapmaker', '9', 'Benchy 小船', 'Jerry'), lib), null);

    // 跨站确认：作者件 hash 撞上才算
    assert.equal(await dup.confirm('creality:aaa', [{ sha256: 'h2' }], lib), true);
    assert.equal(await dup.confirm('creality:aaa', [{ sha256: 'zzz' }], lib), false);
    // 别人加的配置不参与比 hash
    assert.equal(await dup.confirm('creality:aaa', [{ sha256: 'h1', origin: 'other' }], lib), false);
    // 没下到文件时确认不了，只能停在疑似
    assert.equal(await dup.confirm('creality:aaa', [], lib), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('网址只认 hostname 白名单，路径才跑正则（构造网址进不来）', () => {
  // 伪造站：真站域名只出现在 fragment / query，host 不是白名单 → 不认
  assert.equal(matchPlatform('http://evil.example/x#https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7'), null);
  assert.equal(matchPlatform('http://127.0.0.1:8851/api/models?u=https://space.snapmaker.cn/model/1'), null);
  assert.equal(matchPlatform('https://makerworld.com.cn.evil.example/models/2250933'), null);
  // 大小写与 www 归一
  const a = matchPlatform('https://WWW.CREALITYCLOUD.CN/Model-Detail/68fddae0d894ed5f6ce386a7');
  assert.deepEqual([a.name, a.id], ['creality', '68fddae0d894ed5f6ce386a7']);
  // 只认 https/http
  assert.equal(matchPlatform('file:///etc/passwd#https://makerworld.com/models/1'), null);
});

test('站点包与公共层认同一个网址，包认不出就交回 matchPlatform', async () => {
  const sites = await import('./sites/index.mjs');
  const a = sites.match('https://space.snapmaker.cn/zh/model/1695-kuai-su');
  assert.deepEqual([a.name, a.id], ['snapmaker', '1695']);
  // 包重组出来的地址要能再被自己认出来（抓取只用它，不能越重组越跑偏）
  assert.deepEqual(sites.match(a.url), a);
  assert.equal(sites.match('http://evil/x#https://space.snapmaker.cn/zh/model/1'), null);
  assert.equal(sites.match('https://space.snapmaker.cn.evil.example/zh/model/1'), null);
  // 还没搬进包的三个站仍然认
  assert.equal(sites.match('https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7'), null);
  assert.equal(matchPlatform('https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7')?.name, 'creality');
});

test('MARKLAB_ROOT 缝：根目录可注入，临时根里跑判重', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-root-'));
  const lib = path.join(base, 'library');
  await mkdir(path.join(lib, 'm-1'), { recursive: true });
  await writeFile(path.join(lib, 'm-1', 'model.json'), JSON.stringify({ platform: 'creality', id: 'aaa', title: 'Benchy 小船', author: 'Tom' }));
  const child = await new Promise((res, rej) => {
    const cp = spawn(process.execPath, ['-e', `
      import { ROOT } from '/home/gly/marklab/lib.mjs';
      process.stdout.write(ROOT);
    `], { env: { ...process.env, MARKLAB_ROOT: base } });
    let out = ''; cp.stdout.on('data', (d) => (out += d)); cp.on('error', rej); cp.on('close', () => res(out));
  });
  assert.equal(child, base, '子进程应指到注入的根');
  await rm(base, { recursive: true, force: true });
});

// 在临时根里起一个独立的 tasks 进程（模块级状态互不干扰），跑完收尸
async function runTasks(code, base) {
  const cp = spawn(process.execPath, ['-e', code], {
    env: { ...process.env, MARKLAB_ROOT: base },
  });
  let out = '';
  let err = '';
  cp.stdout.on('data', (d) => (out += d));
  cp.stderr.on('data', (d) => (err += d));
  await new Promise((res) => cp.on('close', res));
  return { out, err };
}

test('入队去重：同一网址排着/在跑/24 小时内完成过的不重复排队', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-queue-'));
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    const url = 'https://space.snapmaker.cn/zh/model/1021-model';
    const a = tasks.enqueue({ url, source: 'bulk' });
    const b = tasks.enqueue({ url, source: 'bulk' });   // 在排 = 去重
    const c = tasks.enqueue({ url, source: 'manual' });  // 手动也算
    console.log(JSON.stringify({
      sameId: a.task.id === b.task.id && a.task.id === c.task.id,
      queued: tasks.queueDepth(),
    }));
    // 结束进程，别真的跑 grab（也不该跑：pump 会 spawn，这里直接退出）
    process.exit(0);
  `;
  const { out, err } = await runTasks(code, base);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.sameId, true, '重复网址应返回同一条任务');
  assert.equal(j.queued, 1, '只应排一条');
  assert.equal(err, '', '不应有报错');
  await rm(base, { recursive: true, force: true });
});

test('restore 只恢复本进程排队名单，jsonl 里别的进程排队的不抢', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-restore-'));
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    import { mkdir, writeFile, appendFile } from 'node:fs/promises';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const url = 'https://space.snapmaker.cn/zh/model/1021-model';
    const a = tasks.enqueue({ url, source: 'bulk' }); // 本进程排一条 → queue.json 记它的 id
    // 另一条 jsonl 行代表「别的进程排的」，只存在于 jsonl、不在 queue.json
    await mkdir(path.join(process.env.MARKLAB_ROOT, 'data', 'tasks'), { recursive: true });
    const month = path.join(process.env.MARKLAB_ROOT, 'data', 'tasks', new Date().toISOString().slice(0, 7) + '.jsonl');
    await appendFile(month, JSON.stringify({ id: 't-other', url: 'https://space.snapmaker.cn/zh/model/1022-model', phase: 'queued', createdAt: new Date().toISOString() }) + '\\n');
    // 重新进一个全新模块实例，模拟重启：restore 只应把 queue.json 里那一条捞回来
    const again = await import('/home/gly/marklab/tasks.mjs?restore=' + Date.now());
    const r = await again.restore();
    const list = again.list();
    const tOther = list.find((t) => t.id === 't-other');
    console.log(JSON.stringify({ resumed: r.resumed, hasMine: list.some((t) => t.id === a.task.id), otherPhase: tOther?.phase }));
    process.exit(0);
  `;
  const { out, err } = await runTasks(code, base);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.resumed, 1, '只恢复本进程那一条');
  assert.equal(j.hasMine, true, '本进程任务在');
  assert.notEqual(j.otherPhase, 'fetching', '别的进程排队的不许开跑');
  assert.equal(err, '', '不应有报错');
  await rm(base, { recursive: true, force: true });
});

test('闸门持久化：finish 后 nextOkAt 写进 queue.json，restore 读回', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-gate-'));
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    const url = 'https://space.snapmaker.cn/zh/model/1022-model';
    const a = tasks.enqueue({ url, source: 'bulk' });
    // 伪造一条「已下过文件」的收尾，触发 nextOkAt 推进
    a.task.progress.done = 1;
    tasks._testFinish(a.task.id);
    await new Promise((r) => setTimeout(r, 300)); // saveState 是异步 fire-and-forget，等它落盘
    const st = JSON.parse(await readFile(path.join(process.env.MARKLAB_ROOT, 'data', 'queue.json'), 'utf8'));
    console.log(JSON.stringify({ hasNext: Number(st.nextOkAt) > 0 }));
    process.exit(0);
  `;
  const { out } = await runTasks(code, base);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.hasNext, true, 'nextOkAt 应持久化到 queue.json');
  await rm(base, { recursive: true, force: true });
});

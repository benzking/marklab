// 自检：node --test test.mjs
// 只测纯函数（站点识别 / Nuxt 反序列化 / 富文本清洗 / 判重规则），不联网不起浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { autoTags, catIndex, catOf, inside, noFilesKind, resolveNuxt, sanitize, slugify } from './lib.mjs';
import * as sitePacks from './sites/index.mjs';

// 站点识别搬进站点包了（票 06）。这里留一层薄壳，老断言不用改：包里叫 site，这里叫 name。
const matchPlatform = (u) => {
  const h = sitePacks.match(u);
  return h ? { name: h.site, id: h.id, url: h.url } : null;
};
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
  assert.deepEqual(matchPlatform(u), { name: 'makeronline.com', id: '341770', url: 'https://www.makeronline.com/zh/model/Panther%20Tankhead%20Mech,%20easy%20to%20print%20and%20assemble,%20movable%20gun%20barrel,%20gear%20joints,%20World%20War%20II/341770.html' });
  // 搜索结果里给的网址没有 /zh/ 前缀，标题直接进路径：漏了这条 15 个命中全被当「不支持的站点」丢掉
  const a = matchPlatform('https://www.makeronline.cn/model/皮卡丘/239813.html');
  assert.equal(a.name, 'makeronline.cn'); assert.equal(a.id, '239813');
  assert.ok(a.url.startsWith('https://www.makeronline.cn/model/'), '重组网址带原路径');
  const b = matchPlatform('https://www.makeronline.cn/zh/model/古代混浊-341770.html');
  assert.equal(b.name, 'makeronline.cn'); assert.equal(b.id, '341770');
  assert.ok(b.url.startsWith('https://www.makeronline.cn/zh/model/'), '重组网址带原路径');
});

test('创想云带 profileId 的 3mf 版网址也能认出 id', () => {
  const u = 'https://www.crealitycloud.cn/model-detail/6a8ab5076a693e6edad42a03?source=8&profileId=6a8ab5096a693eedad42a6c';
  assert.deepEqual(matchPlatform(u), { name: 'creality', id: '6a8ab5076a693e6edad42a03', url: 'https://www.crealitycloud.cn/model-detail/6a8ab5076a693e6edad42a03' });
});

test('MakerOnline 国内站 .cn 也认', () => {
  const u = 'https://www.makeronline.cn/zh/model/%E5%8F%A4%E4%BB%A3%E6%B7%B7%E6%B2%8C%E4%B9%8B%E5%BA%93/207581.html';
  assert.deepEqual(matchPlatform(u), { name: 'makeronline.cn', id: '207581', url: 'https://www.makeronline.cn/zh/model/%E5%8F%A4%E4%BB%A3%E6%B7%B7%E6%B2%8C%E4%B9%8B%E5%BA%93/207581.html' });
});

test('加一个站点只碰一个文件：假站点包注册后就能走 match → meta → fileLinks', async () => {
  const fixture = await import('./sites/_fixture.mjs');
  sitePacks.registerForTest(fixture.default);
  const hit = sitePacks.match('https://fixture.example/thing/7?from=search#x');
  assert.deepEqual(hit, { site: 'fixture', id: '7', url: 'https://fixture.example/thing/7' });
  const pack = sitePacks.byName('fixture');
  assert.equal(pack.platform, 'fixture');
  const model = await pack.meta(hit.url);
  assert.equal(model.title, '假站点模型');
  assert.equal(model.files[0].origin, 'author');
  const links = await pack.fileLinks(model);
  assert.deepEqual(links.map((l) => [l.name, l.kind]), [['a.stl', 'model']]);
  // 生产登记表里没有它：五个真包 + 刚注册的这一个
  assert.equal(sitePacks.all().length, 6);
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

    // 跨站确认：作者件 hash 撞上才算，返回的是撞上的那几个（证据要能复查）
    assert.deepEqual(await dup.confirm('creality:aaa', [{ sha256: 'h2' }], lib), ['h2']);
    assert.deepEqual(await dup.confirm('creality:aaa', [{ sha256: 'zzz' }], lib), []);
    // 别人加的配置不参与比 hash
    assert.deepEqual(await dup.confirm('creality:aaa', [{ sha256: 'h1', origin: 'other' }], lib), []);
    // 没下到文件时确认不了，只能停在疑似
    assert.deepEqual(await dup.confirm('creality:aaa', [], lib), []);

    // 同站和跨站都有候选时选同站那条：同站是「确认」，不能被跨站的先到先得降级成「疑似」
    await put('snapmaker-9', {
      platform: 'snapmaker', id: '9', title: 'Benchy 小船', author: 'Tom', fetchedAt: '2025-12-31T00:00:00Z',
      savedFiles: [],
    });
    const both = await dup.check(model('creality', 'ccc', 'Benchy 小船', 'Tom'), lib);
    assert.deepEqual([both.of, both.same], ['creality:aaa', true], '同站候选优先，哪怕跨站那条入库更早');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('重复标记记 scope 与撞上的 hash，删模型时两个方向一起清', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'marklab-dupmarks-'));
  const file = path.join(base, 'duplicates.json');
  try {
    await dup.record('creality', 'bbb', { of: 'creality:aaa', by: 'meta', same: true }, { title: '小船', author: 'Tom' }, file);
    await dup.record('snapmaker', '9', { of: 'creality:aaa', by: 'hash', same: false }, { title: '小船', author: 'Tom', hashes: ['h2'] }, file);
    const all = await dup.marks(file);
    assert.equal(all['creality:bbb'].scope, 'same');
    assert.equal(all['snapmaker:9'].scope, 'cross');
    assert.deepEqual(all['snapmaker:9'].hashes, ['h2'], '只记撞上的那个，不记本次全部文件');
    // 删掉被指向的那个：以它为 of 的两条都要消失，否则页面链到不存在的目录
    assert.equal(await dup.forget('creality:aaa', file), true);
    assert.deepEqual(Object.keys(await dup.marks(file)), []);
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

test('站点包与公共层认同一个网址，四站都已进包', async () => {
  const sites = await import('./sites/index.mjs');
  const a = sites.match('https://space.snapmaker.cn/zh/model/1695-kuai-su');
  assert.deepEqual([a.site, a.id], ['snapmaker', '1695']);
  // 包重组出来的地址要能再被自己认出来（抓取只用它，不能越重组越跑偏）
  assert.deepEqual(sites.match(a.url), a);
  assert.equal(sites.match('http://evil/x#https://space.snapmaker.cn/zh/model/1'), null);
  assert.equal(sites.match('https://space.snapmaker.cn.evil.example/zh/model/1'), null);
  // 已经搬进包的站，包和公共层认的是同一个 id
  const c = sites.match('https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7');
  assert.deepEqual([c.site, c.id], ['creality', '68fddae0d894ed5f6ce386a7']);
  // MakerOnline 两个域各自成包，数据键都是 makeronline（库目录/判重键不分域）
  const cn = sites.match('https://www.makeronline.cn/zh/model/x/207581.html');
  assert.deepEqual([cn.site, cn.id], ['makeronline.cn', '207581']);
  assert.equal(sites.byName('makeronline.cn').platform, 'makeronline');
  // 订阅/搜索沿用旧键 makeronline，要落到 .cn 这个包上
  assert.equal(sites.byName('makeronline').site, 'makeronline.cn');
  // .com 是另一个独立包，数据键同样是 makeronline
  const com = sites.match('https://www.makeronline.com/zh/model/x/341770.html');
  assert.deepEqual([com.site, com.id], ['makeronline.com', '341770']);
  assert.equal(sites.byName('makeronline.com').platform, 'makeronline');
  // 两个包互不认对方的域（两套登录态，混了就认错人）
  assert.equal(sites.byName('makeronline.cn').match('https://www.makeronline.com/model/x/1.html'), null);
  assert.equal(sites.byName('makeronline.com').match('https://www.makeronline.cn/model/x/1.html'), null);
  // 四站都进包了，包和公共层对每个站都认同一个 id
  for (const [url, name, id] of [
    ['https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7', 'creality', '68fddae0d894ed5f6ce386a7'],
    ['https://makerworld.com.cn/zh/models/195581', 'makerworld', '195581'],
    ['https://space.snapmaker.cn/zh/model/1695-kuai-su', 'snapmaker', '1695'],
    ['https://www.makeronline.cn/zh/model/x/207581.html', 'makeronline.cn', '207581'],
    ['https://www.makeronline.com/zh/model/x/341770.html', 'makeronline.com', '341770'],
  ]) {
    const hit = sites.match(url);
    assert.deepEqual([hit.site, hit.id], [name, id], url);
    assert.equal(matchPlatform(url)?.id, id, url);
  }
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

// 起一个独立 node 进程跑一段代码（模块级状态互不干扰），返回它的 stdout
async function runNode(code, extraEnv = {}) {
  const cp = spawn(process.execPath, ['-e', code], {
    cwd: '/home/gly/marklab',
    env: { ...process.env, ...extraEnv },
  });
  let out = '';
  let err = '';
  cp.stdout.on('data', (d) => (out += d));
  cp.stderr.on('data', (d) => (err += d));
  const code_ = await new Promise((res) => cp.on('close', res));
  if (code_ !== 0) throw new Error(`子进程退出 ${code_}: ${err.slice(0, 300)}`);
  return out;
}

// 在临时根里起一个独立的 tasks 进程（模块级状态互不干扰），跑完收尸
async function runTasks(code, base) {
  const cp = spawn(process.execPath, ['-e', code], {
    // NOSPAWN：队列语义的测试不真的起 grab（不联网、不开浏览器）
    env: { ...process.env, MARKLAB_ROOT: base, MARKLAB_TEST_NOSPAWN: '1' },
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
    tasks.pause(); // 让它停在队里，别在 restore 前就跑完
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

test('暂停中手动入队只放行这一条，paused 不动，队列里其余一条不跑', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-force-'));
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    const u = (n) => 'https://space.snapmaker.cn/zh/model/' + n + '-x';
    tasks.pause();
    tasks.enqueue({ url: u(1), source: 'bulk' });
    tasks.enqueue({ url: u(2), source: 'bulk' });
    const m = tasks.enqueue({ url: u(3), source: 'manual' }); // 暂停中手动点
    await new Promise((r) => setTimeout(r, 300));
    const st = JSON.parse(await readFile(path.join(process.env.MARKLAB_ROOT, 'data', 'queue.json'), 'utf8'));
    console.log(JSON.stringify({
      paused: tasks.state().paused,
      savedPaused: st.paused,
      phase3: tasks.get(m.task.id).phase,
      queued: tasks.queueDepth(),
      noUrlInState: !JSON.stringify(st).includes('http'),
    }));
    process.exit(0);
  `;
  const { out, err } = await runTasks(code, base);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.paused, true, '暂停不该被手动入队解除');
  assert.equal(j.savedPaused, true, '暂停位要落盘');
  assert.equal(j.phase3, 'done', '手动点的那一条要真的跑起来');
  assert.equal(j.queued, 2, '其余两条仍在排队，一条都没跑');
  assert.equal(j.noUrlInState, true, 'queue.json 只存 id，不存任务本体');
  assert.equal(err, '', '不应有报错');
  await rm(base, { recursive: true, force: true });
});

test('每站一条队轮转：一个站积压不挡别的站出队', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-lane-'));
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    const A = (n) => 'https://www.crealitycloud.cn/model-detail/' + String(n).padStart(24, '0');
    const B = (n) => 'https://space.snapmaker.cn/zh/model/' + n + '-x';
    // 暂停着排完四条再放行：模拟一批积压，轮转顺序才是确定的
    tasks.pause();
    for (const n of [1, 2, 3]) tasks.enqueue({ url: A(n), source: 'bulk' });
    tasks.enqueue({ url: B(9), source: 'bulk' });
    tasks.resume();
    for (let i = 0; i < 100 && tasks.queueDepth(); i++) await new Promise((r) => setTimeout(r, 30));
    const order = tasks.list().filter((t) => t.phase === 'done')
      .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
      .map((t) => t.site);
    console.log(JSON.stringify({ order, left: tasks.queueDepth() }));
    process.exit(0);
  `;
  const { out, err } = await runTasks(code, base);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.left, 0, '队列应跑空');
  assert.deepEqual(j.order, ['creality', 'snapmaker', 'creality', 'creality'], '两个站要轮转，不按入队顺序一路走完');
  assert.equal(err, '', '不应有报错');
  await rm(base, { recursive: true, force: true });
});

test('失败过的网址能重抓，成功过的 24 小时内不重排', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-retry-'));
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    import { mkdir, appendFile } from 'node:fs/promises';
    import path from 'node:path';
    const url = 'https://space.snapmaker.cn/zh/model/1021-model';
    const failedUrl = 'https://space.snapmaker.cn/zh/model/1022-model';
    // 一条 24 小时内失败过的（上一轮抓到一半崩了）
    await mkdir(path.join(process.env.MARKLAB_ROOT, 'data', 'tasks'), { recursive: true });
    const month = path.join(process.env.MARKLAB_ROOT, 'data', 'tasks', new Date().toISOString().slice(0, 7) + '.jsonl');
    const old = { id: 't-old', url: failedUrl, site: 'snapmaker', phase: 'failed', rounds: 3, createdAt: new Date().toISOString(), endedAt: new Date().toISOString(), ok: false, progress: { done: 0, total: 0, name: '' } };
    await appendFile(month, JSON.stringify(old) + '\\n');
    const again = await import('/home/gly/marklab/tasks.mjs?r=' + Date.now());
    await again.restore();
    const a = again.enqueue({ url, source: 'bulk' });
    for (let i = 0; i < 60 && again.queueDepth(); i++) await new Promise((r) => setTimeout(r, 30));
    const b = again.enqueue({ url, source: 'bulk' });   // 成功过 → 拦
    const c = again.enqueue({ url: failedUrl, source: 'manual' }); // 失败过 → 放行
    console.log(JSON.stringify({
      sameAfterDone: b.task.id === a.task.id,
      failedAllowed: c.task.id !== 't-old',
      rounds: c.task.rounds,
    }));
    process.exit(0);
  `;
  const { out, err } = await runTasks(code, base);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.sameAfterDone, true, '24 小时内成功过的不重复入队');
  assert.equal(j.failedAllowed, true, '失败过的网址要能重新入队');
  assert.equal(j.rounds, 0, '新一轮从 0 开始计数');
  assert.equal(err, '', '不应有报错');
  await rm(base, { recursive: true, force: true });
});

test('人点停止是 stopped 终态：不计失败、rounds 不动', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-stop-'));
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    const url = 'https://space.snapmaker.cn/zh/model/1021-model';
    // 暂停着排，它就停在队里，这时点停止
    tasks.pause();
    const b = tasks.enqueue({ url: 'https://space.snapmaker.cn/zh/model/1030-x', source: 'bulk' });
    tasks.stop(b.task.id);
    const t = tasks.get(b.task.id);
    console.log(JSON.stringify({ phase: t.phase, rounds: t.rounds, failed: tasks.stats().failed24h }));
    process.exit(0);
  `;
  const { out, err } = await runTasks(code, base);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.phase, 'stopped', '停止要记 stopped 终态');
  assert.equal(j.rounds, 0, '停止不改 rounds');
  assert.equal(j.failed, 0, '停止不计入失败');
  assert.equal(err, '', '不应有报错');
  await rm(base, { recursive: true, force: true });
});

test('子进程挂死：先 SIGTERM 让它收尾，5 秒后 SIGKILL，任务记超时', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-hang-'));
  // 临时根里放一个「收到 SIGTERM 也不退」的假 grab，专门验杀进程这条路
  await writeFile(
    path.join(base, 'grab.mjs'),
    'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n',
  );
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    const a = tasks.enqueue({ url: 'https://space.snapmaker.cn/zh/model/1021-model', source: 'bulk' });
    // 只看第一轮：被杀了就说明 SIGTERM→SIGKILL 这条路通了，后面的重排不用等
    let t = tasks.get(a.task.id);
    for (let i = 0; i < 100 && !(t.rounds > 0 && t.error); i++) {
      await new Promise((r) => setTimeout(r, 100));
      t = tasks.get(a.task.id);
    }
    console.log(JSON.stringify({ phase: t.phase, rounds: t.rounds, error: t.error }));
    process.exit(0);
  `;
  const cp = spawn(process.execPath, ['-e', code], {
    env: { ...process.env, MARKLAB_ROOT: base, MARKLAB_TASK_TIMEOUT_MS: '300' },
  });
  let out = '';
  cp.stdout.on('data', (d) => (out += d));
  await new Promise((res) => cp.on('close', res));
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.rounds, 1, '挂死的一轮要计一次失败');
  assert.match(j.error, /超时/, '错误串要是人话（超时），不是堆栈');
  await rm(base, { recursive: true, force: true });
});

test('登录态：请求失败不写成未登录，重新检测会跳过缓存', async () => {
  const { mergeUnknown } = await import('./session.mjs');
  const prev = [
    { site: 'a', ok: true, status: 'logged-in', name: '甲' },
    { site: 'b', ok: false, status: 'logged-out' },
    { site: 'c', ok: false, status: 'unknown' },
  ];
  const fresh = [
    { site: 'a', ok: false, status: 'unknown', reason: '探测超时' },
    { site: 'b', ok: false, status: 'unknown', reason: '探测超时' },
    { site: 'c', ok: false, status: 'unknown', reason: '探测超时' },
  ];
  const out = mergeUnknown(prev, fresh);
  assert.equal(out[0].status, 'logged-in', '已知登录态不该被一次失败盖掉');
  assert.equal(out[0].stale, true, '要标出这是上次的结果');
  assert.equal(out[1].status, 'logged-out', '已知未登录同样保留');
  assert.equal(out[2].status, 'unknown', '本来就是 unknown 就还是 unknown');
  assert.equal(mergeUnknown(null, fresh)[0].status, 'unknown', '没有旧结果时照实报');
});

test('登录态：探测卡住时按超时收口，返回 unknown 而不是挂住', async () => {
  const code = `
    import * as sites from './sites/index.mjs';
    sites.registerForTest({ site: '慢站', label: '慢站', hosts: ['slow.example'],
      loginState: () => new Promise(() => {}), meta() {}, fileLinks() {}, search() {}, userModels() {} });
    const sess = await import('./session.mjs');
    const t = Date.now();
    const r = await sess.probe('慢站');
    console.log(JSON.stringify({ status: r.status, ms: Date.now() - t, reason: r.reason }));
  `;
  const out = await runNode(code, { MARKLAB_PROBE_TIMEOUT_MS: '200' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.status, 'unknown', '卡住要归 unknown');
  assert.ok(r.ms < 5000, '要按超时收口，不是一直等');
  assert.match(r.reason, /超时/, '原因要说清是超时');
});

test('没下到文件的原因：登录/人机验证/解析/站点不给/这次没下，分得开', () => {
  const k = (o) => noFilesKind({ wantFiles: true, savedCount: 0, hasFiles: true, linkErr: '', ...o });
  assert.equal(noFilesKind({ wantFiles: false, savedCount: 0, hasFiles: true, linkErr: '' }), 'skipped', '--no-files 不算失败');
  assert.equal(k({ linkErr: '下载链接要登录：先在浏览器登录创想云' }), 'login');
  assert.equal(k({ linkErr: '下载要过人机验证（code 1003）' }), 'captcha', '人机验证要单独一类');
  assert.equal(k({ linkErr: '拿了 0 个链接' }), 'parse', '有文件列表却没链接 = 解析没拿到');
  assert.equal(k({ hasFiles: false, linkErr: '' }), 'none', '站点压根没给文件');
  assert.equal(k({ savedCount: 3 }), null, '下到了就不记原因');
});

test('失败原因走结构化事件：任务记人话分类，不是 Node.js v20.19.2', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-fail-'));
  // 假 grab：按抓取侧的口径发一条 failed 事件再退出（模拟「要登录」）
  await writeFile(
    path.join(base, 'grab.mjs'),
    `process.stdout.write('@@TASK {"phase":"failed","code":"login","text":"要登录才有文件：先在浏览器登录该站，再补抓","detail":"memberDownload 拒绝（code 1）"}\\n');
process.exit(1);
`,
  );
  const code = `
    import * as tasks from '/home/gly/marklab/tasks.mjs';
    const a = tasks.enqueue({ url: 'https://space.snapmaker.cn/zh/model/1021-model', source: 'bulk' });
    let t = tasks.get(a.task.id);
    for (let i = 0; i < 100 && !t.error; i++) {
      await new Promise((r) => setTimeout(r, 100));
      t = tasks.get(a.task.id);
    }
    console.log(JSON.stringify({ phase: t.phase, code: t.errorCode, error: t.error, detail: t.errorDetail }));
    process.exit(0);
  `;
  const cp = spawn(process.execPath, ['-e', code], { env: { ...process.env, MARKLAB_ROOT: base } });
  let out = '';
  cp.stdout.on('data', (d) => (out += d));
  await new Promise((res) => cp.on('close', res));
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.code, 'login', '分类要落到任务上');
  assert.match(j.error, /要登录才有文件/, '错误串要是人话');
  assert.doesNotMatch(j.error, /Node\.js v/, '不许把 node 版本横幅当错误');
  assert.match(j.detail, /memberDownload/, '原文要留着给人看');
  await rm(base, { recursive: true, force: true });
});

test('判重索引每轮重建：别的进程新写的模型，下一轮订阅能看见', async () => {
  const { index } = await import('./dup.mjs');
  const lib = await mkdtemp(path.join(os.tmpdir(), 'ml-idx-'));
  await mkdir(path.join(lib, 'creality-aaa'), { recursive: true });
  await writeFile(
    path.join(lib, 'creality-aaa', 'model.json'),
    JSON.stringify({ platform: 'creality', id: 'aaa', title: '甲', author: '乙', fetchedAt: new Date().toISOString() }),
  );
  const first = await index(true, lib);
  assert.equal(first.keys.has('creality:aaa'), true, '第一次建索引能看到已有模型');
  // 模拟别的进程刚入库
  await mkdir(path.join(lib, 'creality-bbb'), { recursive: true });
  await writeFile(
    path.join(lib, 'creality-bbb', 'model.json'),
    JSON.stringify({ platform: 'creality', id: 'bbb', title: '丙', author: '丁', fetchedAt: new Date().toISOString() }),
  );
  assert.equal((await index(true, lib)).keys.has('creality:bbb'), true, 'force 重建要看到新模型');
  await rm(lib, { recursive: true, force: true });
});

// ── 订阅：失败要记下来、一轮跑不完要接着跑 ──────────────────────
async function runSubs(code) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-subs-'));
  await mkdir(path.join(base, 'data'), { recursive: true });
  const cp = spawn(process.execPath, ['-e', code], {
    // NORATE：搜索节流是真等 15 秒，测试里关掉（跟 NOSPAWN 同一类缝）
    env: { ...process.env, MARKLAB_ROOT: base, MARKLAB_TEST_NOSPAWN: '1', MARKLAB_TEST_NORATE: '1' },
  });
  let out = '';
  let err = '';
  cp.stdout.on('data', (d) => (out += d));
  cp.stderr.on('data', (d) => (err += d));
  await new Promise((res) => cp.on('close', res));
  await rm(base, { recursive: true, force: true });
  return { out, err };
}

test('订阅：搜索失败要记进 lastResult.error，不能当成「搜到 0 条」', async () => {
  const { out, err } = await runSubs(`
    import * as sites from '/home/gly/marklab/sites/index.mjs';
    import * as subs from '/home/gly/marklab/subs.mjs';
    sites.registerForTest({
      site: 'fixture', label: '假站点', hosts: ['fixture.example'], discover: false,
      match: () => null, loginState: async () => ({ ok: false, status: 'logged-out' }),
      meta: async () => { throw new Error('不该走到这里'); },
      fileLinks: async () => [],
      search: async () => { throw new Error('接口 500'); },
      userModels: async () => { throw new Error('接口 500'); },
    });
    const sub = await subs.create({ name: 't', keywords: ['x'], sites: ['fixture'], roundLimit: 5 });
    const r = await subs.run(sub.id);
    console.log(JSON.stringify(r.sub.lastResult));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.match(String(r.error), /搜索失败/, `失败要写进 lastResult.error，实际：${JSON.stringify(r)}`);
  assert.equal(r.searched, 1, '失败也要算搜过一次');
  assert.equal(err.includes('不该走到这里'), false);
});

test('订阅：一轮跑不完就记「跑到第 N 个」，下一轮从 N 接着跑', async () => {
  const { out } = await runSubs(`
    import * as sites from '/home/gly/marklab/sites/index.mjs';
    import * as subs from '/home/gly/marklab/subs.mjs';
    const seen = [];
    sites.registerForTest({
      site: 'fixture', label: '假站点', hosts: ['fixture.example'], discover: false,
      match: () => null, loginState: async () => ({ ok: false, status: 'logged-out' }),
      meta: async () => { throw new Error('不该走到这里'); }, fileLinks: async () => [],
      search: async ({ keyword }) => { seen.push(keyword); return { total: 0, items: [] }; },
      userModels: async () => ({ total: 0, items: [] }),
    });
    const kw = Array.from({ length: 8 }, (_, i) => 'k' + i);
    const sub = await subs.create({ name: 't', keywords: kw, sites: ['fixture'], intervalHours: 1 });
    // 假时钟：每问一次前进 10 分钟，预算 1h*0.6 = 36 分钟 → 只跑得完前几个
    let t = 0;
    const clock = () => (t += 600_000);
    const first = await subs.run(sub.id, { clock });
    const firstCursor = first.sub.lastResult.cursor;
    const firstSeen = seen.length;
    const second = await subs.run(sub.id, { clock });
    console.log(JSON.stringify({ firstCursor, firstSeen, jobs: first.sub.lastResult.jobs, secondFrom: second.sub.lastResult.from, secondCursor: second.sub.lastResult.cursor }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.jobs, 8, '八个词就是八个活');
  assert.ok(r.firstCursor > 0 && r.firstCursor < 8, `第一轮应该只跑一部分，实际 cursor=${r.firstCursor}`);
  assert.equal(r.firstSeen, r.firstCursor, '跑几个词就搜几次');
  assert.equal(r.secondFrom, r.firstCursor, '第二轮从上一轮停下的地方接着跑');
});

test('订阅：连点两次「立即跑」不会并发打站点', async () => {
  const { out } = await runSubs(`
    import * as sites from '/home/gly/marklab/sites/index.mjs';
    import * as subs from '/home/gly/marklab/subs.mjs';
    let inflight = 0;
    let peak = 0;
    sites.registerForTest({
      site: 'fixture', label: '假站点', hosts: ['fixture.example'], discover: false,
      match: () => null, loginState: async () => ({ ok: false, status: 'logged-out' }),
      meta: async () => { throw new Error('不该走到这里'); }, fileLinks: async () => [],
      search: async () => {
        inflight++; peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        return { total: 0, items: [] };
      },
      userModels: async () => ({ total: 0, items: [] }),
    });
    const sub = await subs.create({ name: 't', keywords: ['a', 'b', 'c'], sites: ['fixture'] });
    const p = subs.run(sub.id);
    let rejected = false;
    try { await subs.run(sub.id); } catch { rejected = true; }
    await p;
    console.log(JSON.stringify({ rejected, peak }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.rejected, true, '第二次点要直接被拒');
  assert.equal(r.peak, 1, '任何时刻最多一个搜索在飞');
});

test('手动加的链接插队：下一个就跑它，其它站不被饿死', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mk-t-'));
  const { out, err } = await runTasks(`
    const tasks = await import('./tasks.mjs');
    tasks.pause();
    const C = 'https://www.crealitycloud.cn/model-detail/';
    const S = 'https://space.snapmaker.cn/zh/model/';
    for (const id of ['aaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbb']) tasks.enqueue({ url: C + id, source: 'subscribe' });
    tasks.enqueue({ url: S + '1695-x', source: 'subscribe' });
    const order = [];
    tasks.onFinish((t) => order.push(t.url.split('/').pop().slice(0, 4)));
    const manual = tasks.enqueue({ url: C + 'dddddddddddddddddddddddd', source: 'manual' });
    tasks.resume();
    await manual.done;
    await new Promise((r) => setTimeout(r, 500));
    console.log(JSON.stringify(order));
  `, base);
  assert.equal(err, '', err);
  const order = JSON.parse(out.trim().split('\n').pop());
  assert.equal(order[0], 'dddd', '手动加的那条要第一个跑');
  assert.equal(order.length, 4);
  assert.ok(order.includes('1695'), '别的站也要跑到，不被创想云饿死');
});

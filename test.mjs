// 自检：node --test test.mjs
// 只测纯函数（站点识别 / Nuxt 反序列化 / 富文本清洗 / 判重规则），不联网不起浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoTags, catIndex, catOf, cookiesFor, inside, noFilesKind, resolveNuxt, sanitize, slugify } from './lib.mjs';
import * as sitePacks from './sites/index.mjs';

// 当前检出的仓库根：子进程与 -e 代码都用它，别写死主仓库路径（worktree 里才测得到自己）
const HERE = path.dirname(fileURLToPath(import.meta.url));

// 站点识别搬进站点包了（票 06）。这里留一层薄壳，老断言不用改：包里叫 site，这里叫 name。
const matchPlatform = (u) => {
  const h = sitePacks.match(u);
  return h ? { name: h.site, id: h.id, url: h.url } : null;
};
import * as dup from './dup.mjs';
import { checkinPlan } from './sites/makeronline-cn.mjs';
import { dayNum } from './sites/creality.mjs';

test('签到：7 天周期里读得出今天签没签、第几天、几分', () => {
  assert.deepEqual(checkinPlan([{ key: 1, is_checkin: 1, integral: 1, date: '2026-11-02' }]), {
    ready: false,
    signed: true,
    day: 1,
    integral: 1,
    date: '2026-11-02',
  });
  assert.deepEqual(checkinPlan([{ key: 3, is_checkin: 0, integral: 1, date: '' }]), {
    ready: true,
    signed: false,
    day: 3,
    integral: 1,
  });
  assert.equal(checkinPlan([]).ready, false, '周期为空是「限时任务没开」，不是可签');
  assert.equal(checkinPlan(null).ready, false);
});

test('签到：创想云的 checkinDay 是 UTC 零点对齐的秒，能对上「今天」', () => {
  assert.equal(dayNum(1793577600), dayNum(Date.UTC(2026, 10, 2) / 1000), '2026-11-02 签的那天');
  assert.notEqual(dayNum(1793577600), dayNum(Date.UTC(2026, 10, 3) / 1000), '换一天就不等');
});

test('cookie 认父域：.snapmaker.cn 的 token 要能被 space.snapmaker.cn 拿到', () => {
  const all = [{ name: 'login_access_token', value: 't', domain: '.snapmaker.cn' }];
  assert.equal(cookiesFor(all, ['space.snapmaker.cn']).length, 1, '父域 cookie 浏览器会发过来，不认就是假未登录');
  assert.equal(cookiesFor([{ name: 't', value: '1', domain: 'evil-snapmaker.cn' }], ['space.snapmaker.cn']).length, 0, 'evil- 前缀仍不许混进来');
});

test('cookie 只认同域与子域，evil- 前缀的不许混进来', () => {
  const all = [
    { name: 'a', value: '1', domain: '.crealitycloud.cn' },
    { name: 'b', value: '2', domain: 'crealitycloud.cn' },
    { name: 'evil', value: 'x', domain: 'evil-crealitycloud.cn' },
    { name: 'other', value: 'y', domain: 'makerworld.com' },
  ];
  assert.deepEqual(cookiesFor(all, ['crealitycloud.cn']).map((c) => c.name), ['a', 'b']);
  assert.deepEqual(cookiesFor(all, []), []);
  assert.deepEqual(cookiesFor(null, ['x']), []);
});

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

    // 空壳（有 model.json、没文件）不算已入库，不许拦住重抓
    await put('creality-empty', {
      platform: 'creality', id: 'empty', title: '空壳模型', author: 'Zoe', fetchedAt: '2026-01-01T00:00:00Z', savedFiles: [],
    });
    assert.equal(await dup.check(model('creality', 'x1', '空壳模型', 'Zoe'), lib), null, '没文件的记录不算重复');
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
  // MakerOnline 两个域各自成包，数据键也分域（.cn/.com 是两套 id 空间，同号不同模型）
  const cn = sites.match('https://www.makeronline.cn/zh/model/x/207581.html');
  assert.deepEqual([cn.site, cn.id], ['makeronline.cn', '207581']);
  assert.equal(sites.byName('makeronline.cn').platform, 'makeronline.cn');
  // 订阅/搜索沿用旧键 makeronline，要落到 .cn 这个包上
  assert.equal(sites.byName('makeronline').site, 'makeronline.cn');
  // .com 是另一个独立包，数据键带域，不和 .cn 撞库目录/判重键
  const com = sites.match('https://www.makeronline.com/zh/model/x/341770.html');
  assert.deepEqual([com.site, com.id], ['makeronline.com', '341770']);
  assert.equal(sites.byName('makeronline.com').platform, 'makeronline.com');
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
      import { ROOT } from '${HERE}/lib.mjs';
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
    cwd: HERE,
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
    import * as tasks from '${HERE}/tasks.mjs';
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
    import * as tasks from '${HERE}/tasks.mjs';
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
    const again = await import('${HERE}/tasks.mjs?restore=' + Date.now());
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
    import * as tasks from '${HERE}/tasks.mjs';
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
    import * as tasks from '${HERE}/tasks.mjs';
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

test('闸门按站独立：一个站跑完只推它自己的，自定义间隔压不到 60 秒地板以下', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-gate-'));
  const code = `
    import * as tasks from '${HERE}/tasks.mjs';
    await tasks.siteConfigLoad();
    const saved = await tasks.siteConfigSet({ creality: { modelGapSec: [10, 10] }, snapmaker: { modelGapSec: [90, 100] } });
    const A = 'https://www.crealitycloud.cn/model-detail/' + '1'.padStart(24, '0');
    tasks.enqueue({ url: A, source: 'bulk' });
    for (let i = 0; i < 100 && tasks.queueDepth(); i++) await new Promise((r) => setTimeout(r, 20));
    const st = tasks.state();
    console.log(JSON.stringify({ saved, gates: Object.keys(st.gates) }));
    process.exit(0);
  `;
  const { out } = await runTasks(code, base);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(j.saved.creality.modelGapSec, [60, 60], '10 秒要被地板抬到 60');
  assert.deepEqual(j.saved.snapmaker.modelGapSec, [90, 100], '合法覆盖原样存');
  assert.deepEqual(j.gates, ['creality'], '只推跑过的那个站，别的站不该被拖住');
  await rm(base, { recursive: true, force: true });
});

test('每站一条队轮转：一个站积压不挡别的站出队', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-lane-'));
  const code = `
    import * as tasks from '${HERE}/tasks.mjs';
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
    import * as tasks from '${HERE}/tasks.mjs';
    import { mkdir, appendFile } from 'node:fs/promises';
    import path from 'node:path';
    const url = 'https://space.snapmaker.cn/zh/model/1021-model';
    const failedUrl = 'https://space.snapmaker.cn/zh/model/1022-model';
    // 一条 24 小时内失败过的（上一轮抓到一半崩了）
    await mkdir(path.join(process.env.MARKLAB_ROOT, 'data', 'tasks'), { recursive: true });
    const month = path.join(process.env.MARKLAB_ROOT, 'data', 'tasks', new Date().toISOString().slice(0, 7) + '.jsonl');
    const old = { id: 't-old', url: failedUrl, site: 'snapmaker', phase: 'failed', rounds: 3, createdAt: new Date().toISOString(), endedAt: new Date().toISOString(), ok: false, progress: { done: 0, total: 0, name: '' } };
    await appendFile(month, JSON.stringify(old) + '\\n');
    const again = await import('${HERE}/tasks.mjs?r=' + Date.now());
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
    import * as tasks from '${HERE}/tasks.mjs';
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
    import * as tasks from '${HERE}/tasks.mjs';
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
    import * as tasks from '${HERE}/tasks.mjs';
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

test('判重索引每轮重建：只有元数据没文件的不算已入库', async () => {
  const { index } = await import('./dup.mjs');
  const lib = await mkdtemp(path.join(os.tmpdir(), 'ml-idx-'));
  await mkdir(path.join(lib, 'creality-aaa'), { recursive: true });
  await writeFile(
    path.join(lib, 'creality-aaa', 'model.json'),
    JSON.stringify({ platform: 'creality', id: 'aaa', title: '甲', author: '乙', fetchedAt: new Date().toISOString() }),
  );
  const first = await index(true, lib);
  assert.equal(first.keys.has('creality:aaa'), false, '只有元数据、没文件的记录不算已入库');
  // 模拟别的进程刚入库
  await mkdir(path.join(lib, 'creality-bbb'), { recursive: true });
  await writeFile(
    path.join(lib, 'creality-bbb', 'model.json'),
    JSON.stringify({ platform: 'creality', id: 'bbb', title: '丙', author: '丁', fetchedAt: new Date().toISOString() }),
  );
  assert.equal((await index(true, lib)).keys.has('creality:bbb'), false, 'force 重建要看到新模型');
  // 下到文件了才算入库
  await writeFile(
    path.join(lib, 'creality-bbb', 'model.json'),
    JSON.stringify({ platform: 'creality', id: 'bbb', title: '丙', author: '丁', fetchedAt: new Date().toISOString(), savedFiles: [{ name: 'a.stl' }] }),
  );
  assert.equal((await index(true, lib)).keys.has('creality:bbb'), true, '有文件才是已入库');
  await rm(lib, { recursive: true, force: true });
});

// ── 订阅：失败要记下来、一轮跑不完要接着跑 ──────────────────────
async function runSubs(code, prep) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'ml-subs-'));
  await mkdir(path.join(base, 'data'), { recursive: true });
  if (prep) await prep(base);
  const cp = spawn(process.execPath, ['-e', code], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), // 相对 import 跟着 test.mjs 走，worktree 里测的才是 worktree
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
    import * as sites from '${HERE}/sites/index.mjs';
    import * as subs from '${HERE}/subs.mjs';
    sites.registerForTest({
      site: 'fixture', label: '假站点', hosts: ['fixture.example'], discover: false,
      match: () => null, loginState: async () => ({ ok: false, status: 'logged-out' }),
      meta: async () => { throw new Error('不该走到这里'); },
      fileLinks: async () => [],
      search: async () => { throw new Error('接口 500'); },
      userModels: async () => { throw new Error('接口 500'); },
    });
    const sub = await subs.create({ name: 't', keywords: ['x'], rules: [{ site: 'fixture', limit: 5 }], matchModes: ['name'] });
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
    import * as sites from '${HERE}/sites/index.mjs';
    import * as subs from '${HERE}/subs.mjs';
    const seen = [];
    sites.registerForTest({
      site: 'fixture', label: '假站点', hosts: ['fixture.example'], discover: false,
      match: () => null, loginState: async () => ({ ok: false, status: 'logged-out' }),
      meta: async () => { throw new Error('不该走到这里'); }, fileLinks: async () => [],
      search: async ({ keyword }) => { seen.push(keyword); return { total: 0, items: [] }; },
      userModels: async () => ({ total: 0, items: [] }),
    });
    const kw = Array.from({ length: 8 }, (_, i) => 'k' + i);
    const sub = await subs.create({ name: 't', keywords: kw, rules: [{ site: 'fixture', limit: 20 }], matchModes: ['name'], intervalHours: 1 });
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
    import * as sites from '${HERE}/sites/index.mjs';
    import * as subs from '${HERE}/subs.mjs';
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
    const sub = await subs.create({ name: 't', keywords: ['a', 'b', 'c'], rules: [{ site: 'fixture', limit: 20 }], matchModes: ['name'] });
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

test('闸门默认是 60–120 秒的区间，不是恒定 60 秒', async () => {
  const { gapsMs } = await import('./tasks.mjs');
  const [min, max] = gapsMs();
  assert.equal(min, 60_000);
  assert.equal(max, 120_000, 'MAX_GAP 被 readGap 的默认值吃掉了，退化成恒定 60 秒');
});

// 站点包卡片第四行：最近 7 个自然日，有 3mf 才算抓成功
test('daily7：只数带 3mf 的，按北京时间自然日分桶，7 天以前不上图', async () => {
  const { daily7 } = await import('./stats.mjs');
  const now = new Date('2026-11-02T12:00:00+08:00');
  const mk = (platform, fetchedAt, names) => ({ platform, fetchedAt, savedFiles: names.map((n) => ({ name: n })) });
  const r = daily7(
    [
      mk('creality', '2026-11-02T01:00:00+08:00', ['a.3mf']),
      mk('creality', '2026-11-02T02:00:00+08:00', ['a.stl']), // 没 3mf，不算
      mk('creality', '2026-11-01T23:30:00+08:00', ['b.3MF']),
      mk('snapmaker', '2026-10-27T00:00:00+08:00', ['c.3mf']),
      mk('snapmaker', '2026-10-26T23:59:00+08:00', ['d.3mf']), // 第 8 天，丢掉
    ],
    now,
  );
  assert.deepEqual(r.days, ['10-27', '10-28', '10-29', '10-30', '10-31', '11-01', '11-02']);
  assert.deepEqual(r.daily.creality, [0, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual(r.daily.snapmaker, [1, 0, 0, 0, 0, 0, 0]);
});

// docs/site-pack.md §9：契约测试。成员表在 sites/contract.mjs，这里只负责跑它——不联网。
test('站点包契约：形状全过 checkPack，能力声明在词表里', async () => {
  const { checkPack, isSearchOptions } = await import('./sites/contract.mjs');
  for (const p of sitePacks.all()) {
    assert.deepEqual(checkPack(p), [], `${p.site} 不合契约`);
    if (p.searchOptions) assert.ok(isSearchOptions(p.searchOptions), `${p.site}.searchOptions 形状不对`);
  }
});

test('站点包契约：八种返回模型各有一条断言，假站点走一遍', async () => {
  const c = await import('./sites/contract.mjs');
  const fixture = (await import('./sites/_fixture.mjs')).default;
  assert.ok(c.isModelMeta(await fixture.meta('https://fixture.example/thing/7')), 'meta() 要是 ModelMeta');
  for (const l of await fixture.fileLinks()) assert.ok(c.isFileLink(l), 'fileLinks() 每项要是 FileLink');
  assert.ok(c.isCategoryTree(await fixture.categories()), 'categories() 要是 Category[]');
  assert.ok(c.isLoginState(await fixture.loginState()), 'loginState() 要是 LoginState');
  assert.ok(c.isPage(await fixture.search({ keyword: 'x' })), 'search() 要是 Page');
  assert.ok(c.isPage(await fixture.userModels({ uid: 'u' })), 'userModels() 要是 Page');
  // 签到结果：没有 text，signed 一定是布尔
  assert.ok(c.isCheckin({ signed: true, streak: 3, gain: 5 }), 'CheckinResult 形状');
  assert.ok(!c.isCheckin({ signed: true, text: '签到成功' }), 'CheckinResult 不许带 text');
  assert.ok(c.isCheckinStatus({ points: 3, checkin: { signed: false } }), 'CheckinStatus 形状');
  // total 拿不到写 null，不许用 0 冒充
  assert.ok(c.isPage({ total: null, items: [] }), 'total 允许 null');
  assert.ok(!c.isPage({ total: '0', items: [] }), 'total 不许是字符串');
});

test('签到文案由公共层拼：包只给字段，人话在 checkinText', async () => {
  const { checkinText } = await import('./lib.mjs');
  assert.equal(checkinText({ signed: true, streak: 3, gain: 10 }, true), '签到成功 · 连签 3 天 · +10');
  assert.equal(checkinText({ signed: true, streak: 1 }, false), '今天已签 · 连签 1 天');
  assert.equal(checkinText({ signed: false, note: '浏览器没连上' }), '可签 · 浏览器没连上');
  assert.equal(checkinText(null), '没拿到签到状态');
});

// 各站点包的自检挂在「文件被直接执行」上，`node --test` 里一条都不跑。
// 这里替它们跑一遍：纯函数、不联网、不起浏览器。
test('五个站点包的自检都要能跑过（match/normalize 回归）', async () => {
  for (const f of ['creality', 'makerworld', 'snapmaker', 'makeronline-cn', 'makeronline-com']) {
    const r = await new Promise((res) => {
      const cp = spawn(process.execPath, [`sites/${f}.mjs`], { cwd: HERE });
      let err = '';
      cp.stderr.on('data', (d) => (err += d));
      cp.on('close', (code) => res({ code, err }));
    });
    assert.equal(r.code, 0, `sites/${f}.mjs 自检失败：${r.err}`);
    // console.assert 只往 stderr 打字，退出码照样是 0：不看 stderr 这条测试等于没跑
    assert.ok(!/Assertion failed/.test(r.err), `sites/${f}.mjs 有断言没过：${r.err.slice(0, 300)}`);
  }
});

test('搜索结果的 site 用包的规范键：别名换回域名，判重键才对得上库', async () => {
  const { search } = await import('./search.mjs');
  // 空关键词直接返回空结果，不联网
  assert.equal((await search('makeronline', '')).site, 'makeronline.cn', '别名要换回规范键');
  assert.equal((await search('makeronline.com', '')).site, 'makeronline.com');
  assert.equal((await search('makerworld', '')).site, 'makerworld');
});

// ── 订阅改版（票 3）：spec §11 能纯函数验证的部分 ──────────────────
// 纯函数直接 import；要跑运行器循环的用假站点子进程（不联网、不起浏览器）。
const candOf = (kw = '皮卡丘', title = '皮卡丘 Pikachu') => ({
  key: 'makerworld:1',
  title,
  tags: [],
  likes: 99,
  downloads: 999,
  picked: true,
  sources: [{ site: 'makerworld', id: 1, url: 'u1', rank: 1, kw }],
});
const kwSub = { kind: 'keyword', minLikes: 0, minDownloads: 0, pickedOnly: false, matchModes: ['name'] };

test('订阅规则：不认识的站点直接报错，不许静默丢规则', async () => {
  const { cleanRules } = await import('./subs.mjs');
  assert.throws(() => cleanRules([{ site: 'no-such-site', limit: 20 }]), /规则里的站点不认识/, '不认识的站点要报错，静默丢规则等于订阅悄悄少跑一站');
});

test('订阅规则：站点不支持的排序回落该站默认序，不抛错', async () => {
  const { cleanRules } = await import('./subs.mjs');
  const { sortsOf } = await import('./search.mjs');
  assert.equal(cleanRules([{ site: 'makerworld', sort: 'no-such-sort', limit: 20 }])[0].sort, sortsOf('makerworld')[0], '不支持的排序回落该站默认序');
  assert.equal(cleanRules([{ site: 'makerworld', sort: 'likes', limit: 20 }])[0].sort, 'likes', '支持的排序原样保留');
  assert.equal(cleanRules([{ site: 'makeronline.cn', limit: 20 }])[0].sort, sortsOf('makeronline.cn')[0] ?? null, '不传排序用该站默认序');
});

test('筛选：只留下词表里有、且该站声明过的值，其余丢掉不抛错', async () => {
  const { filterFor } = await import('./search.mjs');
  assert.deepEqual(filterFor('creality', { color: 'multi' }), { color: 'multi' }, '声明过的值留下');
  assert.deepEqual(filterFor('makerworld', { color: 'single', badge: 'picked' }), { color: 'single', badge: 'picked' }, '两个键都支持就都留');
  assert.deepEqual(filterFor('creality', { color: 'rainbow' }), {}, '词表外的值丢掉');
  assert.deepEqual(filterFor('creality', { size: 'big' }), {}, '词表外的键丢掉');
  assert.deepEqual(filterFor('snapmaker', { badge: 'picked' }), {}, '词表里有但该站没声明的值丢掉');
  assert.deepEqual(filterFor('no-such-site', { color: 'multi' }), {}, '未知站点不炸，返回空对象');
  assert.deepEqual(filterFor('creality', undefined), {}, '没有筛选就是空对象');
  assert.deepEqual(filterFor('creality', { color: 'multi', badge: 'picked' }), { color: 'multi', badge: 'picked' }, '都支持就都留');
});

test('榜单：feedsOf 只读包声明的那份，没声明的站回空数组', async () => {
  const { feedsOf } = await import('./search.mjs');
  assert.deepEqual(feedsOf('makerworld'), [], 'MakerWorld 没有榜单');
  assert.deepEqual(feedsOf('snapmaker'), [], 'Snapmaker 没有榜单');
  assert.deepEqual(feedsOf('no-such-site'), [], '未知站点不炸');
  assert.deepEqual(feedsOf('creality'), [{ key: 'weekly-picks', label: '本周值得打' }], '创想云「本周值得打」');
});

test('榜单：key 不在声明里就回 error，不抛错', async () => {
  const { feed } = await import('./search.mjs');
  const r = await feed('creality', 'no-such-feed');
  assert.deepEqual(r.items, [], '空页');
  assert.equal(r.total, null, '拿不到总数就是 null');
  assert.match(r.error, /没有榜单/, '要能分清「没这条榜单」和「取页失败」');
});

test('订阅规则：limit 夹在 1–1000，150 不许被凑成整页', async () => {
  const { cleanRules } = await import('./subs.mjs');
  assert.equal(cleanRules([{ site: 'makerworld', limit: 150 }])[0].limit, 150, '前 N 条是硬上限：150 就是 150');
  assert.equal(cleanRules([{ site: 'makerworld', limit: 5000 }])[0].limit, 1000, '上限 1000');
  assert.equal(cleanRules([{ site: 'makerworld', limit: -3 }])[0].limit, 1, '下限 1');
  assert.deepEqual(cleanRules(null), [], '不是数组就当没有规则');
});

test('订阅：limit=150 只翻 8 页，第 8 页多出来的 10 条被丢掉', async () => {
  const { out } = await runSubs(`
    import * as sites from './sites/index.mjs';
    import * as subs from './subs.mjs';
    import { readFile } from 'node:fs/promises';
    const pages = [];
    sites.registerForTest({
      site: 'fixture', label: '假站点', hosts: ['fixture.example'], discover: false,
      match: () => null, loginState: async () => ({ ok: false, status: 'logged-out' }),
      meta: async () => { throw new Error('不该走到这里'); }, fileLinks: async () => [],
      search: async ({ page }) => {
        pages.push(page);
        return { total: null, items: Array.from({ length: 20 }, (_, i) => {
          const n = (page - 1) * 20 + i + 1;
          return { site: 'fixture', id: 'm' + n, url: 'https://fixture.example/m' + n, title: '模型 ' + n, author: '作者' };
        }) };
      },
      userModels: async () => ({ total: null, items: [] }),
    });
    const sub = await subs.create({ name: 't', keywords: ['皮卡丘'], rules: [{ site: 'fixture', limit: 150 }], matchModes: ['name'] });
    const r = await subs.run(sub.id);
    const file = JSON.parse(await readFile(process.env.MARKLAB_ROOT + '/data/subs/' + sub.id + '.candidates.json', 'utf8'));
    const ranks = file.items.flatMap((c) => c.sources.map((s) => s.rank));
    console.log(JSON.stringify({ searched: r.searched, pages, cands: file.items.length, maxRank: Math.max(...ranks), has151: ranks.includes(151) }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.pages.join(','), '1,2,3,4,5,6,7,8', 'limit=150 只该翻 8 页（ceil(150/20)），不许翻第 9 页');
  assert.equal(r.searched, 8, '八页就是八次搜索');
  assert.equal(r.cands, 150, '候选正好 150 条：第 8 页多出来的 10 条要丢掉，不许凑整页');
  assert.equal(r.maxRank, 150, '名次最大到 150');
  assert.equal(r.has151, false, '第 151 条不许进候选');
});

test('订阅：库里有这个模型 → in-library，不入队', async () => {
  const { decide } = await import('./subs.mjs');
  assert.equal(decide(candOf(), kwSub, { libKeys: new Set(['makerworld:1']) }), 'in-library', '库里已有（下到文件）就不入队');
});

test('订阅：下载队列里已有这个网址 → in-queue，不入队', async () => {
  const { decide } = await import('./subs.mjs');
  assert.equal(decide(candOf(), kwSub, { busy: new Set(['u1']) }), 'in-queue', '队列里已有就不重复排');
});

test('订阅：门槛不够 → threshold，不入队', async () => {
  const { decide } = await import('./subs.mjs');
  assert.equal(decide(candOf(), { ...kwSub, minLikes: 1000 }, {}), 'threshold', '点赞不够要记 threshold');
  assert.equal(decide(candOf(), { ...kwSub, pickedOnly: true }, {}), 'queued', '不卡精选时精选模型照常入队');
});

test('订阅：名字对不上来源词 → no-match，不入队', async () => {
  const { decide } = await import('./subs.mjs');
  assert.equal(decide(candOf('皮卡丘', '妙蛙种子'), kwSub, {}), 'no-match', '标题不含来源词不算命中');
});

test('订阅：四道闸都过了 → queued', async () => {
  const { decide } = await import('./subs.mjs');
  assert.equal(decide(candOf(), kwSub, { libKeys: new Set(), busy: new Set() }), 'queued', '四道闸都过才入队');
});

test('订阅：作者订阅没有门槛也没有匹配，恒 queued', async () => {
  const { decide } = await import('./subs.mjs');
  const sub = { kind: 'author', minLikes: 99999, minDownloads: 99999, pickedOnly: true, matchModes: ['name'] };
  assert.equal(decide(candOf('拉布布', '妙蛙种子'), sub, {}), 'queued', '作者订阅：他发的我都要，门槛和名字匹配都不算数');
  const cand = { ...candOf(), sources: [{ site: 'snapmaker', id: 9, url: 's9', rank: 1, kw: null }] };
  assert.equal(decide(cand, { kind: 'author' }, {}), 'queued', '作者搜索结果没有来源词也照样入队');
});

test('订阅：跨站同标题同作者（大小写/空白不同）合成一条，sources 两条', async () => {
  const { mergeSources } = await import('./subs.mjs');
  const merged = mergeSources([
    { site: 'snapmaker', id: 9, url: 's9', title: 'Pikachu 皮卡丘', author: 'Tom', rank: 1, kw: '皮卡丘', likes: 5, downloads: 5 },
    { site: 'makerworld', id: 7, url: 'm7', title: 'pikachu皮卡丘 ', author: ' TOM ', rank: 5, kw: '皮卡丘', likes: 900, downloads: 900 },
  ]);
  assert.equal(merged.length, 1, '同标题同作者（归一后）只算一条候选');
  assert.equal(merged[0].sources.length, 2, '两个来源都记下来');
  assert.equal(merged[0].sources[0].site, 'makerworld', 'sources 里 MakerWorld 排第一');
  assert.equal(merged[0].sources[0].rank, 5, '每条来源各带自己的名次');
});

test('订阅：跨站合并后入队取 MakerWorld，门槛数值也按它判', async () => {
  const { mergeSources, pickPrimary } = await import('./subs.mjs');
  const [cand] = mergeSources([
    { site: 'snapmaker', id: 9, url: 's9', title: 'Pikachu', author: 'Tom', rank: 1, kw: 'pikachu', likes: 5, downloads: 5 },
    { site: 'makerworld', id: 7, url: 'm7', title: 'pikachu', author: 'TOM', rank: 5, kw: 'pikachu', likes: 900, downloads: 900 },
  ]);
  const primary = pickPrimary(cand.sources);
  assert.equal(primary.site, 'makerworld', '入队取 MakerWorld 优先');
  assert.equal(primary.url, 'm7', '入队用主来源的网址');
  assert.equal(cand.downloads, 900, '门槛数值取主来源那条，展示和判定才一致');
  assert.equal(cand.likes, 900, '点赞同样取主来源');
});

test('订阅：同一模型被两条规则搜到也只算一条候选，两条来源各记名次', async () => {
  const { mergeSources } = await import('./subs.mjs');
  const merged = mergeSources([
    { site: 'makerworld', id: 7, url: 'm7', title: '皮卡丘', author: 'Tom', rank: 3, kw: '皮卡丘' },
    { site: 'makerworld', id: 7, url: 'm7', title: '皮卡丘', author: 'Tom', rank: 41, kw: '皮卡丘' },
  ]);
  assert.equal(merged.length, 1, '同一个 site:id 搜到两次只留一条候选');
  assert.deepEqual(merged[0].sources.map((s) => s.rank), [3, 41], '两次搜索的名次都记下来');
});

test('订阅：匹配用的是这条候选的来源词，不是订阅里任一词', async () => {
  const { decide } = await import('./subs.mjs');
  const sub = { ...kwSub, keywords: ['皮卡丘', '拉布布'] };
  assert.equal(decide(candOf('皮卡丘'), sub, {}), 'queued', '来源词就是标题里的词 → 命中');
  assert.equal(decide(candOf('拉布布'), sub, {}), 'no-match', '标题是「皮卡丘」但来源词是「拉布布」→ 不算命中，防跨词误伤');
  const two = { ...candOf('拉布布'), sources: [
    { site: 'snapmaker', id: 2, url: 's2', rank: 1, kw: '拉布布' },
    { site: 'makerworld', id: 1, url: 'u1', rank: 2, kw: '皮卡丘' },
  ] };
  assert.equal(decide(two, sub, {}), 'queued', '任一来源词命中就算命中');
});

test('订阅：tag 匹配也只看来源词', async () => {
  const { decide } = await import('./subs.mjs');
  const sub = { ...kwSub, keywords: ['皮卡丘', '拉布布'], matchModes: ['tag'] };
  const cand = { ...candOf('拉布布', '妙蛙种子'), tags: ['皮卡丘'] };
  assert.equal(decide(cand, sub, {}), 'no-match', 'tag 含「皮卡丘」但来源词是「拉布布」→ 不命中');
  const hit = { ...cand, tags: ['可爱皮卡丘摆件'], sources: [{ ...cand.sources[0], kw: '皮卡丘' }] };
  assert.equal(decide(hit, sub, {}), 'queued', 'tag 含来源词 → 命中');
});

test('订阅：作者游标从 {page:1,done:false} 开始，翻到底才置 done 并归 1', async () => {
  const libIds = Array.from({ length: 20 }, (_, i) => 'a' + i);
  const { out } = await runSubs(
    `
    import * as sites from './sites/index.mjs';
    import * as subs from './subs.mjs';
    const pages = [];
    const libItems = Array.from({ length: 20 }, (_, i) => ({ site: 'fixture', id: 'a' + i, url: 'https://fixture.example/a' + i, title: '旧模型 ' + i, author: '作者' }));
    sites.registerForTest({
      site: 'fixture', label: '假站点', hosts: ['fixture.example'], discover: false,
      match: () => null, loginState: async () => ({ ok: false, status: 'logged-out' }),
      meta: async () => { throw new Error('不该走到这里'); }, fileLinks: async () => [],
      search: async () => ({ total: null, items: [] }),
      userModels: async ({ page }) => {
        pages.push(page);
        if (page === 1) return { total: null, items: libItems };
        if (page === 2) return { total: null, items: [{ site: 'fixture', id: 'new1', url: 'https://fixture.example/new1', title: '新模型', author: '作者' }] };
        return { total: null, items: [] };
      },
    });
    const sub = await subs.create({ kind: 'author', name: 't', users: [{ site: 'fixture', id: 'u1', name: '作者' }] });
    const before = JSON.parse(JSON.stringify(sub.authorCursor));
    const r = await subs.run(sub.id);
    console.log(JSON.stringify({ before, pages, after: sub.authorCursor, matched: r.sub.lastResult.matched }));
  `,
    async (base) => {
      for (const id of libIds) {
        const dir = path.join(base, 'library', 'fixture-' + id);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'model.json'), JSON.stringify({ platform: 'fixture', id, title: '旧模型 ' + id, author: '作者', fetchedAt: new Date().toISOString(), savedFiles: [{ name: 'a.stl' }] }));
      }
    },
  );
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r.before, { 'fixture:u1': { page: 1, done: false } }, '作者游标初始是 {page:1,done:false}');
  assert.equal(r.pages.join(','), '1,2,3', 'done 之前不许「连续 20 条就停」：第 1 页 20 条都在库里也要接着翻第 2 页');
  assert.deepEqual(r.after['fixture:u1'], { page: 1, done: true }, '翻到底（空页）才置 done，页码归 1');
  assert.equal(r.matched, 1, '第 2 页那条没入库的新模型要入队');
});

test('订阅：作者翻到底之后才启用「连续 20 条就停」，第二轮只翻一页', async () => {
  const libIds = Array.from({ length: 20 }, (_, i) => 'a' + i);
  const { out } = await runSubs(
    `
    import * as sites from './sites/index.mjs';
    import * as subs from './subs.mjs';
    let round = 0;
    const pages = [];
    const libItems = Array.from({ length: 20 }, (_, i) => ({ site: 'fixture', id: 'a' + i, url: 'https://fixture.example/a' + i, title: '旧模型 ' + i, author: '作者' }));
    sites.registerForTest({
      site: 'fixture', label: '假站点', hosts: ['fixture.example'], discover: false,
      match: () => null, loginState: async () => ({ ok: false, status: 'logged-out' }),
      meta: async () => { throw new Error('不该走到这里'); }, fileLinks: async () => [],
      search: async () => ({ total: null, items: [] }),
      userModels: async ({ page }) => {
        pages.push(page);
        if (round === 0) return { total: null, items: [] };
        if (page === 1) return { total: null, items: libItems };
        if (page === 2) return { total: null, items: [{ site: 'fixture', id: 'new1', url: 'https://fixture.example/new1', title: '新模型', author: '作者' }] };
        return { total: null, items: [] };
      },
    });
    const sub = await subs.create({ kind: 'author', name: 't', users: [{ site: 'fixture', id: 'u1', name: '作者' }] });
    const first = await subs.run(sub.id); // 首轮空页 → 翻到底，done=true
    round = 1;
    pages.length = 0;
    const second = await subs.run(sub.id);
    console.log(JSON.stringify({ firstSearched: first.searched, pages, searched: second.searched, matched: second.hits.length, done: sub.authorCursor['fixture:u1'] }));
  `,
    async (base) => {
      for (const id of libIds) {
        const dir = path.join(base, 'library', 'fixture-' + id);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'model.json'), JSON.stringify({ platform: 'fixture', id, title: '旧模型 ' + id, author: '作者', fetchedAt: new Date().toISOString(), savedFiles: [{ name: 'a.stl' }] }));
      }
    },
  );
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.firstSearched, 1, '首轮空页就算翻到底');
  assert.deepEqual(r.pages, [1], 'done 之后撞到一页全在库里就停，不许再往第 2 页翻');
  assert.equal(r.searched, 1, '第二轮只搜了一页');
  assert.equal(r.matched, 0, '第 2 页那条新模型这轮不该被发现（增量从最新往旧扫，撞到一页旧的就收工）');
});

test('订阅：关键字订阅的任务 = 关键字 × 规则', async () => {
  const { planJobs } = await import('./subs.mjs');
  const jobs = planJobs({
    kind: 'keyword',
    keywords: ['皮卡丘', '拉布布'],
    rules: [{ site: 'makerworld', sort: 'score', limit: 100 }, { site: 'snapmaker', sort: 'downloads', limit: 50 }],
  });
  assert.equal(jobs.length, 4, '两个关键字 × 两条规则 = 四个任务');
  assert.equal(jobs.filter((j) => j.site === 'makerworld').length, 2, '每站各两个任务');
  assert.deepEqual(jobs.map((j) => j.kw).sort(), ['拉布布', '拉布布', '皮卡丘', '皮卡丘'], '每个关键字都要搜');
  assert.ok(jobs.every((j) => j.kind === 'keyword' && j.rule), '每个任务都带自己的规则');
});

test('订阅：作者订阅的任务 = 一人一个，没有关键字也没有规则', async () => {
  const { planJobs } = await import('./subs.mjs');
  const jobs = planJobs({ kind: 'author', users: [{ site: 'makerworld', id: 'a' }, { site: 'snapmaker', id: 'b' }], keywords: ['x'], rules: [{ site: 'makerworld', limit: 20 }] });
  assert.equal(jobs.length, 2, '两个作者两个任务');
  assert.ok(jobs.every((j) => j.kind === 'author' && j.user && !j.kw && !j.rule), '作者任务只跑主页');
});

test('订阅：data/subs.json 每条都有 kind，sites/sort/pageLimit 残留一个不剩', async (t) => {
  const { ROOT } = await import('./lib.mjs');
  let raw;
  try {
    raw = JSON.parse(readFileSync(path.join(ROOT, 'data', 'subs.json'), 'utf8'));
  } catch {
    t.skip('没有 data/subs.json（新装或 CI），跳过迁移后形状检查');
    return;
  }
  assert.ok(Array.isArray(raw.subs), 'subs 要是数组');
  for (const s of raw.subs) {
    assert.ok(['keyword', 'author'].includes(s.kind), `每条订阅都要有 kind（keyword/author），实际：${JSON.stringify(s.kind)}`);
    for (const dead of ['sites', 'sort', 'pageLimit', 'roundLimit']) {
      assert.equal(dead in s, false, `迁移后不许残留 ${dead}：${s.name || s.id}`);
    }
    if (s.kind === 'keyword') {
      assert.ok(s.rules.length > 0, `关键字订阅要有候选规则：${s.name || s.id}`);
      assert.ok(s.matchModes.length > 0, `关键字订阅要有匹配方式：${s.name || s.id}`);
    } else {
      assert.ok(s.users.length > 0, `作者订阅要有用户主页：${s.name || s.id}`);
    }
  }
});

test('订阅：查库不扫全库——libChecker 与 index().keys 结论一致', async (t) => {
  const dup = await import('./dup.mjs');
  const { LIB } = await import('./lib.mjs');
  const { keys } = await dup.index(true);
  if (!keys.size) {
    t.skip('库是空的，没有可比的对象');
    return;
  }
  const checker = dup.libChecker(LIB);
  for (const key of keys) assert.equal(checker.has(key), true, `库里有的 ${key} 要认出来`);
  assert.equal(checker.has('makeronline.cn:1'), keys.has('makeronline.cn:1'), '库里没有的结论也要一致');
  assert.equal(checker.has('nosite:999999999'), false, '不存在的模型一律 false');
});

test('订阅：老订阅（只有 sites[]）迁移成按站一条规则', async () => {
  const { migrateSub } = await import('./subs.mjs');
  const old = { id: 'x', name: '老的', sites: ['creality', 'makerworld'], sort: 'downloads', pageLimit: 2, roundLimit: 50, keywords: ['皮卡丘'] };
  const now = migrateSub({ ...old });
  assert.equal(now.kind, 'keyword', '老订阅都是关键字订阅');
  assert.deepEqual(
    now.rules.map((r) => [r.site, r.limit]),
    [
      ['creality', 40],
      ['makerworld', 40],
    ],
    'pageLimit 2 → 每站前 40 条',
  );
  assert.deepEqual(now.matchModes, ['name'], '老订阅没有匹配方式，按名字');
  for (const dead of ['sites', 'sort', 'pageLimit', 'roundLimit']) assert.equal(dead in now, false, `迁移后不许残留 ${dead}`);
  // 已经是新形状的不许动
  const fresh = { kind: 'keyword', rules: [{ site: 'snapmaker', sort: 'newest', limit: 20 }], matchModes: ['tag'] };
  assert.deepEqual(migrateSub({ ...fresh }), fresh, '新形状原样返回');
});

test('订阅：勾了 tag 但该站搜索结果不带标签时，退回用名字判', async () => {
  const { decide } = await import('./subs.mjs');
  const sub = { kind: 'keyword', matchModes: ['tag'], minLikes: 0, minDownloads: 0, pickedOnly: false };
  const mk = (site, title, tags = []) => ({
    title,
    author: 'a',
    tags,
    sources: [{ site, id: '1', url: `https://x/${site}/1`, rank: 1, kw: '皮卡丘' }],
  });
  assert.equal(decide(mk('creality', '皮卡丘摆件'), sub), 'queued', '创想云不带标签，按名字判就该放行');
  assert.equal(decide(mk('creality', '妙蛙种子'), sub), 'no-match', '名字不命中也不许放行');
  assert.equal(decide(mk('makerworld', '妙蛙种子', ['皮卡丘']), sub), 'queued', 'MakerWorld 有标签，靠 tag 命中');
  assert.equal(decide(mk('makerworld', '妙蛙种子', ['宝可梦']), sub), 'no-match', 'MakerWorld 标签也没命中就是没命中');
});

test('订阅：跨站合并的键与站点到达顺序无关，sources 带来源规则', async () => {
  const { mergeSources } = await import('./subs.mjs');
  const a = { site: 'makerworld', id: '10', title: '皮卡丘', author: 'a', tags: [], rank: 3, kw: '皮卡丘', rule: 'makerworld/score/100' };
  const b = { site: 'creality', id: '99', title: '皮卡丘', author: 'a', tags: [], rank: 7, kw: '皮卡丘', rule: 'creality/downloads/50' };
  const one = mergeSources([a, b]);
  const two = mergeSources([b, a]);
  assert.equal(one.length, 1, '标题+作者一样就合成一条');
  assert.equal(one[0].key, two[0].key, '到达顺序换了，键不能跟着换');
  assert.equal(one[0].sources.length, 2, '两个来源都记下来');
  assert.ok(
    one[0].sources.every((s) => s.rule),
    'sources[] 每条都要带来源规则（spec §6.2）',
  );
});

test('配置 → 本地 3mf：profileId 优先，其次名字，最后才一对一', async () => {
  const { profileFile } = await import('./lib.mjs');
  const files = [
    { kind: 'profile', name: 'A.3mf', path: 'files/01-A.3mf', profileId: 'p1' },
    { kind: 'profile', name: 'B.3mf', path: 'files/02-B.3mf', profileId: 2 },
  ];
  const model = { profiles: [{ id: 'p1' }, { id: 2 }, { id: 'p3' }], savedFiles: files };
  assert.equal(profileFile(model, model.profiles[0]).path, 'files/01-A.3mf', '字符串 id 精确对上');
  assert.equal(profileFile(model, model.profiles[1]).path, 'files/02-B.3mf', '数字 id 也要对上（=== 会挂在这）');
  assert.equal(profileFile(model, model.profiles[2]), null, '对不上就是 null，不许按顺序硬配');

  // 老库没有 profileId：靠名字精确相等
  const old = { profiles: [{ id: 'x', name: '0.2mm layer' }], savedFiles: [{ kind: 'profile', name: '0.2mm layer.3mf', path: 'files/01-x.3mf' }] };
  assert.equal(profileFile(old, old.profiles[0]).path, 'files/01-x.3mf');

  // 一对一：只有一个配置一个文件时可以直接认
  const one = { profiles: [{ id: 'y', name: '别的名字' }], savedFiles: [{ kind: 'profile', name: 'model.3mf', path: 'files/01-m.3mf' }] };
  assert.equal(profileFile(one, one.profiles[0]).path, 'files/01-m.3mf');
});

test('配置的作者标识：各站字段不同，没字段就不猜', async () => {
  const { profileByAuthor } = await import('./lib.mjs');
  assert.equal(profileByAuthor({}, { isAuth: true }), true, '创想云 isAuth');
  assert.equal(profileByAuthor({}, { isAuth: false }), false);
  assert.equal(profileByAuthor({}, { isAuthor: 0 }), false, 'MakerOnline isAuthor');
  assert.equal(profileByAuthor({ authorUid: 7 }, { creatorUid: 7 }), true, 'MakerWorld 比 creatorUid');
  assert.equal(profileByAuthor({ authorUid: '7' }, { creatorUid: 8 }), false);
  assert.equal(profileByAuthor({ authorUid: 7 }, { name: 'x' }), null, '没字段返回 null，界面不显示');
});

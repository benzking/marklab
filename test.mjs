// 自检：node --test test.mjs
// 只测纯函数（站点识别 / Nuxt 反序列化 / 富文本清洗），不联网不起浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPlatform, resolveNuxt, sanitize, slugify, autoTags } from './lib.mjs';

test('认得出三个站点的网址，并抽出 id', () => {
  assert.deepEqual(matchPlatform('https://space.snapmaker.cn/zh/model/1695-model?from=recommend#profileId-1773'), {
    name: 'snapmaker',
    id: '1695',
  });
  assert.deepEqual(
    matchPlatform('https://makerworld.com.cn/zh/models/2250933-1mi-zhuang-jia-du-jiao-shou-wan-zheng-ban-shi-yan#profileId-2531474'),
    { name: 'makerworld', id: '2250933' },
  );
  assert.deepEqual(
    matchPlatform('https://www.crealitycloud.cn/model-detail/68fddae0d894ed5f6ce386a7?source=1&recReqId=pr_x'),
    { name: 'creality', id: '68fddae0d894ed5f6ce386a7' },
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
  assert.deepEqual(matchPlatform(u), { name: 'makeronline', id: '341770' });
});

test('创想云带 profileId 的 3mf 版网址也能认出 id', () => {
  const u = 'https://www.crealitycloud.cn/model-detail/6a8ab5076a693e6edad42a03?source=8&profileId=6a8ab5096a693eedad42a6c';
  assert.deepEqual(matchPlatform(u), { name: 'creality', id: '6a8ab5076a693e6edad42a03' });
});

test('MakerOnline 国内站 .cn 也认', () => {
  const u = 'https://www.makeronline.cn/zh/model/%E5%8F%A4%E4%BB%A3%E6%B7%B7%E6%B2%8C%E4%B9%8B%E5%BA%93/207581.html';
  assert.deepEqual(matchPlatform(u), { name: 'makeronline', id: '207581' });
});

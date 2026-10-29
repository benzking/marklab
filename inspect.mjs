// 看一个 3mf / stl 里面有什么：3mf 抠出打印盘缩略图、盘名、耗时/克重/耗材；
// stl 算出三角面数和外形尺寸。纯 Node，不依赖解压工具（zlib 就够）。
//
//   node inspect.mjs library/xxx/files/01-a.3mf
//
// 3mf 的盘图会写到同目录的 preview/ 下，返回里给相对路径。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

// 极简 zip 读取：只认 store/deflate，够读 3mf
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const nameLen = buf.readUInt16LE(e.localOff + 26);
      const extraLen = buf.readUInt16LE(e.localOff + 28);
      const start = e.localOff + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.compSize);
      return e.method === 0 ? raw : inflateRawSync(raw);
    },
  };
}

// <plate>…<metadata key="k" value="v"/></plate> 这类结构
function platesFromXml(xml) {
  const plates = [];
  for (const m of String(xml || '').matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const meta = {};
    for (const mm of m[1].matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"/g)) meta[mm[1]] = mm[2];
    const filaments = [];
    for (const fm of m[1].matchAll(/<filament\b([^>]*)\/?>/g)) {
      const attrs = {};
      for (const am of fm[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[am[1]] = am[2];
      filaments.push({ type: attrs.type, color: attrs.color, usedG: Number(attrs.used_g) || null });
    }
    plates.push({ meta, filaments });
  }
  return plates;
}

export async function inspectFile(file) {
  const buf = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  const dir = path.dirname(file);
  const previewDir = path.join(dir, 'preview', path.basename(file, ext));

  if (ext === '.3mf' || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const zip = readZip(buf);
    const sliceXml = zip.read('Metadata/slice_info.config')?.toString('utf8') || '';
    const settingsXml = zip.read('Metadata/model_settings.config')?.toString('utf8') || '';
    const slicePlates = platesFromXml(sliceXml);
    const settingPlates = platesFromXml(settingsXml);

    // 盘图落盘
    const plateImgs = zip.names
      .filter((n) => /^Metadata\/plate_\d+\.png$/i.test(n))
      .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
    await mkdir(previewDir, { recursive: true });
    const thumbs = [];
    for (const name of plateImgs) {
      const idx = Number(name.match(/(\d+)/)[1]);
      const out = path.join(previewDir, `plate-${idx}.png`);
      await writeFile(out, zip.read(name));
      thumbs.push({ index: idx, file: path.relative(dir, out).split(path.sep).join('/') });
    }

    const count = Math.max(thumbs.length, slicePlates.length, settingPlates.length);
    const plates = Array.from({ length: count }, (_, i) => {
      const idx = i + 1;
      const s = slicePlates[i] || { meta: {}, filaments: [] };
      const nameMeta = settingPlates[i]?.meta || {};
      return {
        index: idx,
        name: nameMeta.plater_name || nameMeta.plate_name || `打印盘 ${idx}`,
        timeSec: Number(s.meta.prediction) || null,
        weightG: Number(s.meta.weight) || null,
        thumb: thumbs.find((t) => t.index === idx)?.file || null,
        filaments: s.filaments,
      };
    });

    const layer = /layer_height\s*=\s*"?([\d.]+)/.exec(zip.read('Metadata/project_settings.config')?.toString('utf8') || '')?.[1];
    const modelXml = zip.read('3D/3dmodel.model')?.toString('utf8') || '';
    const objects = (modelXml.match(/<object\b/g) || []).length;

    return {
      kind: '3mf',
      plates,
      objects,
      layerHeight: layer ? Number(layer) : null,
      entries: zip.names.length,
    };
  }

  if (ext === '.stl') {
    // 二进制 STL：80 字节头 + uint32 面数 + 每面 50 字节
    const n = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
    if (n > 0 && buf.length === 84 + n * 50) {
      let min = [Infinity, Infinity, Infinity];
      let max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < n; i++) {
        const base = 84 + i * 50 + 12;
        for (let v = 0; v < 3; v++) {
          for (let a = 0; a < 3; a++) {
            const val = buf.readFloatLE(base + v * 12 + a * 4);
            if (val < min[a]) min[a] = val;
            if (val > max[a]) max[a] = val;
          }
        }
      }
      return {
        kind: 'stl',
        triangles: n,
        sizeMm: max.map((v, i) => Math.round((v - min[i]) * 10) / 10),
      };
    }
    return { kind: 'stl', triangles: null, note: 'ASCII STL，没算尺寸' };
  }

  return { kind: ext.replace('.', '') || 'unknown' };
}

// 命令行直接看一个文件
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node inspect.mjs <文件.3mf|.stl>');
    process.exit(1);
  }
  console.log(JSON.stringify(await inspectFile(file), null, 2));
}

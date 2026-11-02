// 只在测试里注册的假站点包：证明「加一个站点只碰一个文件」——公共层一行都不用改。
// 它不出现在 sites/index.mjs 的登记表里，生产环境永远看不到。
const HOSTS = ['fixture.example'];

export function match(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!HOSTS.includes(u.hostname.toLowerCase())) return null;
  const id = /^\/thing\/(\d+)/.exec(u.pathname)?.[1];
  return id ? { site: 'fixture', id, url: `https://${u.hostname}${u.pathname}` } : null;
}

export function matchUser() {
  return null;
}

export async function loginState() {
  return { ok: false, status: 'logged-out' };
}

export async function meta(url) {
  const hit = match(url);
  if (!hit) throw new Error('不是假站点网址');
  return {
    platform: 'fixture',
    id: hit.id,
    sourceUrl: hit.url,
    title: '假站点模型',
    author: '假作者',
    description: '<p>干净描述</p>',
    images: [],
    stats: { downloads: 1 },
    category: '假分类',
    tags: [],
    profiles: [],
    print: null,
    files: [{ name: 'a.stl', format: 'stl', size: 3, kind: 'model', origin: 'author' }],
    docs: [],
  };
}

export async function fileLinks() {
  return [{ name: 'a.stl', url: 'https://fixture.example/a.stl', size: 3, kind: 'model', origin: 'author' }];
}

export async function categories() {
  return [{ id: 1, name: '假分类', children: [] }];
}

export async function search() {
  return { total: 0, items: [] };
}

export async function userModels() {
  return { total: 0, items: [] };
}

export default {
  site: 'fixture',
  platform: 'fixture',
  label: 'Fixture',
  hosts: HOSTS,
  discover: false,
  categoriesKey: 'fixture',
  match,
  matchUser,
  loginState,
  meta,
  fileLinks,
  categories,
  search,
  userModels,
};

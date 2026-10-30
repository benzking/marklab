// 站点包共用的匿名 HTTP：只做 GET 拿文本/JSON，不带任何登录态（ADR-0003 匿名优先）。
// 要登录态的请求走 channel.mjs 的 fetchAs，不在这里。

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export async function httpGet(target) {
  const r = await fetch(target, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'follow',
  });
  return { status: r.status, text: await r.text() };
}

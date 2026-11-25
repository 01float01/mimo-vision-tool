/**
 * net-router — 统一网络层(本地插件共享模块)
 *
 * 目标: 所有插件灵活适应「本地代理开/关」, 无需改配置、无需重启改设置:
 *   - useProxy = false -> 永远直连(国内端点推荐);
 *   - useProxy = true  -> 优先显式 proxyUrl(先探测端口可达性),
 *     不可达时回退自动探测本机常用代理端口(7891/7890/7897),
 *     都不可达时降级为直连(宁可直连失败, 不把请求打到死端口)。
 *
 * 探测结果按 60s TTL 缓存, 避免每轮请求重复 TCP 探测。
 */
import net from 'node:net';

const DEFAULT_PORTS = [7891, 7890, 7897];
let cache = { url: null, at: 0 };
const TTL_MS = 60000;

export function probePort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.on('connect', () => finish(true));
    s.on('error', () => finish(false));
    s.on('timeout', () => finish(false));
  });
}

function portOf(url) {
  try {
    const u = new URL(url);
    const p = Number(u.port);
    return p > 0 ? p : (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return 0;
  }
}

export async function detectLocalProxyUrl(force = false) {
  if (!force && cache.at && Date.now() - cache.at < TTL_MS) return cache.url;
  let url = null;
  for (const p of DEFAULT_PORTS) {
    if (await probePort(p)) {
      url = 'http://127.0.0.1:' + p;
      break;
    }
  }
  cache = { url, at: Date.now() };
  return url;
}

export function clearProxyCache() {
  cache = { url: null, at: 0 };
}

/**
 * 解析最终代理 URL(可能为 null=直连)。
 * @param {{useProxy?: boolean, proxyUrl?: string}} opts
 * @returns {Promise<string|null>}
 */
export async function resolveProxyUrl(opts = {}) {
  const useProxy = opts.useProxy !== false;
  if (!useProxy) return null;
  const explicit = typeof opts.proxyUrl === 'string' ? opts.proxyUrl.trim() : '';
  if (explicit !== '') {
    const p = portOf(explicit);
    if (p > 0 && (await probePort(p))) return explicit;
    // 显式代理不可达 -> 回退自动探测
  }
  return detectLocalProxyUrl();
}

export async function createHttpsProxyAgent(proxyUrl) {
  try {
    const mod = await import('https-proxy-agent');
    const HttpsProxyAgent = mod.HttpsProxyAgent || mod.default;
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    return null;
  }
}

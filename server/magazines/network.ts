import { AsyncLocalStorage } from 'node:async_hooks';
import { GITHUB_REPO_NAME, GITHUB_REPO_OWNER, MAGAZINE_SOURCES } from './config';
import { MAGAZINE_LIBRARY_ORIGIN } from '../../src/lib/magazineDistribution';

const MAX_REDIRECTS = 5;
const repository = `/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;
const configuredWebHosts = new Set(MAGAZINE_SOURCES.flatMap(source => {
  if (!source.sourceUrl) return [];
  const host = new URL(source.sourceUrl).hostname;
  return [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`, ...(source.imageHosts || [])];
}));

/** Only the configured catalogue and its archive download hosts can use the manual exception. */
export function validateMagazineNetworkUrl(input: string | URL): URL {
  const url = new URL(input instanceof URL ? input.href : input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('外刊来源必须使用不含凭据的 HTTPS 地址。');
  }
  const host = url.hostname.toLowerCase();
  const official = url.origin === MAGAZINE_LIBRARY_ORIGIN && !url.search && !url.hash
    && (url.pathname === '/api/library/catalog' || /^\/api\/library\/files\/[a-f0-9]{64}$/.test(url.pathname));
  const allowed = official || configuredWebHosts.has(host)
    || (host === 'api.github.com' && (url.pathname === `/repos${repository}/contents`
      || url.pathname.startsWith(`/repos${repository}/contents/`)))
    || (['github.com', 'raw.githubusercontent.com', 'codeload.github.com'].includes(host)
      && url.pathname.startsWith(`${repository}/`))
    // GitHub archive redirects use these exact CDN hosts, rather than arbitrary subdomains.
    || ['objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(host);
  if (!allowed) throw new Error(`此地址不是已配置的外刊来源：${host}`);
  return url;
}

export function createMagazineNetwork(fetcher: typeof fetch, options: {
  offline: boolean;
  manualSyncEnabled: boolean;
}) {
  const manualSync = new AsyncLocalStorage<boolean>();
  const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], scopedHosts?: ReadonlySet<string>): Promise<Response> => {
    if (options.offline && (!options.manualSyncEnabled || manualSync.getStore() !== true)) {
      throw new Error('本地版外刊联网仅在手动更新期间启用。');
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!['GET', 'HEAD'].includes(method) || init?.body || (input instanceof Request && input.body)) {
      throw new Error('外刊来源仅支持读取。');
    }
    let url = validateMagazineNetworkUrl(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // Learning archives and local API credentials never leave the local service.
    for (const name of ['cookie', 'proxy-authorization', 'x-api-token', 'x-readage-local-data']) headers.delete(name);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (scopedHosts && !scopedHosts.has(url.hostname.toLowerCase())) throw new Error('正文图片的重定向离开了该来源的图片范围。');
      signal?.throwIfAborted();
      const outgoingHeaders = new Headers(headers);
      if (!['api.github.com', 'github.com'].includes(url.hostname)) outgoingHeaders.delete('authorization');
      const response = await fetcher(url, { ...init, method, headers: outgoingHeaders, signal, redirect: 'manual', credentials: 'omit' });
      if (response.status < 300 || response.status >= 400) return response;
      await response.body?.cancel().catch(() => {});
      if (url.origin === MAGAZINE_LIBRARY_ORIGIN) throw new Error('官网期刊下载不接受重定向。');
      if (redirects === MAX_REDIRECTS) throw new Error('外刊来源的重定向次数过多。');
      const location = response.headers.get('location');
      if (!location) throw new Error('外刊来源没有返回有效的重定向地址。');
      // Validate each hop before any request is sent, including the final download.
      url = validateMagazineNetworkUrl(new URL(location, url));
    }
    throw new Error('外刊来源的重定向次数过多。');
  };
  return { fetch: request,
    fetchScoped: (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], hosts: readonly string[]) => request(input, init, new Set(hosts)),
    runManualSync: <T>(operation: () => T): T => manualSync.run(true, operation) };
}

let network = createMagazineNetwork((input, init) => globalThis.fetch(input, init), { offline: false, manualSyncEnabled: false });

/** Capture the original transport before the global local-only fetch boundary is installed. */
export function configureMagazineNetwork(fetcher: typeof fetch, options: { offline: boolean; manualSyncEnabled: boolean }): void {
  network = createMagazineNetwork(fetcher, options);
}

export const magazineFetch: typeof fetch = (input, init) => network.fetch(input, init);
export const magazineImageFetch = (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], hosts: readonly string[]) => network.fetchScoped(input, init, hosts);
export function runWithManualMagazineNetwork<T>(operation: () => T): T { return network.runManualSync(operation); }

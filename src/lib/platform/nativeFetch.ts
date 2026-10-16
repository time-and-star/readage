interface NativeFetchOptions {
  origin: string;
  localFetch: typeof fetch;
  dictionaryFetch: typeof fetch;
  translationFetch?: typeof fetch;
  magazineFetch?: typeof fetch;
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

/** The WebView serves bundled assets; supported APIs are executed on the device. */
export function createNativeAppFetch(options: NativeFetchOptions): typeof fetch {
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, options.origin);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    if (url.origin !== options.origin || url.username || url.password) throw new Error('手机本地版本已停止外部网络访问。');
    if (url.pathname.startsWith('/api/dictionary/')) return options.dictionaryFetch(input, init);
    if (url.pathname.startsWith('/api/magazines/') && options.magazineFetch) return options.magazineFetch(input, init);
    if (url.pathname === '/api/import/backfill-results') return json({ ok: true, results: [], updatedAt: null });
    if (url.pathname === '/api/import/pause') return json({ paused: true, reason: '手机本地版本按需翻译。' });
    if (url.pathname === '/api/health') return json({ ok: true, service: 'readage-android', platform: 'android' });
    if (url.pathname === '/api/translation' || url.pathname === '/api/translation/status') {
      if (options.translationFetch) return options.translationFetch(input, init);
      return json({ ok: false, error: { code: 'NATIVE_MODEL_MISSING', message: '安装包中的本机翻译组件不可用，请重试或安装完整版本。' } }, 503);
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: { code: 'NATIVE_FEATURE_UNAVAILABLE', message: '手机本地版尚未接入此功能。请使用已导入的文章和本机学习档案。' } }, 503);
    return options.localFetch(input, { ...init, redirect: 'error' });
  };
}

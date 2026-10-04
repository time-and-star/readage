import { DEFAULT_SERVICE_ORIGIN, normalizeServiceOrigin } from '../src/lib/browserExtension/protocol';

interface ExtensionStatus {
  ok: true;
  settings: { origin: string; enabled: boolean; sites: string[] };
  pending: number;
  otherPending: number;
  serviceGranted?: boolean;
  appOpen?: boolean;
  syncing?: boolean;
  sync: { lastSyncedAt?: string; error?: string | null; state?: string } | null;
}
type Connection = 'unknown' | 'checking' | 'online' | 'offline';
type Feedback = { text: string; tone?: 'success' | 'info' | 'error' };
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const origin = element<HTMLInputElement>('origin');
const enabled = element<HTMLInputElement>('enabled');
const message = element('message');
let currentOrigin = DEFAULT_SERVICE_ORIGIN;
let currentSite: string | null = null;
let currentSiteUrl: string | null = null;
let currentSiteReady = false;
let serviceGranted = false;
let status: ExtensionStatus | null = null;
let connection: Connection = 'unknown';
let connectionError = '';
let busy = false;
let pendingEnabled: boolean | null = null;
let refreshVersion = 0;
let connectionVersion = 0;

const send = async <T = any>(data: unknown): Promise<T> => {
  const result = await chrome.runtime.sendMessage(data);
  if (!result?.ok) throw new Error(result?.error || '操作失败，请重试。');
  return result;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
function feedback(value?: Feedback) {
  message.hidden = !value;
  message.textContent = value?.text || '';
  message.dataset.tone = value?.tone || 'success';
}
function badge(id: string, text: string, tone = '') {
  const node = element(id); node.textContent = text; node.dataset.tone = tone;
}
function buttonLabel(id: string, text: string, arrow?: string) {
  const node = element<HTMLButtonElement>(id);
  node.replaceChildren(document.createTextNode(text));
  if (arrow) { const icon = document.createElement('span'); icon.textContent = arrow; icon.setAttribute('aria-hidden', 'true'); node.append(icon); }
}
function supportedPage(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
      || url.hostname === 'chromewebstore.google.com'
      || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))
      || (url.hostname === 'microsoftedge.microsoft.com' && url.pathname.startsWith('/addons'))) return null;
    return url.href;
  } catch { return null; }
}
function render() {
  if (!status) return;
  const active = pendingEnabled ?? status.settings.enabled;
  enabled.checked = active;
  enabled.disabled = busy;
  element('enabled-label').textContent = active ? '开启' : '暂停';
  origin.disabled = busy;
  const appPage = currentSite === currentOrigin;
  const usableSite = Boolean(currentSite && !appPage);
  const siteName = element('site-name');
  siteName.textContent = appPage ? '我的学习' : currentSite ? new URL(currentSite).hostname.replace(/^www\./, '') : '打开一篇英文文章';
  siteName.title = currentSite || '';
  const connectButton = element<HTMLButtonElement>('connect');
  const siteButton = element<HTMLButtonElement>('site');
  connectButton.hidden = serviceGranted && connection !== 'offline';
  connectButton.disabled = busy;
  buttonLabel('connect', serviceGranted ? '重新连接' : '连接 ReadAge', '↗');
  siteButton.hidden = !serviceGranted || !usableSite;
  siteButton.disabled = busy || !usableSite;
  siteButton.dataset.ready = String(currentSiteReady && active);
  buttonLabel('site', currentSiteReady && active ? '暂停' : '启用');
  siteButton.setAttribute('aria-label', currentSiteReady && active ? '暂停此网站查词' : '启用此网站查词');
  let setup = '';
  if (!serviceGranted) {
    badge('site-badge', '待连接', 'warning');
    setup = '连接学习应用，即可使用词典并积累查词记录。';
  } else if (!active) {
    badge('site-badge', '已暂停');
    setup = '网页查词已暂停。打开上方开关即可恢复。';
  } else if (appPage) {
    badge('site-badge', '学习应用');
    setup = '切换到英文网页，选词即可查询释义。';
  } else if (!usableSite) {
    badge('site-badge', '此页不支持');
    setup = '浏览器设置页、扩展商店和内置 PDF 不支持查词。';
  } else if (currentSiteReady) {
    badge('site-badge', '已启用', 'success');
    setup = connection === 'offline' ? '词典暂时离线，已缓存的词仍可查询。' : '选中一个英文单词，即可查看释义。';
  } else {
    badge('site-badge', '待启用', 'warning');
    setup = '为这篇阅读开启词典，选词即可查询。';
  }
  element('setup').textContent = setup;
  element('setup').hidden = serviceGranted && active && usableSite && currentSiteReady && connection !== 'offline';
  element('site-card').setAttribute('aria-busy', String(busy));
  badge('connection-badge', !serviceGranted ? '尚未连接' : connection === 'checking' ? '检查中…'
    : connection === 'online' ? '词典可用' : connection === 'offline' ? '词典离线' : '已授权', connection === 'online' ? 'success' : connection === 'offline' ? 'warning' : '');
  element('connection-badge').title = connectionError || currentOrigin;
  element('connection-badge').hidden = serviceGranted && (connection === 'online' || connection === 'unknown');
  element('pending').textContent = String(status.pending);
  const pending = status.pending;
  element('learning-card').hidden = !serviceGranted && !pending && !status.otherPending;
  const syncError = status.sync?.error;
  const syncing = status.syncing || status.sync?.state === 'syncing';
  badge('sync-badge', syncing ? '同步中…' : pending && !serviceGranted ? '等待连接'
    : pending && !status.appOpen ? '已暂存' : pending && syncError ? '等待重试'
    : pending ? '等待同步' : status.sync?.lastSyncedAt ? '记录已同步' : '记录自动保存', syncError && pending ? 'warning' : !pending ? 'success' : '');
  element('queue-number').hidden = !pending;
  element('sync-badge').hidden = Boolean(pending && !syncing);
  element<HTMLButtonElement>('sync').hidden = !pending;
  element('last').textContent = pending && !serviceGranted ? '连接学习应用后，可同步已保存的记录。'
    : pending && !status.appOpen ? '已保存在此浏览器，打开学习应用后自动同步。'
    : pending && syncError ? syncError
    : pending ? '等待学习应用确认，完成后自动同步。'
    : status.sync?.lastSyncedAt ? `最近同步 ${new Date(status.sync.lastSyncedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : '每次查词，都会自动留在你的学习记录里。';
  element('last').hidden = !(pending && syncError && status.appOpen);
  element('sync-row').title = element('last').textContent || '';
  element<HTMLButtonElement>('open').hidden = !serviceGranted;
  const other = element('other');
  other.hidden = !status.otherPending;
  other.textContent = status.otherPending ? `另有 ${status.otherPending} 条属于其他应用地址，切回对应地址可同步。` : '';
  for (const id of ['save', 'open']) element<HTMLButtonElement>(id).disabled = busy;
  element<HTMLButtonElement>('check').disabled = busy || !serviceGranted || connection === 'checking';
  element<HTMLButtonElement>('sync').disabled = busy || !serviceGranted || !pending || Boolean(syncing);
}
async function refresh(initial = false) {
  const version = ++refreshVersion;
  const result = await send<ExtensionStatus>({ type: 'STATUS' });
  const [tabs, granted] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.permissions.contains({ origins: [`${result.settings.origin}/*`] }),
  ]);
  const url = supportedPage(tabs[0]?.url);
  const site = url ? new URL(url).origin : null;
  const siteReady = Boolean(site && result.settings.sites.includes(site)
    && await chrome.permissions.contains({ origins: [`${site}/*`] }));
  if (version !== refreshVersion) return;
  if (result.settings.origin !== currentOrigin) { connection = 'unknown'; connectionError = ''; connectionVersion++; }
  currentOrigin = result.settings.origin; status = result; serviceGranted = granted;
  currentSiteUrl = url; currentSite = site; currentSiteReady = siteReady;
  if (initial) origin.value = currentOrigin;
  render();
}
async function checkConnection(): Promise<void> {
  const version = ++connectionVersion;
  connection = 'checking'; connectionError = ''; render();
  try {
    await send({ type: 'CHECK' });
    if (version === connectionVersion) { connection = 'online'; render(); }
  } catch (error) {
    if (version === connectionVersion) { connection = 'offline'; connectionError = errorText(error); render(); }
    throw error;
  }
}
function action(id: string, run: () => Promise<Feedback>) {
  const button = element<HTMLButtonElement>(id);
  button.addEventListener('click', () => {
    if (busy || !status) return;
    busy = true; feedback(); render();
    button.setAttribute('aria-busy', 'true');
    // Keep permission requests in the original click gesture.
    void run().then(feedback).catch(error => feedback({ text: errorText(error), tone: 'error' }))
      .finally(async () => {
        try { await refresh(); } catch { /* Preserve the result of the user's action. */ }
        busy = false; button.removeAttribute('aria-busy'); render();
      });
  });
}
function serviceInput() {
  try { const value = normalizeServiceOrigin(origin.value); origin.removeAttribute('aria-invalid'); return value; }
  catch { origin.setAttribute('aria-invalid', 'true'); origin.focus(); throw new Error('请输入有效的 HTTPS 根地址，或本机地址（如 http://localhost:3000），不包含路径。'); }
}
async function openApp() {
  const tabs = await chrome.tabs.query({ url: `${currentOrigin}/*` });
  const existing = tabs.find(tab => tab.id !== undefined);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: currentOrigin });
}
action('save', async () => {
  const service = serviceInput();
  if (!await chrome.permissions.request({ origins: [`${service}/*`] })) throw new Error('未获得访问权限，应用地址未更改。');
  await send({ type: 'SAVE_SETTINGS', origin: service, enabled: enabled.checked });
  origin.value = service;
  await refresh();
  try { await checkConnection(); return { text: '设置已保存，词典连接正常。' }; }
  catch (error) { return { text: `设置已保存。${errorText(error)}`, tone: 'info' }; }
});
action('connect', async () => {
  if (!await chrome.permissions.request({ origins: [`${currentOrigin}/*`] })) throw new Error('未获得访问权限。再次点击即可连接。');
  await send({ type: 'SAVE_SETTINGS', origin: currentOrigin, enabled: enabled.checked });
  await refresh();
  await checkConnection();
  await openApp();
  return { text: '词典连接正常。回到英文网页，启用该网站即可查词。' };
});
enabled.addEventListener('change', () => {
  if (busy || !status) return;
  const active = enabled.checked;
  pendingEnabled = active;
  busy = true; feedback(); render();
  void send({ type: 'SET_ENABLED', enabled: active }).then(async () => {
    await refresh(); feedback({ text: active ? '网页查词已恢复。' : '网页查词已暂停，已有学习记录会继续同步。', tone: 'info' });
  }).catch(error => feedback({ text: errorText(error), tone: 'error' }))
    .finally(() => { pendingEnabled = null; busy = false; render(); });
});
action('site', async () => {
  const url = currentSiteUrl; const site = currentSite;
  if (!url || !site || site === currentOrigin) throw new Error('请切换到普通英文网页，再启用查词。');
  if (currentSiteReady && status?.settings.enabled) {
    await send({ type: 'DISABLE_SITE', url });
    return { text: '此网站的查词已暂停，其他网站不受影响。', tone: 'info' };
  }
  if (!await chrome.permissions.request({ origins: [...new Set([`${site}/*`, `${currentOrigin}/*`])] })) throw new Error('未获得网站访问权限。');
  await send({ type: 'SAVE_SETTINGS', origin: currentOrigin, enabled: true });
  await send({ type: 'ENABLE_SITE', url });
  return { text: '此网站已启用。选中一个英文单词，再点「查词」。' };
});
action('check', async () => { await checkConnection(); return { text: '词典服务连接正常。' }; });
action('sync', async () => {
  const result = await send<ExtensionStatus>({ type: 'SYNC' });
  if (!result.pending) return { text: '记录已同步到学习应用。' };
  if (!result.appOpen || result.sync?.state === 'waiting_for_app') return { text: `已保存 ${result.pending} 条记录。打开学习应用后会自动同步。`, tone: 'info' };
  return { text: result.sync?.error || `仍有 ${result.pending} 条记录等待同步，请稍后重试。`, tone: 'info' };
});
action('open', async () => { await openApp(); return { text: '已打开学习应用，暂存记录会自动同步。' }; });
origin.addEventListener('input', () => origin.removeAttribute('aria-invalid'));
origin.addEventListener('keydown', event => { if (event.key === 'Enter' && !busy) { event.preventDefault(); element<HTMLButtonElement>('save').click(); } });
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { void refresh().catch(() => {}); }, 100);
}
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') scheduleRefresh(); });
window.addEventListener('focus', scheduleRefresh);
// The options page can stay open while the user changes browser tabs.
const poll = setInterval(() => { if (!document.hidden) scheduleRefresh(); }, 8_000);
window.addEventListener('pagehide', () => { clearInterval(poll); clearTimeout(refreshTimer); });
void refresh(true).then(() => {
  if (serviceGranted) void checkConnection().catch(() => {});
}).catch(error => feedback({ text: errorText(error), tone: 'error' }));

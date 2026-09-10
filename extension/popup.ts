import { DEFAULT_SERVICE_ORIGIN, normalizeServiceOrigin } from '../src/lib/browserExtension/protocol';
const origin = document.querySelector<HTMLInputElement>('#origin')!;
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const message = document.querySelector<HTMLElement>('#message')!;
let currentOrigin = DEFAULT_SERVICE_ORIGIN;
let currentSite: string | null = null;
let currentSiteUrl: string | null = null;
const send = async (data: unknown) => {
  const result = await chrome.runtime.sendMessage(data);
  if (!result?.ok) throw new Error(result?.error || '操作失败。');
  return result;
};
async function refresh(initial = false) {
  const result = await send({ type: 'STATUS' }); currentOrigin = result.settings.origin;
  if (initial) { origin.value = currentOrigin; enabled.checked = result.settings.enabled; }
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentSiteUrl = activeTab?.url && /^https?:/.test(activeTab.url) ? activeTab.url : null;
  currentSite = currentSiteUrl ? new URL(currentSiteUrl).origin : null;
  const serviceGranted = await chrome.permissions.contains({ origins: [`${currentOrigin}/*`] });
  const siteButton = document.querySelector<HTMLButtonElement>('#site')!;
  const siteReady = Boolean(currentSite && result.settings.sites.includes(currentSite)
    && await chrome.permissions.contains({ origins: [`${currentSite}/*`] }));
  siteButton.disabled = !currentSite || currentSite === currentOrigin;
  siteButton.textContent = siteReady ? '此网站已启用查词' : '为当前网站启用查词';
  document.querySelector('#setup')!.textContent = !serviceGranted
    ? '第一步：连接学习应用，允许插件访问词典。'
    : !result.settings.enabled ? '网页查词已暂停，可打开下方开关。'
    : siteReady ? '已就绪：选中网页中的英文单词，再点「查词」。'
    : '下一步：打开英文网页，为该网站启用查词。';
  document.querySelector('#connect')!.textContent = serviceGranted ? '检查并打开学习应用' : '连接学习应用';
  document.querySelector('#pending')!.textContent = `待同步 ${result.pending} 条查词记录`;
  document.querySelector('#last')!.textContent = result.sync?.error || (result.sync?.lastSyncedAt ? `最近同步：${new Date(result.sync.lastSyncedAt).toLocaleString()}` : '尚未同步。打开主应用即可连接。');
  document.querySelector('#other')!.textContent = result.otherPending ? `另有 ${result.otherPending} 条属于其他主应用地址；切回对应地址后同步。` : '';
}
function action(id: string, run: () => Promise<string>) {
  const button = document.querySelector<HTMLButtonElement>(id)!;
  button.addEventListener('click', () => {
    // Start immediately inside the user gesture so Chrome can show permission UI.
    button.disabled = true; message.textContent = '';
    void run().then(text => { message.textContent = text; return refresh(); })
      .catch(error => { message.textContent = error instanceof Error ? error.message : '操作失败。'; })
      .finally(() => { button.disabled = false; });
  });
}
action('#save', async () => {
  const service = normalizeServiceOrigin(origin.value);
  if (!await chrome.permissions.request({ origins: [`${service}/*`] })) throw new Error('未授权，设置未更改。');
  await send({ type: 'SAVE_SETTINGS', origin: service, enabled: enabled.checked });
  await send({ type: 'CHECK' });
  return '设置已保存。';
});

action('#connect', async () => {
  if (!await chrome.permissions.request({ origins: [`${currentOrigin}/*`] })) throw new Error('未授权。再次点击即可连接。');
  await send({ type: 'SAVE_SETTINGS', origin: currentOrigin, enabled: enabled.checked });
  await send({ type: 'CHECK' });
  const tabs = await chrome.tabs.query({ url: `${currentOrigin}/*` });
  if (!tabs.length) await chrome.tabs.create({ url: currentOrigin });
  return '词典连接正常。接下来打开英文网页并启用查词。';
});

enabled.addEventListener('change', () => {
  void send({ type: 'SET_ENABLED', enabled: enabled.checked }).then(() => refresh())
    .catch(error => { enabled.checked = !enabled.checked; message.textContent = String(error); });
});
action('#site', async () => {
  const url = currentSiteUrl;
  const site = currentSite;
  if (!url || !site) throw new Error('此页面不支持查词，请切换到普通网页。');
  if (!await chrome.permissions.request({ origins: [...new Set([`${site}/*`, `${currentOrigin}/*`])] })) throw new Error('未授权此网站。');
  await send({ type: 'SAVE_SETTINGS', origin: currentOrigin, enabled: enabled.checked });
  await send({ type: 'ENABLE_SITE', url });
  await send({ type: 'CHECK' });
  return '已启用。选中网页中的英文单词即可查词。';
});
action('#check', async () => { await send({ type: 'CHECK' }); return '词典服务连接正常。'; });
action('#sync', async () => { await send({ type: 'SYNC' }); return '已检查同步状态。'; });
action('#open', async () => { await chrome.tabs.create({ url: currentOrigin }); return '已打开主应用。'; });
void refresh(true).catch(error => { message.textContent = String(error); });
setInterval(() => { void refresh().catch(() => {}); }, 2_000);

import { bookAppearance, bookCategoryLabel, filterLibraryItems, libraryBookCategories } from './book-presentation.js';

const downloads = /** @type {HTMLDetailsElement} */ (document.getElementById('downloads'));
const summary = downloads.querySelector('summary');
function openRequestedDownload() {
  if (window.location.hash === '#download') downloads.open = true;
}
window.addEventListener('hashchange', openRequestedDownload);
openRequestedDownload();
const menuToggle = document.getElementById('menu-toggle');
const menu = /** @type {HTMLDialogElement} */ (document.getElementById('site-menu'));
const dialogs = [...document.querySelectorAll('dialog')];
const guestbookPanel = document.getElementById('guestbook-panel');

menuToggle.addEventListener('click', () => {
  downloads.open = false;
  menu.showModal();
  menuToggle.setAttribute('aria-expanded', 'true');
});
for (const dialog of dialogs) {
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (dialog === menu) menuToggle.setAttribute('aria-expanded', 'false');
    if (!dialogs.some(panel => panel.open)) menuToggle.focus({ preventScroll: true });
  });
}
for (const trigger of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-open]'))) {
  trigger.addEventListener('click', () => {
    menu.close();
    const panel = /** @type {HTMLDialogElement} */ (document.getElementById(trigger.dataset.open));
    panel.showModal();
    if (panel === guestbookPanel) initializeGuestbook();
    if (panel.id === 'library-panel') void loadLibrary();
  });
}
document.addEventListener('click', event => {
  if (!downloads.contains(/** @type {Node} */ (event.target))) downloads.open = false;
});

/** @type {Array<{id:string,kind:string,title:string,filename:string,bytes:number,updatedAt:string,sha256:string,downloadPath:string,sourceUrl?:string}>} */
let libraryItems = [];
const librarySearch = /** @type {HTMLInputElement} */ (document.getElementById('library-search'));
const libraryCategory = /** @type {HTMLSelectElement} */ (document.getElementById('library-category'));
const libraryStatus = document.getElementById('library-status');
function renderLibrary() {
  const list = document.getElementById('library-list'); list.replaceChildren();
  const items = filterLibraryItems(libraryItems, { query: librarySearch.value, category: libraryCategory.value, kind: 'book' });
  libraryStatus.textContent = libraryItems.length ? (libraryCategory.value || librarySearch.value.trim()
    ? `已显示 ${items.length} 本 / 共 ${libraryItems.length} 本书籍。` : `共 ${libraryItems.length} 本书籍。`) : '服务器书籍目录已就绪。';
  for (const item of items) {
    const appearance = bookAppearance(item);
    const link = document.createElement('a'); link.className = 'ra-book-choice'; link.href = item.downloadPath; link.download = item.filename;
    link.setAttribute('aria-label', `下载${appearance.kindLabel}：${item.title}`);
    link.title = `${item.filename.split('.').at(-1).toUpperCase()} · ${(item.bytes / 1048576).toFixed(1)} MB`;
    const cover = document.createElement('span'); cover.className = 'ra-book-cover'; cover.dataset.theme = appearance.theme; cover.setAttribute('aria-hidden', 'true');
    for (const [className, text] of [['ra-book-kicker', appearance.label], ['ra-book-name', appearance.name], ['ra-book-orbit', ''], ['ra-book-edition', appearance.author || appearance.edition || '']]) {
      const part = document.createElement('span'); part.className = className; part.textContent = text; cover.append(part);
    }
    const meta = document.createElement('span'); meta.className = 'ra-book-meta'; meta.textContent = appearance.originalTitle || appearance.edition || appearance.kindLabel;
    const category = document.createElement('span'); category.className = 'ra-book-meta'; category.textContent = bookCategoryLabel(item);
    const action = document.createElement('span'); action.className = 'ra-book-state'; action.textContent = '下载整本 →';
    link.append(cover, meta, category, action); list.append(link);
  }
  if (!items.length) { const empty = document.createElement('p'); empty.className = 'empty-comments'; empty.textContent = libraryItems.length ? '没有找到相关书籍。' : '书籍正在整理，稍后再来。'; list.append(empty); }
}
async function loadLibrary() {
  libraryStatus.textContent = '正在读取资料…';
  try {
    const response = await fetch('/api/library/catalog', { cache: 'no-store' });
    if (!response.ok) throw new Error('资料库暂时不可用，请重试。');
    const data = await response.json(); libraryItems = data.items.filter(item => item.kind === 'book');
    const selected = libraryCategory.value; libraryCategory.replaceChildren();
    for (const category of [{ id: '', label: '全部分类', count: libraryItems.length }, ...libraryBookCategories(libraryItems)]) {
      const option = document.createElement('option'); option.value = category.id; option.textContent = `${category.label} · ${category.count}`; libraryCategory.append(option);
    }
    libraryCategory.value = [...libraryCategory.options].some(option => option.value === selected) ? selected : '';
    renderLibrary();
  } catch (error) { libraryStatus.textContent = error.message; }
}
librarySearch.addEventListener('input', renderLibrary);
libraryCategory.addEventListener('change', renderLibrary);
document.getElementById('library-refresh').addEventListener('click', () => void loadLibrary());
const adminStatus = document.getElementById('library-admin-status');
const adminToken = /** @type {HTMLInputElement} */ (document.getElementById('library-token'));
const uploadForm = /** @type {HTMLFormElement} */ (document.getElementById('library-upload'));
uploadForm.addEventListener('submit', async event => {
  event.preventDefault(); const file = /** @type {HTMLInputElement} */ (document.getElementById('library-file')).files[0];
  if (!file || file.size > (/\.epub$/i.test(file.name) ? 128 : 64) * 1048576) { adminStatus.textContent = '请选择 EPUB 不超过 128MB、其他格式不超过 64MB 的文件。'; return; }
  const button = /** @type {HTMLButtonElement} */ (document.getElementById('library-publish')); button.disabled = true; adminStatus.textContent = '上传中…';
  try {
    const response = await fetch('/api/library/admin/upload', { method: 'POST', headers: { Authorization: `Bearer ${adminToken.value}`, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Resource-Title': encodeURIComponent(/** @type {HTMLInputElement} */ (document.getElementById('library-book-title')).value), 'X-Resource-Id': /** @type {HTMLInputElement} */ (document.getElementById('library-book-id')).value.trim(), 'X-Resource-Language': /** @type {HTMLSelectElement} */ (document.getElementById('library-language')).value }, body: file });
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '上传失败。');
    /** @type {HTMLInputElement} */ (document.getElementById('library-book-id')).value = data.id;
    adminStatus.textContent = `已发布，资料编号 ${data.id}。`; await loadLibrary();
  } catch (error) { adminStatus.textContent = error.message; } finally { button.disabled = false; }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && downloads.open) {
    downloads.open = false;
    summary.focus({ preventScroll: true });
  }
});

const form = /** @type {HTMLFormElement} */ (document.getElementById('guestbook-form'));
const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('guest-name'));
const contentInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('guest-content'));
const answerInput = /** @type {HTMLInputElement} */ (document.getElementById('guest-answer'));
const publish = /** @type {HTMLButtonElement} */ (document.getElementById('publish-comment'));
const captchaImage = /** @type {HTMLImageElement} */ (document.getElementById('captcha-image'));
const refreshCaptcha = /** @type {HTMLButtonElement} */ (document.getElementById('refresh-captcha'));
const status = document.getElementById('guestbook-status');
const commentList = document.getElementById('comment-list');
const loadMore = /** @type {HTMLButtonElement} */ (document.getElementById('load-more-comments'));
let challenge = null, nextCursor = null, publishing = false, sessionSequence = 0;
class ApiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}
async function api(url, options) {
  let response;
  try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options }); }
  catch { throw new Error('无法连接留言服务，请稍后点击“刷新”重试。'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('留言服务暂时不可用，请稍后重试。'); }
  if (!response.ok) {
    throw new ApiError(data.error?.message || '操作未完成，请重试。', data.error?.code);
  }
  return data;
}
function acceptChallenge(value) {
  challenge = value;
  captchaImage.src = value.image;
  captchaImage.hidden = false;
  answerInput.value = '';
  publish.disabled = publishing;
}
function renderEntries(entries, append = false) {
  if (!append) commentList.replaceChildren();
  if (!entries.length && !append) {
    const empty = document.createElement('p');
    empty.className = 'empty-comments'; empty.textContent = '还没有留言，写下第一条吧。';
    commentList.append(empty);
  }
  for (const entry of entries) {
    const article = document.createElement('article'); article.className = 'comment';
    const header = document.createElement('header');
    const name = document.createElement('strong'); name.textContent = entry.name;
    header.append(name);
    if (entry.own) { const own = document.createElement('span'); own.className = 'own-comment'; own.textContent = '你'; header.append(own); }
    const time = document.createElement('time');
    time.dateTime = new Date(entry.createdAt).toISOString();
    time.textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(entry.createdAt);
    header.append(time);
    const content = document.createElement('p'); content.textContent = entry.content;
    article.append(header, content); commentList.append(article);
  }
}
function acceptPage(data, append = false) {
  renderEntries(data.entries, append);
  nextCursor = data.nextCursor;
  loadMore.hidden = !data.hasMore;
}
async function initializeGuestbook() {
  const sequence = ++sessionSequence;
  publish.disabled = true;
  commentList.setAttribute('aria-busy', 'true');
  setStatus('正在准备留言与验证码…');
  try {
    const data = await api('/api/guestbook/session');
    if (sequence !== sessionSequence) return;
    if (!nameInput.value) nameInput.value = data.name;
    acceptChallenge(data.challenge);
    acceptPage(data);
    setStatus('输入图中的四位数字即可发布。');
  } catch (error) {
    if (sequence !== sessionSequence) return;
    challenge = null; captchaImage.hidden = true; publish.disabled = true;
    setStatus(error.message, true);
  } finally {
    if (sequence === sessionSequence) commentList.setAttribute('aria-busy', 'false');
  }
}
async function loadChallenge() {
  refreshCaptcha.disabled = true; publish.disabled = true;
  try {
    const data = await api('/api/guestbook/challenge');
    acceptChallenge(data.challenge);
    return true;
  } catch (error) {
    challenge = null; captchaImage.hidden = true; publish.disabled = true;
    setStatus(error.message, true);
    return false;
  } finally { refreshCaptcha.disabled = false; }
}
refreshCaptcha.addEventListener('click', async () => {
  if (await loadChallenge()) { setStatus('验证码已更新。'); answerInput.focus(); }
});
contentInput.addEventListener('input', () => {
  document.getElementById('content-count').textContent = `${contentInput.value.length} / 1000`;
});
document.getElementById('reload-comments').addEventListener('click', initializeGuestbook);
loadMore.addEventListener('click', async () => {
  if (!nextCursor) return;
  loadMore.disabled = true;
  try { acceptPage(await api(`/api/guestbook?before=${nextCursor}`), true); }
  catch (error) { setStatus(error.message, true); }
  finally { loadMore.disabled = false; }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (publishing || !form.reportValidity()) return;
  if (!challenge) { setStatus('请先刷新验证码。', true); return; }
  if (Date.now() >= challenge.expiresAt) {
    await loadChallenge(); setStatus('验证码已过期，请输入新验证码。', true); answerInput.focus(); return;
  }
  publishing = true; publish.disabled = true; refreshCaptcha.disabled = true;
  publish.textContent = '发布中…'; setStatus('正在发布…');
  try {
    await api('/api/guestbook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameInput.value, content: contentInput.value, answer: answerInput.value, challengeId: challenge.id, token: challenge.token }) });
    contentInput.value = ''; document.getElementById('content-count').textContent = '0 / 1000';
    answerInput.value = '';
    let listRefreshed = true;
    try { acceptPage(await api('/api/guestbook')); }
    catch { listRefreshed = false; }
    const challengeReady = await loadChallenge();
    if (!listRefreshed) setStatus('留言已发布。列表暂未更新，可点击“刷新”查看。');
    else if (challengeReady) setStatus('留言已发布，谢谢你。');
    else setStatus('留言已发布。下次发布前请刷新验证码。');
  } catch (error) {
    if (error.code !== 'TOO_FAST') await loadChallenge();
    setStatus(error.message, true);
    if (error.code?.startsWith('CHALLENGE')) answerInput.focus();
  } finally {
    publishing = false; publish.disabled = !challenge;
    refreshCaptcha.disabled = false; publish.textContent = '发布留言';
  }
});

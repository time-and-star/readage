import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const policy = await readFile(new URL('../android/app/src/main/res/raw/readage_selection_menu.js', import.meta.url), 'utf8');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const bundledEntry = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    const entry = process.env.PLAYWRIGHT_MODULE_PATH || bundledEntry;
    await access(entry);
    return import(pathToFileURL(path.resolve(entry)).href);
  }
}

// Real DOM ranges and selectors, with a bridge seam and deterministic policy timers.
// This does not emulate Android's native ActionMode or the vendor's floating card.
const fixture = `<!doctype html><html><body>
<main class="reading-content">
  <h1 data-reading-context="title" id="title">Reader title</h1>
  <p data-reading-paragraph="0" id="paragraph">Reader first sentence. <span id="span">Second sentence.</span> <a id="link" href="#">Linked words</a></p>
  <p data-reading-paragraph="1" id="other-paragraph">Another paragraph.</p>
  <p data-reading-paragraph="2"><button id="button">Play</button><span id="interaction" data-reading-interaction="true">Interactive text</span><span id="translation" data-selection-translation="true">Translated text</span></p>
  <input id="input" value="Editable words"><textarea id="textarea">Editable text</textarea>
  <div id="editable" contenteditable="true">Editable document</div>
  <p id="frozen" data-reading-paragraph="3" contenteditable="false">Static reader text</p>
  <button id="handle" data-reading-touch-handle="start">Handle</button>
  <div class="reading-selection-actions" id="toolbar">App actions</div>
  <div class="reading-selection-actions word-card-selection-actions" id="word-toolbar">Word card actions</div>
</main>
<div class="dictionary-trial__text"><p data-reading-paragraph="0" id="trial">Dictionary trial text</p></div>
<p id="outside">Ordinary page text</p><p data-reading-paragraph="0" id="orphan">Paragraph outside reader</p>
</body></html>`;

test('Android selection policy preserves reader ranges and editable menus', async t => {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  async function pageForTest(installBridge = true) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.setContent(fixture);
    await page.evaluate(withBridge => {
      window.policyEvents = [];
      window.policyTimers = new Map();
      let nextTimer = 1;
      window.setTimeout = callback => { const id = nextTimer++; window.policyTimers.set(id, callback); return id; };
      window.clearTimeout = id => window.policyTimers.delete(id);
      window.flushPolicyTimers = () => { const pending = [...window.policyTimers.values()]; window.policyTimers.clear(); pending.forEach(callback => callback()); };
      if (withBridge) window.ReadageSelectionMenu = { setSuppressed: value => window.policyEvents.push(value) };
      window.press = (id, type = 'pointerdown') => document.getElementById(id).dispatchEvent(new Event(type, { bubbles: true }));
      window.release = () => document.dispatchEvent(new Event('pointerup', { bubbles: true }));
      window.pickRange = (startId, endId = startId) => {
        const start = document.getElementById(startId);
        const end = document.getElementById(endId);
        const range = document.createRange();
        range.setStart(start.firstChild, 0);
        range.setEnd(end.firstChild, end.firstChild.textContent.length);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      };
      window.clearRange = () => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); };
    }, installBridge);
    await page.evaluate(policy);
    return page;
  }
  async function suppressed(page) { return page.evaluate(() => window.policyEvents.at(-1)); }

  await t.test('正文长按提前隐藏菜单，松开后仍保留正文 Range', async () => {
    const page = await pageForTest();
    try {
      assert.equal(await suppressed(page), false);
      await page.evaluate(() => press('paragraph'));
      assert.equal(await suppressed(page), true);
      await page.evaluate(() => { pickRange('span'); release(); });
      assert.equal(await suppressed(page), true);
      assert.equal(await page.evaluate(() => getSelection().toString()), 'Second sentence.');
      await page.evaluate(() => clearRange());
      assert.equal(await suppressed(page), false);
    } finally { await page.close(); }
  });

  await t.test('标题、跨段、正文链接与词典试读都属于应用选区', async () => {
    const page = await pageForTest();
    try {
      for (const [start, end] of [['title', 'title'], ['paragraph', 'other-paragraph'], ['link', 'link'], ['trial', 'trial'], ['frozen', 'frozen']]) {
        await page.evaluate(([first, last]) => pickRange(first, last), [start, end]);
        assert.equal(await suppressed(page), true, `${start} selection`);
      }
      await page.evaluate(() => { clearRange(); press('link'); });
      assert.equal(await suppressed(page), false, 'link presses keep their native interaction before a reader range exists');
    } finally { await page.close(); }
  });

  await t.test('按钮、翻译、其他页面与跨出阅读区域的范围不受屏蔽', async () => {
    const page = await pageForTest();
    try {
      for (const id of ['button', 'interaction', 'translation', 'outside', 'orphan', 'word-toolbar']) {
        await page.evaluate(target => { clearRange(); press(target); }, id);
        assert.equal(await suppressed(page), false, `${id} press`);
        await page.evaluate(() => release());
      }
      for (const [start, end] of [['outside', 'outside'], ['paragraph', 'outside'], ['button', 'button'], ['translation', 'translation']]) {
        await page.evaluate(([first, last]) => pickRange(first, last), [start, end]);
        assert.equal(await suppressed(page), false, `${start}-${end} selection`);
      }
    } finally { await page.close(); }
  });

  await t.test('输入框与富文本获得焦点时保留原生菜单，返回正文恢复策略', async () => {
    const page = await pageForTest();
    try {
      await page.evaluate(() => pickRange('paragraph'));
      for (const id of ['input', 'textarea', 'editable']) {
        await page.evaluate(target => { document.getElementById(target).focus(); press(target); }, id);
        assert.equal(await suppressed(page), false, `${id} focus and press`);
        await page.evaluate(() => release());
        assert.equal(await suppressed(page), false, `${id} release`);
        await page.evaluate(target => { document.getElementById(target).blur(); flushPolicyTimers(); }, id);
        await page.evaluate(() => pickRange('paragraph'));
        assert.equal(await suppressed(page), true, 'reader range after editor blur');
      }
    } finally { await page.close(); }
  });

  await t.test('应用拖柄与选句工具栏保持正文范围，无范围时不屏蔽', async () => {
    const page = await pageForTest();
    try {
      for (const id of ['handle', 'toolbar']) {
        await page.evaluate(target => { clearRange(); press(target); }, id);
        assert.equal(await suppressed(page), false, `${id} without range`);
        await page.evaluate(() => release());
        await page.evaluate(target => { pickRange('span'); press(target); }, id);
        assert.equal(await suppressed(page), true, `${id} with reader range`);
        await page.evaluate(() => release());
        assert.equal(await page.evaluate(() => getSelection().toString()), 'Second sentence.');
      }
    } finally { await page.close(); }
  });

  await t.test('Android取消触摸流后短时保留策略，超时释放未建立的选区', async () => {
    const page = await pageForTest();
    try {
      await page.evaluate(() => { press('paragraph', 'touchstart'); press('paragraph', 'pointercancel'); });
      assert.equal(await suppressed(page), true, 'cancellation must not terminate selection preparation');
      await page.evaluate(() => flushPolicyTimers());
      assert.equal(await suppressed(page), false, 'abandoned gesture must expire');
      await page.evaluate(() => { press('paragraph', 'touchstart'); pickRange('span'); flushPolicyTimers(); });
      assert.equal(await suppressed(page), true, 'completed selection survives press timer');
      assert.equal(await page.evaluate(() => getSelection().toString()), 'Second sentence.');
    } finally { await page.close(); }
  });

  await t.test('重复安装不会重复注册监听，缺少原生桥时可延迟安装', async () => {
    const page = await pageForTest(false);
    try {
      assert.equal(await page.evaluate(() => window.__readageSelectionMenuInstalled), undefined);
      await page.evaluate(() => { window.ReadageSelectionMenu = { setSuppressed: value => window.policyEvents.push(value) }; });
      await page.evaluate(policy);
      await page.evaluate(policy);
      const count = await page.evaluate(() => {
        window.policyEvents.length = 0;
        document.dispatchEvent(new Event('selectionchange'));
        return window.policyEvents.length;
      });
      assert.equal(count, 1);
    } finally { await page.close(); }
  });
});

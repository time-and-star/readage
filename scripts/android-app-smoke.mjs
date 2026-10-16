import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PROFILE_KEY = 'readage:local-database-profile:v1';
const FIXTURE_KEY = 'english-ai:v2:android-ui-smoke-fixture';
const FIXTURE_VERSION = 'android-emulator-ui-v1';
const fixtureArticle = {
  id: 'android-emulator-ui-fixture-v1', language: 'en',
  title: 'Android reading fixture with a long title that must fit inside the phone screen',
  description: 'Synthetic article used only by the dedicated Android emulator UI checks.',
  date: '2026-10-11', status: 'In Progress', source: 'user_input', level: 'B1', importEnrichmentStatus: 'ready',
  content: [
    'Readers select this sentence to open actions beside the original words. The toolbar keeps its reading action close to the selected sentence without covering the phone navigation.',
    'A narrow screen still leaves enough room for the whole paragraph. Every line wraps inside the page, and a long heading stays within the same visible width as the ordinary reading text.',
    'The next paragraph provides room to scroll while keeping the same selected words. Moving the page should move the nearby toolbar instead of leaving it at a fixed and unrelated place.',
    'This article contains only synthetic test material. Opening the import dialog checks supported document formats without selecting a file, starting a download, or playing a voice.',
    'The final paragraph gives the reader a little more space below the first selection. The test restores its earlier profile and route when the layout evidence has been recorded.',
  ], media: [], keyWords: [],
};

/** Executed in the actual APK WebView, not a host DOM or a copied positioning implementation. */
function layoutEvidence() {
  const rect = element => {
    if (!element) return null;
    const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const visual = window.visualViewport;
  const viewport = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
    width: visual?.width ?? document.documentElement.clientWidth, height: visual?.height ?? window.innerHeight };
  const selection = window.getSelection();
  const toolbar = document.querySelector('[role="toolbar"][aria-label="选中文本操作"]');
  const readingPage = document.querySelector('.reading-page');
  const readingStyle = readingPage ? getComputedStyle(readingPage) : null;
  const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  const rangeRect = range ? range.getBoundingClientRect() : null;
  const measuredRange = rangeRect ? { left: rangeRect.left, top: rangeRect.top, right: rangeRect.right, bottom: rangeRect.bottom, width: rangeRect.width, height: rangeRect.height } : null;
  return { path: location.pathname, viewport, innerWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio,
    coarsePointer: matchMedia('(pointer: coarse)').matches, maxTouchPoints: navigator.maxTouchPoints,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth, clientWidth: document.documentElement.clientWidth, scrollY: window.scrollY,
    readingPage: rect(readingPage), readingPaint: readingStyle ? { opacity: readingStyle.opacity,
      transform: readingStyle.transform, translate: readingStyle.translate ?? null } : null,
    readingHeader: rect(document.querySelector('.reading-page-header')),
    readingContent: rect(document.querySelector('.reading-content')), title: rect(document.querySelector('[data-reading-article-title]')),
    selection: range ? { text: selection.toString(), rect: measuredRange,
      startArticleId: range.startContainer.parentElement?.closest('[data-reading-article-id]')?.dataset.readingArticleId,
      endArticleId: range.endContainer.parentElement?.closest('[data-reading-article-id]')?.dataset.readingArticleId } : null,
    toolbar: toolbar ? { rect: rect(toolbar), visibility: getComputedStyle(toolbar).visibility,
      touchSelection: toolbar.dataset.touchSelection === 'true', buttons: [...toolbar.querySelectorAll('button')].map(button => ({
        label: button.getAttribute('aria-label') || button.innerText, disabled: button.disabled, rect: rect(button) })) } : null };
}

function assertWithinViewport(evidence, rectangle, label) {
  const v = evidence.viewport;
  if (!rectangle || rectangle.left < v.left - 1 || rectangle.right > v.left + v.width + 1
    || rectangle.top < v.top - 1 || rectangle.bottom > v.top + v.height + 1) throw new Error(`${label} falls outside the actual WebView viewport.`);
}
function assertNoHorizontalOverflow(evidence, label) {
  if (evidence.documentWidth > evidence.clientWidth + 1 || evidence.bodyWidth > evidence.clientWidth + 1) {
    throw new Error(`${label} causes horizontal page overflow: ${JSON.stringify(evidence)}`);
  }
}
function assertSelectionLayout(evidence) {
  if (evidence.viewport.width > 480) throw new Error('The dedicated emulator must provide a real narrow viewport.');
  if (!evidence.selection?.text || evidence.selection.startArticleId !== fixtureArticle.id || evidence.selection.endArticleId !== fixtureArticle.id) {
    throw new Error('The DOM Range must select original words in the isolated fixture article.');
  }
  if (!evidence.toolbar || evidence.toolbar.visibility !== 'visible' || !evidence.toolbar.touchSelection) throw new Error('Actual touch selection actions did not open.');
  assertNoHorizontalOverflow(evidence, 'Reading selection'); assertWithinViewport(evidence, evidence.toolbar.rect, 'Selection toolbar');
  const speech = evidence.toolbar.buttons.find(button => button.label === '朗读选中句子');
  if (!speech || speech.disabled || speech.rect.width < 43.5 || speech.rect.height < 43.5) throw new Error('The selected-sentence reading action must be enabled and offer a 44px touch target.');
  const t = evidence.toolbar.rect, r = evidence.selection.rect;
  const gap = Math.min(Math.abs(t.top - r.bottom), Math.abs(r.top - t.bottom));
  if (gap > 80 || t.top < (evidence.readingHeader?.bottom ?? 0) - 1) throw new Error('The toolbar is not anchored near the selected words below the app header.');
}

async function runUiChecks({ evaluate, request, screenshot, command, output, serial }) {
  if (serial !== 'emulator-5560') throw new Error('UI fixtures are restricted to the dedicated emulator-5560.');
  const waitFor = async (expression, message) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { const value = await evaluate(expression); if (value) return value; }
      catch (error) {
        if (!/Execution context was destroyed|Cannot find context|Inspected target navigated|execution was terminated/i.test(error.message)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(message);
  };
  const reload = async () => {
    const token = `${Date.now()}-${Math.random()}`;
    await evaluate(`window.__readageUiSmokeReloadToken=${JSON.stringify(token)}`);
    await request('Page.reload');
    await waitFor(`window.__readageUiSmokeReloadToken!==${JSON.stringify(token)} && document.readyState!=='loading'`, 'The APK WebView did not reload into a fresh document.');
  };
  const evidence = { environment: 'Actual production APK WebView on dedicated emulator-5560.', fixtureArticleId: fixtureArticle.id,
    downloadsTriggered: false, voicePlaybackTriggered: false, passed: false };
  let original, fixture;
  let failure;
  let touchEmulationEnabled = false;
  try {
    original = await evaluate(`({profileId:localStorage.getItem(${JSON.stringify(PROFILE_KEY)}),path:location.pathname})`);
    if (!original.profileId) throw new Error('Initialized native profile must exist before UI fixture creation.');
    // Only our marked profile is written. Native bootstrap can reuse an empty first profile,
    // so reject that case before calling it rather than overwriting unrelated fixture data.
    fixture = await evaluate(`(async()=>{
      const db = window.Capacitor?.Plugins?.ReadageDatabase;
      if (!db) throw new Error('Native database bridge missing');
      const ask = async(command,body={})=>{const result=await db.request({command,body});if(result.status!==200)throw new Error(result.body.error||'Native fixture request failed');return result.body;};
      const profiles=(await ask('profiles')).profiles;
      let existing;
      for(const profile of profiles){const row=await ask('query',{profileId:profile.id,table:'settings',key:${JSON.stringify(FIXTURE_KEY)}});
        if(row.rows[0]?.value===${JSON.stringify(JSON.stringify(FIXTURE_VERSION))}){existing=profile;break;}}
      let result;
      if(existing)result=await ask('bootstrap',{preferredId:existing.id});
      else {
        if(profiles[0]){let records=0;for(const table of ['settings','rawEvents','articleEvidence','dailyEvidence','memoryState','finalizationTasks','meta']){
          records+=(await ask('query',{profileId:profiles[0].id,table})).rows.length;}
          if(records===0)throw new Error('Refusing to reuse an empty unrelated profile for UI fixtures');}
        const source={format:'english-ai-local-backup',version:1,exportedAt:'2026-10-11T00:00:00Z',memoryStorage:'indexedDB',
          localStorage:{${JSON.stringify(FIXTURE_KEY)}:${JSON.stringify(JSON.stringify(FIXTURE_VERSION))},'english-ai:v2:articles':${JSON.stringify(JSON.stringify([fixtureArticle]))}},
          indexedDb:{name:'english-ai-memory-v2',version:1,stores:{rawEvents:[],articleEvidence:[],dailyEvidence:[],memoryState:[],finalizationTasks:[],meta:[]}}};
        result=await ask('bootstrap',{source});
        if(profiles.some(profile=>profile.id===result.profile.id))throw new Error('UI fixture must use a distinct marked profile');
      }
      const changes=[{table:'settings',key:'english-ai:v2:articles',value:${JSON.stringify(JSON.stringify([fixtureArticle]))}},
        {table:'settings',key:'english-ai:v2:libraryView',deleted:true},{table:'settings',key:'english-ai:v2:readingBookmark',deleted:true},
        {table:'settings',key:'english-ai:v2:readingBookmarks',deleted:true},{table:'settings',key:'english-ai:v2:readingParagraphProgress',deleted:true}];
      await ask('commit',{profileId:result.profile.id,revision:result.profile.revision,changes,operationId:crypto.randomUUID()});
      localStorage.setItem(${JSON.stringify(PROFILE_KEY)},result.profile.id);history.replaceState(null,'','/library');
      return {profileId:result.profile.id,reused:!!existing,marker:${JSON.stringify(FIXTURE_VERSION)}};
    })()`);
    evidence.fixture = fixture;
    await reload();
    await waitFor("document.querySelector('.library-collections') && [...document.querySelectorAll('.library-collections button')].some(b=>b.innerText.trim()==='外刊')", 'Fixture library did not initialize.');
    await evaluate("[...document.querySelectorAll('.library-collections button')].find(b=>b.innerText.trim()==='外刊').click()");
    await waitFor("[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='更新外刊目录')", 'Manual magazine update entry is missing.');
    evidence.magazines = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='更新外刊目录');
      const r=b.getBoundingClientRect();return {path:location.pathname,label:b.innerText.trim(),disabled:b.disabled,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},layout:(${layoutEvidence.toString()})()};})()`);
    if (evidence.magazines.disabled) throw new Error('The manual magazine update entry is not available.');
    assertNoHorizontalOverflow(evidence.magazines.layout, 'Magazine entry');
    assertWithinViewport(evidence.magazines.layout, evidence.magazines.rect, 'Magazine update button');
    await screenshot('app-magazines-ui.png');
    await evaluate("[...document.querySelectorAll('.library-collections button')].find(b=>b.innerText.trim()==='我的书架').click()");
    await waitFor("[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='导入')", 'Import entry is missing.');
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='导入').click()");
    await waitFor("Boolean(document.querySelector('[role=dialog] input[type=file][aria-label=\"选择文章文件\"]'))", 'File import dialog did not open.');
    evidence.import = await evaluate(`(()=>{const input=document.querySelector('[role=dialog] input[type=file][aria-label="选择文章文件"]');
      const dialog=input.closest('[role=dialog]'),r=dialog.getBoundingClientRect();return {accept:input.accept,disabled:input.disabled,
      dialog:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},layout:(${layoutEvidence.toString()})()};})()`);
    if (evidence.import.disabled || !['.pdf', '.epub', '.docx'].every(extension => evidence.import.accept.split(',').includes(extension))) throw new Error('Import must accept PDF, EPUB and DOCX.');
    assertNoHorizontalOverflow(evidence.import.layout, 'Import dialog');
    assertWithinViewport(evidence.import.layout, evidence.import.dialog, 'Import dialog');
    await screenshot('app-import-ui.png');
    await evaluate("document.querySelector('button[aria-label=\"关闭导入\"]').click()");
    await evaluate(`history.replaceState(null,'',${JSON.stringify(`/read/${fixtureArticle.id}`)})`);
    await reload();
    await waitFor(`Boolean(document.querySelector('.reading-content [data-reading-article-id="${fixtureArticle.id}"][data-reading-paragraph]'))`, 'Real ReadingScreen fixture did not render.');
    // ReadingScreen inserts its DOM at opacity 0 / translate-x-2, then starts a
    // 150ms entry transition on requestAnimationFrame. Measure only the painted,
    // settled page; inserted nodes alone are not evidence of a visible layout.
    await waitFor(`(()=>{const page=document.querySelector('.reading-page');if(!page)return false;
      return Number(getComputedStyle(page).opacity)>0.999 && !page.getAnimations().some(animation=>animation.playState==='running');})()`,
    'The real ReadingScreen did not finish its entry animation.');
    evidence.reading = await evaluate(`(${layoutEvidence.toString()})()`);
    assertNoHorizontalOverflow(evidence.reading, 'Reading screen');
    if (evidence.reading.viewport.width > 480) throw new Error('Reading fixture must be inspected at a real narrow phone width.');
    const title = evidence.reading.title, content = evidence.reading.readingContent, v = evidence.reading.viewport;
    if (!title || !content || title.width <= 0 || title.height <= 0
      || [title, content].some(rect => rect.left < v.left - 1 || rect.right > v.left + v.width + 1)) {
      throw new Error('The actual long title and article must wrap inside the narrow viewport.');
    }
    await screenshot('app-reading-ui.png');
    const touchPoint = await evaluate(`(()=>{const p=document.querySelector('.reading-content [data-reading-article-id="${fixtureArticle.id}"][data-reading-paragraph]');
      p.scrollIntoView({block:'center'});const r=p.getBoundingClientRect(),main=p.closest('.reading-content').getBoundingClientRect();
      return {x:main.left+2,y:r.top+2};})()`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    if (!await evaluate(`(()=>{const e=document.elementFromPoint(${touchPoint.x},${touchPoint.y});return Boolean(e?.closest('.reading-page'))
      && !e.closest('button,a,input,textarea,select,[data-reading-interaction],[data-speech-start]');})()`)) {
      throw new Error('Fixture touch point must be inside the reader margin, outside words and controls.');
    }
    // A headless AVD can report a fine primary pointer even though it accepts
    // touch input. Dispatch actual WebView touch input, then cancel it without
    // clicking a word or starting a swipe, before selecting the native Range.
    const touchEvents = await evaluate(`(()=>{window.__readageUiSmokeTouchEvents=[];
      const listener=event=>{window.__readageUiSmokeTouchEvents.push({type:event.type,trusted:event.isTrusted});};
      for(const type of ['touchstart','touchcancel','touchend'])document.addEventListener(type,listener,{capture:true});return true;})()`);
    if (!touchEvents) throw new Error('Touch event observation did not initialize.');
    evidence.touchInput = { point: touchPoint, cdp: {}, events: [] };
    try {
      await request('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      touchEmulationEnabled = true;
      evidence.touchInput.cdp.emulation = 'Explicit DevTools touchscreen emulation on the dedicated Android WebView.';
      await request('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...touchPoint, radiusX: 1, radiusY: 1, force: 1, id: 1 }] });
    } catch (error) { evidence.touchInput.cdp.error = error.message; }
    finally {
      await request('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(error => { evidence.touchInput.cdp.cancelError = error.message; });
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    evidence.touchInput.cdp.events = await evaluate('window.__readageUiSmokeTouchEvents');
    if (evidence.touchInput.cdp.events.some(event => event.type === 'touchstart' && event.trusted)) {
      evidence.touchInput.method = 'CDP emulated touchscreen; trusted touchstart observed in the actual APK.';
    } else {
      // Some Android WebView versions acknowledge CDP input without delivering
      // it. Use the actual emulator touchscreen and observed native WebView
      // bounds, never guessed screen offsets or JavaScript-created touch events.
      const dumpFile = `/data/local/tmp/readage-ui-smoke-${Date.now()}.xml`;
      let hierarchy;
      try {
        await command(['shell', 'uiautomator', 'dump', dumpFile]);
        hierarchy = await command(['shell', 'cat', dumpFile]);
      } finally { await command(['shell', 'rm', '-f', dumpFile]).catch(() => {}); }
      const views = (hierarchy.match(/<node\b[^>]*>/g) || []).filter(node => /\bclass="android\.webkit\.WebView"/.test(node) && /\bpackage="cn\.readage\.app"/.test(node));
      const bounds = views.length === 1 ? views[0].match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) : null;
      if (!bounds) throw new Error('A unique actual application WebView surface was not observed; native touch was refused.');
      const [left, top, right, bottom] = bounds.slice(1).map(Number);
      const current = await evaluate(`(${layoutEvidence.toString()})()`), viewport = current.viewport;
      const scaleX = (right - left) / viewport.width, scaleY = (bottom - top) / viewport.height;
      if (scaleX <= 0 || scaleY <= 0 || Math.abs(scaleX - scaleY) > 0.04 || touchPoint.x < viewport.left || touchPoint.y < viewport.top
        || touchPoint.x >= viewport.left + viewport.width || touchPoint.y >= viewport.top + viewport.height) {
        throw new Error('Observed WebView bounds do not match the CSS viewport; native touch was refused.');
      }
      const point = { x: Math.round(left + (touchPoint.x - viewport.left) * scaleX), y: Math.round(top + (touchPoint.y - viewport.top) * scaleY) };
      evidence.touchInput.native = { surface: { left, top, right, bottom }, viewport, scaleX, scaleY, point };
      await evaluate('window.__readageUiSmokeTouchEvents=[]');
      await command(['shell', 'input', 'touchscreen', 'tap', String(point.x), String(point.y)]);
      evidence.touchInput.method = 'Actual dedicated emulator touchscreen tap through Android input, using observed WebView bounds.';
      await waitFor("window.__readageUiSmokeTouchEvents.some(event=>event.type==='touchstart' && event.trusted) && window.__readageUiSmokeTouchEvents.some(event=>event.type==='touchend' && event.trusted)",
        'The actual emulator touchscreen did not produce trusted WebView touch events.');
    }
    evidence.touchInput.events = await evaluate('window.__readageUiSmokeTouchEvents');
    const selectedText = await evaluate(`(()=>{
      const p=document.querySelector('.reading-content [data-reading-article-id="${fixtureArticle.id}"][data-reading-paragraph]');
      p.scrollIntoView({block:'center'});
      const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),nodes=[];let node,text='';
      while(node=walker.nextNode()){if(node.parentElement?.closest('[data-selection-translation],[data-reading-interaction]'))continue;nodes.push(node);text+=node.textContent;}
      const end=text.indexOf('.')+1;if(end<10)throw new Error('Fixture sentence not found');
      let remaining=end,endNode;for(const n of nodes){if(remaining<=n.length){endNode=n;break;}remaining-=n.length;}
      const range=document.createRange();range.setStart(nodes[0],0);range.setEnd(endNode,remaining);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    })()`);
    await waitFor("Boolean(document.querySelector('[role=toolbar][aria-label=\"选中文本操作\"]')?.querySelector('button[aria-label=\"朗读选中句子\"]'))", 'Selected-sentence speech toolbar did not appear.');
    await waitFor("getComputedStyle(document.querySelector('[role=toolbar][aria-label=\"选中文本操作\"]')).visibility==='visible'", 'Selection toolbar has no measured position.');
    // Native screen capture can precede WebView's composited frame despite a
    // measured DOM layout. Let the actual toolbar paint before recording pixels.
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 250));
    evidence.selection = await evaluate(`(${layoutEvidence.toString()})()`);
    assertSelectionLayout(evidence.selection);
    await screenshot('app-selection-ui.png');
    await evaluate('window.scrollBy(0,36)');
    await new Promise(resolve => setTimeout(resolve, 250));
    evidence.scrolledSelection = await evaluate(`(${layoutEvidence.toString()})()`);
    assertSelectionLayout(evidence.scrolledSelection);
    if (evidence.scrolledSelection.selection.text !== selectedText) throw new Error('Scrolling changed the original selected words.');
    const moved = evidence.scrolledSelection.selection.rect.top - evidence.selection.selection.rect.top;
    const toolbarMoved = evidence.scrolledSelection.toolbar.rect.top - evidence.selection.toolbar.rect.top;
    if (Math.abs(moved) < 20 || Math.abs(toolbarMoved - moved) > 6) throw new Error('The touch toolbar did not follow the live DOM Range while scrolling.');
    evidence.anchorMovement = { selectionDeltaY: moved, toolbarDeltaY: toolbarMoved };
    await screenshot('app-selection-scrolled-ui.png');
    await evaluate(`document.querySelector('[role=toolbar][aria-label="选中文本操作"] button[aria-label="朗读选中句子"]').click()`);
    evidence.voicePlaybackTriggered = true;
    const boxExpression = `(()=>{const box=document.querySelector('.speech-word-box');if(!box)return null;const rect=box.getBoundingClientRect();if(!rect.width||!rect.height)return null;
      const section=document.querySelector('[data-reading-article-section]');const word=[...section.querySelectorAll('[data-speech-start]')].find(node=>{const r=node.getBoundingClientRect();return Math.abs(r.left-rect.left)<8&&Math.abs(r.top-rect.top)<6});
      return {left:rect.left,top:rect.top,width:rect.width,height:rect.height,word:word?.textContent,start:word?.getAttribute('data-speech-start')};})()`;
    const firstBox = await waitFor(boxExpression, 'S04: Native playback did not show the current-word box.');
    if (!firstBox.word) throw new Error('S04: Speech box did not point to the original article word.');
    await screenshot('app-speech-word-box.png');
    const nextBox = await waitFor(`(()=>{const box=${boxExpression};return box&&box.start!==${JSON.stringify(firstBox.start)}?box:null})()`, 'S05: Native playback box did not advance to another original word.');
    evidence.speechPosition = { estimated: true, first: firstBox, next: nextBox };
    await evaluate(`document.querySelector('button[aria-label="停止朗读"]')?.click()`);
    await waitFor(`!document.querySelector('.speech-word-box')&&!document.querySelector('button[aria-label="停止朗读"]')`, 'S09: Stopping playback left a word box or a speaking state.');
    evidence.speechPosition.stoppedAndCleared = true;
    evidence.passed = true;
  } catch (error) {
    failure = error; evidence.error = error.message;
    if (evidence.touchInput) evidence.touchInput.events = await evaluate('window.__readageUiSmokeTouchEvents ?? []').catch(() => []);
    await screenshot('app-ui-failure.png').catch(() => {});
  } finally {
    await evaluate(`document.querySelector('button[aria-label="停止朗读"]')?.click()`).catch(() => {});
    if (touchEmulationEnabled) {
      await request('Emulation.setTouchEmulationEnabled', { enabled: false }).then(() => { evidence.touchEmulationRestored = true; })
        .catch(error => { evidence.touchEmulationRestoreError = error.message; failure ??= error; });
    }
    if (original?.profileId) {
      try {
        await evaluate(`(()=>{window.getSelection()?.removeAllRanges();localStorage.setItem(${JSON.stringify(PROFILE_KEY)},${JSON.stringify(original.profileId)});
          history.replaceState(null,'',${JSON.stringify(original.path)});return true;})()`);
        await reload();
        await waitFor(`document.documentElement.dataset.platform==='android' && localStorage.getItem(${JSON.stringify(PROFILE_KEY)})===${JSON.stringify(original.profileId)} && document.querySelectorAll('button').length>0 && !/正在读取本机|重试读取/.test(document.body.innerText)`, 'Original emulator profile did not restore.');
        evidence.originalProfileRestored = true;
      } catch (error) { evidence.restoreError = error.message; failure ??= error; }
    }
    if (failure) evidence.passed = false;
    await fs.writeFile(path.join(output, 'app-ui-smoke.json'), JSON.stringify(evidence, null, 2));
  }
  if (failure) throw failure;
  return { passed: true, fixtureProfileId: fixture.profileId, evidence: 'app-ui-smoke.json' };
}

/** Inspect the production WebView through its debug-build testing endpoint, on the dedicated emulator only. */
export async function runAndroidAppSmoke({ command, adb, serial, env, output }) {
  if (serial !== 'emulator-5560') throw new Error('Android app smoke is restricted to the dedicated emulator-5560; no device fixture was written.');
  await command(['shell', 'am', 'start', '-W', '-n', 'cn.readage.app/.MainActivity']);
  const pid = (await command(['shell', 'pidof', 'cn.readage.app'])).trim().split(/\s+/)[0];
  if (!/^\d+$/.test(pid)) throw new Error('Android application process did not start.');
  const debugPort = (await command(['forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`])).trim();
  if (!/^\d+$/.test(debugPort)) throw new Error('Unable to allocate the Android WebView test port.');
  let socket;
  try {
    const deadline = Date.now() + 45000;
    let tab;
    while (Date.now() < deadline) {
      const tabs = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json()).catch(() => []);
      tab = tabs.find(item => item.type === 'page' && item.url.startsWith('https://localhost'));
      if (tab) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!tab) throw new Error('Production Android WebView debug endpoint did not open.');
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let id = 0;
    const pending = new Map();
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); const job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id); clearTimeout(job.timer);
      if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result);
    });
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('WebView application check timed out.')); }, 90000);
      pending.set(key, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
    const evaluate = expression => request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then(result => {
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    });
    let page;
    while (Date.now() < deadline) {
      page = await evaluate("({platform:document.documentElement?.dataset.platform,path:location.pathname,text:document.body?.innerText||'',buttons:document.querySelectorAll('button').length,userAgent:navigator.userAgent,features:{timeout:typeof AbortSignal.timeout,throwIfAborted:typeof AbortSignal.prototype.throwIfAborted,structuredClone:typeof structuredClone,randomUUID:typeof crypto.randomUUID,at:typeof Array.prototype.at,hasOwn:typeof Object.hasOwn,any:typeof AbortSignal.any}})");
      if (page.platform === 'android' && page.buttons > 0 && !/正在准备本机|正在读取本机|重试读取/.test(page.text)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!page || page.platform !== 'android' || page.buttons < 1 || /重试读取/.test(page.text)) {
      await fs.writeFile(path.join(output, 'app-startup-failure.json'), JSON.stringify(page ?? null, null, 2));
      throw new Error(`Production Android reading interface did not initialize: ${JSON.stringify(page)}`);
    }
    const result = await evaluate(`(async()=>{
      const status = await (await fetch('/api/translation/status')).json();
      const response = await fetch('/api/translation', {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({text:'The cat is sleeping.',sourceLanguage:'en',targetLanguage:'Chinese'})});
      const data = await response.json();
      return {status,httpStatus:response.status,data};
    })()`);
    if (result.httpStatus !== 200 || result.status.offline !== true || result.data.ok !== true
      || result.data.result.originalText !== 'The cat is sleeping.' || !result.data.result.translatedText.includes('猫')) {
      throw new Error(`Production Android fetch-to-JNI translation failed: ${JSON.stringify(result)}`);
    }
    const screenshot = async name => {
      const image = await new Promise((resolve, reject) => {
        const child = spawn(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { env, windowsHide: true });
        const blocks = []; child.stdout.on('data', data => blocks.push(data));
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve(Buffer.concat(blocks)) : reject(new Error('Android app screenshot failed.')));
      });
      await fs.writeFile(path.join(output, name), image);
    };
    const ui = await runUiChecks({ evaluate, request, screenshot, command, output, serial });
    await screenshot('app-smoke.png');
    await fs.writeFile(path.join(output, 'app-smoke.json'), JSON.stringify({ page, translation: result, airplaneMode: '1',
      ui, environment: 'Project Android 12 x86_64 emulator; production APK WebView and native fetch adapter.' }, null, 2));
    return { path: page.path, translatedText: result.data.result.translatedText, ui };
  } finally {
    socket?.close(); await command(['forward', '--remove', `tcp:${debugPort}`]).catch(() => {});
  }
}

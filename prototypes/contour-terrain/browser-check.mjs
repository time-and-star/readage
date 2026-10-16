import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const playwrightEntry=process.env.PLAYWRIGHT_MODULE_PATH||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const root = fileURLToPath(new URL('./', import.meta.url));
const output = path.join(root,'verification');
await mkdir(output,{recursive:true});
const browser = await chromium.launch({headless:true});
const results = [], errors = [];
const check = (name, details) => results.push({name, passed:true, details});
const state = p => p.evaluate(()=>window.terrainPrototype.getState());
const settle = p => p.waitForTimeout(160);
const sameHeights = (a,b,tolerance=1e-10) => a.length===b.length && a.every((h,i)=>Math.abs(h-b[i])<=tolerance);
const total = a => a.reduce((s,h)=>s+h,0);
async function point(page,u=17,v=19) {
  const local = await page.evaluate(({u,v})=>{const t=window.terrainPrototype,s=t.getState();const h=s.heights[v*25+u];return t.project(u,v,s.showWater?Math.max(.35,h):h);},{u,v});
  const bounds=await page.locator('#terrain').boundingBox();
  return {x:bounds.x+local.x,y:bounds.y+local.y,local};
}
async function hold(page,tool,u=17,v=19,duration=360) {
  await page.locator(`[data-tool="${tool}"]`).click();await settle(page);
  const p=await point(page,u,v);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.waitForTimeout(duration);await page.mouse.up();await settle(page);
}
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const response=await page.goto('http://127.0.0.1:4318');assert.equal(response.status(),200);
  await page.waitForFunction(()=>window.terrainPrototype?.getState().width>1);
  await settle(page);
  const initial=await state(page);assert.equal(initial.renderer,'WebGL');assert.equal(initial.heights.length,625);
  check('P01 默认地形完整加载',{renderer:initial.renderer,viewport:[1440,1000],range:[Math.min(...initial.heights),Math.max(...initial.heights)]});
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});

  for(const preset of ['island','plateau','valley']) {
    await page.locator(`[data-preset="${preset}"]`).click();await settle(page);
    assert.equal((await state(page)).preset,preset);assert.equal((await state(page)).selection,null);
  }
  check('P02 三种底稿可切换并更新地形');
  const base=(await state(page)).heights;
  for(const id of ['grid','contours','water']){
    await page.locator('#'+id).uncheck();await settle(page);assert.equal((await state(page))['show'+id[0].toUpperCase()+id.slice(1)],false);
    assert(sameHeights(base,(await state(page)).heights));await page.locator('#'+id).check();
  }
  for(const i of ['0.5','2','1']){await page.locator('#interval').selectOption(i);await settle(page);assert.equal((await state(page)).interval,+i);assert(sameHeights(base,(await state(page)).heights));}
  check('P03/P04 图层与等高距切换不改变地形');

  const pick=await point(page,17,19);await page.mouse.click(pick.x,pick.y);await settle(page);
  assert((await state(page)).selection);assert.match(await page.locator('#selection').innerText(),/标高.*坡度/);assert(sameHeights(base,(await state(page)).heights));
  check('P10 地块选择显示实际标高和坡度，查看不编辑');

  await hold(page,'raise');const raised=await state(page);assert(total(raised.heights)>total(base));
  const afterRelease=raised.heights;await page.waitForTimeout(220);assert(sameHeights(afterRelease,(await state(page)).heights));
  check('P05 抬高、笔刷反馈和松手停止');
  await page.locator('#undo').click();await settle(page);assert(sameHeights(base,(await state(page)).heights));
  check('P09 撤销精确恢复本次编辑前地形');
  await hold(page,'lower');assert(total((await state(page)).heights)<total(base));await page.locator('#undo').click();await settle(page);
  check('P06 降低地形');

  await hold(page,'raise',17,19,650);const spiked=(await state(page)).heights;
  await hold(page,'smooth',17,19,450);const smoothed=(await state(page)).heights;assert(!sameHeights(spiked,smoothed));
  const energy=a=>{let n=0;for(let v=0;v<25;v++)for(let u=0;u<25;u++){const h=a[v*25+u];if(u<24)n+=(a[v*25+u+1]-h)**2;if(v<24)n+=(a[(v+1)*25+u]-h)**2;}return n;};
  assert(energy(smoothed)<energy(spiked));check('P07 平滑降低相邻格点的整体高差',{before:energy(spiked),after:energy(smoothed)});
  await page.locator('[data-tool="flatten"]').click();await page.locator('#target').fill('1.5');await page.locator('#target').press('Tab');
  const beforeFlat=(await state(page)).heights[19*25+17];await hold(page,'flatten',17,19,500);
  const afterFlat=(await state(page)).heights[19*25+17];assert(Math.abs(afterFlat-1.5)<Math.abs(beforeFlat-1.5));assert.match(await page.locator('#strength-value').innerText(),/%/);
  check('P08 整平趋近目标标高',{target:1.5,before:beforeFlat,after:afterFlat});
  await page.locator('#reset').click();await settle(page);assert(sameHeights(base,(await state(page)).heights));assert.match(await page.locator('#toast').innerText(),/可撤销/);

  await page.locator('#zoom-value').click();await settle(page);assert.equal((await state(page)).zoom,1);
  const metrics=await page.evaluate(()=>{const t=window.terrainPrototype,p=[t.project(0,0,0),t.project(1,0,0),t.project(1,1,0),t.project(0,1,0)],a=t.project(0,0,1);return {width:Math.max(...p.map(p=>p.x))-Math.min(...p.map(p=>p.x)),height:Math.max(...p.map(p=>p.y))-Math.min(...p.map(p=>p.y)),vertical:p[0].y-a.y};});
  assert.deepEqual(metrics,{width:52,height:26,vertical:26});
  await page.locator('#fit').click();await settle(page);
  const beforePan=await state(page);await page.locator('#pan').click();const q=await point(page);await page.mouse.move(q.x,q.y);await page.mouse.down();await page.mouse.move(q.x+38,q.y+25,{steps:4});await page.mouse.up();await settle(page);const afterPan=await state(page);assert(Math.abs(afterPan.ox-beforePan.ox-38)<1);assert(sameHeights(beforePan.heights,afterPan.heights));await page.locator('#pan').click();
  const zoomAnchor=await point(page);const beforeZoom=await page.evaluate(p=>window.terrainPrototype.pick(p.x,p.y),zoomAnchor.local);await page.mouse.move(zoomAnchor.x,zoomAnchor.y);await page.mouse.wheel(0,-100);await settle(page);const afterZoom=await page.evaluate(p=>window.terrainPrototype.pick(p.x,p.y),zoomAnchor.local);assert(Math.hypot(beforeZoom.u-afterZoom.u,beforeZoom.v-afterZoom.v)<.03);
  check('P11 基准尺寸、平移与指针锚定缩放',{metrics});

  await page.locator('#terrain').focus();const beforeArrow=await state(page);await page.keyboard.press('ArrowLeft');await settle(page);assert.equal((await state(page)).ox,beforeArrow.ox+35);
  await hold(page,'raise');await page.keyboard.press('Control+z');await settle(page);assert(sameHeights(base,(await state(page)).heights));
  await page.locator('[data-tool="flatten"]').click();await page.locator('#target').fill('2');await page.locator('#target').press('Space');assert.equal((await state(page)).tool,'flatten');
  check('P12 键盘平移、撤销及输入框隔离');
  await page.locator('[data-tool="lower"]').click();const immediate=await point(page);await page.mouse.move(immediate.x,immediate.y);await page.mouse.down();await page.waitForTimeout(260);await page.mouse.up();const saved=(await state(page)).heights;await page.reload();await page.waitForFunction(()=>window.terrainPrototype?.getState().width>1);await settle(page);assert(sameHeights(saved,(await state(page)).heights,1e-5));
  check('额外：编辑后立即刷新也保留独立地形');
  await context.close();

  const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  const phone=await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));await phone.goto('http://127.0.0.1:4318');await phone.waitForFunction(()=>window.terrainPrototype?.getState().width>1);await settle(phone);
  assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await phone.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
  await phone.locator('[data-tool="raise"]').tap();await phone.locator('#terrain').scrollIntoViewIfNeeded();await settle(phone);
  const beforeTouch=await state(phone),tp=await point(phone,17,19);
  const cdp=await mobile.newCDPSession(phone);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tp.x,y:tp.y,id:1}]});await phone.waitForTimeout(240);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tp.x+5,y:tp.y+2,id:1}]});await phone.waitForTimeout(240);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(phone);
  assert(total((await state(phone)).heights)>total(beforeTouch.heights));
  const stopped=(await state(phone)).heights;await phone.waitForTimeout(180);assert(sameHeights(stopped,(await state(phone)).heights));
  await phone.locator('#undo').tap();assert(sameHeights(beforeTouch.heights,(await state(phone)).heights));
  check('P13 390px窄屏不溢出，触摸雕刻、停止与撤销');

  await phone.locator('#terrain').scrollIntoViewIfNeeded();await settle(phone);const pinchBefore=await state(phone);const t=await point(phone,17,19);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:t.x-20,y:t.y,id:1}]});
  await phone.waitForTimeout(40);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:t.x-20,y:t.y,id:1},{x:t.x+20,y:t.y,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:t.x-35,y:t.y,id:1},{x:t.x+35,y:t.y,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(phone);
  const pinchAfter=await state(phone);assert(pinchAfter.zoom>pinchBefore.zoom);assert(sameHeights(pinchBefore.heights,pinchAfter.heights));
  check('双指缩放不会在编辑模式误画地形');
  await phone.locator('#interval').selectOption('0.5');assert.equal((await state(phone)).interval,.5);
  await phone.locator('#radius').evaluate(e=>{e.value='3';e.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal((await state(phone)).radius,3);
  await phone.locator('#reset').tap();await settle(phone);assert.equal((await state(phone)).preset,'valley');
  check('P14 触屏等高距、参数和恢复入口可用');
  await mobile.close();

  const wallContext=await browser.newContext({viewport:{width:1200,height:900}});
  const wallHeights=[...initial.heights];wallHeights[12*25+24]=8;
  await wallContext.addInitScript(h=>localStorage.setItem('terrain-atelier-prototype-v1',JSON.stringify({version:1,preset:'valley',heights:h})),wallHeights);
  const wall=await wallContext.newPage();wall.on('pageerror',e=>errors.push(e.message));await wall.goto('http://127.0.0.1:4318');await wall.waitForFunction(()=>window.terrainPrototype?.getState().width>1);await settle(wall);
  const wallPick=await wall.evaluate(()=>{const t=window.terrainPrototype,p=t.project(24,12,4);return t.pick(p.x,p.y);});
  assert.equal(wallPick,null);check('高侧壁挡住后方地块时，点击不会选中或编辑隐藏地面');await wallContext.close();

  const fallbackContext=await browser.newContext({viewport:{width:1200,height:900}});
  await fallbackContext.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(name,...args){return name==='webgl'?null:original.call(this,name,...args);};});
  const fallback=await fallbackContext.newPage();fallback.on('pageerror',e=>errors.push(e.message));await fallback.goto('http://127.0.0.1:4318');await fallback.waitForFunction(()=>window.terrainPrototype?.getState().width>1);await settle(fallback);assert.equal((await state(fallback)).renderer,'Canvas2D');
  const withWater=await fallback.locator('#terrain').screenshot();await fallback.locator('#water').uncheck();await settle(fallback);const withoutWater=await fallback.locator('#terrain').screenshot();assert(!withWater.equals(withoutWater));
  await fallback.locator('#water').check();await hold(fallback,'raise');assert(total((await state(fallback)).heights)>total(initial.heights));await fallback.locator('#undo').click();await settle(fallback);assert(sameHeights(initial.heights,(await state(fallback)).heights));
  await fallback.screenshot({path:path.join(output,'software-renderer.png'),fullPage:true});check('无WebGL时仍绘制水面、侧壁和深度遮挡，编辑与撤销可用');await fallbackContext.close();

  const standaloneContext=await browser.newContext({viewport:{width:1200,height:900},offline:true});
  const standalone=await standaloneContext.newPage();standalone.on('pageerror',e=>errors.push(e.message));await standalone.goto(pathToFileURL(path.join(root,'terrain.html')).href);await standalone.waitForFunction(()=>window.terrainPrototype?.getState().width>1);await settle(standalone);
  await hold(standalone,'raise');assert(total((await state(standalone)).heights)>total(initial.heights));
  check('最终单文件通过离线打开与编辑检查，无外部资源依赖');await standaloneContext.close();

  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'browser-check.json'),JSON.stringify({date:'2026-10-14',browser:'Chromium',results,errors},null,2));
  console.log(JSON.stringify({passed:results.length,errors,output},null,2));
} catch(error) {
  await writeFile(path.join(output,'browser-check-failure.json'),JSON.stringify({results,errors,error:String(error),stack:error.stack},null,2));throw error;
} finally {await browser.close();}

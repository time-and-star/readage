import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import postcss from 'postcss';
import { transformAndroidCss, prepareAndroidCss } from '../scripts/android-css-compat.mjs';
import { loadConfigFromFile } from 'vite';

function declarations(css: string, property: string) {
  const values: string[] = [];
  postcss.parse(css).walkDecls(property, declaration => { values.push(declaration.value); });
  return values;
}

test('Chrome 91 CSS retains cascade layer precedence over selector specificity and unlayered overrides', async () => {
  const { css, remainingLayers } = await transformAndroidCss(`
    @layer low, high;
    @layer low { #strong { color: red } }
    @layer high { .weak { color: blue } }
    .plain { color: green }
  `, { minify: false });
  const selectors: Record<string, string> = {};
  postcss.parse(css).walkRules(rule => {
    for (const key of ['strong', 'weak', 'plain']) if (rule.selector.includes(key)) selectors[key] = rule.selector;
  });
  const ids = (selector: string) => [...selector.matchAll(/#(?:\\.|[\w-])+/g)].length;
  assert.equal(remainingLayers, 0);
  assert.ok(ids(selectors.weak) > ids(selectors.strong));
  assert.ok(ids(selectors.plain) > ids(selectors.weak));
});

test('Chrome 91 receives usable theme colors and preserves guarded modern color mixing', async () => {
  const { css } = await transformAndroidCss(`
    @layer theme { :root { --accent: oklch(70.5% .213 47.604) } }
    @layer utilities { .accent { color: var(--accent) } }
    .overlay { background: #0006 }
    @supports (color: color-mix(in oklab, red, transparent)) {
      .overlay { background: color-mix(in oklab, var(--accent) 40%, transparent) }
    }
  `);
  assert.match(declarations(css, '--accent')[0], /^#[0-9a-f]+$/i);
  assert.ok(declarations(css, 'color').includes('var(--accent)'));
  assert.ok(declarations(css, 'background').includes('#0006'));
  assert.doesNotMatch(css, /oklch\(/);
});

test('viewport fallbacks cover calc/min values without changing utility selectors, strings or image URLs', async () => {
  const { css, viewportFallbacks } = await transformAndroidCss(`
    .max-h-\\[50dvh\\] { max-height: min(50dvh, 24rem); }
    .panel { height: calc(100dvh - 40px); width: 90dvw; }
    .label::after { content: "100dvh"; background-image: url(100dvh.svg); }
  `);
  assert.equal(viewportFallbacks, 3);
  assert.deepEqual(declarations(css, 'max-height'), ['min(50vh,24rem)', 'min(50dvh,24rem)']);
  assert.deepEqual(declarations(css, 'height'), ['calc(100vh - 40px)', 'calc(100dvh - 40px)']);
  assert.ok(declarations(css, 'width').includes('90vw'));
  assert.match(css, /max-h-\\\[50dvh\\\]/);
  assert.ok(declarations(css, 'content').includes('"100dvh"'));
  assert.match(declarations(css, 'background-image')[0], /100dvh\.svg/);
});

test('legacy transforms compose translation, rotation, scale then the original transform across utility classes', async () => {
  const { css } = await transformAndroidCss(`
    @layer utilities {
      .move { --x: -50%; translate: var(--x) calc(2px + 3px) !important; }
      .turn { rotate: z 180deg; }
      .grow { --zoom: 105%; scale: var(--zoom) 120%; }
      .original { transform: skewX(15deg); }
      @media (min-width: 40rem) { .move { translate: 1px 2px 3px; } }
    }
  `, { minify: false });
  const parsed = postcss.parse(css);
  let legacy: postcss.AtRule | undefined;
  parsed.walkAtRules('supports', rule => { if (/not.*translate/.test(rule.params)) legacy = rule; });
  assert.ok(legacy);
  const compositions: postcss.Declaration[] = [];
  legacy!.walkDecls('transform', declaration => { compositions.push(declaration); });
  assert.ok(compositions.length >= 5);
  for (const declaration of compositions) assert.match(declaration.value,
    /^var\(--readge-android-translate\) var\(--readge-android-rotate\) var\(--readge-android-scale\) var\(--readge-android-transform\)$/);
  assert.ok(compositions.some(declaration => declaration.important));
  assert.ok(declarations(css, '--readge-android-translate').includes('translate(var(--x),calc(2px + 3px))'));
  assert.ok(declarations(css, '--readge-android-translate').includes('translate3d(1px,2px,3px)'));
  assert.ok(declarations(css, '--readge-android-rotate').includes('rotateZ(180deg)'));
  assert.ok(declarations(css, '--readge-android-scale').includes('scale(var(--zoom),1.2)'));
  assert.ok(declarations(css, '--zoom').includes('1.05'));
  assert.ok(declarations(css, '--readge-android-transform').includes('skewX(15deg)'));
  // Each element resets its own components instead of inheriting a parent's transform.
  assert.ok(declarations(css, '--readge-android-scale').includes('scale(1)'));
});

test('transform fallback keeps keyframes and media conditions rather than activating them globally', async () => {
  const { css } = await transformAndroidCss(`
    @media (prefers-reduced-motion: no-preference) {
      @keyframes spin { to { transform: rotate(360deg) } }
      .icon { rotate: 20deg }
    }
  `, { minify: false });
  const root = postcss.parse(css);
  let fallbackAnimation = false;
  root.walkAtRules('keyframes', rule => {
    const ancestors: string[] = [];
    for (let node = rule.parent; node; node = node.parent) if (node.type === 'atrule') ancestors.push((node as postcss.AtRule).params);
    if (ancestors.some(value => /not.*translate/.test(value))) {
      fallbackAnimation = true;
      assert.ok(ancestors.includes('(prefers-reduced-motion: no-preference)'));
    }
  });
  assert.ok(fallbackAnimation);
});

test('only Android changes Vite targets and disables CSS splitting', async () => {
  const previous = process.env.VITE_APP_PLATFORM;
  try {
    const config = async () => (await loadConfigFromFile({ command: 'build', mode: 'production' }, path.resolve('vite.config.ts')))!.config;
    process.env.VITE_APP_PLATFORM = 'android';
    assert.deepEqual((await config()).build,
      { target: 'chrome91', cssTarget: 'chrome91', cssMinify: 'lightningcss', cssCodeSplit: false });
    process.env.VITE_APP_PLATFORM = 'desktop';
    assert.equal((await config()).build, undefined);
    delete process.env.VITE_APP_PLATFORM;
    assert.equal((await config()).build, undefined);
  } finally {
    if (previous === undefined) delete process.env.VITE_APP_PLATFORM;
    else process.env.VITE_APP_PLATFORM = previous;
  }
});

test('the build helper refuses split stylesheets before mutating any assets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readge-android-css-'));
  try {
    await fs.mkdir(path.join(directory, 'assets'));
    for (const name of ['base.css', 'lazy.css']) await fs.writeFile(path.join(directory, 'assets', name), '.x{color:red}');
    await assert.rejects(prepareAndroidCss({ directory }), /complete single bundle/);
    assert.equal(await fs.readFile(path.join(directory, 'assets/base.css'), 'utf8'), '.x{color:red}');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

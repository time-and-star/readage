import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import postcss from 'postcss';
import cascadeLayers from '@csstools/postcss-cascade-layers';
import { transform } from 'lightningcss';

const RESET_LAYER = 'readge-android-transform-defaults';
const COMPONENTS = {
  translate: '--readge-android-translate', rotate: '--readge-android-rotate',
  scale: '--readge-android-scale', transform: '--readge-android-transform',
};
const TRANSFORM_ORDER = Object.values(COMPONENTS).map(name => `var(${name})`).join(' ');
const IDENTITY = { translate: 'translate(0)', rotate: 'rotate(0deg)', scale: 'scale(1)', transform: 'matrix(1,0,0,1,0,0)' };

// Split component values without splitting calc()/var() expressions or strings.
function componentTokens(value) {
  const tokens = [];
  let start = 0, depth = 0, quote = '';
  for (let index = 0; index <= value.length; index++) {
    const character = value[index];
    if (quote) { if (character === quote && value[index - 1] !== '\\') quote = ''; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    if (index === value.length || (!quote && depth === 0 && /\s/.test(character))) {
      if (index > start) tokens.push(value.slice(start, index));
      start = index + 1;
    }
  }
  return tokens;
}

function numberScale(value) {
  // Legacy scale() takes numbers; Tailwind's scale variables may contain percentages.
  return value.replace(/(?<![-\w.])(-?\d*\.?\d+)%/g, (_, number) => String(Number(number) / 100));
}

function transformFunction(property, value) {
  if (value.trim() === 'none') return IDENTITY[property];
  if (property === 'transform') return value;
  const tokens = componentTokens(property === 'scale' ? numberScale(value.trim()) : value.trim());
  if (property === 'translate' || property === 'scale') {
    if (tokens.length < 1 || tokens.length > 3) throw new Error(`Unsupported ${property} value: ${value}`);
    return `${property}${tokens.length === 3 ? '3d' : ''}(${tokens.join(',')})`;
  }
  if (tokens.length === 1) return `rotate(${tokens[0]})`;
  if (tokens.length === 2 && /^[xyz]$/.test(tokens[0])) return `rotate${tokens[0].toUpperCase()}(${tokens[1]})`;
  if (tokens.length === 4) return `rotate3d(${tokens.join(',')})`;
  throw new Error(`Unsupported rotate value: ${value}`);
}

function fallbackViewportValue(value) {
  // String contents and URLs are not CSS dimensions.
  let output = '', segment = '', quote = '', urlDepth = 0;
  const flush = () => {
    output += segment.replace(/(?<![\w.])(-?\d*\.?\d+)d(v[hw])\b/gi, '$1$2');
    segment = '';
  };
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      output += character;
      if (character === quote && value[index - 1] !== '\\') quote = '';
    } else if (character === '"' || character === "'") {
      flush(); quote = character; output += character;
    } else if (urlDepth) {
      output += character;
      if (character === '(') urlDepth++;
      else if (character === ')') urlDepth--;
    } else if (/^url\(/i.test(value.slice(index))) {
      flush(); output += value.slice(index, index + 4); index += 3; urlDepth = 1;
    } else segment += character;
  }
  flush();
  return output;
}

function addViewportFallbacks(root) {
  let count = 0;
  root.walkDecls(declaration => {
    const fallback = fallbackViewportValue(declaration.value);
    if (fallback === declaration.value) return;
    // Only declaration values are rewritten: escaped utility selectors remain intact.
    declaration.cloneBefore({ value: fallback });
    count++;
  });
  return count;
}

function addTransformFallbacks(root) {
  const scaleVariables = new Set();
  root.walkDecls('scale', declaration => {
    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)) scaleVariables.add(match[1]);
  });
  let count = 0;
  function cloneFallback(node) {
    if (node.type === 'rule') {
      const copy = node.clone({ nodes: [] });
      let transforms = false, important = false;
      for (const declaration of node.nodes ?? []) {
        if (declaration.type !== 'decl') continue;
        if (scaleVariables.has(declaration.prop)) copy.append(declaration.clone({ value: numberScale(declaration.value) }));
        if (!Object.hasOwn(COMPONENTS, declaration.prop)) continue;
        copy.append(declaration.clone({ prop: COMPONENTS[declaration.prop], value: transformFunction(declaration.prop, declaration.value) }));
        important ||= Boolean(declaration.important);
        transforms = true;
        count++;
      }
      if (transforms) copy.append(postcss.decl({ prop: 'transform', value: TRANSFORM_ORDER, important }));
      return copy.nodes.length ? copy : undefined;
    }
    if (node.type !== 'atrule' || !node.nodes || node.name === 'property') return;
    const copy = node.clone({ nodes: [] });
    for (const child of node.nodes) { const fallback = cloneFallback(child); if (fallback) copy.append(fallback); }
    return copy.nodes.length ? copy : undefined;
  }
  const fallbackRules = root.nodes.map(cloneFallback).filter(Boolean);
  if (count === 0) return 0;
  const defaults = postcss.rule({ selector: '*,:before,:after,::backdrop' });
  for (const [property, name] of Object.entries(COMPONENTS)) defaults.append(postcss.decl({ prop: name, value: IDENTITY[property] }));
  const reset = postcss.atRule({ name: 'layer', params: RESET_LAYER });
  reset.append(defaults);
  const legacy = postcss.atRule({ name: 'supports', params: 'not (translate: 0)' });
  legacy.append(reset, ...fallbackRules);
  // Establish the reset layer first: unlayered resets would override utility variables.
  root.prepend(postcss.atRule({ name: 'layer', params: RESET_LAYER }));
  root.append(legacy);
  return count;
}

/** Process a complete Android stylesheet; callers must bundle CSS before this step. */
export async function transformAndroidCss(css, { filename = 'android.css', minify = true } = {}) {
  const root = postcss.parse(css, { from: filename });
  const viewportFallbacks = addViewportFallbacks(root);
  const transformFallbacks = addTransformFallbacks(root);
  const layered = await postcss([cascadeLayers()]).process(root, { from: filename, map: false });
  const warnings = layered.warnings();
  if (warnings.length) throw new Error(`Android CSS layer conversion requires review: ${warnings.map(warning => warning.text).join('; ')}`);
  const compiled = transform({ filename, code: Buffer.from(layered.css), targets: { chrome: 91 << 16 }, minify });
  const output = compiled.code.toString();
  const result = postcss.parse(output);
  let remainingLayers = 0;
  result.walkAtRules('layer', () => remainingLayers++);
  if (remainingLayers !== 0) throw new Error('Android CSS still contains unsupported cascade layers.');
  return { css: output, viewportFallbacks, transformFallbacks, remainingLayers, warnings: compiled.warnings };
}

/** Called only by build-android, before Capacitor copies the final web assets. */
export async function prepareAndroidCss({ directory } = {}) {
  if (!directory) throw new Error('An explicit Android build directory is required.');
  const assets = path.join(path.resolve(directory), 'assets');
  const stylesheets = (await fs.readdir(assets)).filter(filename => filename.endsWith('.css'));
  // Per-file layer conversion gives incorrect priorities across lazy stylesheets.
  if (stylesheets.length !== 1) throw new Error(`Android CSS must be a complete single bundle; found ${stylesheets.length} stylesheets. Enable cssCodeSplit:false.`);
  const filename = path.join(assets, stylesheets[0]);
  const original = await fs.readFile(filename, 'utf8');
  const result = await transformAndroidCss(original, { filename: stylesheets[0] });
  await fs.writeFile(filename, result.css);
  const report = { schemaVersion: 1, platform: 'android', target: 'chrome91', filename: stylesheets[0],
    inputBytes: Buffer.byteLength(original), bytes: Buffer.byteLength(result.css),
    sha256: createHash('sha256').update(result.css).digest('hex'), viewportFallbacks: result.viewportFallbacks,
    transformFallbacks: result.transformFallbacks, remainingLayers: result.remainingLayers, warnings: result.warnings };
  await fs.writeFile(path.join(path.resolve(directory), 'android-css-compatibility.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Android WebView 91 CSS: ${report.viewportFallbacks} viewport fallbacks, ${report.transformFallbacks} transform fallbacks, no cascade layers.`);
  return report;
}

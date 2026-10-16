import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const densities = [
  ['mdpi', 48, 108, 64], ['hdpi', 72, 162, 96], ['xhdpi', 96, 216, 128],
  ['xxhdpi', 144, 324, 192], ['xxxhdpi', 192, 432, 256],
];
const requirePolicy = (condition, message) => { if (!condition) throw new Error(message); };
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function androidApplicationIdentity(root) {
  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const read = (key, pattern) => {
    const matches = [...gradle.matchAll(new RegExp(`\\b${key}\\s*(?:=\\s*)?${pattern}`, 'g'))];
    requirePolicy(matches.length === 1, `Expected one literal ${key} in android/app/build.gradle.`);
    return matches[0][1];
  };
  return { applicationId: read('applicationId', '["\x27]([^"\x27]+)["\x27]'),
    versionCode: Number(read('versionCode', '(\\d+)\\b')),
    versionName: read('versionName', '["\x27]([^"\x27]+)["\x27]') };
}

export function verifyAndroidIconSources(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/brand/readge-android-icon-manifest.json'), 'utf8'));
  requirePolicy(manifest.schemaVersion === 2 && manifest.source === 'assets/brand/readge-icon.png', 'Android icons require the transparent bitmap schema 2 canonical source.');
  requirePolicy(manifest.sourceSha256 === hash(path.join(root, manifest.source)), 'Android icon canonical source SHA-256 is stale.');
  const launcher = { icon: 'mipmap/readge_launcher', roundIcon: 'mipmap/readge_launcher_round', drawableType: 'bitmap' };
  for (const [key, value] of Object.entries(launcher)) requirePolicy(manifest.launcher?.[key] === value, `Unexpected Android launcher ${key}.`);
  requirePolicy(Object.keys(manifest.launcher).length === Object.keys(launcher).length, 'Unexpected Android launcher wrapper/background metadata.');
  requirePolicy(manifest.adaptiveLayerDp === 108 && manifest.adaptiveArtworkDp === 64, 'Android adaptive artwork must retain the complete 64/108 safe area.');
  const expected = densities.flatMap(([density, legacy, foreground, artwork]) => [
    ...['readge_launcher', 'readge_launcher_round'].map(name => ({ path: `android/app/src/main/res/mipmap-${density}/${name}.png`, size: legacy, artworkSize: legacy })),
    { path: `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, size: foreground, artworkSize: artwork },
  ]);
  expected.push({ path: 'android/app/src/main/res/drawable/readge_mark.png', size: 256, artworkSize: 256 });
  requirePolicy(Array.isArray(manifest.frames) && manifest.frames.length === expected.length, 'Android icon manifest must contain all 16 PNG frames exactly once.');
  for (const frame of expected) {
    const matches = manifest.frames.filter(item => item.path === frame.path);
    requirePolicy(matches.length === 1, `Missing or duplicate Android icon frame: ${frame.path}.`);
    requirePolicy(matches[0].size === frame.size && matches[0].artworkSize === frame.artworkSize, `Unexpected Android icon frame dimensions: ${frame.path}.`);
    requirePolicy(matches[0].sha256 === hash(path.join(root, frame.path)), `Android icon PNG SHA-256 is stale: ${frame.path}.`);
  }
  return { manifest, identity: androidApplicationIdentity(root) };
}

function xmlTree(dump) {
  const roots = [], stack = [];
  for (const line of dump.split(/\r?\n/)) {
    const element = /^(\s*)E: ([\w.-]+)(?: |$)/.exec(line);
    if (element) {
      const node = { name: element[2], depth: element[1].length, attrs: {}, children: [] };
      while (stack.length && stack.at(-1).depth >= node.depth) stack.pop();
      (stack.length ? stack.at(-1).children : roots).push(node);
      stack.push(node);
    } else {
      const attribute = /^\s*A: (?:[^\s=]+:)?([\w.-]+)(?:\(0x[\da-f]+\))?=(.*)$/i.exec(line);
      if (attribute && stack.length) {
        requirePolicy(!(attribute[1] in stack.at(-1).attrs), `Duplicate compiled XML attribute: ${attribute[1]}.`);
        stack.at(-1).attrs[attribute[1]] = attribute[2];
      }
    }
  }
  return roots;
}
const stringValue = value => /^"([^"]*)"/.exec(value ?? '')?.[1];
const refValue = value => /^@(0x[\da-f]+)$/.exec(value ?? '')?.[1];
function resourceTable(dump) {
  const resources = new Map();
  let resource;
  for (const line of dump.split(/\r?\n/)) {
    const entry = /^\s*resource (0x[\da-f]+) ([\w/]+)\s*$/.exec(line);
    if (entry) {
      requirePolicy(!resources.has(entry[2]), `Duplicate compiled resource: ${entry[2]}.`);
      resource = { id: entry[1], name: entry[2], configurations: [] };
      resources.set(resource.name, resource);
    } else if (/^\s*(?:type|Package|Binary APK)/.test(line)) resource = undefined;
    else if (resource) {
      const variant = /^\s*\(([^)]*)\) (.+)$/.exec(line);
      if (variant) {
        const file = /^\(file\) (\S+) type=(\w+)$/.exec(variant[2]);
        resource.configurations.push({ qualifier: variant[1], value: variant[2], file: file?.[1], type: file?.[2] });
      }
    }
  }
  return resources;
}
function bitmapVariants(resource, name) {
  requirePolicy(resource, `Missing compiled resource mipmap/${name}.`);
  for (const [density] of densities) {
    const variants = resource.configurations.filter(item => item.qualifier === density);
    requirePolicy(variants.length === 1 && variants[0].type === 'PNG'
      && variants[0].file === `res/mipmap-${density}-v4/${name}.png`, `Unexpected ${name} legacy ${density} variant.`);
  }
}

export function verifyCompiledAndroidIconPolicy({ manifestDump, resourceDump, identity }) {
  const roots = xmlTree(manifestDump);
  requirePolicy(roots.length === 1 && roots[0].name === 'manifest', 'Expected one compiled Android manifest.');
  const manifest = roots[0], applications = manifest.children.filter(node => node.name === 'application');
  requirePolicy(stringValue(manifest.attrs.package) === identity.applicationId
    && Number(manifest.attrs.versionCode) === identity.versionCode
    && stringValue(manifest.attrs.versionName) === identity.versionName, 'APK application identity/version does not match android/app/build.gradle.');
  requirePolicy(applications.length === 1, 'Expected one compiled application element.');
  const application = applications[0];
  const components = application.children.filter(node => ['activity', 'activity-alias'].includes(node.name));
  requirePolicy(components.every(node => !('icon' in node.attrs) && !('roundIcon' in node.attrs)), 'Activity or alias icon overrides are forbidden.');
  requirePolicy(components.every(node => node.name !== 'activity-alias'), 'Unexpected activity-alias can introduce another launcher identity.');
  const launchers = components.filter(node => node.children.some(filter => filter.name === 'intent-filter'
    && filter.children.some(child => child.name === 'action' && stringValue(child.attrs.name) === 'android.intent.action.MAIN')
    && filter.children.some(child => child.name === 'category' && stringValue(child.attrs.name) === 'android.intent.category.LAUNCHER')));
  requirePolicy(launchers.length === 1, 'Expected one launcher activity.');
  const resources = resourceTable(resourceDump), foreground = resources.get('mipmap/ic_launcher_foreground');
  bitmapVariants(foreground, 'ic_launcher_foreground');
  requirePolicy(foreground.configurations.length === 5, 'Foreground must contain exactly five PNG densities.');
  const launcher = [];
  for (const [attribute, name] of [['icon', 'readge_launcher'], ['roundIcon', 'readge_launcher_round']]) {
    const resource = resources.get(`mipmap/${name}`);
    bitmapVariants(resource, name);
    requirePolicy(resource.configurations.length === 5, `${name} must contain exactly five transparent PNG densities, without XML wrappers or extra configurations.`);
    requirePolicy(refValue(application.attrs[attribute]) === resource.id, `Application ${attribute} must select mipmap/${name}.`);
    launcher.push({ manifestAttribute: attribute, resource: resource.name, drawableType: 'bitmap', pngDensityVariants: 5, adaptiveXmlVariants: 0 });
  }
  return { ...identity, applicationLauncher: { icon: refValue(application.attrs.icon), roundIcon: refValue(application.attrs.roundIcon),
    launcherActivity: stringValue(launchers[0].attrs.name), activityIconOverrides: 0, activityAliases: 0 },
    launcherDrawableType: 'bitmap', selectedLauncherPngCount: 10, selectedAdaptiveXmlCount: 0, launcher };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, filename] = process.argv.slice(2);
  if (mode === '--sources') process.stdout.write(JSON.stringify(verifyAndroidIconSources(filename)));
  else if (mode === '--compiled') {
    const bundle = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const source = verifyAndroidIconSources(bundle.root);
    process.stdout.write(JSON.stringify(verifyCompiledAndroidIconPolicy({ ...bundle, identity: source.identity })));
  } else throw new Error('Usage: android-icon-policy.mjs --sources ROOT | --compiled BUNDLE.json');
}

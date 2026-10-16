import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DESKTOP_APP_ID, desktopWindowBranding } from './brand.mjs';
import { icoFrames, matchingBrandIcon } from './icon-resources.mjs';
import { createPngIco } from '../scripts/desktop-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

test('Windows ICO retains every transparent desktop PNG frame byte for byte, including the 256px Explorer icon', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'desktop/resources/icon-manifest.json'), 'utf8'));
  const icon = await fs.readFile(path.join(root, 'desktop/resources/readge.ico'));
  const frames = icoFrames(icon);
  assert.deepEqual(frames.map(frame => frame.size), [16,32,48,128,256]);
  assert.equal(hash(icon), manifest.ico.sha256);
  for (const frame of manifest.frames) {
    const source = await fs.readFile(path.join(root, frame.source));
    assert.equal(hash(source), frame.sha256);
    assert.equal(frames.find(candidate => candidate.size === frame.size).sha256, frame.sha256);
  }
  assert.equal(hash(await fs.readFile(path.join(root, 'desktop/resources/readge.png'))),
    hash(await fs.readFile(path.join(root, 'desktop/resources/readge-icon-256.png'))));
  assert.throws(() => createPngIco([Buffer.from('not an image')]), /PNG/);
});

test('desktop windows and shortcuts use the ReadAge display name with the stable application identity and a physical packaged icon path', () => {
  const config = createRequire(import.meta.url)('./electron-builder.cjs');
  assert.equal(config.appId, DESKTOP_APP_ID);
  assert.equal(config.productName, 'ReadAge');
  assert.equal(config.win.executableName, 'readge');
  assert.equal(config.win.icon, 'desktop/resources/readge.ico');
  assert.equal(config.nsis.installerIcon, config.win.icon);
  assert.equal(config.nsis.uninstallerIcon, config.win.icon);
  assert.equal(config.nsis.installerHeaderIcon, config.win.icon);
  assert.equal(config.nsis.shortcutName, 'ReadAge');
  const development = desktopWindowBranding({ appRoot: root, isPackaged: false });
  assert.equal(development.title, 'ReadAge');
  assert.equal(development.icon, path.join(root, 'desktop/resources/readge.png'));
  const packaged = desktopWindowBranding({ appRoot: 'ignored.asar', isPackaged: true, resourcesPath: path.join(root, 'fixture/resources') });
  assert.equal(packaged.icon, path.join(root, 'fixture/resources/brand/readge.png'));
  assert.ok(config.extraResources.some(resource => resource.to === 'brand' && resource.filter.includes('readge.png')));
});

test('PE brand verification rejects the default Electron icon and incomplete size sets', async () => {
  const frames = icoFrames(await fs.readFile(path.join(root, 'desktop/resources/readge.ico')));
  assert.equal(matchingBrandIcon([{ frames }], frames), true);
  assert.equal(matchingBrandIcon([{ frames: frames.slice(1) }], frames), false);
  assert.equal(matchingBrandIcon([{ frames: frames.map(frame => ({ ...frame, sha256: 'electron-default' })) }], frames), false);
  assert.equal(matchingBrandIcon([{ frames: frames.map(frame => ({ ...frame, sha256: 'electron-default' })) }, { frames }], frames), false);
});

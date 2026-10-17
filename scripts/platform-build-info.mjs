import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = 1;
const stampName = 'readge-build.json';
const groupsFor = {
  web: ['shared', 'node'],
  desktop: ['shared', 'node', 'desktop'],
  android: ['shared', 'android'],
};
const sourceRoots = {
  shared: ['src', 'public', 'packages', 'vendor/nextword-local-dictionary',
    'website/book-presentation.js', 'website/bookshelf.css', 'website/update-protocol.mjs', 'website/patch-protocol.mjs', 'website/assets/wisdom.png', 'config/update-trust.json',
    'data/dictionary/readage', 'data/dictionary/revisions',
    'data/dictionary/imported/wordnet-3.1', 'data/dictionary/imported/wiktionary-fr',
    'data/dictionary/imported/wiktionary-fr-zh', 'data/dictionary/imported/wiktionary-ja-zh', 'prototypes/rec-particles',
    'assets/brand/readge-icon.png', 'index.html', 'metadata.json', 'package.json',
    'package-lock.json', 'bun.lock', 'vite.config.ts', 'tsconfig.json', 'LICENSE', 'NOTICE', 'scripts'],
  node: ['server', 'server.ts'],
  desktop: ['desktop'],
  android: ['android/app/src/main', 'android/app/libs', 'android/app/build.gradle',
    'android/app/proguard-rules.pro', 'android/build.gradle', 'android/settings.gradle',
    'android/variables.gradle', 'android/gradle.properties', 'android/gradle',
    'android/gradlew', 'android/gradlew.bat', 'capacitor.config.ts'],
};
const ignoredDirectories = new Set(['node_modules', '.git', '.gradle', '.cxx', 'build', 'dist', 'dist-android', 'tests', 'test', 'androidTest']);
const safeRelative = value => typeof value === 'string' && value.length > 0
  && !path.isAbsolute(value) && !value.includes('\\') && !value.includes(':')
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const hashObject = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const outputDirectory = platform => platform === 'android' ? 'dist-android' : 'dist';
const recordPath = (workspace, platform, kind) => path.join(workspace, 'build/platforms', `${platform}-${kind}.json`);

export async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function filesUnder(workspace, relative, source = false) {
  if (source && ignoredDirectories.has(path.basename(relative))) return [];
  const filename = path.join(workspace, relative);
  const stat = await fs.lstat(filename).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return [];
  if (stat.isSymbolicLink()) throw new Error(`版本核对不跟随目录链接：${relative}`);
  if (source && (relative.startsWith('android/app/src/main/assets/')
    || relative === 'android/app/src/main/assets'
    || /(?:^|\/)(?:\.env[^/]*|[^/]*\.test\.[^/]*|README\.md)$/.test(relative)
    || (relative.startsWith('scripts/') && /^(?:test-|smoke-|desktop-|build-desktop|android-|build-android|prepare-android|check-android|verify-android|VerifyAndroidRuntime)/.test(path.basename(relative))))) return [];
  if (stat.isDirectory()) {
    const entries = await fs.readdir(filename);
    const files = [];
    for (const entry of entries.sort()) files.push(...await filesUnder(workspace, `${relative}/${entry}`, source));
    return files;
  }
  return stat.isFile() ? [relative] : [];
}

async function inventory(workspace, files) {
  const result = [];
  for (const relative of [...new Set(files)].sort()) {
    const filename = path.join(workspace, relative);
    const stat = await fs.stat(filename);
    result.push({ path: relative, bytes: stat.size, sha256: await fileDigest(filename) });
  }
  return result;
}

export async function captureSources(workspace = root) {
  const groups = {};
  for (const [group, roots] of Object.entries(sourceRoots)) {
    const files = [];
    for (const relative of roots) files.push(...await filesUnder(workspace, relative, true));
    // Build/runtime helpers belong to their target rather than making every
    // Android-only change invalidate an otherwise current Windows installer.
    if (group === 'desktop' || group === 'android') {
      for (const relative of await filesUnder(workspace, 'scripts')) {
        const name = path.basename(relative);
        const belongs = group === 'desktop' ? /^(?:desktop-|build-desktop)/.test(name)
          : /^(?:android-|build-android|prepare-android|check-android|verify-android)/.test(name);
        if (belongs && !/\.test\./.test(name)) files.push(relative);
      }
    }
    groups[group] = await inventory(workspace, files);
  }
  const groupIds = Object.fromEntries(Object.entries(groups).map(([key, files]) => [key, hashObject(files)]));
  return { schema, groupIds, groups, sourceId: hashObject(groupIds) };
}

export function platformInputId(snapshot, platform) {
  if (!groupsFor[platform]) throw new Error(`未知平台：${platform}`);
  return hashObject(groupsFor[platform].map(group => [group, snapshot.groupIds[group]]));
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function readJson(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function assertSourcesUnchanged(workspace, platform, before) {
  const after = await captureSources(workspace);
  if (platformInputId(before, platform) !== platformInputId(after, platform)) {
    const sources = groupsFor[platform].flatMap(group => before.groups[group]);
    const changed = sourceChanges({ sources }, after, platform);
    throw new Error(`${platform} 构建期间源码发生变化，请重新构建后再记录版本。${changed.length ? `\n变化文件：${changed.slice(0, 8).join('、')}` : ''}`);
  }
}

export async function recordBuild(workspace, platform, before) {
  await assertSourcesUnchanged(workspace, platform, before);
  const directory = outputDirectory(platform);
  await fs.access(path.join(workspace, directory, 'index.html'));
  if (platform !== 'android') await fs.access(path.join(workspace, directory, 'server.mjs'));
  const stamp = { schema, platform, builtAt: new Date().toISOString(),
    inputId: platformInputId(before, platform), sourceId: before.sourceId,
    groupIds: Object.fromEntries(groupsFor[platform].map(group => [group, before.groupIds[group]])),
    sources: groupsFor[platform].flatMap(group => before.groups[group]) };
  await writeJson(path.join(workspace, directory, stampName), stamp);
  const files = await inventory(workspace, await filesUnder(workspace, directory));
  const record = { ...stamp, files };
  await writeJson(recordPath(workspace, platform, 'build'), record);
  return record;
}

export async function recordAndroidSync(workspace, build) {
  if (build.platform !== 'android' || !Array.isArray(build.files) || !build.files.length
    || build.files.some(file => !file.path.startsWith('dist-android/'))) {
    throw new Error('缺少 Android 前端构建记录。');
  }
  await assertBuildCurrent(workspace, build);
  const from = path.join(workspace, 'dist-android', stampName);
  const to = path.join(workspace, 'android/app/src/main/assets/public', stampName);
  await fs.copyFile(from, to);
  const copied = build.files.map(file => ({ ...file,
    path: file.path.replace(/^dist-android\//, 'android/app/src/main/assets/public/') }));
  const mismatch = await verifyFiles(workspace, copied);
  if (mismatch) throw new Error(`手机工程没有完整同步本次前端：${mismatch}`);
  const publicDirectory = 'android/app/src/main/assets/public';
  const publicFiles = await filesUnder(workspace, publicDirectory);
  const expected = new Set(copied.map(file => file.path));
  const unexpected = publicFiles.filter(file => !expected.has(file)
    && !/^(?:capacitor(?:_plugins)?\.js|cordova(?:_plugins)?\.js|plugins\/.*)$/.test(file.slice(publicDirectory.length + 1)));
  if (unexpected.length) throw new Error(`手机工程含有未同步的旧前端文件：${unexpected[0]}`);
  // Capacitor generates these inputs during sync; record them afterwards so
  // their generation cannot masquerade as a source change during the build.
  const generated = [];
  for (const relative of ['android/capacitor.settings.gradle', 'android/app/capacitor.build.gradle',
    'android/app/src/main/assets/capacitor.config.json', 'android/app/src/main/assets/capacitor.plugins.json']) {
    generated.push(...await filesUnder(workspace, relative));
  }
  const files = await inventory(workspace, [...publicFiles, ...generated]);
  const sync = { schema, platform: 'android', inputId: build.inputId, sourceId: build.sourceId,
    syncedAt: new Date().toISOString(), files };
  await writeJson(recordPath(workspace, 'android', 'sync'), sync);
  return sync;
}

export async function assertBuildCurrent(workspace, build) {
  const stamp = await readJson(path.join(workspace, outputDirectory(build.platform), stampName));
  if (!stamp || stamp.platform !== build.platform || stamp.inputId !== build.inputId) {
    throw new Error('打包前端目标已被覆盖，请重新构建对应平台。');
  }
  const mismatch = await verifyFiles(workspace, build.files);
  if (mismatch) throw new Error(`本次构建文件已改变：${mismatch}`);
  const extra = await unexpectedFiles(workspace, outputDirectory(build.platform), build.files);
  if (extra) throw new Error(`本次构建目录含有额外文件：${extra}`);
}

export async function assertAndroidSyncCurrent(workspace, build) {
  const sync = await readJson(recordPath(workspace, 'android', 'sync'));
  if (!sync || sync.inputId !== build.inputId) throw new Error('手机工程缺少本次同步记录。');
  const mismatch = await verifyFiles(workspace, sync.files);
  if (mismatch) throw new Error(`手机工程同步文件已改变：${mismatch}`);
  const extra = await unexpectedFiles(workspace, 'android/app/src/main/assets/public', sync.files);
  if (extra) throw new Error(`手机工程同步目录含有额外文件：${extra}`);
}

export async function recordPackage(workspace, platform, build, artifact, startedAt) {
  if (platform === 'web') throw new Error('网页构建没有安装包。');
  if (build.platform !== platform) throw new Error('安装包与构建目标不一致。');
  if (!safeRelative(artifact)) throw new Error('安装包路径必须在项目目录内。');
  await assertBuildCurrent(workspace, build);
  if (platform === 'android') await assertAndroidSyncCurrent(workspace, build);
  if (build.inputId !== platformInputId(await captureSources(workspace), platform)) {
    throw new Error('打包期间源码发生变化，请重新构建。');
  }
  const filename = path.join(workspace, artifact);
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size === 0 || stat.mtimeMs < startedAt - 2000) {
    throw new Error(`未发现本次打包生成的安装包：${artifact}`);
  }
  const record = { schema, platform, inputId: build.inputId, sourceId: build.sourceId,
    builtAt: build.builtAt, packagedAt: new Date().toISOString(),
    artifact: { path: artifact, bytes: stat.size, sha256: await fileDigest(filename) } };
  await writeJson(recordPath(workspace, platform, 'package'), record);
  return record;
}

async function verifyFiles(workspace, files) {
  if (!Array.isArray(files) || files.length === 0) return '缺少文件校验清单';
  for (const file of files) {
    if (!file || !safeRelative(file.path)) return '文件清单包含无效路径';
    const filename = path.join(workspace, file.path);
    const stat = await fs.stat(filename).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isFile() || stat.size !== file.bytes || await fileDigest(filename) !== file.sha256) {
      return `文件缺失或已改变：${file.path}`;
    }
  }
  return null;
}

async function unexpectedFiles(workspace, directory, files) {
  const expected = new Set(files.map(file => file.path));
  return (await filesUnder(workspace, directory)).find(file => !expected.has(file));
}

function sourceChanges(record, current, platform) {
  if (!Array.isArray(record.sources)) return [];
  const previous = new Map(record.sources.map(file => [file.path, file.sha256]));
  const next = new Map(groupsFor[platform].flatMap(group => current.groups[group]).map(file => [file.path, file.sha256]));
  return [...new Set([...previous.keys(), ...next.keys()])].sort().filter(file => previous.get(file) !== next.get(file));
}

async function checkRecord(workspace, platform, kind, current) {
  const record = await readJson(recordPath(workspace, platform, kind));
  if (!record || record.schema !== schema || record.platform !== platform) {
    return { status: 'unrecorded', reason: '尚无版本记录；已有旧产物不能据此确认对应当前源码' };
  }
  if (record.inputId !== platformInputId(current, platform)) {
    return { status: 'stale', reason: '源码已更新，需要重新构建', changedFiles: sourceChanges(record, current, platform) };
  }
  if (kind === 'build') {
    const stamp = await readJson(path.join(workspace, outputDirectory(platform), stampName));
    if (!stamp || stamp.platform !== platform || stamp.inputId !== record.inputId) {
      return { status: 'stale', reason: '构建目录已被覆盖或缺少对应平台标记' };
    }
  }
  const reason = await verifyFiles(workspace, kind === 'package' ? [record.artifact] : record.files);
  const extra = !reason && kind !== 'package' ? await unexpectedFiles(workspace,
    kind === 'sync' ? 'android/app/src/main/assets/public' : outputDirectory(platform), record.files) : null;
  return reason || extra ? { status: 'stale', reason: reason || `目录含有未记录的文件：${extra}` } : { status: 'current',
    reason: '对应当前源码，记录的文件校验一致', artifact: record.artifact?.path,
    recordedAt: record.packagedAt || record.syncedAt || record.builtAt };
}

export async function checkPlatforms(workspace = root) {
  const current = await captureSources(workspace);
  const platforms = {};
  for (const platform of Object.keys(groupsFor)) {
    platforms[platform] = { inputId: platformInputId(current, platform),
      build: await checkRecord(workspace, platform, 'build', current),
      ...(platform === 'android' ? { sync: await checkRecord(workspace, platform, 'sync', current) } : {}),
      ...(platform !== 'web' ? { package: await checkRecord(workspace, platform, 'package', current) } : {}),
      installed: { status: 'unknown', reason: '需读取实际设备版本并验收；源码和构建记录不代表已安装' } };
  }
  const complete = platforms.web.build.status === 'current'
    && platforms.desktop.package.status === 'current'
    && platforms.android.build.status === 'current' && platforms.android.sync.status === 'current'
    && platforms.android.package.status === 'current';
  return { schema, checkedAt: new Date().toISOString(), sourceId: current.sourceId, complete, platforms,
    scope: '仅检查纳入清单的源码和构建文件；功能对应、模型资源完整性及实际设备运行另行验收。' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await checkPlatforms();
    await writeJson(path.join(root, 'build/platforms/status.json'), report);
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      const labels = { web: '本地网页', desktop: 'Windows 电脑端', android: 'Android 手机端' };
      const stages = { build: '构建', sync: '手机工程', package: '安装包', installed: '设备' };
      for (const [platform, state] of Object.entries(report.platforms)) {
        console.log(labels[platform]);
        for (const [stage, label] of Object.entries(stages)) {
          if (state[stage]) console.log(`  ${label}：${state[stage].reason}${state[stage].artifact ? `（${state[stage].artifact}）` : ''}`);
        }
      }
      console.log(`核对报告：build/platforms/status.json\n${report.scope}`);
    }
    if (process.argv.includes('--strict') && !report.complete) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

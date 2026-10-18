import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function forbiddenDesktopDependency(filename) {
  const normalized = filename.replaceAll('\\', '/').replace(/^\/+/, '')
    .replace(/^resources\/app\.asar\.unpacked\//, '');
  return /^node_modules\/@capacitor\/android(?:\/|$)/i.test(normalized);
}

export function windowsUpgradePath(filename, profile = os.homedir()) {
  // Matches the legacy child's NSIS plugin directory plus its rollback folder.
  return path.win32.join(profile, '.ra-tmp', 'nsFFFFF.tmp', 'old-install', filename);
}

export async function verifyDesktopInstallLayout(directory, archiveNames, { profile, additionalFiles = [] } = {}) {
  for (const filename of archiveNames) {
    if (forbiddenDesktopDependency(filename)) throw new Error(`Windows 包混入 Android 依赖：${filename}`);
  }
  let files = 0, longestUpgradePath = 0;
  // Installer-only resources are absent from the core 7z but remain physical
  // installation files. Apply the same path gate to their complete inventory.
  for (const filename of additionalFiles) {
    if (typeof filename !== 'string' || /[\\:]/.test(filename) || filename.startsWith('/')
      || filename.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Windows 安装资源路径无效。');
    if (forbiddenDesktopDependency(filename)) throw new Error(`Windows 包混入 Android 依赖：${filename}`);
    const projected = windowsUpgradePath(filename, profile);
    longestUpgradePath = Math.max(longestUpgradePath, projected.length);
    if (projected.length >= 260) throw new Error(`Windows 升级临时路径过长（${projected.length}）：${filename}`);
    files++;
  }
  async function visit(relative) {
    const filename = path.join(directory, relative);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw new Error(`Windows 安装目录不允许链接：${relative}`);
    if (forbiddenDesktopDependency(relative)) throw new Error(`Windows 包混入 Android 依赖：${relative}`);
    const projected = windowsUpgradePath(relative, profile);
    longestUpgradePath = Math.max(longestUpgradePath, projected.length);
    if (projected.length >= 260) throw new Error(`Windows 升级临时路径过长（${projected.length}）：${relative}`);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(filename)) await visit(path.join(relative, name));
    } else files++;
  }
  for (const name of await fs.readdir(directory)) await visit(name);
  return { files, longestUpgradePath, androidDependenciesExcluded: true };
}

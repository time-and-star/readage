/** @typedef {'web'|'windows'|'android'} AppPlatform */
/** @typedef {{revision:number,runtime:string,version:string,bytes:number}} UpdateBundle */
/** @typedef {{version:string,build:number,publishedAt:string,notes:string[],bundle?:UpdateBundle}} UpdateRelease */
/** @typedef {{schemaVersion:1,releases:Record<AppPlatform,UpdateRelease>}} UpdateManifest */
/** @typedef {{platform:AppPlatform,version:string,build:number,runtime?:string,revision?:number,rejectedRevision?:number,shellVersion?:string}} InstalledVersion */
export const UPDATE_ORIGIN = 'https://readage.xyz';
export const UPDATE_PATH = '/api/updates/latest';
export const UPDATE_MAX_BYTES = 128 * 1024;
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
/** @param {unknown} value @returns {UpdateManifest} */
export function validateUpdateManifest(value) {
  const data = /** @type {UpdateManifest} */ (value);
  if (!data || data.schemaVersion !== 1 || !data.releases) throw new Error('官网更新信息格式无效。');
  /** @type {Record<AppPlatform,UpdateRelease>} */
  const releases = { web: null, windows: null, android: null };
  for (const platform of /** @type {AppPlatform[]} */ (['web', 'windows', 'android'])) {
    const release = data.releases[platform];
    if (!release || typeof release.version !== 'string' || !versionPattern.test(release.version)
      || !Number.isSafeInteger(release.build) || release.build < 0 || (platform === 'android' && release.build < 1)
      || typeof release.publishedAt !== 'string' || release.publishedAt.length > 40 || !Number.isFinite(Date.parse(release.publishedAt))
      || !Array.isArray(release.notes) || release.notes.length < 1 || release.notes.length > 20
      || release.notes.some(note => typeof note !== 'string' || !note.trim() || note.length > 500 || /[\x00-\x08\x0b-\x1f]/.test(note))) throw new Error('官网更新信息不完整，请稍后重试。');
    releases[platform] = { version: release.version, build: release.build, publishedAt: release.publishedAt, notes: release.notes.map(note => note.trim()) };
    if (release.bundle !== undefined) {
      const b = release.bundle;
      if (!b || !Number.isSafeInteger(b.revision) || b.revision < 1 || !/^[a-f0-9]{64}$/.test(b.runtime)
        || typeof b.version !== 'string' || !versionPattern.test(b.version) || !Number.isSafeInteger(b.bytes) || b.bytes < 0 || b.bytes > 512 * 1024 * 1024) throw new Error('小更新信息无效。');
      releases[platform].bundle = { revision: b.revision, runtime: b.runtime, version: b.version, bytes: b.bytes };
    }
  }
  return { schemaVersion: 1, releases };
}
/** @param {UpdateRelease} release @param {InstalledVersion} current */
export function isNewerRelease(release, current) {
  if (release.bundle && release.bundle.runtime === current.runtime && release.bundle.revision > Math.max(current.revision || 0, current.rejectedRevision || 0)) return true;
  if (current.platform === 'android') return release.build > current.build;
  const next = release.version.split('.').map(Number), installed = (current.shellVersion || current.version).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (next[i] !== installed[i]) return next[i] > installed[i];
  return false;
}
/** @param {AppPlatform} platform @param {UpdateRelease} release */
export const updateIdentity = (platform, release) => `${platform}:${release.version}:${release.build}${release.bundle ? ':' + release.bundle.revision : ''}`;

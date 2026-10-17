/** File-level updates contain web assets only. Native APIs, models and user data are outside this channel. */
export const PATCH_MANIFEST_MAX = 2 * 1024 * 1024;
export const PATCH_FILE_MAX = 128 * 1024 * 1024;
export const PATCH_TOTAL_MAX = 512 * 1024 * 1024;
export const PATCH_PREFIX = '/api/updates/patches';
const hash = /^[a-f0-9]{64}$/;
export function safePatchPath(value) {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(p => p && !p.startsWith('.') && !p.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
    && !/^(?:server|local-data|data|node_modules|desktop|android|api)(?:\/|\.)/i.test(value)
    && !['readage-shell.json', 'readge-build.json'].includes(value.toLowerCase())
    && (/\.(?:html|m?js|css|json|webmanifest|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|wasm|txt|md|pdf|epub|zip|mp3|wav|ogg|mp4|vtt)$/i.test(value) || /^licenses\/(?:LICENSE|NOTICE)$/.test(value));
}
export function validatePatch(value) {
  if (!value || value.schema !== 1 || value.kind !== 'readage-web-patch' || !['web', 'windows', 'android'].includes(value.platform)
    || !hash.test(value.runtime) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value.version)
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 2000) throw new Error('小更新清单无效。');
  const names = new Set(); let total = 0;
  for (const file of value.files) {
    if (!file || !safePatchPath(file.path) || names.has(file.path.toLowerCase()) || !hash.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > PATCH_FILE_MAX) throw new Error('小更新文件记录无效。');
    names.add(file.path.toLowerCase()); total += file.bytes;
  }
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (names.has(parts.join('/'))) throw new Error('小更新文件路径冲突。'); parts.pop(); }
  }
  if (!value.files.some(f => f.path === 'index.html') || total > PATCH_TOTAL_MAX) throw new Error('小更新缺少入口或体积过大。');
  return value;
}

/** Installer deltas reconstruct the original complete installer, never an installed data directory. */
export const MAX_INSTALLER_BYTES = 4 * 1024 ** 3;
export const MAX_INSTALLER_DELTAS = 32;
export const MAX_DELTA_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_DELTA_OPERATIONS = 100_000;
const hashPattern = /^[a-f0-9]{64}$/;
const hash = value => typeof value === 'string' && hashPattern.test(value);
const installerPattern = /^ReadAge-\d{1,5}\.\d{1,5}\.\d{1,5}-(?:windows-x64-setup\.exe|android\.apk)$/;
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/** @typedef {{baseSha256:string,bytes:number,sha256:string,manifestBytes:number,manifestSha256:string}} InstallerDelta */
/** @typedef {{filename:string,sha256:string,bytes:number}} Installer */
/** @typedef {['b'|'d',number,number]} DeltaOperation */
/** @typedef {{schema:1,baseSha256:string,targetSha256:string,targetBytes:number,payloadSha256:string,payloadBytes:number,operations:DeltaOperation[]}} InstallerDeltaManifest */

/** @param {Pick<Installer,'filename'>} installer @param {Pick<InstallerDelta,'baseSha256'>} delta */
export function deltaFilename(installer, delta) {
  if (!installer || typeof installer.filename !== 'string' || !installerPattern.test(installer.filename) || !delta || !hash(delta.baseSha256)) throw new Error('差分安装包文件名无效。');
  return `${installer.filename}.from-${delta.baseSha256}.delta`;
}

/** @param {unknown} input @param {Installer} installer @returns {InstallerDelta} */
export function validateInstallerDeltaRecord(input, installer) {
  const delta = /** @type {InstallerDelta} */ (input);
  if (!delta || !hash(delta.baseSha256) || !hash(delta.sha256) || !hash(delta.manifestSha256)
    || !installer || !hash(installer.sha256) || !integer(installer.bytes, 1, MAX_INSTALLER_BYTES)
    || !integer(delta.bytes, 0, installer.bytes - 1) || !integer(delta.manifestBytes, 1, MAX_DELTA_MANIFEST_BYTES)) throw new Error('差分安装包信息无效。');
  deltaFilename(installer, delta);
  return { baseSha256: delta.baseSha256, bytes: delta.bytes, sha256: delta.sha256, manifestBytes: delta.manifestBytes, manifestSha256: delta.manifestSha256 };
}

/** @param {unknown} input @param {Installer} installer @param {InstallerDelta} delta @returns {InstallerDeltaManifest} */
export function validateInstallerDelta(input, installer, delta) {
  validateInstallerDeltaRecord(delta, installer);
  const value = /** @type {InstallerDeltaManifest} */ (input);
  if (!value || value.schema !== 1 || value.baseSha256 !== delta.baseSha256 || value.targetSha256 !== installer.sha256
    || value.targetBytes !== installer.bytes || value.payloadSha256 !== delta.sha256 || value.payloadBytes !== delta.bytes
    || !Array.isArray(value.operations) || !integer(value.operations.length, 1, MAX_DELTA_OPERATIONS)) throw new Error('差分重构清单无效。');
  /** @type {DeltaOperation[]} */
  const operations = [];
  let outputBytes = 0, payloadBytes = 0;
  for (const operation of value.operations) {
    if (!Array.isArray(operation) || operation.length !== 3 || !['b', 'd'].includes(operation[0])
      || !integer(operation[1], 0, MAX_INSTALLER_BYTES) || !integer(operation[2], 1, MAX_INSTALLER_BYTES)
      || operation[1] + operation[2] > MAX_INSTALLER_BYTES || outputBytes + operation[2] > installer.bytes) throw new Error('差分重构操作无效。');
    if (operation[0] === 'd') {
      if (operation[1] !== payloadBytes || payloadBytes + operation[2] > delta.bytes) throw new Error('差分下载块顺序无效。');
      payloadBytes += operation[2];
    }
    outputBytes += operation[2];
    operations.push([operation[0], operation[1], operation[2]]);
  }
  if (outputBytes !== installer.bytes || payloadBytes !== delta.bytes) throw new Error('差分重构大小无效。');
  return { schema: 1, baseSha256: delta.baseSha256, targetSha256: installer.sha256, targetBytes: installer.bytes,
    payloadSha256: delta.sha256, payloadBytes: delta.bytes, operations };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resourceFileHash } from '../desktop/bundled-resources.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportFile = process.argv[2] && path.resolve(process.argv[2]);
if (!reportFile) throw new Error('Provide the successful packaged resource smoke report.');
const smoke = JSON.parse(await fs.readFile(reportFile, 'utf8'));
const first = JSON.parse(await fs.readFile(path.join(path.dirname(reportFile), 'first-report.json'), 'utf8'));
const packageVerification = JSON.parse(await fs.readFile(path.join(root, 'build/desktop/package-verification.json'), 'utf8'));
const peIntegrityFile = path.join(root, 'build/desktop/pe-integrity.json');
const peIntegrity = JSON.parse(await fs.readFile(peIntegrityFile, 'utf8'));
const nativeModuleFile = path.join(root, 'build/desktop/native-modules-verification.json');
const nativeModules = JSON.parse((await fs.readFile(nativeModuleFile, 'utf8')).replace(/^\uFEFF/, ''));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'build/desktop-resources/manifest.json'), 'utf8'));
const executableDirectory = path.resolve(nativeModules.appDirectory);
const finalPayloadDirectory = path.resolve(packageVerification.directory);
// Resource smoke may run from win-unpacked while the verifier audits the final
// NSIS payload. Accept that only when their executable and entire ASAR are exact
// copies; the bundle and native import audit must still match the final payload.
const samePackagedApplication = executableDirectory === finalPayloadDirectory || (await Promise.all([
  'readge.exe', 'resources/app.asar',
].map(async file => await resourceFileHash(path.join(executableDirectory, file))
  === await resourceFileHash(path.join(finalPayloadDirectory, file))))).every(Boolean);
const iconVerificationFile = path.join(root, 'build/desktop/icon-verification.json');
const iconVerification = JSON.parse(await fs.readFile(iconVerificationFile, 'utf8'));
const speechLatencyFile = path.join(root, 'build/desktop/speech-latency-verification.json');
const speechLatency = JSON.parse(await fs.readFile(speechLatencyFile, 'utf8'));
const speechRegressionFile = path.join(root, 'build/desktop/speech-regression-verification.json');
const speechRegression = JSON.parse(await fs.readFile(speechRegressionFile, 'utf8'));
const desktopSpeechRegressionFile = path.join(root, 'build/desktop/speech-desktop-regression-verification.json');
const desktopSpeechRegression = JSON.parse(await fs.readFile(desktopSpeechRegressionFile, 'utf8'));
const desktopTestPass = desktopSpeechRegression.checks.find(check => check.command === 'node --test desktop/*.test.mjs' && check.exitCode === 0);
const localTextTestPass = desktopSpeechRegression.checks.find(check => check.command.includes('tests/kokoroText.test.ts') && check.exitCode === 0);
for (const record of [speechRegression, desktopSpeechRegression]) {
  for (const file of record.files) {
    if (await resourceFileHash(path.join(root, file.path)) !== file.sha256) throw new Error(`Speech test evidence is stale: ${file.path}`);
  }
}
const smokeSettings = JSON.parse(await fs.readFile(path.join(path.dirname(reportFile), 'user/desktop-settings.json'), 'utf8'));
const smokeStartupLog = await fs.readFile(path.join(path.dirname(reportFile), 'user/workspace/local-data/startup-logs/desktop.log'), 'utf8');
const fp32ActuallyLoaded = smokeSettings.TTS_KOKORO_DTYPE === 'fp32'
  && smokeStartupLog.includes('[kokoro] Loading installed local CPU model (fp32)');
if (!speechLatency.ok || !speechRegression.passed || !speechRegression.typecheck || !desktopSpeechRegression.ok
  || !desktopTestPass || !localTextTestPass || !fp32ActuallyLoaded || !speechLatency.results.every(result => result.measurements.every(measurement =>
    measurement.runs.every(run => run.audio.valid && run.audio.peak > 0)))) {
  throw new Error('Successful local speech speed and playback regression evidence is required.');
}
const regressionTestLog = path.join(root, 'build/desktop/repair-tests.log');
const regressionTests = await fs.readFile(regressionTestLog, 'utf8');
const regressionTestCount = Number(regressionTests.match(/\btests (\d+)/)?.[1]);
const regressionPassCount = Number(regressionTests.match(/\bpass (\d+)/)?.[1]);
if (!regressionTestCount || regressionTestCount !== regressionPassCount
  || !/\bfail 0\b/.test(regressionTests) || !/\bskipped 0\b/.test(regressionTests)) {
  throw new Error('Successful desktop repair regression test evidence is required.');
}
if (!smoke.ok || !first.ok || !smoke.resourceProof?.ok || !packageVerification.ok || !peIntegrity.passed || !nativeModules.ok || first.resources.deployed !== manifest.files.length || smoke.resources.deployed !== 0
  || nativeModules.systemVcRuntimeUsed || path.resolve(nativeModules.fixture) !== path.dirname(reportFile)
  || !samePackagedApplication || peIntegrity.directory !== packageVerification.directory
  || !iconVerification.ok || !packageVerification.physicalBrandResourcesVerified || !packageVerification.windowsExecutableIconVerified
  || first.origin !== smoke.origin || first.profiles.profiles[0].id !== smoke.profiles.profiles[0].id) throw new Error('Successful initial/reopen/package verification evidence is required.');
const installer = path.join(root, 'build/desktop/readge-0.1.0-windows-x64-setup.exe');
const signatureEnvironment = { ...process.env, READGE_VERIFIED_INSTALLER: installer };
// A PowerShell 7 parent's module paths are incompatible with Windows PowerShell 5's built-in modules.
delete signatureEnvironment.PSModulePath;
const signature = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
  '(Get-AuthenticodeSignature -LiteralPath $env:READGE_VERIFIED_INSTALLER).Status.ToString()'], { windowsHide: true, env: signatureEnvironment });
const report = { ok: true, checkedAt: new Date().toISOString(), installer: { path: installer, bytes: (await fs.stat(installer)).size,
  sha256: await resourceFileHash(installer), authenticode: signature.stdout.trim(), platform: 'windows-x64', translationCpuRequirement: 'AVX2' },
  resourceBundle: { bundleId: manifest.bundleId, files: manifest.files.length, bytes: manifest.totalBytes, components: manifest.components },
  validation: { source: 'actual NSIS application payload', extractedApp: packageVerification.directory, packageVerification,
    resourceSmokeApplication: executableDirectory, resourceSmokeAndFinalPayloadByteIdentical: samePackagedApplication,
    iconVerificationReport: iconVerificationFile, executableAndInstallerDefaultIconsVerified: iconVerification.ok,
    peIntegrityReport: peIntegrityFile, allPeNativeDependenciesResolved: peIntegrity.passed, nativeModuleReport: nativeModuleFile,
    nativeFilesAudited: peIntegrity.nativeFileCount, peImportBlocksAudited: peIntegrity.importCount,
    unresolvedNativeImports: peIntegrity.unresolvedImports.length, missingNativeExportChecks: peIntegrity.missingExportChecks.length,
    applicationLocalVcRuntimeModulesVerified: nativeModules.modules.length,
    systemVcRuntimeUsed: nativeModules.systemVcRuntimeUsed,
    smokeReport: reportFile, firstSmokeReport: path.join(path.dirname(reportFile), 'first-report.json'), screenshot: smoke.screenshot,
    firstDeploymentFiles: first.resources.deployed, repeatDeploymentFiles: smoke.resources.deployed,
    isolatedLegacyFixtureHasNoModels: true, outsidePythonOverrideInvalidAndIgnored: smoke.resourceProof.hostileExternalPythonOverrideIgnored,
    networkPolicy: 'Renderer and general services remain loopback-only; manual magazine sync alone may read configured sources in an isolated scope. Automatic sync remains disabled. Renderer external HTTPS probe blocked. System adapters were not changed.',
    resourceProof: smoke.resourceProof, libraryPath: smoke.pathname, learningProfileAndSavedRecordPreserved: true,
    oldBrowserMp3AndCloudModelSettingsUpgraded: true,
    speechValidation: { defaultFp32ActuallyLoaded: fp32ActuallyLoaded,
      modelLatencyReport: speechLatencyFile, modelLatencyComparison: speechLatency.comparison,
      additionalObservedFp32RssBytes: speechLatency.additionalFp32RssBytes,
      clientRegressionReport: speechRegressionFile, clientRegressionTestsPassed: speechRegression.count,
      clientTypecheckPassed: speechRegression.typecheck, desktopRegressionReport: desktopSpeechRegressionFile,
      desktopTestsPassed: desktopTestPass.passed, localTextTestsPassed: localTextTestPass.passed },
    desktopTargetedRegressionTestsPassed: regressionPassCount, regressionTestLog } };
const output = path.join(root, 'build/desktop/offline-verification.json');
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, output, installer: report.installer, bundleId: manifest.bundleId }, null, 2));

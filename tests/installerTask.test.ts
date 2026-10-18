import test from 'node:test';
import assert from 'node:assert/strict';
import { localInstallerOffer, installerProgressText, installerIsWorking, installerMatchesRelease, withRequestedInstallerRelease } from '../src/lib/installerTask';
import type { InstallerStatus } from '../src/lib/installerUpdates';

const current = { platform: 'windows' as const, version: '0.1.6', build: 0 };
const release = { version: '0.2.0', build: 10, publishedAt: '2026-10-18T00:00:00Z', notes: ['A complete update.'] };
const task = (phase: InstallerStatus['phase']): InstallerStatus => ({ phase, version: release.version, release, downloadedBytes: 25, totalBytes: 100 });

test('offline local tasks remain discoverable after later installation, but never offer the installed version or stale mismatched metadata', () => {
  for (const phase of ['paused', 'downloading', 'waiting', 'ready', 'error'] as const) {
    assert.equal(localInstallerOffer(task(phase), current)?.release.version, release.version);
    assert.equal(localInstallerOffer(task(phase), { ...current, version: release.version }), null);
  }
  assert.equal(localInstallerOffer({ ...task('ready'), version: '0.0.1' }, current), null);
  assert.equal(localInstallerOffer(task('idle'), current), null);
  assert.equal(localInstallerOffer({ ...task('ready'), release: undefined }, current), null);
  assert.ok(localInstallerOffer({ ...task('ready'), release: { ...release, version: '0.0.1' }, version: '0.0.1' },
    { platform: 'android', version: '9.9.9', build: 9 }), 'Android uses the actual build code');
});

test('long downloads explain progress, retained pause and network recovery; local reconstruction and verification are distinct stages', () => {
  assert.match(installerProgressText({ ...task('downloading'), mode: 'delta', speedBytesPerSecond: 1024 ** 2, etaSeconds: 91 }), /补丁.*25%.*1.0 MB\/s.*约2分钟/);
  assert.match(installerProgressText(task('paused')), /保留进度/);
  assert.match(installerProgressText({ ...task('paused'), error: '系统暂停了长时间后台任务' }), /系统暂停了长时间后台任务.*保留进度/);
  assert.match(installerProgressText(task('waiting')), /等待网络/);
  assert.match(installerProgressText(task('applying')), /准备安装包/);
  assert.match(installerProgressText(task('verifying')), /校验安装包/);
  assert.match(installerProgressText(task('ready')), /准备好.*保存学习记录/);
  assert.match(installerProgressText(task('error')), /保留进度/);
  assert.doesNotMatch(installerProgressText({ ...task('downloading'), totalBytes: 0, etaSeconds: NaN }), /NaN|Infinity/);
  assert.match(installerProgressText({ ...task('downloading'), speedBytesPerSecond: 12 * 1024 }), /12 KB\/s/);
  assert.equal(installerIsWorking(task('waiting')), true);
  assert.equal(installerIsWorking(task('ready')), false);
});

test('a failed initial metadata request remains visible only for the release accepted by this session', () => {
  const requested = { ...release, installer: { filename: 'ReadAge-0.2.0-windows-x64-setup.exe', bytes: 200, sha256: 'a'.repeat(64) } };
  const failure = { ...task('error'), release: undefined, error: '无法连接更新服务' };
  const visible = withRequestedInstallerRelease(failure, requested);
  assert.equal(installerMatchesRelease(visible, requested), true);
  assert.equal(installerProgressText(visible), failure.error);
  assert.equal(withRequestedInstallerRelease(failure).release, undefined);
  assert.equal(withRequestedInstallerRelease({ ...failure, version: '0.3.0' }, requested).release, undefined);
  assert.equal(withRequestedInstallerRelease({ ...failure, phase: 'ready' }, requested).release, undefined);
  assert.equal(withRequestedInstallerRelease({ ...failure, phase: 'idle' }, requested).release, undefined);
  const other = { ...requested, build: requested.build + 1 };
  assert.equal(withRequestedInstallerRelease({ ...failure, release: other }, requested).release, other);
});

test('a same-name Android version cannot mistake an earlier build or different APK for the requested ready update', () => {
  const previous = { ...release, installer: { filename: 'ReadAge-0.2.0-android.apk', bytes: 200, sha256: 'a'.repeat(64) } };
  const cached = { ...task('ready'), release: previous };
  assert.equal(installerMatchesRelease(cached, previous), true);
  assert.equal(installerMatchesRelease(cached, { ...previous, build: previous.build + 1 }), false);
  assert.equal(installerMatchesRelease(cached, { ...previous, installer: { ...previous.installer, sha256: 'b'.repeat(64) } }), false);
  assert.equal(installerMatchesRelease({ ...cached, release: undefined }, previous), false);
});

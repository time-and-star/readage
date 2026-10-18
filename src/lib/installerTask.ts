import { isNewerRelease, type InstalledVersion, type UpdateRelease } from '../../website/update-protocol.mjs';
import type { InstallerStatus } from './installerUpdates';

export const installerIsWorking = (task?: InstallerStatus | null) =>
  !!task && ['preparing', 'downloading', 'waiting', 'applying', 'verifying'].includes(task.phase);

/** Android may publish a new build with the same displayed version. */
export function installerMatchesRelease(task: InstallerStatus | null | undefined, release: UpdateRelease) {
  return !!task?.release && task.version === release.version && task.release.version === release.version
    && task.release.build === release.build && task.release.installer?.sha256 === release.installer?.sha256;
}

/** Only the release accepted by this session's explicit start command can fill pre-metadata status. */
export function withRequestedInstallerRelease(task: InstallerStatus, requested?: UpdateRelease) {
  if (!task.release && requested?.installer && task.version === requested.version
    && ['preparing', 'paused', 'waiting', 'error'].includes(task.phase)) return { ...task, release: requested };
  return task;
}

/** A cached job remains reachable without a successful online version check. */
export function localInstallerOffer(task: InstallerStatus | null, current: InstalledVersion) {
  if (!task?.release || task.phase === 'idle' || task.version !== task.release.version
    || !isNewerRelease(task.release, current)) return null;
  return { current, release: task.release };
}

export function installerProgressText(task?: InstallerStatus | null) {
  if (!task || task.phase === 'idle') return '可在后台下载，继续阅读；准备好后再选择安装。';
  if (task.phase === 'ready') return '更新已准备好，安装前会保存学习记录。';
  if (task.phase === 'preparing') return '正在检查可用更新，准备后台下载…';
  if (task.phase === 'applying') return '正在准备安装包，可以继续阅读…';
  if (task.phase === 'verifying') return '正在校验安装包，可以继续阅读…';
  const total = Math.max(0, task.totalBytes || 0), done = Math.max(0, Math.min(total, task.downloadedBytes || 0));
  const percent = total ? `${Math.floor(done / total * 100)}% · ` : '';
  const bytes = `${(done / 1024 ** 2).toFixed(1)} / ${(total / 1024 ** 2).toFixed(1)} MB`;
  if (task.phase === 'paused') return `${task.error || '已暂停'} · ${percent}${bytes}，继续时保留进度。`;
  if (task.phase === 'waiting') return `等待网络后继续 · ${percent}${bytes}`;
  if (task.phase === 'error') return task.error || '下载未完成，已保留进度，可以重试。';
  const speed = Number.isFinite(task.speedBytesPerSecond) && task.speedBytesPerSecond > 0
    ? task.speedBytesPerSecond < 1024 ** 2
      ? ` · ${Math.max(1, Math.round(task.speedBytesPerSecond / 1024))} KB/s`
      : ` · ${(task.speedBytesPerSecond / 1024 ** 2).toFixed(1)} MB/s` : '';
  const eta = Number.isFinite(task.etaSeconds) && task.etaSeconds > 0
    ? ` · 约${Math.max(1, Math.ceil(task.etaSeconds / 60))}分钟` : '';
  return `${task.mode === 'delta' ? '下载更新补丁' : '后台下载更新'} · ${percent}${bytes}${speed}${eta}`;
}

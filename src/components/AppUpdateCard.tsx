import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { UpdateState } from '../lib/appUpdateController';
import { CAN_INSTALL_IN_APP, downloadInstaller, installerStatus, installInstaller, pauseInstaller, resumeInstaller, cancelInstaller,
  type InstallerStatus, type InstallerAction } from '../lib/installerUpdates';
import { installerIsWorking, installerProgressText, installerMatchesRelease } from '../lib/installerTask';
import artwork from '../../website/assets/wisdom.png';

interface AppUpdateCardProps {
  available: NonNullable<UpdateState['available']>;
  onDecline: () => void;
  onUpdate?: () => Promise<void>;
  installer?: InstallerStatus | null;
  collapsed?: boolean;
  working?: boolean;
  actionError?: string;
  onAction?: (action: InstallerAction, version: string) => Promise<void>;
  onCollapse?: () => void;
  onExpand?: () => void;
}
export const AppUpdateCard: React.FC<AppUpdateCardProps> = ({ available, onDecline, onUpdate, installer: supplied,
  collapsed, working, actionError, onAction, onCollapse, onExpand }) => {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [local, setLocal] = useState<InstallerStatus | null>(null);
  const { release } = available;
  const full = CAN_INSTALL_IN_APP && !!release.installer;
  const snapshot = onAction ? supplied : local;
  const task = installerMatchesRelease(snapshot, release) ? snapshot : null;
  const ready = full && task?.phase === 'ready';
  const active = installerIsWorking(task);
  const processing = task?.phase === 'applying' || task?.phase === 'verifying';
  const pending = full && !!task && task.phase !== 'idle';
  const busy = opening || working;
  useEffect(() => {
    if (!full || onAction) return;
    let alive = true, querying = false;
    const refresh = async () => {
      if (querying) return;
      querying = true;
      try { const status = await installerStatus(); if (alive) setLocal(status); } catch {}
      finally { querying = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1000);
    // Only stop observing; the native task belongs to the application, not this card.
    return () => { alive = false; window.clearInterval(timer); };
  }, [full, release.version, onAction]);
  const act = async (action: InstallerAction) => {
    setOpening(true); setError(''); setConfirmCancel(false);
    try {
      if (onAction) await onAction(action, release.version);
      else if (onUpdate && (action === 'download' || action === 'install')) await onUpdate();
      else if (!full) throw new Error('请使用最新版完整安装包更新本机 ReadAge 服务，原学习数据保留。');
      else if (action === 'download') setLocal(await downloadInstaller(release.version, undefined,
        release.installer ? { build: release.build, sha256: release.installer.sha256 } : undefined));
      else if (action === 'resume') setLocal(await resumeInstaller());
      else if (action === 'install') await installInstaller(release.version);
      else { if (action === 'pause') await pauseInstaller(); else await cancelInstaller(); setLocal(await installerStatus()); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '更新操作未完成，请重试。'); }
    finally { setOpening(false); }
  };
  const progress = installerProgressText(task);
  const primary: InstallerAction = ready ? 'install' : active ? 'pause' : pending ? 'resume' : 'download';
  const primaryLabel = busy ? '正在处理…' : ready ? '安装更新' : processing ? '正在准备…' : active ? '暂停下载' : pending ? '继续下载' : full ? '后台下载' : '更新';
  const compactLabel = ready ? '更新已准备好' : !pending ? '有可用更新' : task.phase === 'paused' ? '更新已暂停'
    : task.phase === 'error' ? '更新待重试' : task.phase === 'waiting' ? '更新等待网络' : task.phase === 'verifying' ? '更新校验中'
      : processing || task.phase === 'preparing' ? '更新准备中' : '更新下载中';
  if (collapsed) return <aside className="app-update-compact" aria-label="更新任务">
    <button type="button" onClick={onExpand} aria-label={`查看更新 v${release.version}：${progress}`}>
      <span>{compactLabel}</span>
      <span className="app-update-compact-detail">{pending && !ready && task.totalBytes > 0 ? `${Math.min(100, Math.floor(task.downloadedBytes / task.totalBytes * 100))}% · ` : ''}v{release.version}<span aria-hidden="true"> ›</span></span>
    </button>
  </aside>;
  return (
    <aside className={`app-update-card${expanded ? ' is-expanded' : ''}`} aria-labelledby="app-update-title" data-testid="app-update-card">
      <div className="app-update-visual">
        <img className="app-update-art" src={artwork} alt="" aria-hidden="true" />
        <div className="app-update-shade" />
        <div className="app-update-content">
          <header className="app-update-header">
            <h2 id="app-update-title">ReadAge<span>.</span></h2>
            <span className="app-update-version">v{release.version}</span>
            <button type="button" className="app-update-details" aria-expanded={expanded} aria-controls="app-update-notes" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '详情'}</button>
          </header>
          <div id="app-update-notes" className={`app-update-notes${expanded ? '' : ' is-compact'}`} tabIndex={expanded ? 0 : undefined} aria-label="版本更新内容">
            <ul>{(expanded ? release.notes : release.notes.slice(0, 2)).map((note, index) => <li key={index}>{note}</li>)}</ul>
          </div>
        </div>
      </div>
      <div className="app-update-footer">
        {full && <>
          <p role="status" className="app-update-progress">{progress}</p>
          {pending && !ready && !processing && task.totalBytes > 0 && <progress className="app-update-meter" aria-label="更新下载进度" max={task.totalBytes} value={Math.min(task.totalBytes, task.downloadedBytes)} />}
          {task?.fallbackReason && <p className="app-update-progress">{task.fallbackReason}</p>}
        </>}
        {!CAN_INSTALL_IN_APP && <p className="app-update-progress">请使用最新版完整安装包更新本机 ReadAge 服务，原学习数据保留。</p>}
        {(actionError || error) && <p role="alert" className="app-update-error">{actionError || error}</p>}
        <div className="app-update-actions">
          <button type="button" onClick={() => { void act(primary); }} disabled={busy || processing}>{primaryLabel}</button>
          <button type="button" disabled={busy} onClick={pending ? onCollapse || onDecline : onDecline}>{ready ? '稍后安装' : pending ? '继续阅读' : '暂不更新'}</button>
        </div>
        {pending && !ready && <div className="app-update-task-tools">
          {confirmCancel ? <>
            <p>取消后会清除本次下载进度。</p>
            <button type="button" disabled={busy} onClick={() => { void act('cancel'); }}>确认取消</button>
            <button type="button" onClick={() => setConfirmCancel(false)}>保留下载</button>
          </> : <button type="button" disabled={busy} onClick={() => setConfirmCancel(true)}>取消这次下载</button>}
        </div>}
      </div>
    </aside>
  );
};

export function AppUpdateNotice({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="app-update-notice"><p role="status">{message}</p><button type="button" onClick={onClose} aria-label="关闭更新提示"><X size={18} /></button></div>;
}

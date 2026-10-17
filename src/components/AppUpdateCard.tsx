import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { UpdateState } from '../lib/appUpdateController';
import { CAN_INSTALL_IN_APP, downloadInstaller, installerStatus, installInstaller, type InstallerStatus } from '../lib/installerUpdates';
import artwork from '../../website/assets/wisdom.png';

interface AppUpdateCardProps {
  available: NonNullable<UpdateState['available']>;
  onDecline: () => void;
  onUpdate?: () => Promise<void>;
}
export const AppUpdateCard: React.FC<AppUpdateCardProps> = ({ available, onDecline, onUpdate }) => {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [installer, setInstaller] = useState<InstallerStatus | null>(null);
  const request = useRef<AbortController | null>(null);
  const { release } = available;
  const full = CAN_INSTALL_IN_APP && !!release.installer;
  const installerReady = full && installer?.phase === 'ready' && installer.version === release.version;
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => {
    if (!full) return;
    let active = true;
    void installerStatus().then(status => { if (active) setInstaller(status); }).catch(() => {});
    return () => { active = false; };
  }, [full, release.version]);
  useEffect(() => {
    if (!opening) return;
    const timer = window.setInterval(() => {
      if (full) void installerStatus().then(setInstaller).catch(() => {});
    }, 750);
    return () => window.clearInterval(timer);
  }, [opening, full]);
  const update = async () => {
    setOpening(true); setError('');
    const controller = new AbortController(); request.current = controller;
    try {
      if (onUpdate) await onUpdate();
      else if (full) {
        if (installerReady) await installInstaller(release.version);
        else setInstaller(await downloadInstaller(release.version, controller.signal));
      }
      else throw new Error(CAN_INSTALL_IN_APP ? '此版本尚未提供应用内安装包，请稍后重新检查更新。' : '请使用最新版完整安装包更新本机 ReadAge 服务，原学习数据保留。');
    } catch (failure) {
      setError(controller.signal.aborted ? '下载已取消，当前版本和学习记录保留。' : failure instanceof Error ? failure.message : '更新失败，请重试。');
    } finally { if (request.current === controller) request.current = null; setOpening(false); }
  };
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
        {full && <p role="status" className="app-update-progress">{installerReady ? '安装包已校验。安装前会保存学习记录，再打开系统安装器。' : opening ? `正在下载 ${(installer?.downloadedBytes / 1024 / 1024 || 0).toFixed(1)} / ${(installer?.totalBytes / 1024 / 1024 || 0).toFixed(1)} MB` : '在应用内下载最新版完整安装包并校验，原学习数据保留。'}</p>}
        {!CAN_INSTALL_IN_APP && <p className="app-update-progress">请使用最新版完整安装包更新本机 ReadAge 服务，原学习数据保留。</p>}
        {error && <p role="alert" className="app-update-error">{error}</p>}
        <div className="app-update-actions">
          <button type="button" onClick={() => { void update(); }} disabled={opening} title="使用最新版完整安装包更新">{opening ? installerReady ? '正在启动安装…' : '正在准备…' : installerReady ? '安装更新' : full ? '下载更新' : '更新'}</button>
          <button type="button" disabled={opening && installerReady} onClick={() => { if (opening && full) request.current?.abort(); else onDecline(); }}>{opening && full && !installerReady ? '取消下载' : installerReady ? '稍后安装' : '暂不更新'}</button>
        </div>
      </div>
    </aside>
  );
};

export function AppUpdateNotice({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="app-update-notice"><p role="status">{message}</p><button type="button" onClick={onClose} aria-label="关闭更新提示"><X size={18} /></button></div>;
}

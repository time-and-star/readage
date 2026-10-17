import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { UpdateState } from '../lib/appUpdateController';
import { openAppDownload } from '../lib/appUpdates';
import artwork from '../../website/assets/wisdom.png';
import { preparePatch, patchStatus, activatePatch, type PatchStatus } from '../lib/webPatches';

interface AppUpdateCardProps {
  available: NonNullable<UpdateState['available']>;
  onDecline: () => void;
  onUpdate?: () => Promise<void>;
}
export const AppUpdateCard: React.FC<AppUpdateCardProps> = ({ available, onDecline, onUpdate }) => {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState<PatchStatus | null>(null);
  const [prepared, setPrepared] = useState('');
  const request = useRef<AbortController | null>(null);
  const { release, current } = available;
  const small = !!release.bundle && release.bundle.runtime === current.runtime && release.bundle.revision > Math.max(current.revision || 0, current.rejectedRevision || 0);
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => {
    if (!small) return;
    let active = true;
    void patchStatus().then(saved => { if (active && !request.current && saved.pendingRevision === release.bundle.revision) setPrepared(saved.pending || ''); });
    return () => { active = false; };
  }, [small, release.bundle?.revision]);
  useEffect(() => {
    if (!opening || !small) return;
    const timer = window.setInterval(() => { void patchStatus().then(setProgress); }, 750);
    return () => window.clearInterval(timer);
  }, [opening, small]);
  const update = async () => {
    setOpening(true); setError('');
    const controller = new AbortController(); request.current = controller;
    try {
      if (onUpdate) await onUpdate();
      else if (!small) await openAppDownload();
      else if (prepared) await activatePatch(prepared);
      else {
        const saved = await patchStatus();
        const result = saved.pending && saved.pendingRevision === release.bundle.revision ? saved : await preparePatch(release.bundle.revision, controller.signal);
        if (!controller.signal.aborted) { setProgress(result); setPrepared(result.pending || ''); }
      }
    } catch (failure) {
      setError(controller.signal.aborted ? '下载已取消，当前版本和学习记录保留。' : small ? failure instanceof Error ? failure.message : '小更新失败，请重试。' : '无法打开下载页，请稍后重试。');
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
            <span className="app-update-version">v{small ? release.bundle.version : release.version}</span>
            <button type="button" className="app-update-details" aria-expanded={expanded} aria-controls="app-update-notes" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '详情'}</button>
          </header>
          <div id="app-update-notes" className={`app-update-notes${expanded ? '' : ' is-compact'}`} tabIndex={expanded ? 0 : undefined} aria-label="版本更新内容">
            <ul>{(expanded ? release.notes : release.notes.slice(0, 2)).map((note, index) => <li key={index}>{note}</li>)}</ul>
          </div>
        </div>
      </div>
      <div className="app-update-footer">
        {small && <p role="status" className="app-update-progress">{prepared ? '更新已准备好，保存学习进度后即可切换。' : opening ? `正在准备 ${progress?.completed || 0}/${progress?.total || '…'} · 已下载 ${((progress?.downloadedBytes || 0) / 1024 / 1024).toFixed(1)} MB` : '仅下载变化文件，保留已有模型、词典和学习记录。'}</p>}
        {!small && release.bundle && <p className="app-update-progress">此版本需要更新应用外壳，请下载安装更新。</p>}
        {error && <p role="alert" className="app-update-error">{error}</p>}
        <div className="app-update-actions">
          <button type="button" onClick={() => { void update(); }} disabled={opening} title={small ? '只更新变化的文件' : '打开官网下载页'}>{opening ? small ? '正在准备…' : '正在打开…' : prepared ? '重启更新' : small ? '下载小更新' : '更新'}</button>
          <button type="button" disabled={opening && !!prepared} onClick={() => { if (opening && small) request.current?.abort(); else onDecline(); }}>{opening && small && !prepared ? '取消下载' : prepared ? '稍后重启' : '暂不更新'}</button>
        </div>
      </div>
    </aside>
  );
};

export function AppUpdateNotice({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="app-update-notice"><p role="status">{message}</p><button type="button" onClick={onClose} aria-label="关闭更新提示"><X size={18} /></button></div>;
}

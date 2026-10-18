import { useEffect, useRef, useState } from 'react';
import { APP_VERSION, installedAppVersion, loadAppUpdates } from './appUpdates';
import { AppUpdateController } from './appUpdateController';
import { startAppUpdateChecks } from './appUpdateSchedule';
import { CAN_INSTALL_IN_APP, installerStatus, downloadInstaller, pauseInstaller, resumeInstaller, cancelInstaller,
  installInstaller, type InstallerStatus, type InstallerAction } from './installerUpdates';
import { localInstallerOffer, withRequestedInstallerRelease } from './installerTask';
import type { UpdateRelease } from '../../website/update-protocol.mjs';

export function useAppUpdates() {
  const [controller] = useState(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch {}
    return new AppUpdateController({ current: APP_VERSION, installed: installedAppVersion, load: loadAppUpdates, storage });
  });
  const [state, setState] = useState(controller.state);
  const [installer, setInstaller] = useState<InstallerStatus | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState('');
  const acting = useRef(false);
  const revision = useRef(0);
  const requestedRelease = useRef<UpdateRelease | undefined>(undefined);
  const acceptStatus = (value: InstallerStatus) => {
    if (value.phase === 'idle') requestedRelease.current = undefined;
    setInstaller(withRequestedInstallerRelease(value, requestedRelease.current));
  };
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setState(controller.state));
    const stop = startAppUpdateChecks(controller);
    return () => {
      unsubscribe(); stop(); controller.cancel();
    };
  }, [controller]);
  useEffect(() => {
    if (!CAN_INSTALL_IN_APP) return;
    let active = true, pending = false, first = true;
    const refresh = async () => {
      if (pending || acting.current) return;
      pending = true; const generation = revision.current;
      try {
        const value = await installerStatus();
        if (active && generation === revision.current) {
          acceptStatus(value);
          if (first && value.phase !== 'idle') setCollapsed(true);
          first = false;
        }
      } catch { /* A missing old bridge must not disturb reading or online checks. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  const localOffer = localInstallerOffer(installer, state.current);
  const available = localOffer || state.available;
  const act = async (action: InstallerAction, version: string) => {
    if (acting.current) return;
    acting.current = true; ++revision.current; setWorking(true); setActionError('');
    try {
      if (action === 'download') {
        const release = available?.release;
        const value = await downloadInstaller(version, undefined, release?.installer
          ? { build: release.build, sha256: release.installer.sha256 } : undefined);
        requestedRelease.current = release;
        acceptStatus(value);
      }
      else if (action === 'resume') acceptStatus(await resumeInstaller());
      else if (action === 'pause') { await pauseInstaller(); acceptStatus(await installerStatus()); }
      else if (action === 'cancel') { await cancelInstaller(); acceptStatus(await installerStatus()); }
      else await installInstaller(version);
      if (action === 'download' || action === 'resume') setCollapsed(true);
    } catch (error) { setCollapsed(false); setActionError(error instanceof Error ? error.message : '更新操作未完成，请重试。'); }
    finally { acting.current = false; setWorking(false); }
  };
  return { ...state, available, installer, collapsed, working, actionError, act,
    check: () => { setCollapsed(false); setActionError(''); if (!localOffer) void controller.check(true); },
    collapse: () => setCollapsed(true), expand: () => setCollapsed(false),
    decline: () => { if (localOffer) setCollapsed(true); else controller.decline(); }, clearNotice: controller.clearNotice };
}

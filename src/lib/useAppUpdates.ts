import { useEffect, useState } from 'react';
import { APP_VERSION, installedAppVersion, loadAppUpdates } from './appUpdates';
import { AppUpdateController } from './appUpdateController';
import { startAppUpdateChecks } from './appUpdateSchedule';

export function useAppUpdates() {
  const [controller] = useState(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch {}
    return new AppUpdateController({ current: APP_VERSION, installed: installedAppVersion, load: loadAppUpdates, storage });
  });
  const [state, setState] = useState(controller.state);
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setState(controller.state));
    const stop = startAppUpdateChecks(controller);
    return () => {
      unsubscribe(); stop(); controller.cancel();
    };
  }, [controller]);
  return { ...state, check: () => { void controller.check(true); }, decline: controller.decline, clearNotice: controller.clearNotice };
}

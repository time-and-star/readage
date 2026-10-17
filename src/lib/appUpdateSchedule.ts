import type { AppUpdateController } from './appUpdateController';

/** Shared by browser, Electron and Android WebView; startup/reconnection bypass the success cooldown. */
export function startAppUpdateChecks(controller: AppUpdateController, browser = window, page = document, network = navigator) {
  let pending = true;
  const check = () => {
    if (page.visibilityState === 'hidden' || network.onLine === false) return;
    const force = pending; pending = false;
    void controller.check(false, force);
  };
  const reconnect = () => { pending = true; check(); };
  const startup = browser.setTimeout(reconnect, 8_000);
  const timer = browser.setInterval(check, 60_000);
  browser.addEventListener('focus', check);
  browser.addEventListener('online', reconnect);
  page.addEventListener('visibilitychange', check);
  return () => {
    browser.clearTimeout(startup); browser.clearInterval(timer);
    browser.removeEventListener('focus', check); browser.removeEventListener('online', reconnect);
    page.removeEventListener('visibilitychange', check);
  };
}

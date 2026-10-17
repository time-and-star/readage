import { isNewerRelease, updateIdentity, UPDATE_INTERVAL_MS, type InstalledVersion, type UpdateManifest, type UpdateRelease } from '../../website/update-protocol.mjs';

export const UPDATE_PREFERENCES_KEY = 'readage:app-updates:v1';
export interface UpdatePreferences { lastAttemptAt: number; lastSuccessAt?: number; declined: string }
export const UPDATE_RETRY_MS = 60_000;
export interface UpdateState {
  current: InstalledVersion;
  checking: boolean;
  available: { current: InstalledVersion; release: UpdateRelease } | null;
  notice: string | null;
}
type Dependencies = {
  current: InstalledVersion;
  installed: () => Promise<InstalledVersion>;
  load: (signal: AbortSignal) => Promise<UpdateManifest>;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
};
/** Scheduling and dismissal are independent of learning profiles, backups and progress. */
export class AppUpdateController {
  state: UpdateState;
  private preferences: UpdatePreferences = { lastAttemptAt: 0, declined: '' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort?: AbortController;
  private manualRequested = false;
  private reconnectRequested = false;
  constructor(private deps: Dependencies) {
    this.state = { current: deps.current, checking: false, available: null, notice: null };
    try {
      const value = JSON.parse(deps.storage?.getItem(UPDATE_PREFERENCES_KEY) || '{}');
      if (Number.isFinite(value.lastAttemptAt) && value.lastAttemptAt > 0) this.preferences.lastAttemptAt = value.lastAttemptAt;
      if (Number.isFinite(value.lastSuccessAt) && value.lastSuccessAt > 0) this.preferences.lastSuccessAt = value.lastSuccessAt;
      if (typeof value.declined === 'string' && value.declined.length < 100) this.preferences.declined = value.declined;
    } catch { /* Unavailable storage still permits checks and in-memory dismissal. */ }
  }
  private now() { return (this.deps.now || Date.now)(); }
  private save() { try { this.deps.storage?.setItem(UPDATE_PREFERENCES_KEY, JSON.stringify(this.preferences)); } catch {} }
  private emit(patch: Partial<UpdateState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  due() {
    const elapsed = this.now() - this.preferences.lastAttemptAt;
    const interval = this.preferences.lastSuccessAt === this.preferences.lastAttemptAt ? UPDATE_INTERVAL_MS : UPDATE_RETRY_MS;
    return !this.preferences.lastAttemptAt || elapsed < 0 || elapsed >= interval;
  }
  async check(manual = false, reconnect = false) {
    if (this.state.checking) { this.manualRequested ||= manual; this.reconnectRequested ||= reconnect; return; }
    if (!manual && !reconnect && !this.due()) return;
    const generation = ++this.generation;
    const controller = new AbortController(); this.abort = controller; const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), 25_000);
    let aborted: () => void;
    const interruption = new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true });
    });
    let succeeded = false;
    this.manualRequested = manual;
    this.preferences.lastAttemptAt = this.now(); this.preferences.lastSuccessAt = 0; this.save();
    this.emit({ checking: true, notice: null });
    try {
      const current = await Promise.race([this.deps.installed(), interruption]);
      signal.throwIfAborted();
      const manifest = await Promise.race([this.deps.load(signal), interruption]);
      if (generation !== this.generation) return;
      signal.throwIfAborted();
      succeeded = true; this.preferences.lastSuccessAt = this.preferences.lastAttemptAt; this.save();
      const release = manifest.releases[current.platform];
      if (isNewerRelease(release, current)) {
        this.emit({ current, available: this.manualRequested || this.preferences.declined !== updateIdentity(current.platform, release) ? { current, release } : null });
      } else this.emit({ current, available: null, notice: this.manualRequested ? release.bundle?.runtime === current.runtime && current.rejectedRevision
        ? '上次小更新未能正常使用，已保留可用版本。请等待后续修复更新。' : `当前已是最新版本 v${current.version}` : null });
    } catch {
      if (generation === this.generation && this.manualRequested) this.emit({ notice: '暂时无法检查更新，请确认网络后重试。' });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted!);
      if (generation === this.generation) {
        const retry = !succeeded && this.reconnectRequested;
        this.reconnectRequested = false; this.abort = undefined; this.emit({ checking: false });
        if (retry) void this.check(this.manualRequested, true);
      }
    }
  }
  decline = () => {
    const available = this.state.available;
    if (available) { this.preferences.declined = updateIdentity(available.current.platform, available.release); this.save(); }
    this.emit({ available: null });
  };
  clearNotice = () => this.emit({ notice: null });
  cancel() { ++this.generation; this.reconnectRequested = false; this.abort?.abort(); this.abort = undefined; this.emit({ checking: false }); }
}

import {
  DictionarySettingsError,
  dictionarySettingsEqual,
  type DictionarySettings,
  type DictionarySettingsSnapshot,
  type DictionarySettingsUpdate,
} from './dictionarySettingsClient';

export interface DictionaryAutosaveState {
  snapshot: DictionarySettingsSnapshot;
  settings: DictionarySettings;
  status: 'idle' | 'saving' | 'error' | 'conflict';
  message?: string;
  cacheWarning?: string;
}

interface AutosaveOptions {
  save: (update: DictionarySettingsUpdate) => Promise<DictionarySettingsSnapshot>;
  applyCatalog: (catalog: DictionarySettingsSnapshot['catalog']) => Promise<unknown>;
}

/** Serialize changes with the latest confirmed revision, coalescing edits made during a write. */
export class DictionarySettingsAutosave {
  private state: DictionaryAutosaveState;
  private pending?: Promise<void>;
  private listeners = new Set<(state: DictionaryAutosaveState) => void>();

  constructor(snapshot: DictionarySettingsSnapshot, private options: AutosaveOptions) {
    this.state = { snapshot, settings: snapshot.settings, status: 'idle' };
  }

  getSnapshot() { return this.state; }

  subscribe(listener: (state: DictionaryAutosaveState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(state: DictionaryAutosaveState) {
    this.state = state;
    this.listeners.forEach(listener => listener(state));
  }

  update(settings: DictionarySettings): Promise<void> {
    // A conflict needs an explicit reload; never overwrite another window's preferences blindly.
    if (this.state.status === 'conflict') return Promise.resolve();
    this.publish({ ...this.state, settings });
    return this.retry();
  }

  retry(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.state.status === 'conflict') return Promise.resolve();
    if (dictionarySettingsEqual(this.state.settings, this.state.snapshot.settings) && !this.state.snapshot.warning) {
      this.publish({ ...this.state, status: 'idle', message: undefined });
      return Promise.resolve();
    }
    this.publish({ ...this.state, status: 'saving', message: undefined });
    this.pending = Promise.resolve().then(() => this.drain()).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async drain() {
    while (!dictionarySettingsEqual(this.state.settings, this.state.snapshot.settings) || this.state.snapshot.warning) {
      const submitted = this.state.settings;
      let saved: DictionarySettingsSnapshot;
      try {
        saved = await this.options.save({ expectedRevision: this.state.snapshot.settings.revision,
          enabledSources: submitted.enabledSources, sourceOrder: submitted.sourceOrder, defaultSource: submitted.defaultSource });
      } catch (error) {
        const conflict = error instanceof DictionarySettingsError && error.status === 409;
        this.publish({ ...this.state, status: conflict ? 'conflict' : 'error',
          message: conflict ? '词典设置已在其他窗口修改，请重新加载。' : '设置未能保存，请重试。' });
        return;
      }
      this.publish({ ...this.state, snapshot: saved,
        settings: dictionarySettingsEqual(this.state.settings, submitted) ? saved.settings : this.state.settings,
        cacheWarning: undefined });
      try { await this.options.applyCatalog(saved.catalog); }
      catch { this.publish({ ...this.state, cacheWarning: '设置已保存，请刷新页面更新查词缓存。' }); }
    }
    this.publish({ ...this.state, status: 'idle', message: undefined });
  }
}

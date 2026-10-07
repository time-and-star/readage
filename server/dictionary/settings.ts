import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DictionaryServiceConfig } from '../../packages/dictionary/contracts';

export const DICTIONARY_SETTINGS_VERSION = 'dictionary-settings.v1' as const;

export interface DictionarySourceSettings {
  version: typeof DICTIONARY_SETTINGS_VERSION;
  revision: string;
  enabledSources: string[];
  sourceOrder: string[];
  defaultSource: string;
}
export interface DictionarySettingsUpdate {
  expectedRevision: string;
  enabledSources: string[];
  sourceOrder: string[];
  defaultSource: string;
}

export class DictionarySettingsError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: 'INVALID_SETTINGS' | 'SETTINGS_CONFLICT' | 'SETTINGS_STORAGE_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'DictionarySettingsError';
  }
}

type Selection = Pick<DictionarySourceSettings, 'enabledSources' | 'sourceOrder' | 'defaultSource'>;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const selectionRevision = (selection: Selection) => `settings:${digest(JSON.stringify([
  DICTIONARY_SETTINGS_VERSION, selection.enabledSources, selection.sourceOrder, selection.defaultSource,
]))}`;
const copy = (settings: DictionarySourceSettings): DictionarySourceSettings => ({ ...settings,
  enabledSources: [...settings.enabledSources], sourceOrder: [...settings.sourceOrder] });

function validateSelection(value: unknown, installedIds: readonly string[]): Selection {
  const selection = value as Selection;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(id => typeof id === 'string' && id.length > 0);
  if (!selection || !strings(selection.enabledSources) || !strings(selection.sourceOrder) || typeof selection.defaultSource !== 'string') {
    throw new DictionarySettingsError(400, 'INVALID_SETTINGS', 'Dictionary settings require enabled sources, a complete source order and a default source.');
  }
  if (!selection.enabledSources.length || new Set(selection.enabledSources).size !== selection.enabledSources.length) {
    throw new DictionarySettingsError(400, 'INVALID_SETTINGS', 'Enable at least one dictionary; duplicate sources are not allowed.');
  }
  if (selection.sourceOrder.length !== installedIds.length || new Set(selection.sourceOrder).size !== installedIds.length ||
      selection.sourceOrder.some(id => !installedIds.includes(id)) || selection.enabledSources.some(id => !installedIds.includes(id))) {
    throw new DictionarySettingsError(400, 'INVALID_SETTINGS', 'The source order must contain every installed dictionary exactly once.');
  }
  if (!selection.enabledSources.includes(selection.defaultSource)) {
    throw new DictionarySettingsError(400, 'INVALID_SETTINGS', 'The default dictionary must be enabled.');
  }
  return { enabledSources: [...selection.enabledSources], sourceOrder: [...selection.sourceOrder], defaultSource: selection.defaultSource };
}

/** Persistent application configuration. Dictionary contracts and learning storage stay independent. */
export class DictionarySettingsManager {
  private current: DictionarySourceSettings;
  private readonly installedIds: string[];
  private queued: Promise<unknown> = Promise.resolve();
  private warning?: string;
  private savedPreferences = false;
  private updateInProgress = false;
  private loadedValidSettings = false;

  constructor(private readonly options: {
    installedIds: readonly string[];
    startupConfig: DictionaryServiceConfig;
    settingsFile?: string;
    /** Prepare before writing, so a failed adapter/configuration cannot replace a working file. */
    prepareApply: (settings: DictionarySourceSettings) => () => void;
  }) {
    this.installedIds = [...options.installedIds];
    if (!this.installedIds.length || new Set(this.installedIds).size !== this.installedIds.length) throw new Error('Installed dictionary IDs must be unique and nonempty.');
    const requestedOrder = options.startupConfig.sourceOrder ?? this.installedIds;
    let initial: Selection;
    let startupError: unknown;
    try {
      initial = validateSelection({
        sourceOrder: [...requestedOrder, ...this.installedIds.filter(id => !requestedOrder.includes(id))],
        enabledSources: [...(options.startupConfig.enabledSources ?? this.installedIds)],
        defaultSource: options.startupConfig.defaultSource ?? options.startupConfig.enabledSources?.[0] ?? this.installedIds[0],
      }, this.installedIds);
    } catch (error) {
      startupError = error;
      initial = { sourceOrder: [...this.installedIds], enabledSources: [...this.installedIds], defaultSource: this.installedIds[0] };
    }
    this.current = { version: DICTIONARY_SETTINGS_VERSION, revision: selectionRevision(initial), ...initial };
    if (options.settingsFile) this.load(options.settingsFile);
    // Valid saved preferences have precedence even when old startup IDs no longer exist.
    if (startupError && !this.loadedValidSettings) throw startupError;
  }

  private load(file: string) {
    let bytes: Buffer | undefined;
    try {
      if (fs.statSync(file).size > 65536) throw new Error('The settings file exceeds the supported size.');
      this.savedPreferences = true;
      bytes = fs.readFileSync(file);
      const saved = JSON.parse(bytes.toString('utf8'));
      if (saved?.version !== DICTIONARY_SETTINGS_VERSION || typeof saved.revision !== 'string' || !saved.revision) throw new Error('Unsupported settings file.');
      // Validate the original installation first, then reconcile a changed installation.
      const original = validateSelection(saved, Array.isArray(saved.sourceOrder) ? saved.sourceOrder : []);
      const sourceOrder = original.sourceOrder.filter(id => this.installedIds.includes(id));
      sourceOrder.push(...this.installedIds.filter(id => !sourceOrder.includes(id)));
      const enabledSources = original.enabledSources.filter(id => this.installedIds.includes(id));
      if (!enabledSources.length) enabledSources.push(sourceOrder[0]);
      const defaultSource = enabledSources.includes(original.defaultSource) ? original.defaultSource : enabledSources[0];
      const reconciled = validateSelection({ sourceOrder, enabledSources, defaultSource }, this.installedIds);
      this.loadedValidSettings = true;
      this.current = { version: DICTIONARY_SETTINGS_VERSION, revision: selectionRevision(reconciled), ...reconciled };
      if (JSON.stringify(original) !== JSON.stringify(reconciled)) {
        this.warning = 'Installed dictionaries changed. Saved preferences were matched to the available installation; review and save the updated settings.';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      this.savedPreferences = true;
      this.warning = 'Saved dictionary settings could not be read. Startup preferences are active; saving reviewed settings will replace the unreadable file.';
      // Two clients repairing the same malformed file still use an explicit revision.
      this.current.revision = `unreadable:${digest(bytes ?? Buffer.from(this.current.revision))}`;
    }
  }

  snapshot(): { settings: DictionarySourceSettings; warning?: string } {
    return { settings: copy(this.current), ...(this.warning ? { warning: this.warning } : {}) };
  }
  get hasSavedPreferences(): boolean { return this.savedPreferences; }
  assertCanRegister(): void {
    if (this.updateInProgress) throw new Error('Dictionary registration must wait for the current settings save to finish.');
  }

  /** Adapter registration stays usable after configuration changes. New sources start disabled for a saved/explicit configuration. */
  addSource(id: string, enabled: boolean): void {
    this.assertCanRegister();
    if (!id || this.installedIds.includes(id)) throw new Error(`Dictionary already registered or invalid: ${id}`);
    this.installedIds.push(id);
    const selection = { sourceOrder: [...this.current.sourceOrder, id],
      enabledSources: [...this.current.enabledSources, ...(enabled ? [id] : [])], defaultSource: this.current.defaultSource };
    const next = { version: DICTIONARY_SETTINGS_VERSION, revision: selectionRevision(selection), ...selection };
    try {
      const apply = this.options.prepareApply(next);
      apply();
      this.current = next;
    } catch (error) {
      this.installedIds.pop();
      throw error;
    }
  }

  update(value: unknown): Promise<DictionarySourceSettings> {
    // Serialize revision checks and disk writes so two tabs cannot both overwrite one revision.
    const operation = this.queued.then(async () => {
      const request = value as DictionarySettingsUpdate;
      if (!request || typeof request.expectedRevision !== 'string' || !request.expectedRevision) {
        throw new DictionarySettingsError(400, 'INVALID_SETTINGS', 'An expected settings revision is required.');
      }
      if (request.expectedRevision !== this.current.revision) {
        throw new DictionarySettingsError(409, 'SETTINGS_CONFLICT', 'Dictionary settings changed. Reload the current settings before saving.');
      }
      const selection = validateSelection(request, this.installedIds);
      const next = { version: DICTIONARY_SETTINGS_VERSION, revision: selectionRevision(selection), ...selection };
      this.updateInProgress = true;
      try {
        const apply = this.options.prepareApply(next);
        if (this.options.settingsFile) await this.persist(next, this.options.settingsFile);
        apply();
        this.current = next;
        this.warning = undefined;
        this.savedPreferences = true;
        return copy(next);
      } finally { this.updateInProgress = false; }
    });
    this.queued = operation.catch(() => {});
    return operation;
  }

  /** Import is a queued registry/configuration transaction. Failed persistence never enables the new source. */
  installSource(id: string, register: () => () => void): Promise<DictionarySourceSettings> {
    const operation = this.queued.then(async () => {
      if (!id || this.installedIds.includes(id)) throw new DictionarySettingsError(400, 'INVALID_SETTINGS', 'Dictionary is already installed.');
      this.updateInProgress = true;
      let rollback: (() => void) | undefined;
      let appended = false;
      try {
        rollback = register();
        this.installedIds.push(id); appended = true;
        const selection = { enabledSources: [...this.current.enabledSources, id], sourceOrder: [...this.current.sourceOrder, id],
          defaultSource: this.current.defaultSource };
        const next = { version: DICTIONARY_SETTINGS_VERSION, revision: selectionRevision(selection), ...selection };
        const apply = this.options.prepareApply(next);
        if (this.options.settingsFile) await this.persist(next, this.options.settingsFile);
        apply(); this.current = next; this.warning = undefined; this.savedPreferences = true;
        return copy(next);
      } catch (error) {
        if (appended) this.installedIds.pop();
        rollback?.();
        throw error;
      } finally { this.updateInProgress = false; }
    });
    this.queued = operation.catch(() => {});
    return operation;
  }

  private async persist(settings: DictionarySourceSettings, target: string): Promise<void> {
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      await fs.promises.mkdir(directory, { recursive: true });
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Rename within the same directory atomically replaces the old snapshot.
      await fs.promises.rename(temporary, target);
    } catch {
      throw new DictionarySettingsError(503, 'SETTINGS_STORAGE_UNAVAILABLE', 'Dictionary settings could not be saved. The current configuration is unchanged.');
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temporary).catch(() => {});
    }
  }
}

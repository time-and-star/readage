/** Minimal types for the Chrome APIs used by this extension (no runtime dependency). */
interface ExtensionTab { id?: number; url?: string }
interface ExtensionSender { id?: string; url?: string; tab?: ExtensionTab; frameId?: number }
declare const chrome: {
  runtime: {
    id: string; getURL(path: string): string;
    sendMessage<T = any>(message: unknown): Promise<T>;
    onMessage: { addListener(listener: (message: any, sender: ExtensionSender, respond: (value: unknown) => void) => boolean | void): void };
    onInstalled: { addListener(listener: (details?: { reason?: string }) => void): void };
    onStartup: { addListener(listener: () => void): void };
  };
  storage: { local: {
    get(keys?: string | string[] | null): Promise<Record<string, any>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
    setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
  } };
  permissions: {
    contains(options: { origins: string[] }): Promise<boolean>;
    request(options: { origins: string[] }): Promise<boolean>;
    onRemoved: { addListener(listener: () => void): void };
  };
  tabs: {
    query(options: { active?: boolean; currentWindow?: boolean; url?: string }): Promise<ExtensionTab[]>;
    create(options: { url: string }): Promise<ExtensionTab>;
    sendMessage<T = any>(tabId: number, message: unknown, options?: { frameId: number }): Promise<T>;
  };
  scripting: {
    getRegisteredContentScripts(): Promise<Array<{ id: string; matches?: string[] }>>;
    unregisterContentScripts(options: { ids: string[] }): Promise<void>;
    registerContentScripts(scripts: Array<{ id: string; matches: string[]; js: string[]; runAt: 'document_idle'; allFrames: false }>): Promise<void>;
    executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
  alarms: { create(name: string, options: { periodInMinutes: number }): Promise<void>;
    onAlarm: { addListener(listener: () => void): void } };
};

import type { LocalDatabaseTransport, LocalDatabaseCommand, LocalDatabaseResponse } from './localDatabaseTransport';

export interface NativeDatabasePlugin {
  request(options: { command: LocalDatabaseCommand; body?: unknown }): Promise<LocalDatabaseResponse>;
}

/** A cancelled receipt does not cancel a native transaction already saving on disk. */
export function createNativeDatabaseTransport(plugin: NativeDatabasePlugin): LocalDatabaseTransport {
  return {
    kind: 'native',
    request(command, body, signal) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new DOMException('操作已取消', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        plugin.request({ command, ...(body === undefined ? {} : { body }) }).then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', abort));
      });
    },
  };
}

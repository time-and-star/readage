import { LOCAL_DATA_API, LOCAL_DATA_HEADER } from '../localDatabaseProtocol';

/** Shared commands; Android implements these against its own SQLite file. */
export const LOCAL_DATABASE_COMMANDS = [
  'status', 'profiles', 'bootstrap', 'query', 'settings-since', 'commit',
  'operation', 'snapshot', 'previous-snapshot', 'restore',
] as const;
export type LocalDatabaseCommand = typeof LOCAL_DATABASE_COMMANDS[number];
export interface LocalDatabaseResponse { status: number; body: Record<string, unknown> }
export interface LocalDatabaseTransport {
  readonly kind: 'http' | 'native';
  request(command: LocalDatabaseCommand, body?: unknown, signal?: AbortSignal): Promise<LocalDatabaseResponse>;
}

const environment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const nativeRequired = environment?.VITE_APP_PLATFORM === 'android';
let configured: LocalDatabaseTransport | undefined;
let started = false;

/** Register the Android adapter before initializeLocalDatabase hydrates the UI. */
export function configureLocalDatabaseTransport(transport: LocalDatabaseTransport): void {
  if (started) throw new Error('读取学习档案后不能切换数据库，请重新启动应用。');
  if (nativeRequired && transport.kind !== 'native') throw new Error('Android 必须使用手机本机数据库。');
  configured = transport;
}

export function usesNativeLocalDatabase(): boolean {
  return nativeRequired || configured?.kind === 'native';
}

export function createHttpLocalDatabaseTransport(fetcher?: typeof fetch): LocalDatabaseTransport {
  return {
    kind: 'http',
    async request(command, body, signal) {
      if (!LOCAL_DATABASE_COMMANDS.includes(command)) throw new Error('不支持的数据库操作。');
      const response = await (fetcher ?? globalThis.fetch)(`${LOCAL_DATA_API}/${command}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { [LOCAL_DATA_HEADER]: '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', signal,
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

export function resolveLocalDatabaseTransport(
  transport: LocalDatabaseTransport | undefined, requireNative: boolean,
): LocalDatabaseTransport {
  if (requireNative && transport?.kind !== 'native') throw new Error('手机本地数据库尚未接入，学习记录读取已停止。');
  return transport ?? createHttpLocalDatabaseTransport();
}

/** Never substitute browser storage or a PC connection for a missing native database. */
export async function requestLocalDatabase(
  command: string, body?: unknown, signal?: AbortSignal,
): Promise<LocalDatabaseResponse> {
  if (!LOCAL_DATABASE_COMMANDS.includes(command as LocalDatabaseCommand)) throw new Error('不支持的数据库操作。');
  configured = resolveLocalDatabaseTransport(configured, nativeRequired);
  started = true;
  signal?.throwIfAborted();
  // Native implementations must honor cancellation and acknowledge committed writes
  // with the existing operationId, including when the activity is interrupted.
  const result = await configured.request(command as LocalDatabaseCommand, body, signal);
  if (!Number.isInteger(result?.status) || result.status < 100 || result.status > 599
    || !result.body || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw new Error('本地数据库返回了无效结果，原有记录已保留。');
  }
  return result;
}

import type { ChildProcess } from 'node:child_process';
import { ensureLocalHyMt2, getHyMt2LaunchConfiguration, launchHyMt2 } from '../../scripts/hymt2-service.mjs';
import { stopChild } from '../../scripts/local-process.mjs';

export type LocalTranslationStartupState = 'disabled' | 'starting' | 'ready' | 'error' | 'stopped';

/** The ordinary app entry owns only the model process it starts itself. */
export function createLocalTranslationStartup(options: {
  environment?: NodeJS.ProcessEnv;
  ensure?: typeof ensureLocalHyMt2;
  launch?: () => ChildProcess;
  log?: (message: string) => void;
} = {}) {
  const environment = options.environment ?? process.env;
  const controller = new AbortController();
  let state: LocalTranslationStartupState = environment.TRANSLATION_LOCAL_ENGINE === 'hymt2' ? 'starting' : 'disabled';
  let message: string | undefined;
  let child: ChildProcess | null = null;
  let pending: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const failed = (error: unknown) => {
    if (controller.signal.aborted) return;
    state = 'error';
    message = error instanceof Error ? error.message : '本机翻译模型启动失败。';
  };

  return {
    status: () => ({ state, ...(message ? { message } : {}) }),
    start(): Promise<void> {
      if (state === 'disabled' || controller.signal.aborted) return Promise.resolve();
      if (pending) return pending;
      pending = (async () => {
        const configuration = getHyMt2LaunchConfiguration(environment);
        const result = await (options.ensure ?? ensureLocalHyMt2)({
          baseUrl: configuration.baseUrl,
          signal: controller.signal,
          launch: options.launch ?? (() => launchHyMt2(configuration)),
          log: options.log ?? console.log,
        });
        child = result.child;
        controller.signal.throwIfAborted();
        child?.once('error', failed);
        child?.once('exit', code => failed(new Error(`本机翻译模型已退出（${code}），请重新启动应用。`)));
        state = 'ready';
      })().catch(error => { failed(error); throw error; });
      return pending;
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      controller.abort(new Error('应用已关闭，停止本机翻译模型。'));
      stopping = (async () => {
        await pending?.catch(() => {});
        await stopChild(child);
        state = 'stopped';
      })();
      return stopping;
    },
  };
}

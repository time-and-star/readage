// This module is imported only by the Android platform entry point. core-js
// keeps working native implementations and supplies the standard clone algorithm
// (including cycles, dates and typed data) rather than a lossy JSON replacement.
import 'core-js/actual/array/at';
import 'core-js/actual/string/at';
import 'core-js/actual/typed-array/at';
import 'core-js/actual/object/has-own';

const MAX_TIMER_DELAY = 2_147_483_647;

/** Android 12 can ship WebView 91 even though the native app targets Android 16. */
export async function installAndroidWebViewCompatibility(): Promise<void> {
  // core-js also repairs cloning quirks in some existing implementations. Here
  // retain every native implementation and load the fallback only when absent.
  if (typeof globalThis.structuredClone !== 'function') await import('core-js/actual/structured-clone');
  const Signal = globalThis.AbortSignal;
  const Controller = globalThis.AbortController;
  if (typeof Signal !== 'function' || typeof Controller !== 'function') {
    throw new Error('手机网页组件缺少操作取消支持，请重新安装完整版本。');
  }

  if (!('reason' in Signal.prototype)) {
    const reasons = new WeakMap<AbortSignal, unknown>();
    const abort = Controller.prototype.abort;
    const defaultReason = () => new DOMException('This operation was aborted', 'AbortError');
    Object.defineProperty(Signal.prototype, 'reason', {
      configurable: true,
      get(this: AbortSignal): unknown {
        if (!(this instanceof Signal)) throw new TypeError('Invalid AbortSignal receiver');
        if (!this.aborted) return undefined;
        // Signals aborted by fetch or before installation still have the standard
        // default reason, kept stable across repeated reads.
        if (!reasons.has(this)) reasons.set(this, defaultReason());
        return reasons.get(this);
      },
    });
    Object.defineProperty(Controller.prototype, 'abort', {
      configurable: true, writable: true,
      value: function (this: AbortController, reason?: unknown): void {
        const signal = this.signal;
        // Record before native dispatch: abort listeners must see the same reason.
        // A repeated abort never changes the original cancellation reason.
        if (!signal.aborted) reasons.set(signal, reason === undefined ? defaultReason() : reason);
        abort.call(this);
      },
    });
    // Older static abort implementations also ignore their reason argument.
    Object.defineProperty(Signal, 'abort', {
      configurable: true, writable: true,
      value: (reason?: unknown): AbortSignal => {
        const controller = new Controller(); controller.abort(reason); return controller.signal;
      },
    });
  }

  if (typeof Signal.prototype.throwIfAborted !== 'function') {
    Object.defineProperty(Signal.prototype, 'throwIfAborted', {
      configurable: true, writable: true,
      value: function (this: AbortSignal): void {
        if (!(this instanceof Signal)) throw new TypeError('Invalid AbortSignal receiver');
        if (this.aborted) throw this.reason;
      },
    });
  }

  if (typeof Signal.timeout !== 'function') {
    Object.defineProperty(Signal, 'timeout', {
      configurable: true, writable: true,
      value: (delay: number): AbortSignal => {
        // WebIDL [EnforceRange] unsigned long long: numeric conversion, truncate,
        // then range check. Unary + also rejects BigInt and Symbol arguments.
        const value = Math.trunc(+delay);
        if (!Number.isFinite(value) || value < 0 || value >= 2 ** 64) throw new TypeError('Invalid timeout duration');
        let remaining = value;
        const controller = new Controller();
        const schedule = () => {
          const chunk = Math.min(remaining, MAX_TIMER_DELAY);
          globalThis.setTimeout(() => {
            remaining -= chunk;
            if (remaining > 0) schedule();
            else controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
          }, chunk);
        };
        schedule(); return controller.signal;
      },
    });
  }

  if (typeof Signal.any !== 'function') {
    Object.defineProperty(Signal, 'any', {
      configurable: true, writable: true,
      value: (signals: Iterable<AbortSignal>): AbortSignal => {
        const sources = [...signals];
        // Validate the entire sequence before using an already-aborted source.
        for (const source of sources) if (!(source instanceof Signal)) throw new TypeError('Expected an AbortSignal');
        const controller = new Controller();
        for (const source of sources) if (source.aborted) {
          controller.abort(source.reason); return controller.signal;
        }
        const listeners = new Map<AbortSignal, () => void>();
        const detach = () => {
          listeners.forEach((listener, source) => source.removeEventListener('abort', listener));
          listeners.clear();
        };
        for (const source of sources) {
          if (listeners.has(source)) continue;
          const listener = () => { detach(); controller.abort(source.reason); };
          listeners.set(source, listener);
          source.addEventListener('abort', listener, { once: true });
        }
        return controller.signal;
      },
    });
  }

  const secureCrypto = globalThis.crypto;
  if (typeof secureCrypto?.randomUUID !== 'function') {
    if (typeof secureCrypto?.getRandomValues !== 'function') throw new Error('手机网页组件缺少安全随机数支持，学习记录无法开始保存。');
    Object.defineProperty(secureCrypto, 'randomUUID', {
      configurable: true, writable: true,
      value: (): `${string}-${string}-${string}-${string}-${string}` => {
        const bytes = new Uint8Array(16);
        secureCrypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    });
  }
}

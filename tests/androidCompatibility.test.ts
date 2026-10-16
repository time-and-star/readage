import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm, { type Context } from 'node:vm';
import { buildSync } from 'esbuild';

let bundled: string | undefined;
function productionBundle(): string {
  return bundled ??= buildSync({
    entryPoints: ['src/lib/platform/androidCompatibility.ts'], bundle: true, write: false,
    platform: 'browser', format: 'iife', globalName: 'ReadageCompatibility', target: 'chrome91',
  }).outputFiles[0].text;
}

interface Timer { callback: () => void; milliseconds: number }
async function oldWebView() {
  const timers = new Map<number, Timer>();
  let nextTimer = 0;
  const context = vm.createContext({
    DOMException,
    setTimeout(callback: () => void, milliseconds: number) {
      const handle = ++nextTimer; timers.set(handle, { callback, milliseconds }); return handle;
    },
    clearTimeout(handle: number) { timers.delete(handle); },
  });
  vm.runInContext(`
    delete globalThis.structuredClone;
    delete Array.prototype.at;
    delete String.prototype.at;
    delete Object.getPrototypeOf(Uint8Array.prototype).at;
    delete Object.hasOwn;
    class OldAbortSignal {
      constructor() { this.aborted = false; this.listeners = new Map(); this.added = 0; this.removed = 0; }
      addEventListener(type, listener, options) {
        if (type === 'abort') { this.listeners.set(listener, !!options?.once); this.added++; }
      }
      removeEventListener(type, listener) {
        if (type === 'abort') { this.listeners.delete(listener); this.removed++; }
      }
      dispatchAbort() {
        for (const [listener, once] of Array.from(this.listeners)) {
          if (once) this.listeners.delete(listener);
          if (typeof listener === 'function') listener.call(this, { type: 'abort', target: this });
          else listener.handleEvent({ type: 'abort', target: this });
        }
      }
    }
    class OldAbortController {
      constructor() { this.signal = new OldAbortSignal(); }
      abort() {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        this.signal.dispatchAbort();
      }
    }
    globalThis.AbortSignal = OldAbortSignal;
    globalThis.AbortController = OldAbortController;
    globalThis.crypto = {
      calls: 0,
      getRandomValues(bytes) {
        this.calls++;
        for (let index = 0; index < bytes.length; index++) bytes[index] = (128 + index * 17) & 255;
        return bytes;
      },
    };
  `, context);
  assert.equal(vm.runInContext(`typeof AbortSignal.timeout + ':' + typeof AbortSignal.any + ':' +
    typeof AbortSignal.prototype.throwIfAborted + ':' + typeof crypto.randomUUID + ':' + typeof structuredClone + ':' +
    typeof Array.prototype.at + ':' + typeof String.prototype.at + ':' + typeof Uint8Array.prototype.at + ':' + typeof Object.hasOwn`, context),
  Array(9).fill('undefined').join(':'));
  vm.runInContext(productionBundle(), context);
  await vm.runInContext('ReadageCompatibility.installAndroidWebViewCompatibility()', context);
  return { context, timers };
}
function evaluate<T>(context: Context, code: string): T { return vm.runInContext(code, context) as T; }

test('old WebView timeout aborts with TimeoutError and throwIfAborted throws the same reason', async () => {
  const { context, timers } = await oldWebView();
  evaluate(context, `globalThis.timed = AbortSignal.timeout(250);
    globalThis.timeoutEvents = 0;
    timed.addEventListener('abort', () => { timeoutEvents++; globalThis.eventReason = timed.reason; });
    timed.throwIfAborted();`);
  assert.equal(evaluate(context, 'timed.aborted'), false);
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0]; assert.equal(timer.milliseconds, 250);
  timer.callback();
  assert.equal(evaluate(context, 'timed.aborted'), true);
  assert.equal(evaluate(context, 'timeoutEvents'), 1);
  assert.equal(evaluate(context, 'timed.reason.name'), 'TimeoutError');
  assert.equal(evaluate(context, 'eventReason === timed.reason'), true);
  assert.equal(evaluate(context, `(() => { try { timed.throwIfAborted(); return false; } catch (error) { return error === timed.reason; } })()`), true);
});

test('timeout rejects invalid durations and chunks long delays without aborting early', async () => {
  const { context, timers } = await oldWebView();
  assert.equal(evaluate(context, `[-1, NaN, Infinity, 2 ** 64, 1n, Symbol('delay')].every(value => {
    try { AbortSignal.timeout(value); return false; } catch (error) { return error instanceof TypeError; }
  })`), true);
  assert.equal(timers.size, 0);
  evaluate(context, 'globalThis.longTimeout = AbortSignal.timeout(2_147_483_647 + 200)');
  const [handle, firstTimer] = [...timers][0];
  assert.equal(firstTimer.milliseconds, 2_147_483_647);
  timers.delete(handle); firstTimer.callback();
  assert.equal(evaluate(context, 'longTimeout.aborted'), false);
  const lastTimer = [...timers.values()][0]; assert.equal(lastTimer.milliseconds, 200);
  lastTimer.callback();
  assert.equal(evaluate(context, 'longTimeout.reason.name'), 'TimeoutError');
});

test('old controller preserves explicit reasons before synchronous listeners and never replaces the first reason', async () => {
  const { context } = await oldWebView();
  evaluate(context, `globalThis.controller = new AbortController();
    globalThis.reason = { operation: 'cancelled' };
    globalThis.seen = undefined;
    controller.signal.addEventListener('abort', () => { seen = controller.signal.reason; });
    controller.abort(reason);
    controller.abort({ operation: 'later' });`);
  assert.equal(evaluate(context, 'controller.signal.aborted'), true);
  assert.equal(evaluate(context, 'seen === reason && controller.signal.reason === reason'), true);
  assert.equal(evaluate(context, `(() => { try { controller.signal.throwIfAborted(); return false; } catch (error) { return error === reason; } })()`), true);
});

test('old controller supplies default AbortError and preserves null as an explicit reason', async () => {
  const { context } = await oldWebView();
  evaluate(context, `globalThis.defaultController = new AbortController();
    globalThis.nullController = new AbortController();
    defaultController.abort(); nullController.abort(null);`);
  assert.equal(evaluate(context, 'defaultController.signal.reason instanceof DOMException'), true);
  assert.equal(evaluate(context, 'defaultController.signal.reason.name'), 'AbortError');
  assert.equal(evaluate(context, 'nullController.signal.reason'), null);
  assert.equal(evaluate(context, `(() => { try { nullController.signal.throwIfAborted(); return false; } catch (error) { return error === null; } })()`), true);
  assert.equal(evaluate(context, `AbortSignal.abort('static reason').reason`), 'static reason');
  assert.equal(evaluate(context, `AbortSignal.abort().reason.name`), 'AbortError');
});

test('any follows the first source to abort and detaches listeners from all sources', async () => {
  const { context } = await oldWebView();
  evaluate(context, `globalThis.first = new AbortController(); globalThis.second = new AbortController();
    globalThis.combined = AbortSignal.any([first.signal, second.signal]);
    globalThis.anyEvents = 0;
    combined.addEventListener('abort', () => { anyEvents++; });`);
  assert.equal(evaluate(context, 'combined.aborted'), false);
  assert.equal(evaluate(context, 'first.signal.listeners.size'), 1);
  assert.equal(evaluate(context, 'second.signal.listeners.size'), 1);
  evaluate(context, `globalThis.winningReason = { source: 2 }; second.abort(winningReason); first.abort('too late');`);
  assert.equal(evaluate(context, 'combined.aborted && combined.reason === winningReason'), true);
  assert.equal(evaluate(context, 'anyEvents'), 1);
  assert.equal(evaluate(context, 'first.signal.listeners.size + second.signal.listeners.size'), 0);
  assert.ok(evaluate<number>(context, 'first.signal.removed') > 0);
  assert.ok(evaluate<number>(context, 'second.signal.removed') > 0);
});

test('any chooses the first already aborted input without retaining pending input listeners', async () => {
  const { context } = await oldWebView();
  evaluate(context, `globalThis.pending = new AbortController();
    globalThis.early = new AbortController(); globalThis.late = new AbortController();
    early.abort('first in iterable'); late.abort('second in iterable');
    globalThis.preAborted = AbortSignal.any(new Set([pending.signal, early.signal, late.signal]));
    globalThis.empty = AbortSignal.any([]);`);
  assert.equal(evaluate(context, 'preAborted.aborted'), true);
  assert.equal(evaluate(context, 'preAborted.reason'), 'first in iterable');
  assert.equal(evaluate(context, 'pending.signal.listeners.size + early.signal.listeners.size + late.signal.listeners.size'), 0);
  assert.equal(evaluate(context, 'empty.aborted'), false);
});

test('any validates every input before aborting and registers each duplicate source only once', async () => {
  const { context } = await oldWebView();
  evaluate(context, `globalThis.abortedSource = new AbortController(); abortedSource.abort('earlier');
    globalThis.duplicate = new AbortController();
    globalThis.duplicateAny = AbortSignal.any([duplicate.signal, duplicate.signal]);`);
  assert.equal(evaluate(context, 'duplicate.signal.added'), 1);
  assert.equal(evaluate(context, `(() => {
    try { AbortSignal.any([abortedSource.signal, {}]); return false; } catch (error) { return error instanceof TypeError; }
  })()`), true);
  evaluate(context, 'duplicate.abort(null)');
  assert.equal(evaluate(context, 'duplicateAny.aborted && duplicateAny.reason === null'), true);
  assert.equal(evaluate(context, 'duplicate.signal.listeners.size'), 0);
});

test('randomUUID uses secure random bytes with RFC 4122 version and variant bits', async () => {
  const { context } = await oldWebView();
  evaluate(context, `Math.random = () => { throw new Error('Insecure randomness'); };`);
  const uuid = evaluate<string>(context, 'crypto.randomUUID()');
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(evaluate(context, 'crypto.calls'), 1);
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => (128 + index * 17) & 255);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  assert.equal(uuid.replaceAll('-', ''), Buffer.from(bytes).toString('hex'));
});

test('structuredClone retains cycles, shared identity, Date, Map, Set, and independent binary data', async () => {
  const { context } = await oldWebView();
  evaluate(context, `globalThis.source = { date: new Date('2026-10-10T00:00:00Z'), map: new Map(), set: new Set(),
      buffer: new Uint8Array([0, 127, 255]).buffer, missing: undefined, invalid: NaN, infinite: Infinity, large: 42n };
    source.self = source; source.alias = source.date; source.map.set(source, source.date); source.set.add(source);
    globalThis.copy = structuredClone(source);`);
  assert.equal(evaluate(context, 'copy !== source && copy.self === copy && copy.alias === copy.date'), true);
  assert.equal(evaluate(context, 'copy.date instanceof Date && copy.date.getTime() === source.date.getTime()'), true);
  assert.equal(evaluate(context, 'copy.map instanceof Map && copy.map.get(copy) === copy.date'), true);
  assert.equal(evaluate(context, 'copy.set instanceof Set && copy.set.has(copy)'), true);
  assert.equal(evaluate(context, 'copy.buffer instanceof ArrayBuffer && copy.buffer !== source.buffer'), true);
  assert.deepEqual(Array.from(evaluate<Uint8Array>(context, 'new Uint8Array(copy.buffer)')), [0, 127, 255]);
  evaluate(context, 'new Uint8Array(copy.buffer)[0] = 99');
  assert.equal(evaluate(context, 'new Uint8Array(source.buffer)[0]'), 0);
  assert.equal(evaluate(context, `Object.hasOwn(copy, 'missing') && copy.missing === undefined && Number.isNaN(copy.invalid)
    && copy.infinite === Infinity && copy.large === 42n`), true);
});

test('array, string, and typed array at handle negative bounds and hasOwn ignores inherited keys', async () => {
  const { context } = await oldWebView();
  assert.equal(evaluate(context, `[1, 2, 3].at(-1)`), 3);
  assert.equal(evaluate(context, `[1, 2, 3].at(-4)`), undefined);
  assert.equal(evaluate(context, `Array.prototype.at.call({ 0: 'value', length: 1 }, -1)`), 'value');
  assert.equal(evaluate(context, `'abc'.at(-2)`), 'b');
  assert.equal(evaluate(context, `'abc'.at(3)`), undefined);
  assert.equal(evaluate(context, `new Uint8Array([10, 20]).at(-1)`), 20);
  assert.equal(evaluate(context, `new Float64Array([1.5, 2.5]).at(-2)`), 1.5);
  assert.equal(evaluate(context, `new Uint8Array([10, 20]).at(2)`), undefined);
  assert.equal(evaluate(context, `(() => {
    const value = Object.create({ inherited: true }); value.own = undefined; value.hasOwnProperty = null;
    const bare = Object.create(null); bare.own = 1;
    return Object.hasOwn(value, 'own') && !Object.hasOwn(value, 'inherited') && Object.hasOwn(bare, 'own');
  })()`), true);
});

test('modern realm retains native implementations across installation and repeated installation', async () => {
  const context = vm.createContext({ DOMException, AbortController, AbortSignal, structuredClone, crypto: webcrypto, setTimeout, clearTimeout });
  evaluate(context, `globalThis.original = { timeout: AbortSignal.timeout, any: AbortSignal.any,
    throwIfAborted: AbortSignal.prototype.throwIfAborted, abort: AbortController.prototype.abort,
    reason: Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get,
    uuid: crypto.randomUUID, clone: structuredClone, arrayAt: Array.prototype.at, stringAt: String.prototype.at,
    typedAt: Uint8Array.prototype.at, hasOwn: Object.hasOwn };`);
  vm.runInContext(productionBundle(), context);
  await evaluate(context, `ReadageCompatibility.installAndroidWebViewCompatibility()`);
  await evaluate(context, `ReadageCompatibility.installAndroidWebViewCompatibility()`);
  for (const [name, expression] of Object.entries({
    timeout: 'AbortSignal.timeout', any: 'AbortSignal.any', throwIfAborted: 'AbortSignal.prototype.throwIfAborted',
    abort: 'AbortController.prototype.abort', reason: "Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get",
    uuid: 'crypto.randomUUID', clone: 'structuredClone', arrayAt: 'Array.prototype.at', stringAt: 'String.prototype.at',
    typedAt: 'Uint8Array.prototype.at', hasOwn: 'Object.hasOwn',
  })) assert.equal(evaluate(context, `original.${name} === ${expression}`), true, name);
});

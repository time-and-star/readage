import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeSpeechAdapter, type NativeSpeechPlugin } from '../src/lib/platform/nativeSpeech';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const settings = { lang: 'en-US', rate: 1 };
type Progress = Parameters<NativeSpeechPlugin['addListener']>[1];

test('buffering hides estimated words until matching resumed audio advances the clock', async () => {
  const f = fixture(), received: Array<{ range: unknown; timing: unknown }> = [];
  const adapter = createNativeSpeechAdapter(f.plugin, { estimatedTimings: true });
  const playing = adapter.speak('hello world again', settings, (range, timing) => received.push({ range, timing }), new AbortController().signal);
  await tick(); const id = f.calls[0].id;
  f.progress({ id, type: 'buffering' }); assert.equal(received.length, 0);
  f.progress({ id, type: 'segment', start: 0, end: 11, startTime: 0, endTime: 2 });
  f.progress({ id, type: 'start' });
  f.progress({ id, type: 'position', time: 1 });
  f.progress({ id, type: 'buffering' });
  assert.deepEqual(received.at(-1), { range: undefined, timing: { buffering: true } });
  const count = received.length;
  f.progress({ id, type: 'buffering' });
  f.progress({ id, type: 'segment', start: 12, end: 17, startTime: 2, endTime: 3 });
  f.progress({ id, type: 'position', time: 2 });
  f.progress({ id: 'stale', type: 'resume', time: 2 });
  assert.equal(received.length, count);
  f.progress({ id, type: 'resume', time: 2.1 });
  assert.deepEqual(received.at(-2), { range: undefined, timing: { buffering: false } });
  assert.deepEqual(received.at(-1)?.range, { start: 12, end: 17, estimated: true });
  f.calls[0].resolve({ completed: true }); await playing;
  const finishedCount = received.length;
  f.progress({ id, type: 'resume', time: 2.5 }); assert.equal(received.length, finishedCount);
});

test('bundled progress follows actual audio position, estimates words per segment, and ignores stale events', async () => {
  const f = fixture(), progress: unknown[] = [], controller = new AbortController();
  const adapter = createNativeSpeechAdapter(f.plugin, { estimatedTimings: true });
  const speech = adapter.speak('hello world again', settings, range => progress.push(range), controller.signal);
  const rejected = assert.rejects(speech, { name: 'AbortError' });
  await tick(); const id = f.calls[0].id;
  f.progress({ id, type: 'segment', start: 0, end: 11, startTime: 0, endTime: 2 });
  assert.deepEqual(progress, [], 'synthesis preparation must not show a playing position');
  f.progress({ id, type: 'start' });
  assert.deepEqual(progress.at(-1), { start: 0, end: 5, estimated: true });
  f.progress({ id, type: 'segment', start: 12, end: 17, startTime: 2, endTime: 3 });
  assert.deepEqual(progress.at(-1), { start: 0, end: 5, estimated: true }, 'queued future audio cannot move the box ahead');
  f.progress({ id, type: 'position', time: 1.5 });
  assert.deepEqual(progress.at(-1), { start: 6, end: 11, estimated: true });
  f.progress({ id, type: 'position', time: 2.3 });
  assert.deepEqual(progress.at(-1), { start: 12, end: 17, estimated: true });
  const count = progress.length;
  f.progress({ id, type: 'position', time: 1 });
  f.progress({ id: 'other', type: 'position', time: 2.5 });
  f.progress({ id, type: 'segment', start: -1, end: 11, startTime: 0, endTime: 2 });
  assert.equal(progress.length, count);
  controller.abort(); await rejected;
  f.progress({ id, type: 'position', time: 2.8 }); assert.equal(progress.length, count);
});

function fixture() {
  const listeners = new Set<Progress>();
  const calls: Array<{ id: string; resolve: (value: { completed: boolean }) => void; reject: (reason: unknown) => void }> = [];
  const stopped: string[] = [];
  let removed = 0;
  const plugin: NativeSpeechPlugin = {
    async addListener(_name, listener) { listeners.add(listener); return { async remove() { removed++; listeners.delete(listener); } }; },
    speak({ id }) { return new Promise((resolve, reject) => calls.push({ id, resolve, reject })); },
    async stop({ id }) { stopped.push(id); calls.find(call => call.id === id)?.reject(new Error('native interrupted')); },
  };
  return { plugin, adapter: createNativeSpeechAdapter(plugin), calls, stopped, get removed() { return removed; },
    progress(event: Parameters<Progress>[0]) { for (const listener of listeners) listener(event); } };
}

test('native speech cancellation stops only its own utterance while a replacement can finish', async () => {
  const f = fixture(), first = new AbortController(), second = new AbortController();
  const old = f.adapter.speak('old text', settings, () => {}, first.signal);
  const oldRejected = assert.rejects(old, { name: 'AbortError' });
  await tick();
  const replacement = f.adapter.speak('new text', settings, () => {}, second.signal);
  await tick();
  assert.equal(f.calls.length, 2);
  first.abort();
  await oldRejected;
  assert.deepEqual(f.stopped, [f.calls[0].id]);
  f.calls[1].resolve({ completed: true });
  await replacement;
  assert.equal(f.removed, 2);
});

test('abort while subscribing removes its listener and never begins native speech', async () => {
  let resolveListener!: (value: { remove(): Promise<void> }) => void;
  let spoken = 0, stopped = 0, removed = 0;
  const plugin: NativeSpeechPlugin = {
    addListener() { return new Promise(resolve => { resolveListener = resolve; }); },
    async speak() { spoken++; return { completed: true }; },
    async stop() { stopped++; },
  };
  const controller = new AbortController();
  const speech = createNativeSpeechAdapter(plugin).speak('text', settings, () => {}, controller.signal);
  const rejected = assert.rejects(speech, { name: 'AbortError' });
  controller.abort();
  resolveListener({ async remove() { removed++; } });
  await rejected;
  assert.deepEqual({ spoken, stopped, removed }, { spoken: 0, stopped: 0, removed: 1 });
});

test('native speech forwards only matching starts and valid actual text ranges', async () => {
  const f = fixture(), progress: unknown[] = [], controller = new AbortController();
  const speech = f.adapter.speak('hello world', settings, range => progress.push(range), controller.signal);
  await tick();
  const id = f.calls[0].id;
  f.progress({ id: 'other', type: 'start' });
  f.progress({ id, type: 'unrecognized' });
  f.progress({ id, type: 'start' });
  f.progress({ id, type: 'range', start: 0, end: 5 });
  f.progress({ id, type: 'range', start: -1, end: 5 });
  f.progress({ id, type: 'range', start: 0, end: 99 });
  f.progress({ id, type: 'range', start: 5, end: 5 });
  f.progress({ id, type: 'range', start: 1.5, end: 5 });
  assert.deepEqual(progress, [undefined, { start: 0, end: 5 }]);
  f.calls[0].resolve({ completed: true }); await speech;
});

test('listener cleanup failure cannot hide the native speech error', async () => {
  const plugin: NativeSpeechPlugin = {
    async addListener() { return { async remove() { throw new Error('cleanup failed'); } }; },
    async speak() { throw new Error('offline voice missing'); },
    async stop() {},
  };
  await assert.rejects(createNativeSpeechAdapter(plugin).speak('text', settings, () => {}, new AbortController().signal), /offline voice missing/);
});

test('optional native preparation forwards the exact language and rate without playback or progress listeners', async () => {
  const requests: unknown[] = [];
  const plugin: NativeSpeechPlugin = {
    async prepare(value) { requests.push(value); },
    async speak() { throw new Error('Preparation must not play'); },
    async stop() {},
    async addListener() { throw new Error('Preparation must not subscribe to playback'); },
  };
  const adapter = createNativeSpeechAdapter(plugin, { maxTextLength: 20_000, prepare: true });
  assert.equal(adapter.maxTextLength, 20_000);
  await adapter.prepare!('Bonjour', { lang: 'fr-FR', rate: .85 }, new AbortController().signal);
  assert.equal(requests.length, 1);
  assert.deepEqual({ ...(requests[0] as object), id: 'own-id' }, { id: 'own-id', text: 'Bonjour', language: 'fr-FR', rate: .85 });
});

test('cancelling native preparation stops its own ID and leaves an active utterance intact', async () => {
  const f = fixture();
  let preparationId = '', rejectPreparation!: (reason: unknown) => void;
  const originalStop = f.plugin.stop;
  f.plugin.prepare = ({ id }) => { preparationId = id; return new Promise((_resolve, reject) => { rejectPreparation = reject; }); };
  f.plugin.stop = async ({ id }) => {
    if (id === preparationId) { f.stopped.push(id); rejectPreparation(new Error('Preparation stopped')); }
    else await originalStop({ id });
  };
  const adapter = createNativeSpeechAdapter(f.plugin, { prepare: true });
  const controller = new AbortController();
  const preparation = adapter.prepare!('Prepared paragraph', settings, controller.signal);
  const rejected = assert.rejects(preparation, { name: 'AbortError' });
  const spoken = adapter.speak('Different word', settings, () => {}, new AbortController().signal);
  await tick(); controller.abort(); await rejected;
  assert.deepEqual(f.stopped, [preparationId]); assert.notEqual(preparationId, f.calls[0].id);
  f.calls[0].resolve({ completed: true }); await spoken;
});


test('native timing fields only follow a matching start and reject negative or nonfinite times',async()=>{
  const f=fixture(), timings:unknown[]=[];
  const speaking=f.adapter.speak('hello world',settings,(_range,details)=>{if(details)timings.push(details)},new AbortController().signal);
  await tick();const id=f.calls[0].id;
  f.progress({id:'other',type:'start',elapsedMs:55,engineLoadMs:66});
  f.progress({id,type:'start',elapsedMs:1234,engineLoadMs:456,openingCacheHit:true});
  f.progress({id,type:'start',elapsedMs:-1,engineLoadMs:Infinity});
  assert.deepEqual(timings,[{elapsedMs:1234,engineLoadMs:456,openingCacheHit:true},{elapsedMs:undefined,engineLoadMs:undefined,openingCacheHit:false}]);
  f.calls[0].resolve({completed:true});await speaking;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechClient, type SpeechEnvironment, type NativeSpeechAdapter } from '../src/lib/speech';

function environment(nativeSpeech?: NativeSpeechAdapter): SpeechEnvironment {
  return {
    fetch: (async () => { throw new Error('Local voice is missing'); }) as typeof fetch,
    getSynthesis: () => undefined,
    createUtterance: () => { throw new Error('Unexpected browser voice'); },
    createAudio: () => { throw new Error('Unexpected HTTP audio'); },
    createObjectURL: () => { throw new Error('Unexpected HTTP audio'); },
    revokeObjectURL: () => {}, allowBrowserFallback: false, nativeSpeech,
  };
}

test('native buffering clears the old word and retains first-play timing when audio resumes', async () => {
  let update!: Parameters<NativeSpeechAdapter['speak']>[2], complete!: () => void;
  const client = createSpeechClient(environment({ speak(_text, _settings, progress) {
    update = progress; return new Promise<void>(resolve => { complete = resolve; });
  } }));
  const result = client.speakText('hello world', { scope: 'reader', target: { articleId: 'a', startOffset: 0 } });
  update({ start: 0, end: 5, estimated: true }, { elapsedMs: 150, engineLoadMs: 80 });
  const firstPlayback = client.getSnapshot().state.timing!.firstPlaybackMs;
  assert.equal(client.getSnapshot().state.status, 'speaking'); assert.ok(client.getProgress().word);
  update(undefined, { buffering: true });
  assert.equal(client.getSnapshot().state.status, 'loading'); assert.deepEqual(client.getProgress(), {});
  update(undefined, { buffering: false }); update({ start: 6, end: 11, estimated: true });
  assert.equal(client.getSnapshot().state.status, 'speaking'); assert.equal(client.getProgress().word?.text, 'world');
  assert.equal(client.getSnapshot().state.timing!.firstPlaybackMs, firstPlayback);
  assert.equal(client.getSnapshot().state.timing!.firstAudioMs, 150);
  client.stopSpeech();
  update({ start: 0, end: 5 }); update(undefined, { buffering: false });
  assert.equal(client.getSnapshot().state.status, 'idle'); assert.deepEqual(client.getProgress(), {});
  complete(); assert.equal((await result).cancelled, true);
});

test('native estimated word progress keeps original article offsets and clears after playback', async () => {
  const client = createSpeechClient(environment({ async speak(_text, _settings, progress) {
    progress({ start: 6, end: 11, estimated: true });
    assert.deepEqual(client.getProgress(), { scope: 'reader', target: { articleId: 'article', startOffset: 100 }, word: { text: 'world', start: 6, end: 11 }, estimated: true });
  } }));
  await client.speakText('hello world', { scope: 'reader', target: { articleId: 'article', startOffset: 100 } });
  assert.deepEqual(client.getProgress(), {});
});

test('Android speech reads every chunk serially and reports actual boundaries without HTTP or browser playback', async () => {
  const calls: string[] = [];
  let playing = 0; let maxPlaying = 0;
  const client = createSpeechClient(environment({ async speak(text, settings, progress, signal) {
    signal.throwIfAborted(); assert.equal(settings.lang, 'en-US');
    calls.push(text); maxPlaying = Math.max(maxPlaying, ++playing);
    progress(); progress({ start: 0, end: 5 });
    await Promise.resolve(); playing--;
  } }));
  const positions: number[] = [];
  const unsubscribe = client.subscribeProgress(() => {
    const value = client.getProgress();
    if (value.word) { assert.equal(value.estimated, false); positions.push(value.word.start); }
  });
  const text = 'First phrase. '.repeat(400).trim();
  assert.deepEqual(await client.speakText(text, { target: { articleId: 'article', startOffset: 100 } }), { provider: 'android-offline', cancelled: false });
  assert.ok(calls.length > 1); assert.equal(maxPlaying, 1);
  assert.equal(calls.join(' ').replace(/\s+/g, ' '), text);
  assert.ok(positions.at(-1)! > positions[0]);
  assert.deepEqual(client.getProgress(), {}); assert.equal(client.getSnapshot().state.status, 'idle');
  unsubscribe();
});

test('offline desktop speech surfaces a missing local voice instead of entering device fallback', async () => {
  let fallbackCalls = 0;
  const configured = environment();
  configured.getSynthesis = () => { fallbackCalls++; return undefined; };
  const client = createSpeechClient(configured);
  await assert.rejects(client.speakText('Read this locally.'), /Local voice is missing/);
  assert.equal(client.getSnapshot().state.status, 'error');
  assert.equal(fallbackCalls, 0);
});

test('bundled Android reads a full excerpt in one native pipeline instead of restarting every 2000 characters', async () => {
  const calls: Array<{ text: string; rate: number }> = [];
  const client = createSpeechClient(environment({ maxTextLength: 20_000, async speak(text, settings, progress) {
    calls.push({ text, rate: settings.rate }); progress();
  } }));
  const text = 'Every paragraph keeps its original words. '.repeat(150).trim();
  await client.speakText(text, { lang: 'en-GB', rate: .85 });
  assert.deepEqual(calls, [{ text, rate: .85 }]);
});

test('native preparation is silent and nonblocking, uses the same normalized text, and survives playback handoff', async () => {
  let preparedText = '', preparedSignal!: AbortSignal, finishPreparation!: () => void, finishSpeech!: () => void;
  let playbackStarted!: () => void;
  const client = createSpeechClient(environment({ maxTextLength: 20_000,
    prepare(text, settings, signal) {
      preparedText = text; preparedSignal = signal; assert.equal(settings.rate, .75);
      return new Promise(resolve => { finishPreparation = resolve; });
    },
    speak(text, settings, progress) {
      assert.equal(text, preparedText); assert.equal(settings.rate, .75); playbackStarted = progress;
      return new Promise(resolve => { finishSpeech = resolve; });
    },
  }));
  const text = '  First paragraph.\r\n\r\nSecond paragraph.  ';
  const cleanup = client.prepareText(text, { rate: .75 });
  assert.equal(client.getSnapshot().state.status, 'idle');
  assert.equal(preparedText, 'First paragraph.\n\nSecond paragraph.');
  const spoken = client.speakText(text, { rate: .75 });
  cleanup(); assert.equal(preparedSignal.aborted, false, 'An explicit play owns the pending preparation');
  assert.equal(client.getSnapshot().state.status, 'loading');
  playbackStarted(); assert.equal(client.getSnapshot().state.status, 'speaking');
  finishPreparation(); finishSpeech(); await spoken;
  assert.equal(client.getSnapshot().state.status, 'idle');
});

test('leaving or replacing optional native preparation cancels it and failures remain invisible', async () => {
  const signals: AbortSignal[] = [];
  const client = createSpeechClient(environment({ async speak() {}, prepare(_text, _settings, signal) {
    signals.push(signal); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('optional preparation interrupted')), { once: true }));
  } }));
  const first = client.prepareText('First opening');
  const second = client.prepareText('Replacement opening');
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  first(); assert.equal(signals[1].aborted, false);
  second(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(signals[1].aborted, true); assert.equal(client.getSnapshot().state.status, 'idle');
});


test('native timing details retain engine load and real audio arrival after playback',async()=>{
  const client=createSpeechClient(environment({async speak(_text,_settings,progress){progress(undefined,{elapsedMs:1234,engineLoadMs:456,openingCacheHit:true});}}));
  await client.speakText('Harbor boats return.');
  const timing=client.getSnapshot().state.timing!;
  assert.equal(timing.native,true);assert.equal(timing.firstAudioMs,1234);assert.equal(timing.engineLoadMs,456);assert.equal(timing.openingCacheHit,true);
  assert.ok(timing.firstPlaybackMs!>=0);
});

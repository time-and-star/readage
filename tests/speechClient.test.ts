import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechClient, splitRemoteSpeechText, splitSpeechText, type SpeechEnvironment } from '../src/lib/speech';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const config = (remote = false, maxTextLength = 2000, preload = false) => new Response(JSON.stringify({
  ok: true, configured: remote, provider: remote ? 'openai-compatible' : 'browser', maxTextLength, preload,
}), { headers: { 'Content-Type': 'application/json' } });
const audioResponse = () => new Response('audio bytes', { headers: { 'Content-Type': 'audio/mpeg' } });

test('French speech uses declared capability and preserves the stored English accent', async () => {
  const requests: Record<string, unknown>[] = [];
  const f = fixture(async (url, options) => {
    if (url === '/api/tts/status') return new Response(JSON.stringify({ ok: true, configured: true, provider: 'openai-compatible',
      maxTextLength: 200, languages: ['en-US', 'en-GB', 'fr-FR'] }));
    requests.push(JSON.parse(options!.body as string)); return audioResponse();
  });
  f.client.setSpeechPreferences({ lang: 'en-GB' });
  await f.client.speakText('Les chevaux mangent.', { lang: 'fr', scope: 'french' });
  assert.equal(requests[0].lang, 'fr-FR');
  assert.equal(f.client.getSpeechPreferences().lang, 'en-GB');
  await f.client.speakText('The horses eat.');
  assert.equal(requests[1].lang, 'en-GB');
});

test('an English-only service is never asked to read French and a missing French device voice is explicit', async () => {
  let syntheses = 0;
  const f = fixture(async url => { if (url === '/api/tts/status') return config(true); syntheses++; return audioResponse(); });
  await assert.rejects(f.client.speakText('Bonjour.', { lang: 'fr-FR' }), /没有此语言/);
  assert.equal(syntheses, 0); assert.equal(f.utterances.length, 0);
  f.setVoices([voice('French', 'fr-FR')]);
  const result = await f.client.speakText('Bonjour.', { lang: 'fr-FR' });
  assert.equal(result.provider, 'browser');
  assert.equal(f.utterances[0].voice?.lang, 'fr-FR');
  assert.equal(f.utterances[0].lang, 'fr-FR');
  await assert.rejects(f.client.speakText('Bad language.', { lang: 'bad_language' }), /语言标识无效/);
  assert.equal(f.client.getSnapshot().state.status, 'error');
  await f.client.speakText('Bonjour.', { lang: 'fr-FR' });
  assert.equal(f.client.getSnapshot().state.status, 'idle');
});

test('Japanese preparation and playback share normalized language cache and preserve the English accent', async () => {
  const requests: Record<string, unknown>[] = [];
  const f = fixture(async (url, options) => {
    if (url === '/api/tts/status') return new Response(JSON.stringify({ ok: true, configured: true,
      provider: 'openai-compatible', preload: true, maxTextLength: 200, languages: ['en-US', 'en-GB', 'ja-JP'] }));
    requests.push(JSON.parse(options!.body as string));
    return audioResponse();
  });
  f.client.setSpeechPreferences({ lang: 'en-GB', rate: 0.9 });
  f.client.prepareText('日本語を読みます。', { lang: 'ja', scope: 'japanese' });
  await tick();
  assert.equal(f.audios.length, 0);
  assert.equal(f.client.getSnapshot().state.status, 'idle');
  await f.client.speakText('日本語を読みます。', { lang: 'ja', scope: 'japanese' });
  await f.client.speakText('日本語を読みます。', { lang: 'ja-JP' });
  assert.deepEqual(requests, [{ text: '日本語を読みます。', lang: 'ja-JP', rate: 0.9 }]);
  assert.equal(f.client.getSpeechPreferences().lang, 'en-GB');
  await f.client.speakText('日本語を読みます。', { lang: 'ja', rate: 1 });
  await f.client.speakText('日本語を読みます。');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].lang, 'ja-JP');
  assert.equal(requests[2].lang, 'en-GB');
  assert.equal(f.utterances.length, 0);
  assert.equal(f.liveURLs.size, 0);
});

test('Japanese uses a matching device voice when the service has no Japanese capability', async () => {
  let syntheses = 0;
  const f = fixture(async url => { if (url === '/api/tts/status') return config(true); syntheses++; return audioResponse(); });
  await assert.rejects(f.client.speakText('日本語を読みます。', { lang: 'ja' }), /没有此语言/);
  assert.equal(syntheses, 0);
  assert.equal(f.utterances.length, 0);
  f.setVoices([voice('English', 'en-US'), voice('Japanese Natural', 'ja-JP')]);
  const result = await f.client.speakText('日本語を読みます。', { lang: 'ja' });
  assert.equal(result.provider, 'browser');
  assert.equal(f.utterances[0].voice?.lang, 'ja-JP');
  assert.equal(f.utterances[0].lang, 'ja-JP');
});

test('Japanese service failure falls back to Japanese device speech', async () => {
  const f = fixture(async url => url === '/api/tts/status'
    ? new Response(JSON.stringify({ ok: true, configured: true, provider: 'openai-compatible', languages: ['ja-JP'] }))
    : new Response('{}', { status: 503 }));
  f.setVoices([voice('English', 'en-US'), voice('Japanese', 'ja-JP')]);
  const result = await f.client.speakText('今日は晴れです。', { lang: 'ja' });
  assert.equal(result.provider, 'browser');
  assert.equal(result.fallback, true);
  assert.equal(f.utterances[0].lang, 'ja-JP');
  assert.equal(f.utterances[0].text, '今日は晴れです。');
});

test('a Japanese prefetch failure resumes at forced source boundaries without skipping words', async () => {
  let requests = 0;
  const text = `${'図書館'.repeat(60)}へ行きます。`;
  const chunks = splitRemoteSpeechText(text, 200, 100, 'ja-JP');
  const f = fixture(async url => {
    if (url === '/api/tts/status') return new Response(JSON.stringify({ ok: true, configured: true,
      provider: 'openai-compatible', preload: true, maxTextLength: 200, languages: ['ja-JP'] }));
    requests += 1;
    return requests === 1 ? audioResponse() : new Response('{}', { status: 503 });
  });
  f.setVoices([voice('Japanese', 'ja-JP')]);
  const boundaries: number[] = [];
  f.client.subscribeProgress(() => {
    const word = f.client.getProgress().word;
    if (word) boundaries.push(word.start);
  });
  const result = await f.client.speakText(text, { lang: 'ja', target: { articleId: 'ja', startOffset: 0 } });
  assert.equal(result.fallback, true);
  assert.equal(f.audios.length, 1);
  assert.equal(f.utterances.map(utterance => utterance.text).join(''), chunks.slice(1).join(''));
  assert.ok(boundaries.includes(chunks[0].length), 'fallback highlighting starts at the first unread character');
});
const voice = (name: string, lang: string, isDefault = false) => ({ name, lang, default: isDefault } as SpeechSynthesisVoice);

class FakeUtterance {
  lang = '';
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onstart: (() => void) | null = null;
  onboundary: ((event: { name: string; charIndex: number }) => void) | null = null;
  constructor(public text: string) {}
}
class FakeAudio {
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  duration = 8;
  currentTime = 0;
  paused = false;
  loaded = false;
  play = async () => {};
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { this.loaded = true; }
}
function fixture(fetcher: typeof fetch = async () => config(), automatic = true) {
  const events = new EventTarget();
  let voices = [voice('Chinese default', 'zh-CN', true), voice('American', 'en-US'), voice('British Natural', 'en-GB')];
  let cancelCount = 0;
  const utterances: FakeUtterance[] = [];
  const audios: FakeAudio[] = [];
  const liveURLs = new Set<string>();
  const revokedURLs: string[] = [];
  const values = new Map<string, string>();
  const synthesis = {
    getVoices: () => voices,
    cancel: () => { cancelCount += 1; },
    speak: (utterance: FakeUtterance) => {
      utterances.push(utterance);
      if (automatic) queueMicrotask(() => { utterance.onstart?.(); utterance.onend?.(); });
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  const environment: SpeechEnvironment = {
    fetch: fetcher,
    getSynthesis: () => synthesis as unknown as SpeechSynthesis,
    createUtterance: (text) => new FakeUtterance(text) as unknown as SpeechSynthesisUtterance,
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      if (automatic) audio.play = async () => { queueMicrotask(() => { audio.onplaying?.(); audio.onended?.(); }); };
      return audio as unknown as HTMLAudioElement;
    },
    createObjectURL: () => { const url = `blob:audio-${audios.length}`; liveURLs.add(url); return url; },
    revokeObjectURL: (url) => { liveURLs.delete(url); revokedURLs.push(url); },
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
    voiceWaitMs: 5,
  };
  return {
    environment, client: createSpeechClient(environment), utterances, audios, liveURLs, revokedURLs,
    get cancelCount() { return cancelCount; },
    setVoices: (next: SpeechSynthesisVoice[]) => { voices = next; events.dispatchEvent(new Event('voiceschanged')); },
  };
}

test('article chunks preserve paragraph pauses, sentence punctuation, and stay within the service limit', () => {
  assert.deepEqual(splitSpeechText('First paragraph.\r\n\r\nSecond paragraph.'), ['First paragraph.\n\nSecond paragraph.']);
  const text = `${'A complete sentence with punctuation. '.repeat(30)}\n\n${'word '.repeat(70)}end!`;
  const chunks = splitSpeechText(text, 120);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 120 && chunk.length > 0));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.trim().replace(/\s+/g, ' '));
  assert.ok(chunks[0].endsWith('.'));
  assert.equal(splitSpeechText('  ').length, 0);
  assert.ok(splitSpeechText('x'.repeat(2001)).every((chunk) => chunk.length <= 2000));
});

test('Japanese sentence and opening chunks preserve punctuation and text without inserting spaces', () => {
  const text = '今日は晴れです。「図書館へ行きます。」本を借りました！日本語を勉強します。';
  for (const limit of [10, 20]) {
    const chunks = splitSpeechText(text, limit, 'ja-JP');
    assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= limit));
    assert.equal(chunks.join(''), text);
  }
  const remote = splitRemoteSpeechText(text, 20, 20, 'ja-JP');
  assert.equal(remote[0], '今日は晴れです。');
  assert.equal(remote.join(''), text);
  const phrase = `${'日本語'.repeat(18)}、${'読書'.repeat(60)}。`;
  const phraseChunks = splitRemoteSpeechText(phrase, 200, 100, 'ja-JP');
  assert.equal(phraseChunks[0], `${'日本語'.repeat(18)}、`);
  assert.equal(phraseChunks.join(''), phrase);
  const long = `${'本📖'.repeat(30)}。`;
  const longChunks = splitSpeechText(long, 10, 'ja-JP');
  assert.equal(longChunks.join(''), long);
  assert.ok(longChunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
});

test('Japanese punctuation also splits on devices without Intl.Segmenter', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
  try {
    Object.defineProperty(Intl, 'Segmenter', { ...descriptor, value: undefined });
    const text = '今日は晴れです。明日は雨です。「本を読みます。」';
    const chunks = splitRemoteSpeechText(text, 20, 20, 'ja-JP');
    assert.equal(chunks[0], '今日は晴れです。');
    assert.equal(chunks.join(''), text);
    assert.deepEqual(splitSpeechText('春です。夏です。秋です。', 8, 'ja-JP'), ['春です。夏です。', '秋です。']);
  } finally {
    Object.defineProperty(Intl, 'Segmenter', descriptor);
  }
});

test('local preparation uses matching opening and preferences without playback or visible state changes', async () => {
  const requests: Record<string, unknown>[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 200, true);
    requests.push(JSON.parse(String(init?.body)));
    return audioResponse();
  });
  f.client.setSpeechPreferences({ lang: 'en-GB', rate: 0.9 });
  let notifications = 0;
  f.client.subscribe(() => { notifications += 1; });
  const opening = 'A natural opening sentence is ready before the reader clicks.';
  f.client.prepareText(`${opening}\n\n${'Another complete sentence follows. '.repeat(10)}`);
  await tick();
  assert.deepEqual(requests, [{ text: opening, lang: 'en-GB', rate: 0.9 }]);
  assert.equal(f.client.getSnapshot().state.status, 'idle');
  assert.equal(notifications, 0);
  assert.equal(f.audios.length, 0);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.liveURLs.size, 0);
});

test('preparation never automatically synthesizes with a hosted or device provider', async () => {
  for (const remote of [true, false]) {
    let syntheses = 0;
    const f = fixture(async (url) => {
      if (url === '/api/tts/status') return config(remote);
      syntheses += 1;
      return audioResponse();
    });
    f.client.prepareText('Hello.');
    await tick();
    assert.equal(syntheses, 0);
    assert.equal(f.utterances.length, 0);
    assert.equal(f.client.getSnapshot().state.status, 'idle');
  }
});

test('a click joins preparation and closing its owner cannot cancel foreground playback', async () => {
  const requests: AbortSignal[] = [];
  const ready = deferred<void>();
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 200, true);
    requests.push(init!.signal!);
    await new Promise<void>((resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      ready.promise.then(resolve);
    });
    return audioResponse();
  });
  const cancelPreparation = f.client.prepareText('Shared word.', { scope: 'reader' });
  await tick();
  const played = f.client.speakText('Shared word.', { scope: 'reader' });
  cancelPreparation();
  await tick();
  assert.equal(requests.length, 1, 'preparation and playback share one browser request');
  assert.equal(requests[0].aborted, false, 'the click must preserve the preparation already in progress');
  assert.equal(requests[0].aborted, false, 'closing preparation must keep the shared playback request alive');
  ready.resolve();
  assert.equal((await played).provider, 'openai-compatible');
  assert.equal(f.audios.length, 1);
  assert.equal(f.utterances.length, 0);
});

test('prepared audio and repeated playback reuse browser bytes with separate accent and speed keys', async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 200, true);
    bodies.push(JSON.parse(String(init?.body)));
    return audioResponse();
  });
  f.client.prepareText('A ready sentence.');
  await tick();
  await f.client.speakText('A ready sentence.');
  await f.client.speakText('A ready sentence.');
  assert.equal(bodies.length, 1, 'prepared and replayed audio must not make another HTTP request');
  await f.client.speakText('A ready sentence.', { lang: 'en-GB' });
  await f.client.speakText('A ready sentence.', { rate: 0.9 });
  assert.equal(bodies.length, 3);
  assert.equal(f.audios.length, 4);
  assert.equal(f.liveURLs.size, 0);
});

test('rapid repeated clicks share unfinished synthesis and only the last click plays', async () => {
  const ready = deferred<void>();
  let requests = 0;
  const f = fixture(async url => {
    if (url === '/api/tts/status') return config(true);
    requests += 1;
    await ready.promise;
    return audioResponse();
  });
  const first = f.client.speakText('Same sentence.');
  await tick();
  const second = f.client.speakText('Same sentence.');
  await tick();
  assert.equal(requests, 1);
  ready.resolve();
  assert.equal((await first).cancelled, true);
  assert.equal((await second).cancelled, false);
  assert.equal(f.audios.length, 1);
});

test('browser audio cache evicts older entries and does not cache failed synthesis', async () => {
  let requests = 0;
  let failing = true;
  const f = fixture(async url => {
    if (url === '/api/tts/status') return config(true);
    requests += 1;
    if (failing) return new Response('{}', { status: 503 });
    return audioResponse();
  });
  await f.client.speakText('Retry me.');
  failing = false;
  await f.client.speakText('Retry me.');
  assert.equal(requests, 2);
  for (let index = 0; index < 32; index += 1) await f.client.speakText(`Sentence ${index}.`);
  await f.client.speakText('Sentence 31.');
  assert.equal(requests, 34, 'recent audio remains cached');
  await f.client.speakText('Retry me.');
  assert.equal(requests, 35, 'least recently used audio is evicted');
});

test('switching preparation aborts stale work and a preparation failure stays silent', async () => {
  const requests: { text: string; signal: AbortSignal }[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 200, true);
    requests.push({ text: JSON.parse(String(init?.body)).text, signal: init!.signal! });
    if (requests.length === 1) return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return new Response('{}', { status: 503 });
  });
  f.client.prepareText('Old word.');
  await tick();
  f.client.prepareText('New word.');
  await tick();
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(requests.map(request => request.text), ['Old word.', 'New word.']);
  assert.equal(f.client.getSnapshot().state.status, 'idle');
  assert.equal(f.utterances.length, 0);
  assert.equal(f.audios.length, 0);
});

test('remote chunks keep a short first sentence and every remaining word within the service limit', () => {
  const opening = 'This repeated sentence should be spoken once at each place in the original article.';
  const text = `${opening}\r\n\r\n${opening} ${'A further complete sentence follows. '.repeat(12)}`;
  for (const serviceLimit of [100, 400, 2000]) {
    const chunks = splitRemoteSpeechText(text, serviceLimit);
    assert.equal(chunks[0], opening);
    assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= Math.min(200, serviceLimit)));
    assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.trim().replace(/\s+/g, ' '));
  }
  const completeOpening = `${'A natural opening with more detail '.repeat(4)}ends here.`;
  assert.ok(completeOpening.length > 120 && completeOpening.length <= 180);
  assert.equal(splitRemoteSpeechText(`${completeOpening} Another sentence follows.`, 400)[0], completeOpening);
  assert.deepEqual(splitRemoteSpeechText('A short word or sentence.'), ['A short word or sentence.']);
});

test('an oversized opening prefers a phrase pause and keeps unbroken Unicode text intact', () => {
  const clause = 'The reader can hear a natural opening clause before the next thought begins,';
  const text = `${clause} ${'the remainder of this long sentence continues '.repeat(8)}and ends here.`;
  const chunks = splitRemoteSpeechText(text, 400);
  assert.equal(chunks[0], clause);
  assert.ok(chunks[0].length <= 120);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text);

  const unbroken = `${'😀'.repeat(201)}. Another sentence ends here.`;
  const unicodeChunks = splitRemoteSpeechText(unbroken, 101);
  assert.ok(unicodeChunks.every((chunk) => chunk.length <= 101));
  assert.equal(unicodeChunks.join('').replace(/\s/g, ''), unbroken.replace(/\s/g, ''));
  assert.ok(unicodeChunks.every((chunk) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk)));
});

test('shared accent and speed preferences survive reload and select an explicit English voice', async () => {
  const f = fixture();
  f.client.setSpeechPreferences({ lang: 'en-GB', rate: 0.9 });
  const reloaded = createSpeechClient(f.environment);
  await reloaded.speakText('A British example.');
  assert.equal(f.utterances[0].voice?.name, 'British Natural');
  assert.equal(f.utterances[0].lang, 'en-GB');
  assert.equal(f.utterances[0].rate, 0.9);
  assert.deepEqual(reloaded.getSpeechPreferences(), { lang: 'en-GB', rate: 0.9 });
  reloaded.setSpeechPreferences({ rate: Infinity });
  assert.equal(reloaded.getSpeechPreferences().rate, 0.9);
});

test('device voices can load later, without choosing the system Chinese voice', async () => {
  const f = fixture();
  f.setVoices([]);
  const speaking = f.client.speakText('Hello.', { lang: 'en-GB' });
  await Promise.resolve();
  f.setVoices([voice('Chinese', 'zh-CN', true), voice('English', 'en-GB')]);
  await speaking;
  assert.equal(f.utterances[0].voice?.lang, 'en-GB');
});

test('repeated clicks replace device playback, and closing an unrelated scope leaves it playing', async () => {
  const f = fixture(undefined, false);
  const first = f.client.speakText('Old word.', { scope: 'reader' });
  await tick();
  const second = f.client.speakText('New word.', { scope: 'reader' });
  await tick();
  assert.equal((await first).cancelled, true);
  assert.deepEqual(f.utterances.map((utterance) => utterance.text), ['Old word.', 'New word.']);
  const previousCancels = f.cancelCount;
  f.client.stopSpeech('lookup');
  assert.equal(f.cancelCount, previousCancels);
  assert.equal(f.client.getSnapshot().state.status, 'speaking');
  f.utterances[1].onend?.();
  assert.equal((await second).cancelled, false);
});

test('a superseded device request waiting for voices cannot cancel the replacement', async () => {
  const f = fixture(undefined, false);
  f.setVoices([]);
  const first = f.client.speakText('Old request.', { scope: 'reader' });
  await tick();
  const second = f.client.speakText('Replacement.', { scope: 'reader' });
  f.setVoices([voice('English', 'en-US')]);
  await tick();
  assert.equal((await first).cancelled, true);
  assert.deepEqual(f.utterances.map((utterance) => utterance.text), ['Replacement.']);
  assert.equal(f.client.getSnapshot().state.status, 'speaking');
  f.utterances[0].onend?.();
  await second;
});

test('remote playback sends selected pronunciation settings and releases every audio URL', async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true);
    bodies.push(JSON.parse(String(init?.body)));
    return audioResponse();
  });
  const result = await f.client.speakText('One paragraph.\n\nAnother paragraph.', { lang: 'en-GB', rate: 0.9 });
  assert.equal(result.provider, 'openai-compatible');
  assert.deepEqual(bodies[0], { text: 'One paragraph.\n\nAnother paragraph.', lang: 'en-GB', rate: 0.9 });
  assert.equal(f.utterances.length, 0);
  assert.equal(f.liveURLs.size, 0);
  assert.equal(f.revokedURLs.length, 1);
  assert.ok(f.audios.every((audio) => audio.paused && audio.loaded && !audio.src));
});

test('remote word guide follows media time and clears on stop without re-rendering speech state for every word', async () => {
  const f = fixture(async url => url === '/api/tts/status' ? config(true) : audioResponse(), false);
  const played = f.client.speakText('First second third.', { scope: 'reader', target: { articleId: 'article', startOffset: 20 } });
  await tick();
  const audio = f.audios[0];
  audio.onplaying?.();
  assert.equal(f.client.getProgress().word?.text, 'First');
  assert.deepEqual(f.client.getProgress().target, { articleId: 'article', startOffset: 20 });
  assert.equal(f.client.getProgress().estimated, true);
  const snapshot = f.client.getSnapshot();
  audio.currentTime = 7.8;
  audio.ontimeupdate?.();
  assert.equal(f.client.getProgress().word?.text, 'third');
  assert.equal(f.client.getSnapshot(), snapshot, 'word updates have a separate subscription');
  audio.currentTime = 0;
  audio.ontimeupdate?.();
  assert.equal(f.client.getProgress().word?.start, 0);
  f.client.stopSpeech('reader');
  assert.deepEqual(f.client.getProgress(), {});
  assert.equal(audio.ontimeupdate, null);
  assert.equal((await played).cancelled, true);
});

test('device boundaries track exact source occurrences and stop removes stale boundary callbacks', async () => {
  const f = fixture(undefined, false);
  const played = f.client.speakText('Repeat repeat.', { scope: 'reader', target: { articleId: 'article', startOffset: 0 } });
  await tick();
  const utterance = f.utterances[0];
  utterance.onstart?.();
  utterance.onboundary?.({ name: 'word', charIndex: 7 });
  assert.deepEqual(f.client.getProgress().word, { text: 'repeat', start: 7, end: 13 });
  assert.equal(f.client.getProgress().estimated, false);
  f.client.stopSpeech();
  assert.equal(utterance.onboundary, null);
  assert.deepEqual(f.client.getProgress(), {});
  assert.equal((await played).cancelled, true);
});

test('word progress moves to the later occurrence across repeated chunks', async () => {
  const f = fixture(async url => url === '/api/tts/status' ? config(true, 12) : audioResponse(), false);
  const played = f.client.speakText('Repeat one. Repeat one. End.', { scope: 'reader', target: { articleId: 'article', startOffset: 0 } });
  await tick();
  f.audios[0].onplaying?.();
  assert.equal(f.client.getProgress().word?.start, 0);
  f.audios[0].onended?.();
  await tick();
  f.audios[1].onplaying?.();
  assert.equal(f.client.getProgress().word?.start, 12);
  f.client.stopSpeech();
  assert.equal((await played).cancelled, true);
});

test('playback diagnostics preserve actual cache source and safe server timing values', async () => {
  const f = fixture(async url => url === '/api/tts/status' ? config(true) : new Response('bytes', {
    headers: { 'Content-Type': 'audio/wav', 'Server-Timing': 'tts-app;dur=260, tts-queue;dur=20, tts-infer;dur=210, tts-pre;dur=25, tts-encode;dur=1' },
  }));
  await f.client.speakText('Read me.');
  const timing = f.client.getSnapshot().state.timing!;
  assert.equal(timing.inferenceMs, 210);
  assert.equal(timing.queueMs, 20);
  assert.equal(timing.cache, 'none');
  assert.ok(timing.firstPlaybackMs! >= timing.firstAudioMs!);
  await f.client.speakText('Read me.');
  assert.equal(f.client.getSnapshot().state.timing?.cache, 'browser');
});

test('the opening sentence starts playing while the following audio is still being generated', async () => {
  const nextAudio = deferred<Response>();
  const requested: string[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 400);
    requested.push(JSON.parse(String(init?.body)).text);
    return requested.length === 1 ? audioResponse() : nextAudio.promise;
  }, false);
  const first = 'The first sentence should be heard as soon as its audio is ready.';
  const second = 'The following sentence is still being generated while the first is playing, and should never delay the first sound.';
  const playing = f.client.speakText(`${first}\n\n${second}`, { scope: 'reader' });
  await tick();
  assert.deepEqual(requested, [first, second]);
  assert.equal(f.audios.length, 1, 'first audio must play before the next synthesis resolves');
  assert.equal(f.client.getSnapshot().state.status, 'speaking');
  f.audios[0].onended?.();
  await tick();
  assert.equal(f.audios.length, 1, 'an unfinished prefetch must not overlap or replay the opening');
  nextAudio.resolve(audioResponse());
  await tick();
  assert.equal(f.audios.length, 2);
  f.audios[1].onended?.();
  assert.equal((await playing).cancelled, false);
  assert.equal(f.liveURLs.size, 0);
});

test('ready audio remains loading until the media actually starts; late play completion cannot revive cancelled playback', async () => {
  const playReady = deferred<void>();
  const f = fixture(async url => url === '/api/tts/status' ? config(true) : audioResponse(), false);
  const createAudio = f.environment.createAudio;
  f.environment.createAudio = () => {
    const audio = createAudio();
    audio.play = () => playReady.promise;
    return audio;
  };
  const spoken = f.client.speakText('Ready to read.', { scope: 'reader', target: { articleId: 'fixture', startOffset: 0 } });
  await tick();
  assert.equal(f.audios.length, 1);
  assert.equal(f.client.getSnapshot().state.status, 'loading');
  assert.equal(f.client.getSnapshot().state.timing?.firstPlaybackMs, undefined);
  assert.deepEqual(f.client.getProgress(), {});
  f.audios[0].onplaying?.();
  assert.equal(f.client.getSnapshot().state.status, 'speaking');
  assert.ok(f.client.getSnapshot().state.timing?.firstPlaybackMs !== undefined);
  f.client.stopSpeech('reader');
  assert.equal((await spoken).cancelled, true);
  playReady.resolve();
  await tick();
  assert.equal(f.client.getSnapshot().state.status, 'idle');
  assert.deepEqual(f.client.getProgress(), {});
  assert.equal(f.audios.length, 1);
  assert.equal(f.liveURLs.size, 0);
});

test('slow prefetch clears the completed word guide and shows loading, then resumes the exact next chunk', async () => {
  const nextAudio = deferred<Response>();
  const requested: string[] = [];
  const first = 'The opening sentence is ready.';
  const second = 'The remaining sentence waits for its local voice to finish generating and must play once.';
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 200, true);
    requested.push(JSON.parse(String(init?.body)).text);
    return requested.length === 1 ? audioResponse() : nextAudio.promise;
  }, false);
  const spoken = f.client.speakText(`${first}\n\n${second}`, { scope: 'reader', target: { articleId: 'fixture', startOffset: 0 } });
  await tick();
  f.audios[0].onplaying?.();
  f.audios[0].currentTime = 7.9;
  f.audios[0].ontimeupdate?.();
  assert.ok(f.client.getProgress().word);
  f.audios[0].onended?.();
  await tick();
  assert.equal(f.client.getSnapshot().state.status, 'loading');
  assert.deepEqual(f.client.getProgress(), {});
  assert.equal(f.audios.length, 1);
  assert.equal(f.audios[0].src, '');
  nextAudio.resolve(audioResponse());
  await tick();
  assert.deepEqual(requested, [first, second]);
  assert.equal(f.audios.length, 2);
  f.audios[1].onplaying?.();
  assert.equal(f.client.getSnapshot().state.status, 'speaking');
  assert.equal(f.client.getProgress().word?.start, first.length + 2);
  f.audios[1].onended?.();
  assert.equal((await spoken).cancelled, false);
  assert.equal(f.client.getSnapshot().state.status, 'idle');
  assert.equal(f.liveURLs.size, 0);
});

test('already prepared next chunks do not flash loading, and cancellation in a prefetch gap cannot restart or repeat text', async () => {
  const prepared = fixture(async url => url === '/api/tts/status' ? config(true, 50) : audioResponse(), false);
  const statuses: string[] = [];
  prepared.client.subscribe(() => statuses.push(prepared.client.getSnapshot().state.status));
  const complete = prepared.client.speakText(`${'A'.repeat(45)}\n\n${'B'.repeat(45)}`);
  await tick();
  prepared.audios[0].onended?.();
  await tick();
  assert.equal(prepared.audios.length, 2);
  assert.equal(statuses.lastIndexOf('loading'), statuses.indexOf('loading'));
  prepared.audios[1].onended?.();
  await complete;

  const late = deferred<Response>();
  const requested: string[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 200, true);
    requested.push(JSON.parse(String(init?.body)).text);
    return requested.length === 1 ? audioResponse() : late.promise;
  }, false);
  const cancelled = f.client.speakText('First sentence.\n\nThe second sentence is longer and waits for generation before playing after the first sentence.',
    { scope: 'reader', target: { articleId: 'fixture', startOffset: 0 } });
  await tick();
  f.audios[0].onended?.();
  await tick();
  assert.equal(f.client.getSnapshot().state.status, 'loading');
  f.client.stopSpeech('reader');
  assert.equal((await cancelled).cancelled, true);
  late.resolve(audioResponse());
  await tick();
  assert.equal(f.audios.length, 1);
  assert.equal(requested.length, 2);
  assert.equal(f.client.getSnapshot().state.status, 'idle');
  assert.deepEqual(f.client.getProgress(), {});
  assert.equal(f.liveURLs.size, 0);
});

test('long article playback prefetches only the next chunk and never overlaps audio', async () => {
  const requested: string[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 50);
    requested.push(JSON.parse(String(init?.body)).text);
    return audioResponse();
  }, false);
  const text = ['A'.repeat(45), 'B'.repeat(45), 'C'.repeat(45)].join('\n\n');
  const playing = f.client.speakText(text);
  await tick();
  assert.equal(requested.length, 2);
  assert.equal(f.audios.length, 1);
  assert.equal(f.liveURLs.size, 1);
  f.audios[0].onended?.();
  await tick();
  assert.equal(requested.length, 3);
  assert.equal(f.audios.length, 2);
  assert.ok(f.audios[0].paused);
  assert.equal(f.liveURLs.size, 1);
  f.audios[1].onended?.();
  await tick();
  f.audios[2].onended?.();
  await playing;
  assert.equal(f.liveURLs.size, 0);
  assert.equal(f.revokedURLs.length, 3);
});

test('a late response after replacement cannot play or overwrite current status', async () => {
  const late = deferred<Response>();
  let firstSignal: AbortSignal | undefined;
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true);
    if (JSON.parse(String(init?.body)).text === 'Old request.') {
      firstSignal = init?.signal as AbortSignal;
      return late.promise; // Simulate a transport ignoring abort until its response arrives.
    }
    return audioResponse();
  }, false);
  const old = f.client.speakText('Old request.');
  await tick();
  const current = f.client.speakText('Current request.');
  await tick();
  assert.equal(firstSignal?.aborted, true);
  late.resolve(audioResponse());
  assert.equal((await old).cancelled, true);
  assert.equal(f.audios.length, 1);
  assert.equal(f.client.getSnapshot().state.status, 'speaking');
  f.audios[0].onended?.();
  await current;
});

test('stop cancels playing audio and pending prefetch and releases its resources', async () => {
  const signals: AbortSignal[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 50);
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    if (signals.length === 1) return audioResponse();
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
  }, false);
  const playing = f.client.speakText(`${'A'.repeat(45)}\n\n${'B'.repeat(45)}`, { scope: 'review' });
  await tick();
  f.client.stopSpeech('review');
  assert.equal((await playing).cancelled, true);
  assert.equal(signals[1].aborted, true);
  assert.ok(f.audios[0].paused);
  assert.equal(f.liveURLs.size, 0);
  assert.equal(f.client.getSnapshot().state.status, 'idle');
});

test('service failure falls back visibly to device speech, while application auth failure remains an error', async () => {
  for (const responseStatus of [502, 401, 403]) {
    const f = fixture(async (url) => url === '/api/tts/status' ? config(true)
      : new Response(JSON.stringify({ ok: false, error: { code: 'FAIL', message: 'Unavailable' } }), { status: responseStatus }));
    if (responseStatus === 502) {
      const result = await f.client.speakText('Fallback example.');
      assert.equal(result.fallback, true);
      assert.equal(result.provider, 'browser');
      assert.equal(f.utterances.length, 1);
      assert.match(f.client.getSnapshot().state.notice || '', /已使用设备语音/);
    } else {
      await assert.rejects(f.client.speakText('Protected example.'), /认证失败/);
      assert.equal(f.utterances.length, 0);
      assert.equal(f.client.getSnapshot().state.status, 'error');
    }
  }
});

test('upstream credential failure preserves a useful configuration message when falling back', async () => {
  const f = fixture(async (url) => url === '/api/tts/status' ? config(true)
    : new Response(JSON.stringify({ ok: false, error: { code: 'TTS_UPSTREAM_AUTH_FAILED', message: '服务认证失败' } }), { status: 502 }));
  await f.client.speakText('A word.');
  assert.match(f.client.getSnapshot().state.notice || '', /检查服务配置.*已使用设备语音/);
});

test('prefetch failure resumes the unread article instead of replaying paragraphs already heard', async () => {
  let requests = 0;
  const f = fixture(async (url) => {
    if (url === '/api/tts/status') return config(true, 50);
    requests += 1;
    if (requests === 1) return audioResponse();
    throw new Error('Network disconnected');
  });
  const first = 'Already heard paragraph with a sentence.';
  const second = 'Unread paragraph with a sentence.';
  const result = await f.client.speakText(`${first}\n\n${second}`);
  assert.equal(result.fallback, true);
  assert.equal(f.audios.length, 1);
  assert.deepEqual(f.utterances.map((utterance) => utterance.text), [second]);
});

test('a failed next chunk after the shorter opening falls back without skipping repeated sentences', async () => {
  let requests = 0;
  const requested: string[] = [];
  const f = fixture(async (url, init) => {
    if (url === '/api/tts/status') return config(true, 400);
    requested.push(JSON.parse(String(init?.body)).text);
    requests += 1;
    if (requests === 1) return audioResponse();
    throw new Error('Network disconnected');
  });
  const first = 'A repeated sentence remains important at each point in this article.';
  const remainder = `${first}\n\n${'The rest of the article must be heard exactly once. '.repeat(8)}`.trimEnd();
  const result = await f.client.speakText(`${first}\n\n${remainder}`, { scope: 'reader' });
  assert.equal(result.fallback, true);
  assert.equal(requested[0], first);
  assert.ok(requested[1].length <= 200);
  assert.equal(f.audios.length, 1);
  assert.equal(f.utterances.map((utterance) => utterance.text).join(' ').replace(/\s+/g, ' '), remainder.replace(/\s+/g, ' '));
});

test('service failure on a device with no speech support yields an actionable visible error', async () => {
  const f = fixture(async () => { throw new Error('Network disconnected'); });
  f.environment.getSynthesis = () => undefined;
  await assert.rejects(f.client.speakText('A word.'), /当前设备无法朗读/);
  assert.equal(f.client.getSnapshot().state.status, 'error');
  assert.match(f.client.getSnapshot().state.error || '', /支持朗读的浏览器/);
});

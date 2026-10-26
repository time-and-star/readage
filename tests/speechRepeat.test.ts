import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speakRepeatedText } from '../src/lib/speech/repeat';

test('repeats the same headword sequentially exactly zero through three times', async () => {
  for (const count of [0, 1, 2, 3]) {
    const played: string[] = [];
    await speakRepeatedText('word', count, async text => {
      played.push(text);
      return { cancelled: false };
    });
    assert.deepEqual(played, Array(count).fill('word'));
  }
});

test('does not start another repeat after playback or its owner is cancelled', async () => {
  const played: string[] = [];
  const controller = new AbortController();
  await speakRepeatedText('word', 3, async text => {
    played.push(text);
    controller.abort();
    return { cancelled: false };
  }, controller.signal);
  assert.deepEqual(played, ['word']);

  const replaced: string[] = [];
  await speakRepeatedText('word', 3, async text => {
    replaced.push(text);
    return { cancelled: true };
  });
  assert.deepEqual(replaced, ['word']);
});

test('waits for each completed pronunciation before starting the next', async () => {
  let finishFirst!: () => void;
  const order: string[] = [];
  const playback = speakRepeatedText('word', 2, async () => {
    const index = order.filter(item => item.startsWith('start')).length + 1;
    order.push(`start-${index}`);
    if (index === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
    order.push(`end-${index}`);
    return { cancelled: false };
  });
  await Promise.resolve();
  assert.deepEqual(order, ['start-1']);
  finishFirst();
  await playback;
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

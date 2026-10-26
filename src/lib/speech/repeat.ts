export interface RepeatSpeechResult { cancelled: boolean }

/** Play one text sequentially, stopping when the owner cancels or playback is replaced. */
export async function speakRepeatedText(text: string, count: number,
  speakOnce: (value: string) => Promise<RepeatSpeechResult>, signal?: AbortSignal): Promise<void> {
  const repetitions = Math.max(0, Math.min(3, Math.floor(count)));
  for (let index = 0; index < repetitions; index += 1) {
    if (signal?.aborted) break;
    const result = await speakOnce(text);
    if (signal?.aborted || result.cancelled) break;
  }
}

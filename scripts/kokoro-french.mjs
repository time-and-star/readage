import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const FRENCH_VOICE_SHA256 = 'a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861';
export const FRENCH_VOICE_URL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/4685882/voices/ff_siwis.bin';

/** A separate adapter: the installed English Kokoro.js package is never patched. */
export async function loadFrenchKokoro(tts, runtimeDir, voiceFile, Tensor) {
  const voiceBytes = await fs.readFile(voiceFile);
  if (createHash('sha256').update(voiceBytes).digest('hex') !== FRENCH_VOICE_SHA256) throw new Error('French voice checksum mismatch.');
  const voice = new Float32Array(voiceBytes.buffer.slice(voiceBytes.byteOffset, voiceBytes.byteOffset + voiceBytes.byteLength));
  const entry = path.join(runtimeDir, '@echogarden', 'espeak-ng-emscripten', 'espeak-ng.js');
  const { default: initialize } = await import(pathToFileURL(entry).href);
  const engine = await initialize();
  const worker = new engine.eSpeakNGWorker();
  worker.set_voice('fr-fr');
  const phonemize = text => {
    // Keep source punctuation and word spaces; French phonemes bypass all English normalization.
    return text.normalize('NFC').replace(/[’‘]/g, "'").split(/([;:,.!?…«»“”"()[\]{}—]\s*)/u)
      .map((part, index) => index % 2 || !part.trim() ? part : worker.synthesize_ipa(part).ipa.trim())
      .join('').replace(/\((?:[a-z]{2,3})(?:-[a-z]{2})?\)/g, '').replace(/[-^]/g, '').trim();
  };
  return {
    metadata: { name: 'Siwis', language: 'fr-fr', gender: 'Female' }, phonemize,
    async generate(text, { speed }) {
      const phones = phonemize(text);
      if (!phones) throw new Error('Empty French phonemes.');
      const { input_ids } = tts.tokenizer(phones, { truncation: false });
      const styleOffset = 256 * Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), 509);
      const began = performance.now();
      try {
        const { waveform } = await tts.model({ input_ids, style: new Tensor('float32', voice.slice(styleOffset, styleOffset + 256), [1, 256]),
          speed: new Tensor('float32', [speed], [1]) });
        return { audio: waveform.data };
      } finally { tts.inferenceTimeMs += performance.now() - began; }
    },
  };
}

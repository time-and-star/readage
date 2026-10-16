# Japanese local speech

Imported articles with language `ja` can be spoken with the Kokoro Japanese Alpha voice (`jf_alpha`, `ja-JP`).
The backend reuses the project's cached Kokoro-82M v1 ONNX network and generates 24 kHz mono PCM WAV audio.
Japanese shares the original English reading layout: use the existing menu's “听全文”, the selection toolbar's
“朗读”, or the word-card pronunciation button. Article language selects the tokenizer, dictionary, translation
source and speech voice; there is no separate Japanese reading screen or per-paragraph action row.

## Setup

```powershell
npm run tts:setup
npm run tts:setup-japanese
npm run tts:start
```

`tts:setup-japanese` installs the official 522 KB Alpha voice and lightweight Japanese pronunciation dependencies
under `local-data/kokoro-japanese/`. It downloads about 50 MB and needs Python 3.9–3.13; the Codex bundled Python
is detected automatically on Windows. Set `TTS_JAPANESE_PYTHON` to a Python executable when using another runtime.
The installer records the executable locally and verifies both the voice SHA-256 and kana/kanji pronunciation.
All voice and dictionary files remain in the ignored `local-data` directory.

Configure the application speech environment with:

```dotenv
TTS_LOCAL_ENGINE=kokoro-js
TTS_PROVIDER=openai-compatible
TTS_BASE_URL=http://127.0.0.1:8880/v1
TTS_MODEL=kokoro
TTS_VOICE_JA_JP=jf_alpha
TTS_AUDIO_FORMAT=wav
```

Restart an existing Kokoro service after installing Japanese support. `/v1/audio/voices` then lists `jf_alpha` with
language `ja-JP`; startup verifies a real Japanese waveform before the service advertises readiness.

## Frontend and inference

The adapter uses the unmodified official [Misaki Cutlet frontend](https://github.com/hexgrad/misaki/blob/main/misaki/cutlet.py),
which is Kokoro v1's original Japanese G2P. Fugashi/MeCab and UniDic Lite determine kanji readings, particle pronunciation,
vowel length and geminates. Python stays in a persistent stdin/stdout worker; inference remains in the existing Node ONNX model.
There is no separate Torch model or browser voice requirement.

Japanese sentences split at `。`, `！` and `？`, including adjacent sentences without spaces. Long sentences also split at
Japanese punctuation when the generated phonemes exceed the model's 512-token limit, so whole excerpts retain their text.
The source phonemes bypass the installed Kokoro.js English normalizer and use the official Japanese voice styles directly.

Voice provenance: [official Kokoro voices](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) and
[pinned ONNX Alpha voice](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/blob/468588286ebb2dd77c25b9771e5d165896538cce/voices/jf_alpha.bin).
The pinned Python packages are Misaki 0.9.4, Fugashi 1.5.2, Jaconv 0.5.0, Mojimoji 0.0.13 and UniDic Lite 1.0.8.
Their upstream licenses ship with the installed distributions.

Verify the engine with `npx tsx --test tests/kokoroJapanese.test.ts tests/kokoroService.test.ts tests/kokoroText.test.ts`.
The installed-G2P check skips when Japanese setup has not been run; the sentence and truncation regression checks always run.

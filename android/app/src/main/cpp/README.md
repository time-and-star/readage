ReadAge bundled Hy-MT2 runtime
=============================

The app uses official llama.cpp commit
`8ae386707bed05f02354dbfc6fa5ee0cf58e5f0f`. ARM64 packages shared llama/ggml
libraries and seven official CPU variants, from ARMv8 baseline to DotProd,
FP16, I8MM and newer optional instructions. The baseline-compiled score function
checks runtime CPU capabilities before any candidate's kernels are initialized.
The JNI runtime loads fixed packaged sonames through Android's linker namespace,
including APK-mapped libraries, rather than scanning writable data directories.
x86_64 and host acceptance retain the static CPU backend. Set
`READAGE_ARM_CPU_VARIANTS=OFF` only for a diagnostic baseline build.
NDK `28.2.13676358`, CMake `3.22.1`, Android API 31, ARM64 and x86_64 are
configured in the app's Gradle file. x86_64 enables actual Android emulator
acceptance without implying a physical-phone performance result. Native GPU,
OpenMP, subprocesses, HTTP/TLS, llama examples and servers are disabled.

`node scripts/prepare-android-translation.mjs --download` prepares the fixed
source archive and official Tencent `Hy-MT2-1.8B-Q4_K_M.gguf` (1,133,080,448
bytes, SHA256 `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699`).
The script checks the archive hash and records/checks every extracted source
file. Its default mode validates existing inputs without downloading. Models
and downloaded sources are ignored generated inputs. The component manifest
is `local-data/android-translation/bundle.json`; the shared runtime staging
script embeds the model, config and both license files in the installer.

The old desktop STQ1_0 1.25-bit model is deliberately not used: it depends on
a separate patched runtime and is not interchangeable with standard Q4_K_M.
Official sources: [Tencent model](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/tree/a0c709d9fac510f2c807aa3af52872340dc37a4a),
[fixed llama.cpp](https://github.com/ggml-org/llama.cpp/tree/8ae386707bed05f02354dbfc6fa5ee0cf58e5f0f),
[Android build guide](https://github.com/ggml-org/llama.cpp/blob/8ae386707bed05f02354dbfc6fa5ee0cf58e5f0f/docs/android.md).

Requests use the model's official hunyuan-dense user chat template with BOS
inserted once by its tokenizer, a 4096-token context, at most 768 output
tokens, and the Tencent recommended sampling values. One Java worker accepts
one active request and four queued requests. The deadline starts before the
queue; queued cancellations remove work immediately, while active cancellations
set a native atomic flag used by both the model loader and CPU graph abort
callback. The verified model and one successfully completed context are cached
for the process. A request can reuse only an exactly matching translation-instruction
prefix, ending before the selected text after the first blank line. The instruction
and body are processed as separate batches on both cache misses and hits, so batching
does not depend on the previous request. All prior body/output positions are removed;
the complete new body is decoded again and a fresh seeded sampler accepts the complete
current prompt, including its reused instruction tokens. A changed instruction or
unsupported partial KV removal falls back to clearing all KV metadata.
It borrows the cached context, changes the abort callback to its own request,
and returns the context only after EOS with the callback detached. Cancellation,
timeout or inference failure destroys the borrowed context. A model replacement
frees its old context before freeing the old model.

Optimized ARM weights are read into their final buffers rather than keeping both
the original mmap range and reordered weights resident. Baseline CPU retains mmap.
This preserves the official Q4_K_M model and avoids the roughly 882 MiB duplicated
mapped-weight footprint measured with repacking on the Exynos 1080 test device.
Only EOS-completed output is returned. Partial output on a
deadline, cancellation or length limit is rejected. JNI exchanges ordinary
UTF-8 byte arrays so supplementary scripts and emoji avoid modified UTF-8.

`ReadageTranslationTest` exercises the bundled GGUF through JNI on Android.
On firmware that freezes background instrumentation, the test-only
`ReadageTranslationTestRunner` substitutes a blank foreground Activity for the
target component. The shell harness responds to its readiness marker. Select this
runner only in the test build, and pass `-e waitForActivitiesToComplete false` so
AndroidX does not finish the blank Activity before every test. The class closes
its Activity after the four native checks; no reading WebView or learning profile
is opened. The verified 2026-10-14 harness and build-only runner override are in
`output/arm-translation-2026-10-14/`, with the installed APK and data fingerprints.
`readage_translation_host` is built from the same core for host-equivalent
acceptance when an Android runtime is unavailable; it takes model path,
UTF-8 prompt-file path, deadline milliseconds, and optional cancel-after
milliseconds. Host results never stand in for phone latency or ARM execution.

`READAGE_BUILD_TRANSLATION_BENCH=ON` builds `readage_translation_bench`, a
standalone diagnostic runner which never opens an application profile. It accepts
UTF-8 prompt files, repeated runs, fresh-context mode, an explicit CPU backend,
thread/batch tuning, mmap/read loading, cancellation and recovery. `--no-prefix-reuse`
selects the previous full-prompt prefill for comparison. Metrics include total input
tokens and `reusedInputTokens`; the latter never includes selected body text. Timings separate
model preparation, context setup, prefill and decode; Linux reports peak process RSS.
Its warning/error log filter matches JNI. `scripts/android-translation-benchmark.mjs`
requires an explicit adb serial, verifies the official model hash, uses only
`/data/local/tmp/readage-translation-bench-20261014`, and records repeated-request
isolation, hardware facts, battery temperature and artifact hashes. Its fifth
argument optionally selects comma-separated comparison profiles.

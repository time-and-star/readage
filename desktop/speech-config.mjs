export const KOKORO_FP32_MODEL_RELATIVE = 'local-data/kokoro-models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx';

/** Explicit local settings take precedence; choose the faster bundled CPU model by default. */
export function selectDesktopSpeechDtype({ configuredDtype, fp32Available = false } = {}) {
  const explicit = typeof configuredDtype === 'string' ? configuredDtype.trim() : undefined;
  if (explicit === 'q8' || explicit === 'fp32') return explicit;
  return fp32Available ? 'fp32' : 'q8';
}

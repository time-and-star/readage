#include "translation_core.h"
#include "llama.h"
#include <android/log.h>
#include <jni.h>
#include <mutex>
#include <unordered_map>

namespace {
std::mutex requests_mutex;
std::unordered_map<jlong, std::shared_ptr<readage::RequestState>> requests;
std::atomic<jlong> next_handle{1};
std::string bytes(JNIEnv * env, jbyteArray value) {
    if (!value) throw readage::TranslationError("INVALID_TRANSLATION_REQUEST");
    int length = env->GetArrayLength(value);
    if (length > 16384) throw readage::TranslationError("INVALID_TRANSLATION_REQUEST");
    std::string result(length, '\0');
    env->GetByteArrayRegion(value, 0, length, reinterpret_cast<jbyte *>(result.data()));
    return result;
}
void fail(JNIEnv * env, const char * code) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), code); }
void log_message(ggml_log_level level, const char * text, void *) {
    if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN)
        __android_log_write(level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN, "ReadageHyMt2", text);
}
}
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *, void *) {
    llama_log_set(log_message, nullptr);
    return JNI_VERSION_1_6;
}
extern "C" JNIEXPORT jstring JNICALL Java_cn_readage_app_NativeHyMt2_backend(JNIEnv * env, jclass) {
    try { return env->NewStringUTF(readage::last_translation_backend().c_str()); }
    catch (...) { return env->NewStringUTF("unavailable"); }
}
extern "C" JNIEXPORT jlong JNICALL Java_cn_readage_app_NativeHyMt2_create(JNIEnv * env, jclass, jint timeout) {
    try {
        auto state = std::make_shared<readage::RequestState>(timeout);
        jlong handle = next_handle.fetch_add(1);
        std::lock_guard<std::mutex> guard(requests_mutex);
        requests.emplace(handle, std::move(state));
        return handle;
    } catch (...) { fail(env, "LOCAL_TRANSLATION_UNAVAILABLE"); return 0; }
}
extern "C" JNIEXPORT void JNICALL Java_cn_readage_app_NativeHyMt2_cancel(JNIEnv *, jclass, jlong handle) {
    std::lock_guard<std::mutex> guard(requests_mutex);
    auto it = requests.find(handle);
    if (it != requests.end()) it->second->cancelled.store(true);
}
extern "C" JNIEXPORT void JNICALL Java_cn_readage_app_NativeHyMt2_release(JNIEnv *, jclass, jlong handle) {
    std::lock_guard<std::mutex> guard(requests_mutex);
    requests.erase(handle);
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_cn_readage_app_NativeHyMt2_translate(
    JNIEnv * env, jclass, jlong handle, jbyteArray model_path, jbyteArray instruction) {
    try {
        std::shared_ptr<readage::RequestState> state;
        {
            std::lock_guard<std::mutex> guard(requests_mutex);
            auto it = requests.find(handle);
            if (it == requests.end()) throw readage::TranslationError("LOCAL_TRANSLATION_CANCELLED");
            state = it->second;
        }
        readage::TranslationMetrics metrics;
        std::string result = readage::translate(bytes(env, model_path), bytes(env, instruction), state, &metrics);
        const auto actual_backend = metrics.gpu_backend.empty() ? "cpu:" + metrics.cpu_backend : "vulkan:" + metrics.gpu_backend;
        __android_log_print(ANDROID_LOG_INFO, "ReadageHyMt2",
            "translation backend=%s gpuBackend=%s gpuLayersRequested=%d gpuFallback=%d contextReused=%d reusedInputTokens=%d modelMs=%.1f contextMs=%.1f prefillMs=%.1f decodeMs=%.1f totalMs=%.1f inputTokens=%d outputTokens=%d",
            actual_backend.c_str(), metrics.gpu_backend.c_str(), metrics.gpu_layers_requested, metrics.gpu_fallback,
            metrics.context_reused, metrics.reused_input_tokens, metrics.model_ms, metrics.context_ms,
            metrics.prefill_ms, metrics.decode_ms, metrics.total_ms, metrics.input_tokens, metrics.output_tokens);
        jbyteArray output = env->NewByteArray(result.size());
        if (output) env->SetByteArrayRegion(output, 0, result.size(), reinterpret_cast<const jbyte *>(result.data()));
        return output;
    } catch (const readage::TranslationError & error) { fail(env, error.what()); }
      catch (...) { fail(env, "LOCAL_TRANSLATION_UNAVAILABLE"); }
    return nullptr;
}

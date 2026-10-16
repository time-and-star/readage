#pragma once
#include <atomic>
#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>

namespace readage {
struct RequestState {
    std::atomic<bool> cancelled{false};
    std::chrono::steady_clock::time_point deadline;
    explicit RequestState(int timeout_ms);
    bool stopped() const;
    void check() const;
};
class TranslationError : public std::runtime_error {
public:
    explicit TranslationError(const char * code) : std::runtime_error(code) {}
};
// Diagnostic tuning is used by the isolated benchmark; JNI uses these production defaults.
struct TranslationOptions {
    enum class Loading { Automatic, Mmap, Read };
    enum class Accelerator { Automatic, Cpu, Gpu };
    bool reuse_context = true;
    bool repack_weights = true;
    bool reuse_prompt_prefix = true;
    Loading loading = Loading::Automatic;
    Accelerator accelerator = Accelerator::Automatic;
    int gpu_layers = 99;
    bool flash_attention = true;
    bool offload_attention = true;
    int threads = 4;
    int batch_threads = 4;
    int batch_size = 128;
};
struct TranslationMetrics {
    double model_ms = 0, context_ms = 0, prefill_ms = 0, decode_ms = 0, total_ms = 0;
    int input_tokens = 0, output_tokens = 0;
    bool context_reused = false;
    int reused_input_tokens = 0; // Fixed instruction tokens only; selected body is always computed.
    std::string cpu_backend;
    std::string gpu_backend;
    int gpu_layers_requested = 0;
    bool gpu_fallback = false;
};
// The optional explicit library is for backend comparison in the benchmark only.
// ggml scores the library using baseline instruction code before initializing its kernels.
std::string initialize_cpu_backend(const std::string & library = {});
// Last successful request, never a claim based only on library availability.
std::string last_translation_backend();
// Shared by Android JNI and the host acceptance executable: exactly the same model loader,
// prompt, batching, cancellation callbacks, samplers and completion checks.
std::string translate(const std::string & model_path, const std::string & instruction,
                      const std::shared_ptr<RequestState> & request,
                      TranslationMetrics * metrics = nullptr,
                      const TranslationOptions & options = {});
}

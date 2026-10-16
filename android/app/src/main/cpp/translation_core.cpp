#include "translation_core.h"
#include "llama.h"
#include "ggml-backend.h"
#include <algorithm>
#include <mutex>
#include <string_view>
#include <thread>
#include <vector>

namespace readage {
std::string initialize_cpu_backend(const std::string & library) {
    static std::once_flag initialized;
    static std::string selected = "static-cpu";
    std::call_once(initialized, [&] {
#ifdef READAGE_ARM_CPU_VARIANTS
        if (!library.empty()) {
            if (!ggml_backend_load(library.c_str())) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
            selected = library;
        } else {
            // Bare sonames work in Android's linker namespace, including APK-mapped libs.
            // Do not enumerate /proc/self/exe (app_process) or writable data directories.
            // Each score function is compiled without the candidate's architecture flags.
            const char * candidates[] = {
                "libggml-cpu-android_armv9.2_2.so", "libggml-cpu-android_armv9.2_1.so",
                "libggml-cpu-android_armv9.0_1.so", "libggml-cpu-android_armv8.6_1.so",
                "libggml-cpu-android_armv8.2_2.so", "libggml-cpu-android_armv8.2_1.so",
                "libggml-cpu-android_armv8.0_1.so",
            };
            bool loaded = false;
            for (auto candidate : candidates) {
                if (ggml_backend_load(candidate)) { selected = candidate; loaded = true; break; }
            }
            if (!loaded) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
        }
#else
        if (!library.empty()) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
#endif
        llama_backend_init();
    });
    return selected;
}
RequestState::RequestState(int timeout_ms)
    : deadline(std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms)) {}
bool RequestState::stopped() const {
    return cancelled.load(std::memory_order_relaxed) || std::chrono::steady_clock::now() >= deadline;
}
void RequestState::check() const {
    if (cancelled.load(std::memory_order_relaxed)) throw TranslationError("LOCAL_TRANSLATION_CANCELLED");
    if (std::chrono::steady_clock::now() >= deadline) throw TranslationError("LOCAL_TRANSLATION_TIMEOUT");
}
namespace {
std::mutex backend_status_mutex;
std::string completed_backend = "uninitialized";
ggml_backend_dev_t gpu_device() {
    static std::once_flag initialized;
    static ggml_backend_dev_t device = nullptr;
    std::call_once(initialized, [] {
#ifdef READAGE_VULKAN
        try {
            auto backend = ggml_backend_load("libggml-vulkan.so");
            if (backend) for (size_t i = 0; i < ggml_backend_reg_dev_count(backend); ++i) {
                auto candidate = ggml_backend_reg_dev_get(backend, i);
                const auto type = ggml_backend_dev_type(candidate);
                if (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU) {
                    device = candidate;
                    break;
                }
            }
        } catch (...) { device = nullptr; }
#endif
    });
    return device;
}
bool abort_compute(void * data) { return static_cast<RequestState *>(data)->stopped(); }
bool loading_progress(float, void * data) { return !abort_compute(data); }
using Model = std::unique_ptr<llama_model, decltype(&llama_model_free)>;
using Context = std::unique_ptr<llama_context, decltype(&llama_free)>;
using Sampler = std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)>;
using Batch = std::unique_ptr<llama_batch_ext, decltype(&llama_batch_ext_free)>;
struct Engine {
    std::mutex mutex;
    Model model{nullptr, llama_model_free};
    std::string path;
    Context context{nullptr, llama_free};
    std::vector<llama_token> prefix_tokens;
    int batch_size = 0;
    bool flash_attention = true, offload_attention = true;
    bool mmap_model = true, repack_weights = true;
    ggml_backend_dev_t gpu = nullptr;
    int gpu_layers = 0;
    bool gpu_failed = false;
    Engine() { initialize_cpu_backend(); }
};
Engine & engine() { static Engine instance; return instance; }
void set_batch(llama_batch_ext * batch, const llama_token * tokens, int count, int position, bool logits) {
    llama_batch_ext_clear(batch);
    for (int i = 0; i < count; ++i) {
        int index = llama_batch_ext_add_token(batch, 0, tokens[i]);
        llama_pos pos = position + i;
        if (index < 0 || !llama_batch_ext_set_pos(batch, index, &pos))
            throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
    }
    if (logits && !llama_batch_ext_set_output_logits(batch, count - 1, true))
        throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
}
std::string piece(const llama_vocab * vocab, llama_token token) {
    std::vector<char> buffer(128);
    int n = llama_token_to_piece(vocab, token, buffer.data(), buffer.size(), 0, false);
    if (n < 0) {
        buffer.resize(-n);
        n = llama_token_to_piece(vocab, token, buffer.data(), buffer.size(), 0, false);
    }
    if (n < 0) throw TranslationError("LOCAL_TRANSLATION_INVALID_RESPONSE");
    return {buffer.data(), static_cast<size_t>(n)};
}
}
static std::string translate_once(const std::string & model_path, const std::string & instruction,
                      const std::shared_ptr<RequestState> & request, TranslationMetrics * metrics,
                      const TranslationOptions & options) {
    const auto started = std::chrono::steady_clock::now();
    auto elapsed = [](auto since) {
        return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - since).count();
    };
    request->check();
    if (metrics) { *metrics = {}; metrics->cpu_backend = initialize_cpu_backend(); }
    if (options.threads < 1 || options.threads > 8 || options.batch_threads < 1 || options.batch_threads > 8
        || options.batch_size < 32 || options.batch_size > 512 || options.gpu_layers < 1 || options.gpu_layers > 99)
        throw TranslationError("INVALID_TRANSLATION_REQUEST");
    request->check();
    Engine & runtime = engine();
    std::lock_guard<std::mutex> guard(runtime.mutex);
    request->check();
    auto gpu = options.accelerator == TranslationOptions::Accelerator::Cpu
        || (runtime.gpu_failed && options.accelerator == TranslationOptions::Accelerator::Automatic)
        ? nullptr : gpu_device();
    if (!gpu && options.accelerator == TranslationOptions::Accelerator::Gpu)
        throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
    // Repacking with mmap can keep both the original mapped range and the reordered
    // weights resident. Read into the final buffers on optimized ARM instead.
    const auto cpu_backend = initialize_cpu_backend();
    const bool baseline_cpu = cpu_backend == "static-cpu" || cpu_backend == "libggml-cpu-android_armv8.0_1.so";
    const bool mmap_model = options.loading == TranslationOptions::Loading::Mmap
        || (options.loading == TranslationOptions::Loading::Automatic && (baseline_cpu || gpu));
    if (!runtime.model || runtime.path != model_path || runtime.mmap_model != mmap_model
        || runtime.repack_weights != options.repack_weights || runtime.gpu != gpu
        || (gpu && runtime.gpu_layers != options.gpu_layers)) {
        const auto loading = std::chrono::steady_clock::now();
        // Release all buffers before switching devices; do not hold two full models.
        runtime.context.reset();
        runtime.prefix_tokens.clear();
        runtime.model.reset();
        auto params = llama_model_default_params();
        ggml_backend_dev_t devices[] = {gpu, nullptr};
        params.devices = devices;
        params.n_gpu_layers = gpu ? options.gpu_layers : 0;
        params.load_mode = mmap_model ? LLAMA_LOAD_MODE_MMAP : LLAMA_LOAD_MODE_NONE;
        params.use_extra_bufts = options.repack_weights;
        params.progress_callback = loading_progress;
        params.progress_callback_user_data = request.get();
        Model loaded(llama_model_load_from_file(model_path.c_str(), params), llama_model_free);
        request->check();
        if (!loaded) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
        char architecture[64];
        if (llama_model_meta_val_str(loaded.get(), "general.architecture", architecture, sizeof architecture) < 0
            || std::string(architecture) != "hunyuan-dense")
            throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
        // Free a context before replacing the model to which it points.
        runtime.context.reset();
        runtime.prefix_tokens.clear();
        runtime.model = std::move(loaded);
        runtime.path = model_path;
        runtime.mmap_model = mmap_model;
        runtime.repack_weights = options.repack_weights;
        runtime.gpu = gpu;
        runtime.gpu_layers = gpu ? options.gpu_layers : 0;
        if (metrics) metrics->model_ms = elapsed(loading);
    }
    if (metrics && runtime.gpu) {
        metrics->gpu_backend = ggml_backend_dev_description(runtime.gpu);
        metrics->gpu_layers_requested = runtime.gpu_layers;
    }
    const auto * vocab = llama_model_get_vocab(runtime.model.get());
    // The pinned official GGUF's user-only Jinja template is hunyuan-dense. Its formatter
    // omits BOS; tokenize(add_special=true) inserts the model's BOS exactly once.
    const llama_chat_message message{"user", instruction.c_str()};
    std::vector<char> formatted(instruction.size() + 256);
    int length = llama_chat_apply_template("hunyuan-dense", &message, 1, true, formatted.data(), formatted.size());
    if (length < 0) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
    if (length > static_cast<int>(formatted.size())) {
        formatted.resize(length);
        if (llama_chat_apply_template("hunyuan-dense", &message, 1, true, formatted.data(), formatted.size()) != length)
            throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
    }
    int token_count = -llama_tokenize(vocab, formatted.data(), length, nullptr, 0, true, true);
    constexpr int max_output = 768;
    constexpr int context_size = 4096;
    if (token_count <= 0) throw TranslationError("LOCAL_TRANSLATION_INVALID_RESPONSE");
    if (token_count + max_output > context_size) throw TranslationError("LOCAL_TRANSLATION_INCOMPLETE");
    std::vector<llama_token> tokens(token_count);
    if (llama_tokenize(vocab, formatted.data(), length, tokens.data(), tokens.size(), true, true) != token_count)
        throw TranslationError("LOCAL_TRANSLATION_INVALID_RESPONSE");
    std::vector<llama_token> prefix_tokens;
    if (options.reuse_prompt_prefix) {
        // Cache only the fixed translation instruction, never any selected body text.
        // Tokenizing the truncated header can merge its final whitespace differently;
        // keep only the tokens also present at the start of the complete prompt.
        const auto separator = instruction.find("\n\n");
        const auto offset = std::string_view(formatted.data(), length).find(instruction);
        if (separator != std::string::npos && offset != std::string_view::npos) {
            const int bytes = static_cast<int>(offset + separator + 2);
            const int count = -llama_tokenize(vocab, formatted.data(), bytes, nullptr, 0, true, true);
            if (count > 0) {
                prefix_tokens.resize(count);
                if (llama_tokenize(vocab, formatted.data(), bytes, prefix_tokens.data(), count, true, true) != count)
                    throw TranslationError("LOCAL_TRANSLATION_INVALID_RESPONSE");
                int matched = 0, limit = std::min(count, token_count - 1);
                while (matched < limit && prefix_tokens[matched] == tokens[matched]) ++matched;
                prefix_tokens.resize(matched);
            }
        }
    }
    request->check();
    const auto context_started = std::chrono::steady_clock::now();
    auto params = llama_context_default_params();
    params.n_ctx = context_size;
    params.n_batch = options.batch_size;
    params.n_ubatch = options.batch_size;
    params.flash_attn_type = options.flash_attention ? LLAMA_FLASH_ATTN_TYPE_AUTO : LLAMA_FLASH_ATTN_TYPE_DISABLED;
    params.offload_kqv = options.offload_attention;
    const auto available = std::max(1u, std::thread::hardware_concurrency());
    params.n_threads = std::min(unsigned(options.threads), available);
    params.n_threads_batch = std::min(unsigned(options.batch_threads), available);
    params.abort_callback = abort_compute;
    params.abort_callback_data = request.get();
    // Check the cached context out. Errors/cancellation destroy it automatically; only a
    // successful EOS returns it to the cache, with no callback pointing at an old request.
    Context ctx{nullptr, llama_free};
    if (options.reuse_context && runtime.batch_size == options.batch_size
        && runtime.flash_attention == options.flash_attention && runtime.offload_attention == options.offload_attention)
        ctx = std::move(runtime.context);
    if (metrics) metrics->context_reused = bool(ctx);
    int reused_tokens = 0;
    if (ctx && !prefix_tokens.empty() && runtime.prefix_tokens == prefix_tokens)
        reused_tokens = static_cast<int>(prefix_tokens.size());
    // Token metadata is valid only with its checked-out context. A failed request
    // destroys both. Selected body text is always decoded again to refresh logits.
    if (ctx) runtime.prefix_tokens.clear();
    if (!ctx) ctx.reset(llama_init_from_model(runtime.model.get(), params));
    else {
        auto memory = llama_get_memory(ctx.get());
        if (!reused_tokens || !llama_memory_seq_rm(memory, 0, reused_tokens, -1)) {
            llama_memory_clear(memory, false);
            reused_tokens = 0;
        }
        llama_set_n_threads(ctx.get(), params.n_threads, params.n_threads_batch);
        llama_set_abort_callback(ctx.get(), abort_compute, request.get());
    }
    request->check();
    if (!ctx) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
    if (metrics) { metrics->context_ms = elapsed(context_started); metrics->input_tokens = token_count; metrics->reused_input_tokens = reused_tokens; }
    Batch batch(llama_batch_ext_init(ctx.get()), llama_batch_ext_free);
    if (!batch) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
    Sampler sampler(llama_sampler_chain_init(llama_sampler_chain_default_params()), llama_sampler_free);
    if (!sampler) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
    llama_sampler_chain_add(sampler.get(), llama_sampler_init_penalties(llama_vocab_n_tokens(vocab), 64, 1.05f, 0.f, 0.f));
    llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_k(20));
    llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_p(0.6f, 1));
    llama_sampler_chain_add(sampler.get(), llama_sampler_init_temp(0.7f));
    llama_sampler_chain_add(sampler.get(), llama_sampler_init_dist(42));
    const auto prefill_started = std::chrono::steady_clock::now();
    for (int position = reused_tokens; position < token_count;) {
        request->check();
        // Keep the instruction/body split identical on cache hits and misses so a
        // request's batching and seeded result do not depend on the previous text.
        const int boundary = position < static_cast<int>(prefix_tokens.size())
            ? static_cast<int>(prefix_tokens.size()) : token_count;
        int count = std::min(options.batch_size, boundary - position);
        set_batch(batch.get(), tokens.data() + position, count, position, position + count == token_count);
        int status = llama_process(ctx.get(), LLAMA_PROCESS_TYPE_DECODE, batch.get());
        request->check();
        if (status != 0) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
        position += count;
    }
    if (metrics) metrics->prefill_ms = elapsed(prefill_started);
    // Match llama.cpp server's repetition history, which includes the user prompt.
    for (auto token : tokens) llama_sampler_accept(sampler.get(), token);
    std::string result;
    const auto decode_started = std::chrono::steady_clock::now();
    for (int generated = 0; generated < max_output; ++generated) {
        request->check();
        llama_token token = llama_sampler_sample(sampler.get(), ctx.get(), -1);
        if (llama_vocab_is_eog(vocab, token)) {
            request->check();
            if (result.empty()) throw TranslationError("LOCAL_TRANSLATION_INVALID_RESPONSE");
            if (metrics) {
                metrics->decode_ms = elapsed(decode_started);
                metrics->total_ms = elapsed(started);
                metrics->output_tokens = generated;
            }
            llama_set_abort_callback(ctx.get(), nullptr, nullptr);
            if (options.reuse_context) {
                runtime.context = std::move(ctx);
                runtime.prefix_tokens = std::move(prefix_tokens);
                runtime.batch_size = options.batch_size;
                runtime.flash_attention = options.flash_attention;
                runtime.offload_attention = options.offload_attention;
            }
            {
                std::lock_guard<std::mutex> status_guard(backend_status_mutex);
                completed_backend = runtime.gpu ? std::string("vulkan:") + ggml_backend_dev_description(runtime.gpu) : "cpu:" + cpu_backend;
            }
            return result;
        }
        result += piece(vocab, token);
        set_batch(batch.get(), &token, 1, token_count + generated, true);
        int status = llama_process(ctx.get(), LLAMA_PROCESS_TYPE_DECODE, batch.get());
        request->check();
        if (status != 0) throw TranslationError("LOCAL_TRANSLATION_UNAVAILABLE");
    }
    throw TranslationError("LOCAL_TRANSLATION_INCOMPLETE");
}
std::string last_translation_backend() {
    std::lock_guard<std::mutex> guard(backend_status_mutex);
    return completed_backend;
}
std::string translate(const std::string & model_path, const std::string & instruction,
                      const std::shared_ptr<RequestState> & request, TranslationMetrics * metrics,
                      const TranslationOptions & options) {
    const auto started = std::chrono::steady_clock::now();
    auto fallback = [&]() {
        request->check(); // Cancellation and the original deadline always take priority.
        if (options.accelerator != TranslationOptions::Accelerator::Automatic || !gpu_device()) return false;
        auto & runtime = engine();
        std::lock_guard<std::mutex> guard(runtime.mutex);
        if (runtime.gpu_failed) return false;
        runtime.gpu_failed = true;
        runtime.context.reset();
        runtime.prefix_tokens.clear();
        runtime.model.reset();
        runtime.gpu = nullptr;
        return true;
    };
    try { return translate_once(model_path, instruction, request, metrics, options); }
    catch (const TranslationError & error) {
        if (std::string(error.what()) != "LOCAL_TRANSLATION_UNAVAILABLE" || !fallback()) throw;
    } catch (const std::exception &) { if (!fallback()) throw; }
    auto cpu_options = options;
    cpu_options.accelerator = TranslationOptions::Accelerator::Cpu;
    auto output = translate_once(model_path, instruction, request, metrics, cpu_options);
    if (metrics) {
        metrics->gpu_fallback = true;
        metrics->total_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    }
    return output;
}
}

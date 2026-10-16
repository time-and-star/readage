#include "translation_core.h"
#include "llama.h"
#include <fstream>
#include <iostream>
#include <thread>
#include <vector>
#ifdef __linux__
#include <sys/resource.h>
#endif

namespace {
std::string quoted(const std::string & text) {
    std::string result = "\"";
    const char hex[] = "0123456789abcdef";
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') { result += '\\'; result += c; }
        else if (c < 32) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
        else result += c;
    }
    return result + '"';
}
std::string read(const std::string & file) {
    std::ifstream input(file, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot read prompt file");
    return {(std::istreambuf_iterator<char>(input)), {}};
}
}

// A standalone runner writes only stdout. It never opens an application profile or database.
int main(int argc, char ** argv) {
    try {
        // Match JNI's production log filter; verbose tensor logs distort load timings
        // when streamed through adb. No prompt/translation text is written to stderr.
        llama_log_set([](ggml_log_level level, const char * text, void *) {
            if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) std::cerr << text;
        }, nullptr);
        if (argc < 3) throw std::runtime_error("Usage: readage_translation_bench MODEL PROMPT... [--runs N] [--fresh-context] [--backend SONAME]");
        readage::TranslationOptions options;
        int runs = 1, timeout = 120000, cancel_after = -1;
        bool warmup = false, recover = false;
        std::string backend;
        std::vector<std::string> prompts;
        for (int i = 2; i < argc; ++i) {
            std::string arg = argv[i];
            auto value = [&]() { if (++i >= argc) throw std::runtime_error("Missing option value"); return std::string(argv[i]); };
            if (arg == "--runs") runs = std::stoi(value());
            else if (arg == "--threads") options.threads = std::stoi(value());
            else if (arg == "--batch-threads") options.batch_threads = std::stoi(value());
            else if (arg == "--batch") options.batch_size = std::stoi(value());
            else if (arg == "--timeout") timeout = std::stoi(value());
            else if (arg == "--cancel-after") cancel_after = std::stoi(value());
            else if (arg == "--backend") backend = value();
            else if (arg == "--cpu") options.accelerator = readage::TranslationOptions::Accelerator::Cpu;
            else if (arg == "--gpu") options.accelerator = readage::TranslationOptions::Accelerator::Gpu;
            else if (arg == "--gpu-layers") options.gpu_layers = std::stoi(value());
            else if (arg == "--no-flash-attn") options.flash_attention = false;
            else if (arg == "--cpu-attn") options.offload_attention = false;
            else if (arg == "--verbose") llama_log_set([](ggml_log_level, const char * text, void *) { std::cerr << text; }, nullptr);
            else if (arg == "--fresh-context") options.reuse_context = false;
            else if (arg == "--mmap") options.loading = readage::TranslationOptions::Loading::Mmap;
            else if (arg == "--read") options.loading = readage::TranslationOptions::Loading::Read;
            else if (arg == "--no-repack") options.repack_weights = false;
            else if (arg == "--no-prefix-reuse") options.reuse_prompt_prefix = false;
            else if (arg == "--warmup") warmup = true;
            else if (arg == "--recover") recover = true;
            else if (arg.rfind("--", 0) == 0) throw std::runtime_error("Unknown option");
            else prompts.push_back(arg);
        }
        if (prompts.empty() || runs < 1 || runs > 100 || timeout < 1 || cancel_after < -1)
            throw std::runtime_error("Invalid benchmark options");
        readage::initialize_cpu_backend(backend);
        const std::string hello = "将以下英语文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nHello.";
        if (warmup) readage::translate(argv[1], hello, std::make_shared<readage::RequestState>(120000), nullptr, options);
        int failures = 0;
        for (int run = 0; run < runs; ++run) for (const auto & file : prompts) {
            const auto prompt = read(file);
            auto request = std::make_shared<readage::RequestState>(timeout);
            readage::TranslationMetrics metrics;
            std::string result, error;
            std::thread canceller;
            if (cancel_after >= 0) canceller = std::thread([request, cancel_after] {
                std::this_thread::sleep_for(std::chrono::milliseconds(cancel_after)); request->cancelled = true;
            });
            const auto start = std::chrono::steady_clock::now();
            try { result = readage::translate(argv[1], prompt, request, &metrics, options); }
            catch (const std::exception & e) { error = e.what(); ++failures; }
            const double wall_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            if (canceller.joinable()) canceller.join();
            long max_rss_kb = 0;
#ifdef __linux__
            struct rusage usage{};
            if (getrusage(RUSAGE_SELF, &usage) == 0) max_rss_kb = usage.ru_maxrss;
#endif
            std::cout << "{\"run\":" << run << ",\"prompt\":" << quoted(file)
                << ",\"backend\":" << quoted(metrics.cpu_backend) << ",\"contextReused\":" << (metrics.context_reused ? "true" : "false")
                << ",\"gpuBackend\":" << quoted(metrics.gpu_backend) << ",\"gpuLayersRequested\":" << metrics.gpu_layers_requested
                << ",\"gpuFallback\":" << (metrics.gpu_fallback ? "true" : "false")
                << ",\"reusedInputTokens\":" << metrics.reused_input_tokens
                << ",\"modelMs\":" << metrics.model_ms << ",\"contextMs\":" << metrics.context_ms
                << ",\"prefillMs\":" << metrics.prefill_ms << ",\"decodeMs\":" << metrics.decode_ms
                << ",\"wallMs\":" << wall_ms << ",\"inputTokens\":" << metrics.input_tokens
                << ",\"outputTokens\":" << metrics.output_tokens << ",\"maxRssKb\":" << max_rss_kb << ",\"output\":" << quoted(result)
                << ",\"error\":" << quoted(error) << "}" << std::endl;
            if (recover && !error.empty()) {
                readage::TranslationMetrics recovery;
                auto output = readage::translate(argv[1], hello, std::make_shared<readage::RequestState>(120000), &recovery, options);
                std::cout << "{\"recovery\":true,\"contextReused\":" << (recovery.context_reused ? "true" : "false")
                    << ",\"reusedInputTokens\":" << recovery.reused_input_tokens
                    << ",\"output\":" << quoted(output) << "}" << std::endl;
            }
        }
        return failures ? 1 : 0;
    } catch (const std::exception & error) { std::cerr << error.what() << std::endl; return 2; }
}

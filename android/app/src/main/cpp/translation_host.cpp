#include "translation_core.h"
#include <fstream>
#include <iostream>
#include <thread>

// Host-equivalent acceptance executable; this does not claim Android-device validation.
// Prompt files avoid Windows console code-page conversion of Chinese and emoji.
int main(int argc, char ** argv) {
    if (argc < 3) return 2;
    std::ifstream input(argv[2], std::ios::binary);
    std::string prompt((std::istreambuf_iterator<char>(input)), {});
    int timeout = argc > 3 ? std::stoi(argv[3]) : 120000;
    const bool warmup = argc > 5 && std::string(argv[5]) == "--warmup";
    if (warmup) {
        auto warm_state = std::make_shared<readage::RequestState>(120000);
        auto warm = readage::translate(argv[1], "将以下英语文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nHello.", warm_state);
        if (warm.empty()) return 3;
    }
    auto state = std::make_shared<readage::RequestState>(timeout);
    std::thread canceller;
    if (argc > 4) canceller = std::thread([state, argv] {
        std::this_thread::sleep_for(std::chrono::milliseconds(std::stoi(argv[4])));
        state->cancelled = true;
    });
    int exit_code = 0;
    std::string error_code;
    try { std::cout << readage::translate(argv[1], prompt, state) << std::endl; }
    catch (const std::exception & error) { error_code = error.what(); exit_code = 1; }
    if (canceller.joinable()) canceller.join();
    if (warmup && error_code == "LOCAL_TRANSLATION_CANCELLED") {
        auto fresh = std::make_shared<readage::RequestState>(120000);
        auto recovery = readage::translate(argv[1], "将以下英语文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nGood morning.", fresh);
        if (recovery.empty()) return 4;
    }
    if (!error_code.empty()) std::cerr << error_code << std::endl;
    return exit_code;
}

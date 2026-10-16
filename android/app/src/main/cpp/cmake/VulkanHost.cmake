# Shader generation runs on the build host, never with the Android cross compiler.
get_filename_component(READAGE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../../.." ABSOLUTE)
set(READAGE_HOST_BIN "${READAGE_ROOT}/tmp/android-tools/llvm-mingw/llvm-mingw-20261006-ucrt-x86_64/bin")
set(CMAKE_C_COMPILER "${READAGE_HOST_BIN}/gcc.exe" CACHE FILEPATH "" FORCE)
set(CMAKE_CXX_COMPILER "${READAGE_HOST_BIN}/g++.exe" CACHE FILEPATH "" FORCE)
set(CMAKE_MAKE_PROGRAM "${READAGE_ROOT}/tmp/android-tools/sdk/cmake/3.22.1/bin/ninja.exe" CACHE FILEPATH "" FORCE)

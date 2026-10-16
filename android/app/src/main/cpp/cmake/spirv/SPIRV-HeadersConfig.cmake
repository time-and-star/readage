# Header-only upstream library; no host/target binary installation is needed.
if(NOT TARGET SPIRV-Headers::SPIRV-Headers)
    add_library(SPIRV-Headers::SPIRV-Headers INTERFACE IMPORTED GLOBAL)
    set_target_properties(SPIRV-Headers::SPIRV-Headers PROPERTIES INTERFACE_INCLUDE_DIRECTORIES
        "${READAGE_VULKAN_DEPS}/SPIRV-Headers-${READAGE_KHRONOS_VERSION}/include")
endif()

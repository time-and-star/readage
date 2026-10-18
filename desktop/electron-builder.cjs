const splitInstallerAssets = process.env.READAGE_SPLIT_INSTALLER_ASSETS === '1';

module.exports = {
  appId: 'com.readge.local',
  productName: 'ReadAge',
  electronVersion: '44.5.1',
  directories: { output: 'build/desktop', buildResources: 'desktop/resources' },
  extraMetadata: { main: 'desktop/main.mjs' },
  extraResources: [
    ...(splitInstallerAssets
      ? [{ from: 'build/desktop-installer/asset-layout.json', to: 'installer-assets.json' }]
      : [
        { from: 'build/desktop-resources', to: 'offline-resources', filter: ['manifest.json', 'workspace/**', 'licenses/**'] },
        { from: 'build/desktop-dictionaries', to: 'released-dictionaries', filter: ['manifest.json', 'dictionaries/**'] },
      ]),
    { from: 'desktop/resources', to: 'brand', filter: ['readge.png', 'readge.ico', 'icon-manifest.json'] },
  ],
  files: [
    'dist/**', 'desktop/**', 'scripts/kokoro-service.mjs', 'scripts/kokoro-french.mjs', 'scripts/kokoro-japanese.mjs',
    'scripts/kokoro-japanese-g2p.py', 'scripts/hymt2-service.mjs', 'scripts/local-process.mjs',
    'vendor/nextword-local-dictionary/**', 'data/dictionary/readage/**', 'data/dictionary/revisions/**',
    'package.json', 'website/update-protocol.mjs', 'website/installer-delta-protocol.mjs', 'LICENSE', 'NOTICE', '!**/*.map', '!**/tests/**', '!**/.env*', '!local-data/**', '!data/magazines/**',
    '!desktop/*.test.mjs', '!desktop/README.md',
    '!node_modules/@capacitor/android{,/**}',
  ],
  asar: true,
  asarUnpack: ['**/*.node', '**/*.dll', '**/*.exe', '**/onnxruntime-node/**', 'scripts/kokoro-japanese-g2p.py'],
  npmRebuild: true,
  afterPack: './desktop/verify-package-layout.cjs',
  win: { executableName: 'readge', icon: 'desktop/resources/readge.ico', target: [{ target: 'nsis', arch: ['x64'] }], artifactName: 'ReadAge-${version}-windows-${arch}-setup.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
    include: splitInstallerAssets ? 'build/desktop-installer/installer.nsh' : 'desktop/resources/installer.nsh',
    // The independent payload owns customFiles_x64. Keep future media in the
    // core archive rather than letting builder generate a conflicting macro.
    ...(splitInstallerAssets ? { preCompressedFileExtensions: [] } : {}),
    createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'ReadAge',
    installerIcon: 'desktop/resources/readge.ico', uninstallerIcon: 'desktop/resources/readge.ico',
    installerHeaderIcon: 'desktop/resources/readge.ico', deleteAppDataOnUninstall: false },
  publish: null,
};

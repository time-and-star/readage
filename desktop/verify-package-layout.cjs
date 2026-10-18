// Fail before making an installer if a dependency or physical file recreates
// the legacy upgrade failure. This hook does not modify the package contents.
module.exports = async ({ appOutDir }) => {
  const path = require('node:path');
  const fs = require('node:fs/promises');
  const asar = require('@electron/asar');
  const { verifyDesktopInstallLayout } = await import('./install-layout.mjs');
  const archiveNames = asar.listPackage(path.join(appOutDir, 'resources/app.asar'));
  let additionalFiles = [];
  if (process.env.READAGE_SPLIT_INSTALLER_ASSETS === '1') {
    const { verifyInstallerCoreAssets } = await import('./installer-payload.mjs');
    await verifyInstallerCoreAssets({ directory: appOutDir });
    const metadata = JSON.parse(await fs.readFile(path.join(appOutDir, 'resources/installer-assets.json'), 'utf8'));
    additionalFiles = metadata.files.map(file => file.path);
  }
  await verifyDesktopInstallLayout(appOutDir, archiveNames, { additionalFiles });
};

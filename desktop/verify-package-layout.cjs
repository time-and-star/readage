// Fail before making an installer if a dependency or physical file recreates
// the legacy upgrade failure. This hook does not modify the package contents.
module.exports = async ({ appOutDir }) => {
  const path = require('node:path');
  const asar = require('@electron/asar');
  const { verifyDesktopInstallLayout } = await import('./install-layout.mjs');
  await verifyDesktopInstallLayout(appOutDir, asar.listPackage(path.join(appOutDir, 'resources/app.asar')));
};

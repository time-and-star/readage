import path from 'node:path';

export const DESKTOP_APP_ID = 'com.readge.local';

export function desktopWindowBranding({ appRoot, isPackaged, resourcesPath }) {
  return { title: 'ReadAge', icon: isPackaged
    ? path.join(resourcesPath, 'brand', 'readge.png')
    : path.join(appRoot, 'desktop', 'resources', 'readge.png') };
}

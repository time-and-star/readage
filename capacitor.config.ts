import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cn.readage.app',
  appName: 'ReadAge',
  webDir: 'dist-android',
  android: { allowMixedContent: false },
  // The product uses a light canvas: LIGHT requests dark system-bar icons.
  plugins: { SystemBars: { style: 'LIGHT' } },
  server: { androidScheme: 'https', hostname: 'localhost', cleartext: false },
};
export default config;

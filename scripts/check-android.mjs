import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

const environment = androidToolchainEnvironment();
const java = environment.JAVA_HOME ? path.join(environment.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const checked = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true });
const sdk = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT || (process.platform === 'win32' ? path.join(environment.LOCALAPPDATA || '', 'Android', 'Sdk') : '');
const missing = [];
if (checked.error || checked.status !== 0) missing.push('Java 21（可使用 Android Studio 内置 JDK 并设置 JAVA_HOME）');
else if (!/version "(?:2[1-9]|[3-9]\d)\./.test(checked.stderr + checked.stdout)) missing.push('Java 21 或更新版本');
if (!sdk || !fs.existsSync(path.join(sdk, 'platforms', 'android-36', 'android.jar'))) missing.push('Android SDK Platform 36（设置 ANDROID_HOME）');
if (!sdk || !fs.existsSync(path.join(sdk, 'build-tools', '36.0.0'))) missing.push('Android SDK Build Tools 36.0.0');
if (missing.length) {
  console.error(`APK 构建尚缺少：\n${missing.map(item => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else console.log('Android 构建环境已就绪。请运行 npm run android:apk；设备验收需 Android 12 以上手机。');

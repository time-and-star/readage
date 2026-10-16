import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Prefer configured tools; the task's portable tools never change system settings. */
export function androidToolchainEnvironment(environment = process.env) {
  const result = { ...environment };
  const portable = path.join(root, 'tmp', 'android-tools');
  const jdks = path.join(portable, 'jdk');
  if (!result.JAVA_HOME && fs.existsSync(jdks)) {
    const match = fs.readdirSync(jdks).find(name => fs.existsSync(path.join(jdks, name, 'bin', 'java.exe')));
    if (match) result.JAVA_HOME = path.join(jdks, match);
  }
  if (!result.ANDROID_HOME && !result.ANDROID_SDK_ROOT && fs.existsSync(path.join(portable, 'sdk', 'platforms'))) {
    result.ANDROID_HOME = path.join(portable, 'sdk');
  }
  if (result.JAVA_HOME) result.PATH = `${path.join(result.JAVA_HOME, 'bin')}${path.delimiter}${result.PATH || result.Path || ''}`;
  if (fs.existsSync(path.join(portable, 'gradle-home'))) result.GRADLE_USER_HOME ??= path.join(portable, 'gradle-home');
  return result;
}

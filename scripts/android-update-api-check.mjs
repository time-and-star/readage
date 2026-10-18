import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { androidToolchainEnvironment } from './android-toolchain.mjs';

/** Uses already cached SDK/dependency classes. Does not invoke a product build. */
export async function compileAndroidUpdateApi(output) {
  const root = process.cwd(), env = androidToolchainEnvironment();
  const cached = path.join(root, 'tmp/android-tools/gradle-user/caches/8.14.3/transforms'), jars = [];
  for (const hash of await fs.readdir(cached)) {
    const transformed = path.join(cached, hash, 'transformed');
    for (const name of await fs.readdir(transformed).catch(() => [])) {
      const file = path.join(transformed, name, 'jars/classes.jar'); if (await fs.stat(file).catch(() => null)) jars.push(file);
    }
  }
  const modules = path.join(root, 'tmp/android-tools/gradle-user/caches/modules-2/files-2.1');
  for (const [group, name] of [['androidx.lifecycle', 'lifecycle-common'], ['androidx.annotation', 'annotation-jvm'], ['org.jetbrains.kotlin', 'kotlin-stdlib']]) {
    const folder = path.join(modules, group, name);
    for (const version of await fs.readdir(folder)) for (const hash of await fs.readdir(path.join(folder, version))) {
      for (const name of await fs.readdir(path.join(folder, version, hash))) if (name.endsWith('.jar')) jars.push(path.join(folder, version, hash, name));
    }
  }
  const cp = [path.join(root, 'tmp/android-tools/sdk/platforms/android-36/android.jar'),
    path.join(root, 'node_modules/@capacitor/android/capacitor/build/intermediates/compile_library_classes_jar/debug/bundleLibCompileToJarDebug/classes.jar'),
    path.join(root, 'android/app/build/intermediates/compile_and_runtime_not_namespaced_r_class_jar/debug/processDebugResources/R.jar'),
    path.join(root, 'android/app/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes'), ...jars];
  await fs.mkdir(output, { recursive: true });
  const args = ['-encoding', 'UTF-8', '-cp', cp.join(path.delimiter), '-d', output,
    ...['WebPatchEngine.java', 'NativeAppUpdateHttp.java', 'NativeInstallerUpdate.java', 'InstallerDownloadService.java', 'ReadageAppUpdatesPlugin.java', 'MainActivity.java'].map(n => path.join(root, 'android/app/src/main/java/cn/readage/app', n))];
  const argfile = path.join(output, 'javac-args.txt'); await fs.writeFile(argfile, args.map(s => '"' + s.replaceAll('\\', '/') + '"').join('\n'));
  const result = spawnSync(path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'), ['@' + argfile], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  process.stdout.write((result.stdout || '') + (result.stderr || ''));
  if (result.status !== 0) throw new Error('Android 更新桥接源码 API 检查失败。');
}

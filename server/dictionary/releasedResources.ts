import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const releasedDirectories = {
  wordnet: 'wordnet-3.1',
  french: 'wiktionary-fr',
  frenchChinese: 'wiktionary-fr-zh',
  japaneseChinese: 'wiktionary-ja-zh',
} as const;
const dictionaryIds = { wordnet: 'wordnet', french: 'wiktionary-fr', frenchChinese: 'wiktionary-fr-zh', japaneseChinese: 'wiktionary-ja-zh' };
const environmentNames = {
  wordnet: 'DICTIONARY_WORDNET_DIR', french: 'DICTIONARY_FRENCH_DIR',
  frenchChinese: 'DICTIONARY_FRENCH_CHINESE_DIR', japaneseChinese: 'DICTIONARY_JAPANESE_CHINESE_DIR',
} as const;
type ReleasedDictionaryKind = keyof typeof releasedDirectories;
interface BundleFile { path: string; bytes: number; sha256: string }

/** Explicit/user-installed resources take precedence; packaged releases never write personal imports. */
export function resolveReleasedDictionaryDirectories(env: NodeJS.ProcessEnv = process.env, workspace = process.cwd()) {
  const output: Partial<Record<`${ReleasedDictionaryKind}Dir`, string>> = {};
  const bundleRoot = env.READGE_RELEASED_DICTIONARIES_ROOT?.trim();
  let bundle: { schema: number; kind: string; dictionaries: Array<{ id: string; directory: string }>; files: BundleFile[] } | undefined;
  if (bundleRoot) {
    bundle = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'manifest.json'), 'utf8'));
    if (bundle?.schema !== 1 || bundle.kind !== 'readge-released-dictionaries'
      || !Array.isArray(bundle.dictionaries) || !Array.isArray(bundle.files)) throw new Error('安装包发布词典清单无效。');
  }
  for (const kind of Object.keys(releasedDirectories) as ReleasedDictionaryKind[]) {
    const explicit = env[environmentNames[kind]]?.trim();
    const installed = path.resolve(workspace, 'data/dictionary/imported', releasedDirectories[kind]);
    if (explicit || fs.existsSync(path.join(installed, 'manifest.json'))) {
      output[`${kind}Dir`] = explicit || installed;
      continue;
    }
    if (!bundle || !bundleRoot) continue;
    const relative = `dictionaries/${releasedDirectories[kind]}`;
    const declared = bundle.dictionaries.find(item => item.id === dictionaryIds[kind]);
    if (declared?.directory !== relative) throw new Error(`安装包缺少发布词典：${dictionaryIds[kind]}`);
    // Database/index bytes are verified by their read-only adapters. Verify small declaration and license files here.
    for (const name of ['manifest.json', 'LICENSE.txt']) {
      const entry = bundle.files.find(file => file.path === `${relative}/${name}`);
      const file = path.join(bundleRoot, relative, name);
      const stat = fs.lstatSync(file);
      if (!entry || !stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes
        || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256) {
        throw new Error(`安装包发布词典声明或许可校验失败：${relative}/${name}`);
      }
    }
    output[`${kind}Dir`] = path.join(bundleRoot, relative);
  }
  return output;
}

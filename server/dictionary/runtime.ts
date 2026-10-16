import path from 'node:path';
import { abortable, createDictionaryService } from '../../packages/dictionary/core';
import type { DictionaryAdapter, DictionaryService, DictionaryServiceConfig, LanguageAdapter, LearningTermRef, LookupResult } from '../../packages/dictionary/contracts';
import { englishLanguageAdapter, isEnglishWord } from '../../packages/dictionary/languages/english';
import { EcdictAdapter } from '../../packages/dictionary/server/ecdict';
import { NativeReviewedAdapter } from '../../packages/dictionary/server/nativeReviewed';
import { ReadAgeAuthoredAdapter } from '../../packages/dictionary/server/readageAuthored';
import { WordNetAdapter } from '../../packages/dictionary/server/wordnet';
import { WiktionaryFrenchAdapter } from '../../packages/dictionary/server/wiktionaryFrench';
import { frenchLanguageAdapter } from '../../packages/dictionary/languages/french';
import { WiktionaryJapaneseAdapter } from '../../packages/dictionary/server/wiktionaryJapanese';
import { japaneseLanguageAdapter } from '../../packages/dictionary/languages/japanese';
import { LearningWordIdResolver } from '../../src/lib/learningWordIds';
import { DictionarySettingsManager } from './settings';
import { createDictionaryImporter, discoverImportedDictionaries, DictionaryImportError, type DictionaryImportInput } from './imports';
import { resolveReleasedDictionaryDirectories } from './releasedResources';
import { createDistributionImporter, installedDictionaryDirectories } from './distributionImports';

export interface DictionaryRuntimeOptions extends DictionaryServiceConfig {
  dataDir?: string;
  revisionFile?: string;
  manifestPath?: string;
  readageDir?: string;
  wordnetDir?: string;
  frenchDir?: string;
  frenchChineseDir?: string;
  japaneseChineseDir?: string;
  /** Persistence is opt-in for factory users; the application singleton supplies its local file. */
  settingsFile?: string;
  importsDir?: string;
  additionalDictionaries?: readonly DictionaryAdapter[];
  additionalLanguages?: readonly LanguageAdapter[];
}

/** Application wiring; neither adapters nor core depend on application learning storage. */
export function createDictionaryRuntime(options: DictionaryRuntimeOptions = {}) {
  const installed = installedDictionaryDirectories(options.importsDir);
  let ecdict = new EcdictAdapter({ dataDir: installed.dataDir ?? options.dataDir });
  let native = !installed.readageDir && (options.revisionFile || options.manifestPath)
    ? new NativeReviewedAdapter({ revisionFile: options.revisionFile, manifestPath: options.manifestPath })
    : new ReadAgeAuthoredAdapter({ dataDir: installed.readageDir ?? options.readageDir });
  const wordnet = options.wordnetDir ? new WordNetAdapter({ dataDir: options.wordnetDir }) : undefined;
  const french = options.frenchDir ? new WiktionaryFrenchAdapter({ dataDir: options.frenchDir }) : undefined;
  const frenchChinese = options.frenchChineseDir ? new WiktionaryFrenchAdapter({ dataDir: options.frenchChineseDir, edition: 'zh', morphologyAdapter: french }) : undefined;
  const japaneseChinese = options.japaneseChineseDir ? new WiktionaryJapaneseAdapter({ dataDir: options.japaneseChineseDir }) : undefined;
  const additional = [...(wordnet ? [wordnet] : []), ...(french ? [french] : []), ...(frenchChinese ? [frenchChinese] : []), ...(japaneseChinese ? [japaneseChinese] : []), ...discoverImportedDictionaries(options.importsDir), ...(options.additionalDictionaries ?? [])];
  const registeredIds = ['native-reviewed', 'ecdict', ...additional.map(adapter => adapter.metadata.id)];
  const dictionaries = new Map<string, DictionaryAdapter>();
  const languages = new Map<string, LanguageAdapter>();
  function addDictionary(adapter: DictionaryAdapter) {
    if (!adapter.metadata.id || dictionaries.has(adapter.metadata.id)) throw new Error(`Dictionary already registered or invalid: ${adapter.metadata.id}`);
    dictionaries.set(adapter.metadata.id, adapter);
  }
  function addLanguage(adapter: LanguageAdapter) {
    const key = adapter.language.toLowerCase();
    if (languages.has(key)) throw new Error(`Language already registered: ${adapter.language}`);
    languages.set(key, adapter);
  }
  addLanguage(englishLanguageAdapter);
  addLanguage(japaneseLanguageAdapter);
  if (french || frenchChinese) addLanguage(frenchLanguageAdapter);
  addDictionary(native);
  addDictionary(ecdict);
  for (const language of options.additionalLanguages ?? []) addLanguage(language);
  for (const dictionary of additional) addDictionary(dictionary);
  function buildCore(config: DictionaryServiceConfig) {
    const next = createDictionaryService(config);
    for (const language of languages.values()) next.registerLanguage(language);
    for (const dictionary of dictionaries.values()) next.registerDictionary(dictionary);
    return next;
  }
  let core: DictionaryService;
  const settings = new DictionarySettingsManager({ installedIds: registeredIds, settingsFile: options.settingsFile,
    startupConfig: { enabledSources: options.enabledSources,
      sourceOrder: options.sourceOrder ?? ['native-reviewed', 'ecdict'], defaultSource: options.defaultSource ?? 'native-reviewed' },
    prepareApply: config => {
      const next = buildCore(config);
      return () => { core = next; };
    },
  });
  core = buildCore(settings.snapshot().settings);

  // Display source selection never participates in this resolver. ECDICT remains
  // the existing English morphology authority even when disabled for display.
  const identities = new LearningWordIdResolver(async words => Promise.all(words.map(async word => {
    const request = { text: word, language: 'en', candidates: englishLanguageAdapter.candidates!(word) };
    try {
      const matches = await ecdict.lookup(request);
      return matches[0]?.entry.headword ?? null;
    } catch {
      // A native-only exact term is a valid unit even without the old pack.
      const matches = await native.lookup(request);
      if (matches.some(match => englishLanguageAdapter.normalize(match.entry.headword) === word)) return word;
      throw new Error('Learning-word morphology is unavailable.');
    }
  })));
  async function resolveLearningTerms(words: readonly string[]): Promise<LearningTermRef[]> {
    return (await identities.resolve(words)).map(stableId => ({ language: 'en', kind: stableId.includes(' ') ? 'phrase' : 'word', stableId }));
  }
  async function attachIdentity(result: LookupResult): Promise<LookupResult> {
    if (result.status === 'invalid_request' || !/^en(?:-|$)/i.test(result.request.language)) return result;
    if (!isEnglishWord(result.request.text) && !/^[a-z\s'-]+$/i.test(result.request.text.trim())) return result;
    // Identity failure does not turn a successfully read source into a miss.
    // Missing identity stays explicit; evidence callers must retry the identity API.
    try { return { ...result, learningTermRef: (await resolveLearningTerms([result.request.text]))[0] }; }
    catch { return { ...result, learningTermRef: undefined }; }
  }
  const service: DictionaryService = {
    registerLanguage(adapter) {
      settings.assertCanRegister();
      core.registerLanguage(adapter);
      addLanguage(adapter);
    },
    registerDictionary(adapter) {
      settings.assertCanRegister();
      addDictionary(adapter);
      try { settings.addSource(adapter.metadata.id, options.enabledSources === undefined && !settings.hasSavedPreferences); }
      catch (error) { dictionaries.delete(adapter.metadata.id); throw error; }
    },
    listSources: () => core.listSources(),
    getEntry: (request, signal) => core.getEntry(request, signal),
    lookup: async (request, signal) => abortable(attachIdentity(await core.lookup(request, signal)), signal),
    lookupMany: async (requests, signal) => abortable(Promise.all((await core.lookupMany(requests, signal)).map(attachIdentity)), signal),
  };
  const importer = options.importsDir ? createDictionaryImporter({ directory: options.importsDir,
    findSource: id => dictionaries.get(id), snapshot: () => ({ ...settings.snapshot(), catalog: service.listSources() }),
    install: adapter => settings.installSource(adapter.metadata.id, () => {
      addDictionary(adapter);
      return () => { dictionaries.delete(adapter.metadata.id); };
    }),
  }) : undefined;
  const distribution = options.importsDir ? createDistributionImporter({ directory: options.importsDir,
    snapshot: () => ({ ...settings.snapshot(), catalog: service.listSources() }),
    install: async (adapter, commit) => {
      await settings.replaceSource(adapter.metadata.id, () => {
        const previous = dictionaries.get(adapter.metadata.id)!; dictionaries.set(adapter.metadata.id, adapter);
        return () => { dictionaries.set(adapter.metadata.id, previous); };
      }, commit);
      if (adapter instanceof EcdictAdapter) ecdict = adapter;
      if (adapter instanceof ReadAgeAuthoredAdapter) native = adapter;
      identities.clear();
    },
  }) : undefined;
  async function importDictionary(input: DictionaryImportInput) {
    if (!importer) throw new DictionaryImportError(503, 'DICTIONARY_IMPORT_NOT_CONFIGURED', '词典导入目录未配置。');
    if (/\.(?:pack|nwdict|zip)$/i.test(input.filename)) return distribution!.import(input);
    return importer.import(input);
  }
  return { service, settings, get ecdict() { return ecdict; }, get native() { return native; }, wordnet, french, frenchChinese, japaneseChinese, resolveLearningTerms, importDictionary };
}

let runtime: ReturnType<typeof createDictionaryRuntime> | undefined;
export function getDictionaryRuntime() {
  if (!runtime) {
    const enabledSources = process.env.DICTIONARY_SOURCES?.split(',').map(id => id.trim()).filter(Boolean);
    const releasedDirectories = resolveReleasedDictionaryDirectories();
    runtime = createDictionaryRuntime({
      enabledSources, sourceOrder: process.env.DICTIONARY_SOURCE_ORDER?.split(',').map(id => id.trim()).filter(Boolean),
      defaultSource: process.env.DICTIONARY_DEFAULT_SOURCE?.trim() || enabledSources?.[0],
      dataDir: process.env.DICTIONARY_DATA_DIR?.trim() || undefined,
      readageDir: process.env.DICTIONARY_READAGE_DIR?.trim() || undefined,
      revisionFile: process.env.DICTIONARY_REVISIONS_FILE?.trim() || undefined,
      manifestPath: process.env.DICTIONARY_REVISION_MANIFEST?.trim() || undefined,
      ...releasedDirectories,
      settingsFile: process.env.DICTIONARY_SETTINGS_FILE?.trim() || path.resolve('local-data/dictionary/settings.json'),
      importsDir: process.env.DICTIONARY_IMPORTS_DIR?.trim() || path.resolve('local-data/dictionary/imports'),
    });
  }
  return runtime;
}

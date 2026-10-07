import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';

test('web, extension and public dictionary entry points contain no server adapters or dictionary files', () => {
  for (const entryPoint of ['src/lib/wordCard.ts', 'extension/background.ts', 'packages/dictionary/index.ts',
    'src/components/DictionarySettingsScreen.tsx', 'src/components/DictionaryOriginalContent.tsx']) {
    const build = buildSync({ entryPoints: [entryPoint], absWorkingDir: process.cwd(), bundle: true, write: false,
      platform: 'browser', format: 'esm', target: 'es2022', metafile: true, loader: { '.css': 'empty' } });
    for (const input of Object.keys(build.metafile!.inputs)) {
      assert.ok(!/packages\/dictionary\/server|server\/dictionary|nextword-local-dictionary|js-mdict|curated-50|dictionary\.pack/.test(input), input);
      if (['src/lib/wordCard.ts', 'extension/background.ts', 'packages/dictionary/index.ts'].includes(entryPoint)) {
        assert.ok(!/wink-nlp|wink-eng-lite-web-model|englishTokenizer/.test(input), `Query-only entry includes the tokenizer: ${input}`);
      }
    }
    assert.ok(!/node:fs|readFileSync|createDictionaryRuntime|curated-50\.jsonl/.test(build.outputFiles[0].text));
  }
});

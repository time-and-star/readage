import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('bootstrap and hydrated App startup exclude the reader, recommendation resolver and NLP model', async () => {
  const result = await build({ entryPoints: ['src/main.tsx'], bundle: true, platform: 'browser',
    format: 'esm', splitting: true, outdir: 'tmp/app-startup-bundle-regression',
    write: false, metafile: true, minify: true, loader: { '.css': 'empty', '.png': 'file' } });
  const outputs = result.metafile!.outputs;
  const startup = new Set<string>();
  const visit = (file: string) => {
    if (startup.has(file)) return;
    startup.add(file);
    for (const dependency of outputs[file].imports) {
      if (dependency.kind !== 'dynamic-import' && outputs[dependency.path]) visit(dependency.path);
    }
  };
  // main loads App and MemoryProvider immediately after database hydration. Include
  // all three roots so dynamically importing App cannot hide an eager reader.
  for (const source of ['src/main.tsx', 'src/App.tsx', 'src/lib/memoryV2/MemoryProvider.tsx']) {
    const entry = Object.keys(outputs).find(file => outputs[file].entryPoint === source);
    assert.ok(entry, `startup entry is present: ${source}`);
    visit(entry);
  }
  const inputs = [...startup].flatMap(file => Object.keys(outputs[file].inputs));
  const deferredSources = ['src/components/ReadingScreen.tsx', 'src/lib/resolveRecommendation.ts'];
  assert.equal(inputs.some(file => deferredSources.includes(file) || file.includes('wink-eng-lite-web-model')
    || file.endsWith('/englishTokenizer.ts')), false,
  'the application shell must render before the English language model and reading screen load');
  for (const source of deferredSources) {
    assert.ok(Object.entries(outputs).some(([file, output]) => !startup.has(file)
      && Object.keys(output.inputs).includes(source)), `on-demand functionality remains available: ${source}`);
  }
});

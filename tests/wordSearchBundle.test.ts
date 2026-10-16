import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('a closed header search leaves word-card rendering and the NLP model in a dynamic chunk', async () => {
  const result = await build({ entryPoints: ['src/components/AppPageHeader.tsx'], bundle: true,
    platform: 'browser', format: 'esm', splitting: true, outdir: 'tmp/header-bundle-regression',
    write: false, metafile: true, minify: true });
  const outputs = result.metafile!.outputs;
  const entry = Object.keys(outputs).find(file => outputs[file].entryPoint === 'src/components/AppPageHeader.tsx')!;
  assert.ok(entry);
  const startup = new Set<string>();
  const visit = (file: string) => {
    if (startup.has(file)) return;
    startup.add(file);
    for (const dependency of outputs[file].imports) {
      if (dependency.kind !== 'dynamic-import' && outputs[dependency.path]) visit(dependency.path);
    }
  };
  visit(entry);
  const startupInputs = [...startup].flatMap(file => Object.keys(outputs[file].inputs));
  assert.equal(startupInputs.some(file => file.endsWith('/WordCardPanel.tsx') || file.includes('wink-eng-lite-web-model')), false,
    'opening the library header must not download the dictionary card or English NLP model');
  assert.ok(Object.entries(outputs).some(([file, output]) => !startup.has(file)
    && Object.keys(output.inputs).some(input => input.endsWith('/WordCardPanel.tsx'))),
  'the full word card remains available when a lookup opens it');
});

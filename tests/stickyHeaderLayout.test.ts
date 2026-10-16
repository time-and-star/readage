import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('page shells preserve sticky headers by avoiding hidden overflow scroll containers', () => {
  const globalStyles = readFileSync(resolve(repoRoot, 'src/index.css'), 'utf8');
  const appSource = readFileSync(resolve(repoRoot, 'src/App.tsx'), 'utf8');
  const readingSource = readFileSync(
    resolve(repoRoot, 'src/components/ReadingScreen.tsx'),
    'utf8',
  );

  assert.match(globalStyles, /body\s*\{[\s\S]*?overflow-x:\s*clip;/);
  assert.match(appSource, /flex flex-col overflow-x-clip safe-px/);
  assert.match(readingSource, /ease-out overflow-x-clip/);
});

test('the collapsed discussion entry stays in reading flow on mobile and is fixed on desktop', () => {
  const readingSource = readFileSync(
    resolve(repoRoot, 'src/components/ReadingScreen.tsx'),
    'utf8',
  );
  const desktopButtonMatch = readingSource.match(
    /className="([^"]*sm:fixed[^"]*)"\s+aria-label="Open article discussion input"/,
  );
  const mobileButtonMatch = readingSource.match(
    /className="([^"]*sm:hidden[^"]*)"\s+aria-label="Open article discussion input"/,
  );

  assert.ok(desktopButtonMatch, 'desktop discussion button should be present');
  assert.ok(mobileButtonMatch, 'mobile discussion button should be present');
  assert.match(desktopButtonMatch[1], /hidden\s+sm:inline-flex/);
  assert.match(desktopButtonMatch[1], /sm:right-8/);
  assert.match(desktopButtonMatch[1], /sm:bottom-8/);
  assert.match(mobileButtonMatch[1], /app-primary-action/);
});

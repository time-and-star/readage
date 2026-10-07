import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppPageHeader } from '../src/components/AppPageHeader';

test('renders accessible back, navigation, word search, and page actions', () => {
  const html = renderToStaticMarkup(
    React.createElement(AppPageHeader, {
      onBack: () => undefined,
      navigation: React.createElement('nav', { 'aria-label': 'Primary navigation' }, 'Library'),
      actions: React.createElement('button', { type: 'button', 'aria-label': 'Import an article' }, 'Import'),
    }),
  );

  assert.match(html, /<button\b[^>]*type="button"[^>]*aria-label="Back"/);
  assert.match(html, /<nav aria-label="Primary navigation">Library<\/nav>/);
  assert.match(html, /<button\b[^>]*type="button"[^>]*aria-label="Search a word"/);
  assert.match(html, /<button type="button" aria-label="Import an article">Import<\/button>/);
  assert.doesNotMatch(html, /<h1/);
});

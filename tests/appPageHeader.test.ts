import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppPageHeader } from '../src/components/AppPageHeader';

test('renders the shared ReadAge brand with back, navigation, and page actions', () => {
  const html = renderToStaticMarkup(
    React.createElement(AppPageHeader, {
      onBack: () => undefined,
      navigation: React.createElement('nav', { 'aria-label': 'Primary navigation' }, 'Library'),
      actions: React.createElement('button', { type: 'button' }, 'Search'),
    }),
  );

  assert.match(html, /aria-label="Back"/);
  assert.match(html, />ReadAge</);
  assert.match(html, /aria-label="Primary navigation"/);
  assert.match(html, />Search</);
  assert.doesNotMatch(html, /<h1/);
});

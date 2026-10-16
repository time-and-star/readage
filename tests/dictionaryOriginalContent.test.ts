import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DictionaryOriginalContent } from '../src/components/DictionaryOriginalContent';
import {
  DICTIONARY_ORIGINAL_LIMITS,
  dictionaryRelatedWord,
  parseDictionaryOriginalContent,
  type OriginalDictionaryContent,
} from '../src/lib/dictionaryOriginalContent';

function render(content: string, props: Partial<OriginalDictionaryContent> = {}, onLookupRelated?: (word: string) => void): string {
  return renderToStaticMarkup(React.createElement(DictionaryOriginalContent, {
    content: { mediaType: 'text/html', content, ...props }, onLookupRelated,
  }));
}

test('original dictionary HTML preserves definitions, emphasis, lists and bounded table structure', () => {
  const content = '<h3>bank</h3><p>A <strong>financial</strong> institution &amp; a <em>river</em> edge.</p>'
    + '<ul><li>First sense</li><li>Second sense</li></ul><ol start="3"><li>Usage</li></ol>'
    + '<table><caption>Examples</caption><tbody><tr><th colspan="2">English</th></tr>'
    + '<tr><td rowspan="2">bank</td><td>银行</td></tr></tbody></table>';
  const html = render(content);
  assert.match(html, /<h3>bank<\/h3>/);
  assert.match(html, /<strong>financial<\/strong>/);
  assert.match(html, /<em>river<\/em>/);
  assert.match(html, /<ul><li>First sense<\/li><li>Second sense<\/li><\/ul>/);
  assert.match(html, /<ol start="3">/);
  assert.match(html, /<table><caption>Examples<\/caption>/);
  assert.match(html, /<th colSpan="2">English<\/th>/i);
  assert.match(html, /<td rowSpan="2">bank<\/td>/i);
  const parsed = parseDictionaryOriginalContent({ mediaType: 'text/html; charset=utf-8', content });
  assert.equal(parsed.format, 'html');
  assert.equal(parsed.truncated, false);
  assert.match(parsed.plainText, /bank\n\nA financial institution & a river edge/);
  assert.match(parsed.plainText, /银行/);
});

test('active containers, media and original attributes never reach rendered HTML', () => {
  const html = render('<!doctype html><html><head><style>@import "https://attack.example/style";</style>'
    + '<script>EXECUTE_SECRET</script><base href="https://attack.example/"></head><body>'
    + '<p id="unsafe-id" class="unsafe-class" style="background:url(https://attack.example/pixel)" onclick="EXECUTE_SECRET">Visible definition</p>'
    + '<img src="https://attack.example/pixel" onerror="EXECUTE_SECRET">'
    + '<iframe srcdoc="<script>EXECUTE_SECRET</script>" src="https://attack.example/frame">FRAME_SECRET</iframe>'
    + '<form action="https://attack.example/submit"><input autofocus name="secret"><p>FORM_SECRET</p></form>'
    + '<svg><foreignObject><img src="https://attack.example/svg"></foreignObject><text>SVG_SECRET</text></svg>'
    + '<math><mtext>MATH_SECRET</mtext></math><object data="https://attack.example/object">OBJECT_SECRET</object>'
    + '<video poster="https://attack.example/poster"><source src="https://attack.example/movie">VIDEO_SECRET</video>'
    + '<a href="javascript:EXECUTE_SECRET" onclick="EXECUTE_SECRET">Readable reference</a>'
    + '<a href="https://attack.example/link" target="_blank">Remote reference</a>'
    + '<custom-entry>Custom <b>dictionary text</b></custom-entry></body></html>');
  assert.match(html, /<p>Visible definition<\/p>/);
  assert.match(html, /Readable reference/);
  assert.match(html, /Remote reference/);
  assert.match(html, /Custom <b>dictionary text<\/b>/);
  assert.doesNotMatch(html, /SECRET|attack\.example|javascript:|unsafe-id|unsafe-class|\bonclick=|\bonerror=|\bstyle=|\bhref=|\bsrc=/);
  assert.doesNotMatch(html, /<(?:script|style|img|iframe|form|svg|math|video|source|object|custom-entry)\b/);
});

test('only bounded entry references become lookup buttons and never browser navigation links', () => {
  let calls = 0;
  const content = '<p>See <a href="entry://ice%20cream#sense-1" style="color:red">ice cream</a>'
    + ' and <a href="ENTRY://été">été</a>.</p>'
    + '<a href="entry://javascript:alert(1)">bad entry</a><a href="entry://%zz">malformed</a>'
    + '<a href="//attack.example">remote</a><a href="sound://voice.mp3">audio</a>';
  const html = render(content, {}, () => { calls++; });
  assert.equal(calls, 0, 'rendering a dictionary never performs lookups');
  assert.match(html, /<button type="button" class="dictionary-original-content__related">ice cream<\/button>/);
  assert.match(html, /<button type="button" class="dictionary-original-content__related">été<\/button>/);
  assert.equal((html.match(/<button /g) ?? []).length, 2);
  assert.doesNotMatch(html, /href=|entry:\/\/|javascript:|attack\.example|sound:\/\//);
  assert.doesNotMatch(render(content), /<button /, 'without a lookup callback reference text is inert');
  assert.equal(dictionaryRelatedWord('entry://ice%20cream#sense-1'), 'ice cream');
  assert.equal(dictionaryRelatedWord('entry://日本語'), '日本語');
  assert.equal(dictionaryRelatedWord('entry://%0Aword'), null);
  assert.equal(dictionaryRelatedWord(`entry://${'a'.repeat(513)}`), null);
  assert.equal(dictionaryRelatedWord('javascript:alert(1)'), null);
});

test('plain and unsupported content use escaped text while invalid layout attributes are dropped', () => {
  const html = render('<img src=x onerror=alert(1)>', { mediaType: 'text/plain' });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /dictionary-original-content--text/);
  const fallback = render('unsupported bytes', { mediaType: 'application/octet-stream', plainText: 'Fallback & <em>text</em>' });
  assert.match(fallback, /Fallback &amp; &lt;em&gt;text&lt;\/em&gt;/);
  const table = render('<table><tr><td colspan="999999" rowspan="-1">Text</td></tr></table><ol start="no"><li>Item</li></ol>');
  assert.doesNotMatch(table, /colspan=|rowspan=|start=/i);
});

test('input bytes, displayed text, node count and nesting are bounded without rendering failures', () => {
  const large = '<p>' + '界'.repeat(DICTIONARY_ORIGINAL_LIMITS.inputBytes) + '</p>';
  const parsed = parseDictionaryOriginalContent({ mediaType: 'text/html', content: large });
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.plainText.length <= DICTIONARY_ORIGINAL_LIMITS.textUnits);
  const wide = render('<br>'.repeat(DICTIONARY_ORIGINAL_LIMITS.nodes + 100));
  assert.ok((wide.match(/<br\/>/g) ?? []).length <= DICTIONARY_ORIGINAL_LIMITS.nodes);
  assert.match(wide, /仅显示前一部分/);
  const deep = '<span>'.repeat(2000) + 'Too deep' + '</span>'.repeat(2000) + '<p>Still readable</p>';
  const html = render(deep);
  assert.match(html, /Still readable/);
  assert.match(html, /仅显示前一部分/);
  assert.doesNotMatch(html, /Too deep/);
});

test('encoded markup remains text and skipped executable bodies never leak into compact plain text', () => {
  const content = '<p>&lt;img src="https://attack.example"&gt; &amp; quoted text</p><script>SECRET_SCRIPT</script>'
    + '<style>SECRET_STYLE</style><form>SECRET_FORM</form><unknown><em>Safe custom text</em></unknown>';
  const html = render(content);
  assert.match(html, /&lt;img src=/);
  assert.doesNotMatch(html, /<img\b|SECRET/);
  const parsed = parseDictionaryOriginalContent({ mediaType: 'text/html', content });
  assert.match(parsed.plainText, /Safe custom text/);
  assert.doesNotMatch(parsed.plainText, /SECRET/);
});

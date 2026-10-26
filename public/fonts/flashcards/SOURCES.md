# Word-card reference fonts

These self-hosted fonts approximate the rounded, upright handwriting in the
user's reference. The reference image does not identify its original fonts, so
this is a visual match rather than a claim of an exact font identification.
Existing application fonts are unchanged.

## Comic Neue Regular / Bold

- Author: The Comic Neue Project Authors (Craig Rozynski's project).
- Official project: https://github.com/crozynski/comicneue
- Source: Google Fonts, `ofl/comicneue`, commit
  `3dd78844021e948ceb633d1dcee3f7885561b5d9`.
- Regular source:
  https://raw.githubusercontent.com/google/fonts/3dd78844021e948ceb633d1dcee3f7885561b5d9/ofl/comicneue/ComicNeue-Regular.ttf
- Bold source:
  https://raw.githubusercontent.com/google/fonts/3dd78844021e948ceb633d1dcee3f7885561b5d9/ofl/comicneue/ComicNeue-Bold.ttf
- Upstream version: 2.003. Both complete faces have 328 glyphs and 303 Unicode
  mappings; neither was subsetted.
- License: SIL Open Font License 1.1, retained in `OFL-ComicNeue.txt`.
- Local WOFF2 files: `ComicNeue-Regular.woff2`, `ComicNeue-Bold.woff2`.
- CSS family: `Flashcard Comic`, actual weights 400 and 700.

Comic Neue is an official open-font reinterpretation of Comic Sans. Its upright,
round lowercase letters are a closer fit to the reference than a slanted script.
Use Bold for the large word and Regular for examples and collocations.

## LXGW WenKai Regular

- Authors: LXGW and The Klee Project Authors.
- Official project: https://github.com/lxgw/LxgwWenKai
- Pinned release: https://github.com/lxgw/LxgwWenKai/releases/tag/v1.530
- Source:
  https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf
- Upstream version: 1.530, October 18, 2026.
- Complete face: 47,336 glyphs and 46,926 Unicode mappings, including 30,580 CJK
  code points. The complete upstream character map is retained; this is not a
  subset based on demonstration words, interface text, or test fixtures.
- License: SIL Open Font License 1.1, with the upstream additional permission
  for web-font format conversion using its reserved names, retained verbatim in
  `OFL-LXGWWenKai.txt`.
- Local file: `LXGWWenKai-Regular.woff2`.
- CSS family: `Flashcard WenKai`, actual weight 400. Browsers can synthesize
  heavier Chinese text when requested; no second Chinese font is duplicated.

The font supplies handwritten Chinese and the common British/American IPA
characters used by word cards. Prefer it directly for phonetics; Comic Neue
alone does not contain the complete IPA sample.

## Packaging and verification

Only WOFF2 web-font files are shipped, together with their upstream license
texts. No Windows Comic Sans, KaiTi, or other proprietary system font is copied
into this directory. There are no runtime requests to Google Fonts or GitHub.

The complete upstream TTF faces were converted with fontTools 4.61.1 and Brotli;
no glyph outlines, family names, or character coverage were edited. The
converted faces were reopened and checked against the upstream glyph order and
Unicode maps. `font-manifest.json` records source URLs, file sizes, hashes,
coverage, and conversion checks.

Import `src/components/flashcardFonts.css` in the word-card component. Suggested
mixed-text stack: `'Flashcard Comic', 'Flashcard WenKai', cursive`. The CSS file
only declares these three faces and does not apply global styles.

# Document import model

All format adapters should produce the same reading data:

- `Article.title` is the display title.
- `Article.content` remains the ordered text paragraphs. Translation, bookmarks,
  learning exposure and completion use these indices, so adding images must never
  insert extra strings or shift paragraphs.
- `Article.media` contains `{ src, alt?, caption?, afterParagraphIndex }` in source
  order. `-1` places an image before the first paragraph. Keep captions as plain
  text. The reading view can suppress a matching original caption paragraph while
  preserving its index.
- Store each raster image once as a binary file addressed by its SHA-256 hash.
  Articles keep a small URL reference, not repeated base64 copies. The image store
  is reusable through the EPUB parser's injected `saveImage` sink.

## Current implementation

EPUB adapters read the package manifest and spine, then extract article paragraphs
and embedded raster images in document order. They retain alt text and semantic
figure captions. NCX / EPUB 3 reading TOC anchors and explicit chapter containers
define chapter boundaries rather than assuming that every spine file is a chapter.
A file beginning midway through a chapter continues that chapter, with image anchors
offset by its existing paragraph count. Nested articles retain their full DOM and
text outside article elements is preserved. Explicit navigation, hidden elements,
Gutenberg boilerplate, page markers and image-viewer duplicates are omitted from the
reading text; the original distributed file is unchanged. Legitimate short chapters,
poems, prefaces, author notes and footnotes remain readable.

Only archive-relative references are read; remote URLs, escaping
paths and active SVG/HTML assets are ignored. PNG, JPEG, GIF and WebP are recognised
from their bytes. Individual images are limited to 12 MiB and extracted images to
128 MiB per issue in Node (Android keeps its existing bounded native extraction).
Images are served under `/api/magazines/assets/<digest>.<ext>`.

Older magazine articles are upgraded when opened. A per-issue side manifest is
built from the already saved EPUB blob, without downloading again. Existing article
files, paragraphs, translations, and learning state are not overwritten. Text
anchors prevent attaching media to the wrong paragraph if stored prose was edited.
New media manifests match a unique title and original body text before attaching
images; they do not assume an old chapter ordinal still identifies the same story.
Ambiguous remapped paragraph anchors are skipped. Existing version 1 manifests remain
readable and existing saved prose / learning records are not rewritten.

## Adding more formats

| Format | Adapter input | Media and ordering |
| --- | --- | --- |
| TXT | Text encoding and paragraph boundaries | Text only |
| DOCX | OOXML document and image relationships | Implemented: paragraphs, heading styles, embedded raster drawings, captions and chapter splitting |
| EPUB | Manifest, spine and XHTML | Implemented for embedded raster images |
| PDF | Page text, embedded pictures and retained source file | Implemented for personal uploads: clickable text, page-end pictures and optional original-page previews |

Personal uploads use `/api/import/file` for TXT, DOCX, EPUB, PDF and HTML. TXT
recognises UTF-8, UTF-16 BOMs and common Windows encodings. DOCX keeps short chapters,
ignores deleted text and external image relationships, and reads embedded drawings
as binary assets. Personal EPUB uploads retain short chapters; magazine sync keeps
its existing 80-word threshold. Tables in Word are extracted as text rather than
retaining their original grid layout. Old binary `.doc` files must be saved as DOCX.
Word custom styles inherit chapter, title and caption properties through `basedOn`;
an explicit body outline overrides the inherited chapter level and style cycles stop.
Imported files remain grouped on the user's shelf. Reading advances to the next
chapter/page in that file's source order, rather than entering a recommendation stream.

EPUB / HTML / DOCX imports now use the `-s2` batch identity suffix. Their reorganised
chapter maps are separate editions of the same source bytes, so repeated imports
cannot mix old and new chapter numbers or replace old bookmarks / translations.
The source SHA-256 remains unchanged. A legacy edition stays available on the shelf;
the library offers the reorganised edition from chapter zero, and subsequent imports
resume only that edition. PDF and TXT retain their existing identities and page rules.

PDF uploads retain the complete source once by SHA-256. Up to 80 pages are indexed
as reading entries, including scans. Each `Article.sourceDocument` records the
local source URL, actual page number and total page count. Text is the default
reading content. Embedded raster pictures are saved separately under
`document_images/`, served through the protected `/api/import/images/` route, and
loaded with authenticated blob requests. Extraction is bounded to 64 MiB and 32
pictures per page; pictures are deduplicated. PDF.js exposes their source page but
not a paragraph position, so they appear after that page's text. Vector diagrams,
masked images and unsupported drawings remain available in the original preview.
“查看原页” is collapsed for pages with extracted text or pictures and can visit any
source page and preserves columns, photos and layout. A requested page is rendered
at bounded resolution, cached, and fetched using the same authentication as uploads;
the server never executes PDF JavaScript. Uploaded sources and rendered pages are
served through protected routes with private caching. No browser storage contains
the original PDF bytes. Do not add sensitive uploads to public asset endpoints.

The magazine PDF splitter is still a legacy text-only adapter. Personal PDF uploads
use the page adapter instead. Scans can be viewed, but OCR and clickable words on the
page image are not implemented; lookup and translation use the extracted text.
Original-page previews require the retained local source file. Browser backups copy
the source reference, not the binary document or images, so moving to another server
requires those assets or a fresh import.

For layout/OCR engine candidates, see [pdf-parsing-options.md](pdf-parsing-options.md).

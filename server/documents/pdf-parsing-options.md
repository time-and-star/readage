# PDF extraction options

Reviewed official repositories on 2026-10-04. These are researched candidates,
not installed engines, and their performance claims have not been benchmarked here.

| Engine | Useful capabilities | Integration tradeoff |
| --- | --- | --- |
| [PyMuPDF4LLM](https://github.com/pymupdf/pymupdf4llm) | Reading order across columns, Markdown/JSON, headings, embedded images, selective OCR; no GPU requirement for layout analysis | Python runtime plus native dependencies; OCR requires a supported OCR engine. Project states AGPL/commercial licensing. |
| [Docling](https://github.com/docling-project/docling) | PDF layout, reading order, tables, pictures and OCR, plus DOCX/EPUB/HTML and a shared document tree | Python and downloaded layout/OCR models; run locally as an isolated conversion worker. Code is MIT; model licenses are separate. |
| [MinerU](https://github.com/opendatalab/MinerU) | Complex documents, layout/OCR and Markdown/JSON with several local quality tiers | Model-backed pipeline. Current documentation lists about 0.8 GB models for the basic tier and higher requirements for other tiers. |

For this reading app, evaluate PyMuPDF4LLM first when digital magazine columns
or paragraph boundaries prove unreliable. Evaluate Docling if scanned books,
table structure and a common model across formats become required. Installation
and engine replacement should follow a sample-based comparison, not star counts
or advertised speed figures.

Current shipped adapter uses the already installed PDF.js-based `pdf-parse`:
text extraction, page-scoped raster images and private source references. It does
not repair arbitrary column order, infer chapters, convert tables semantically,
or perform OCR. Keeping an original preview does not satisfy text extraction or
OCR requirements. It only lets the reader inspect source layout.

## Evaluation before replacement

Use a representative digital two-column magazine, a single-column book, a scan,
and a mixed scan/text file. Compare expected paragraphs against output, checking
column order, headings, running headers, line-end hyphens, missing/repeated text,
image references and page provenance. Measure elapsed time and peak memory with
the same pages and cache conditions. The current fixtures validate readable text,
retained source bytes, embedded pictures, scans without a text layer, asset
deduplication and page rendering; they do not establish accuracy for real layouts.

Any replacement must keep `Article.content` as ordered, clickable paragraphs and
attach binary pictures through `Article.media`; it must not substitute rendered
page images for text or silently send a user's file to a remote parsing service.

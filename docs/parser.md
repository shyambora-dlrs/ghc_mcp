# PDF parser

Python 3.12, PyMuPDF text extraction, optional Tesseract OCR, Pydantic models, FastAPI service (`ingestion/parser-service`).
Deterministic only: **no LLM is involved** (the optional LLM-assisted fallback of MDS §7.4 is intentionally not implemented; `PARSER_LLM_ASSIST_ENABLED` is reserved and ignored).

## Pipeline (per PDF)

1. **Validate**: `%PDF-` signature, size cap (`PARSER_MAX_PDF_BYTES`), page cap, encryption → typed `PdfError`s.
2. **Per page**: extract positioned lines (`page.get_text("dict")`). A page is *meaningful* if it has ≥ `PARSER_MIN_TEXT_CHARS` non-rule characters with a sane alphanumeric ratio.
3. **OCR is decided per page**: only if the text layer is unusable **and** the page has images (or a garbled layer). A blank page stays `EMPTY`. OCR output is used only if it contains
   clearly more text than the existing layer. OCR lines get a confidence; entries from OCR are capped by it and flagged `LOW_OCR_CONFIDENCE` below `PARSER_OCR_REVIEW_CONFIDENCE`.
4. **Segment** (`parsers/causelist.py`), only for Daily/Supplementary/Lawazima/Regular-Hearing PDFs; Notices keep page text only.
5. **Validate & score** each entry (`validators/validate.py`).
6. **Deliver** `begin` → page/entry `chunk`s → `complete` (or `failed`) to the Worker.

## Layout handling

Column x-positions are **inferred per page**, not hard-coded: case-number x from the data; parties/advocates x from the header row when present, else carried from the previous page, else from x-clusters
(2-line clusters accepted, plus one isolated far-right cluster). Context state machine: `PREAMBLE → HEADER (sitting time, BEFORE:, judges, COURT NO, [bench] + notes) → TABLE → NOTE`.

* Section headings are centred lone lines (`- FOR ORDERS -`, `JUDGEMENT`) → `section_heading_raw`.
* `Versus` splits petitioner/respondent party text; wrapped party names are joined.
* `WITH` rows: a mid-item `WITH` starts a connected case with its own parties; an item that *starts* with `WITH`, or follows a *trailing* `WITH`, is connected to the previous entry. Links are recorded both ways in `connected_cases` and noted in `listing_note_raw`. `in <case>` notes are recorded as connected references.
* `=====` ends the table (e.g. "LEAVE NOTE OF ADVOCATES" tables are **not** parsed as cases).
* Advocate names: one per printed line, merged only when the previous line has an unclosed `(` or the next line's first word could not have fit on the previous line — **unless** the next line starts like a new advocate (title, counsel designation such as `SC,`/`DY.S.G.I.`). This is a heuristic; affected entries carry `ADVOCATE_WRAP_HEURISTIC` (7–22% of entries on the real 2026-11-02 PDFs, depending on the list) and the exact lines remain in `raw_text`.
* The date printed in the PDF header is compared with the source listing date (`pdf_date_mismatch` in metadata).

## Confidence (documented, deterministic)

`confidence = 1 − Σ penalties`, floored at 0 (see `validators/validate.py` for the table): no case number −0.60, unnormalizable −0.30, implausible year −0.15, no parties −0.25, no `Versus`/side −0.10,
missing serial −0.10, **no bench/court context −0.20**, advocate-wrap heuristic −0.03; OCR: `min(score, ocr_conf) − 0.05`.
`VALIDATED` needs score ≥ `PARSER_VALIDATED_MIN_CONFIDENCE` (0.85) **and** a normalized case number; `UNPARSED` = no case number and no parties; everything else `NEEDS_REVIEW`.
A document is `PARTIALLY_EXTRACTED` if > `PARSER_PARTIAL_REVIEW_FRACTION` (5%) of entries need review or any page failed; `REVIEW_REQUIRED` if no entries were found; `OCR_REQUIRED` if pages needed OCR that was unavailable.
The Worker additionally refuses to record `EXTRACTED` for an entry-type list with zero entries.

## Known limitations

* Verified against 2026-11-02 PDFs only; unknown layouts degrade to `REVIEW_REQUIRED`/`NEEDS_REVIEW` rather than guesses.
* A heading line whose x-position falls inside an advocate column would be read as advocate text.
* A multi-party side ("A, B and C" printed on separate lines) is stored as one party string.
* English-only OCR; OCR layout parsing is far less reliable than the text layer.
* See `docs/parser-accuracy.md` for measured results and what they do *not* prove.

## Running

```bash
.venv/bin/python -m app.cli parse FILE.pdf --listing-date 2026-11-02 --out result.json   # from ingestion/parser-service
.venv/bin/python -m pytest ingestion/parser-service/tests -q
.venv/bin/python ingestion/parser-service/tests/accuracy_report.py --live-dir DIR          # regenerate docs/parser-accuracy.md
```

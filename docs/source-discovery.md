# Source discovery (verified 2026-11-02)

Everything below was observed on the live site on **2 Nov 2026** (server clock `Mon, 02 Nov 2026`). Nothing in the crawler is
guessed; the parser test fixture `tests/fixtures/source/consolidated-cause-list.trimmed.html` is a trimmed copy of the captured page.

## Page: <https://ghconline.gov.in/index.php/consolidated-cause-list/>

| Question (MDS §2.2) | Finding |
|---|---|
| HTTP status / final URL | `200`, no redirect. `Server: Apache`, WordPress (`Link: …/wp-json/…` header), ~591 KB HTML. |
| Server- or JS-rendered? | **Server-rendered.** All links are in the initial HTML; no JavaScript is needed. |
| Link targets | **Direct PDF links**, `https://ghconline.gov.in/NewCList/<prefix>-dd-mm-yyyy[-suffix].pdf`. No intermediate pages. |
| Structure | One `<table>`; header row `Daily | Supplementary | Lawazima | Notices`; one row per date. Plus one stand-alone link above the table: *"Regular Hearing Causelist from 02.11.2026 to 23.12.2026"* (`hl-02-11-2026.pdf`). |
| Where is the date? | In the link text (`dd/mm/yyyy`, **day-first**) **and** in the filename. Across all 2,034 links they agree for 2,028; 4 are filename-only (broken markup such as `/01/2025`); 1 conflicts (`no-10-12-2024.pdf`) and is stored with **no** normalized date. |
| Pagination / filters | None found. The whole archive (back to mid-2024, ~2,034 files) is on one page. A sidebar "Archive Calendar" widget exists (AJAX); its behaviour was not investigated. |
| Separate lists / courts | Not separate pages. Lists are separated by table column; each PDF contains many courts/benches. |
| Publication / update timestamp | **None on the page.** PDFs carry `Last-Modified` and `ETag` response headers (used for conditional requests and change detection). E.g. the 02/11/2026 daily list had `Last-Modified: Thu, 29 Oct 2026` — lists are published days in advance. |
| PDF type | All inspected PDFs are **text-based** (PDFium-produced; notices from MS Word) with a usable text layer on every page. Sizes 0.8–5.8 MB, 6–130 pages. `Content-Type: application/pdf`. |
| Duplicate links | None after URL canonicalization (the same href is occasionally split across several `<a>` tags by broken markup; the crawler merges them). |
| Stable identifier | The filename is stable per document. The canonical URL is the document identity. |

### Categories (as published — never assumed)

| Column header (raw) | Normalized | Links | Filename prefixes seen |
|---|---|---|---|
| Daily | `DAILY` | 504 | `dl` (491), `vc` (5, annotated "[Vacation Court]"), legacy `la`, `LA`, `VC`, `VCL`, `vl`, `Cl` |
| Supplementary | `SUPPLEMENTARY` | 508 | `sl` (505), legacy `LA-Sl`, `PL` |
| Lawazima | `LAWAZIMA` | 468 | `lz` |
| Notices | `NOTICE` | 553 | `no` (560 incl. multi-link cells), `ro` |
| *(stand-alone link)* "Regular Hearing Causelist from … to …" | `REGULAR_HEARING` | 1 | `hl` |

Only these labels are mapped. Any other label is stored raw with `category_normalized = NULL`. The prefix is kept in
`discovery_metadata_json` but is **not** used to assign categories (legacy prefixes sit in unexpected columns). Cell annotations such as
`[Roster]`, `[Sitting Arrangement]`, `[Lok Adalat]`, `[Vacation Court]`, `[Swearing-In Ceremony]` are stored in `publication_label`.
The "Regular Hearing" list covers a **date range**, so it has `listing_date = NULL`, `date_parse_status = RANGE`, and `valid_from/valid_to` in metadata.

### PDF layouts (see `docs/parser.md`)

Daily, Supplementary, Lawazima and Regular-Hearing PDFs share one 5-column table (`Sr.No. | Case Number | Main Parties | Petitioner Advocate | Respondent Advocate`).
Two layout variants exist (A: header block + dashed rules + header row; B: the Kohima-bench section of the supplementary list, with no header row or rules).
Notices are free-form (Word-generated) and are stored as page text only.

### robots.txt / terms

`robots.txt` (`/robots.txt`): `Disallow: /wp-admin/` only; `Allow: /wp-admin/admin-ajax.php`; a sitemap. No `Crawl-delay`. The site's terms of use were **not** reviewed
programmatically — the owner should read them before production use. The crawler is deliberately gentle: sequential requests, ≥ 3 s apart, conditional requests,
descriptive User-Agent, a lookback window (default 14 days) rather than mirroring the 2,000-file archive, and no bypassing of anything.

## TLS: the Court's server sends an incomplete certificate chain  ⚠️

`ghconline.gov.in` presents only its leaf certificate (`*.ghconline.gov.in`, issued by *Sectigo Public Server Authentication CA DV R36*) **without the intermediate**.
Browsers repair this by fetching the intermediate from the certificate's AIA URL; many other clients do not.

Observed: `curl` (system trust store) fails with *unable to get local issuer certificate*, and the **`workerd` runtime used by `wrangler dev` fails too**
(`Network error while contacting the source`, recorded as a FAILED crawl run — the system fails closed and never reports a false "no lists today").

* **Not verified:** whether *production* Cloudflare Workers can fetch the site. Check this first after deploying: `POST /admin/ingestion/crawl {"wait":true}`.
* **Never** "fix" this by disabling certificate verification.
* **Fallback implemented and verified end-to-end (local):** *push mode*. `scripts/build-ca-bundle.sh` downloads the missing intermediate from the leaf's own AIA URL,
  verifies `leaf → intermediate → system root`, and builds a bundle; `python -m app.cli crawl-push` (or `.github/workflows/push-runner.yml`) then fetches the page and PDFs
  with full verification and pushes them to `/internal/runner/*`. The Worker applies identical parsing, hashing, validation and versioning.
  A live run on 2026-11-02 discovered 2,034 documents, stored 8 PDFs and parsed 7 of them (the 8th was still queued behind the single-job parser when checked).
* Longer term: ask the Court's web team to install the intermediate certificate on the server.

## Unknowns (do not assume)

* The Court's publication schedule/time of day (cron is set conservatively: 02:30 and 10:30 UTC).
* Whether published PDFs are revised in place (handled generically by hash → new immutable version).
* Layouts of older (2018–2024) PDFs — only 2026 PDFs were inspected.
* Assamese or other scripts in PDFs: none seen; OCR is configured for English only (`PARSER_OCR_LANG`).

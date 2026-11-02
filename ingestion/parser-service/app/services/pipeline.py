"""PDF -> pages + entries. Deterministic first; OCR is decided per page; no LLM involvement."""
from __future__ import annotations

import logging
import time
from collections import Counter
from typing import Optional

from ..config import PARSER_VERSION, Settings
from ..extractors import ocr as ocr_mod
from ..extractors.pdf import extract_page, open_pdf
from ..models.schemas import PageData, PageOut, ParseOutput
from ..parsers.causelist import CauseListParser

log = logging.getLogger("parser.pipeline")


def parse_pdf(
    data: bytes,
    settings: Settings,
    *,
    parse_entries: bool = True,
    listing_date: Optional[str] = None,
    max_pages: Optional[int] = None,
) -> ParseOutput:
    t0 = time.time()
    doc = open_pdf(data, settings, max_pages)
    can_ocr = settings.ocr_enabled and ocr_mod.ocr_available()
    pages: list[PageData] = []
    for i in range(doc.page_count):
        page = doc[i]
        try:
            pd = extract_page(page, i + 1, settings)
            if pd.status == "EMPTY":
                has_text = bool(pd.text.strip())
                has_images = bool(page.get_images(full=True))
                garbled = "\ufffd" in pd.text
                if has_images or garbled:
                    # Image-only (or unusable text layer): OCR this page only.
                    if can_ocr:
                        lines, conf = ocr_mod.ocr_page_lines(page, i + 1, settings)
                        ocr_chars = sum(len(l.text.replace(" ", "")) for l in lines)
                        if lines and ocr_chars > 1.2 * len(pd.text.replace(" ", "").replace("\n", "")):
                            pd = PageData(i + 1, pd.width, pd.height, lines, "\n".join(l.text for l in lines), "OCR", "OCR_USED", conf)
                        elif has_text:
                            pd.status = "OK"  # OCR found nothing more than the existing text layer: keep the text layer
                        else:
                            pd.status = "OCR_FAILED"
                    else:
                        pd.status = "OCR_FAILED"  # needs OCR but it is unavailable/disabled -> OCR_REQUIRED
                elif has_text:
                    pd.status = "OK"  # short but genuine text-layer page (e.g. a last page with one entry)
                # else: no text and no images -> a genuinely blank page; stays EMPTY
        except Exception as exc:  # one bad page must not sink the document
            log.warning("page %s failed: %s", i + 1, type(exc).__name__)
            pd = PageData(i + 1, 0, 0, [], "", "TEXT", "FAILED")
        pages.append(pd)
    doc.close()

    entries = []
    meta: dict = {}
    parser_obj: CauseListParser | None = None
    if parse_entries:
        parser_obj = CauseListParser(settings)
        entries = parser_obj.parse(pages)

    status_counts = Counter(p.status for p in pages)
    review = sum(1 for e in entries if e.validation_status != "VALIDATED")
    ocr_pages = [p.page_number for p in pages if p.method == "OCR"]
    meta.update(
        {
            "parser_version": PARSER_VERSION,
            "page_status_counts": dict(status_counts),
            "ocr_pages": ocr_pages,
            "entries": len(entries),
            "entries_needing_review": review,
            "elapsed_ms": int((time.time() - t0) * 1000),
            "ocr_available": can_ocr,
        }
    )
    if parser_obj:
        pdf_date = parser_obj.meta.get("pdf_date_text")
        meta.update(
            {
                "benches": parser_obj.meta["benches"],
                "column_sources": dict(parser_obj.meta["layout_sources"]),
                "pdf_date_text": pdf_date,
                "serial_stats": serial_stats(entries),
            }
        )
        if pdf_date and listing_date and pdf_date != listing_date:
            meta["pdf_date_mismatch"] = {"pdf": pdf_date, "source_listing_date": listing_date}

    status = decide_status(settings, parse_entries, pages, entries, review, can_ocr)
    page_out = [
        PageOut(page_number=p.page_number, text_content=p.text, extraction_method=p.method, ocr_confidence=p.ocr_confidence, page_status=p.status)
        for p in pages
    ]
    return ParseOutput(PARSER_VERSION, len(pages), page_out, entries, status, meta)


def decide_status(settings: Settings, parse_entries: bool, pages: list[PageData], entries: list, review: int, can_ocr: bool) -> str:
    failed = sum(1 for p in pages if p.status in ("FAILED", "OCR_FAILED"))
    if failed and failed == len(pages):
        return "OCR_REQUIRED" if any(p.status == "OCR_FAILED" for p in pages) and not can_ocr else "FAILED"
    if parse_entries and not entries:
        return "OCR_REQUIRED" if failed and not can_ocr else "REVIEW_REQUIRED"
    if failed:
        return "PARTIALLY_EXTRACTED"
    if parse_entries and entries and review / len(entries) > settings.partial_review_fraction:
        return "PARTIALLY_EXTRACTED"
    return "EXTRACTED"


def serial_stats(entries: list) -> dict:
    """Objective completeness signal: within each bench section the numeric serials should run 1..N with no holes
    and never go backwards. `missing` counts holes; connected (WITH) entries legitimately repeat their serial."""
    per: dict[tuple, dict] = {}
    for e in entries:
        if not (e.serial_number and e.serial_number.isdigit()):
            continue
        key = e.bench.key() if e.bench else ("none",)
        st = per.setdefault(key, {"seen": set(), "last": 0, "backwards": 0})
        n = int(e.serial_number)
        if n < st["last"]:
            st["backwards"] += 1
        st["last"] = max(st["last"], n)
        st["seen"].add(n)
    # Holes are measured inside the printed range only: supplementary lists legitimately start above 1.
    missing = sum((max(st["seen"]) - min(st["seen"]) + 1) - len(st["seen"]) for st in per.values() if st["seen"])
    return {"sections": len(per), "distinct_serials": sum(len(st["seen"]) for st in per.values()), "missing": missing, "backwards": sum(st["backwards"] for st in per.values())}

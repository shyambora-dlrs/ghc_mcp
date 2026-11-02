"""Per-entry validation and a documented, deterministic confidence score (see docs/parser.md).

confidence = 1.0 minus penalties; each penalty corresponds to a flag so the score is explainable:

  NO_CASE_NUMBER            -0.60   no case-number line was found in the case column
  CASE_NUMBER_UNNORMALIZED  -0.30   a number was found but is not TYPE/NUMBER/YEAR
  CASE_YEAR_IMPLAUSIBLE     -0.15   year outside 1900..2100 (kept, not discarded)
  NO_PARTIES                -0.25   no party text at all
  NO_VERSUS / PARTY_SIDE_MISSING -0.10   could not split petitioner / respondent sides
  SERIAL_MISSING            -0.10   no serial number
  NO_BENCH_CONTEXT          -0.15   no court / bench heading was in force
  ADVOCATE_WRAP_HEURISTIC   -0.03   advocate lines were merged by the wrapped-line heuristic (informational)
  OCR                       min(score, mean OCR confidence) - 0.05

Status: UNPARSED  - no case number and no parties
        VALIDATED - score >= validated_min_confidence AND case number normalised AND not OCR-below-threshold
        NEEDS_REVIEW otherwise.
"""
from __future__ import annotations

from typing import Optional

from ..config import Settings
from ..models.schemas import Entry
from ..parsers.normalize import normalize_case_number

PENALTY = {
    "NO_CASE_NUMBER": 0.60,
    "CASE_NUMBER_UNNORMALIZED": 0.30,
    "CASE_YEAR_IMPLAUSIBLE": 0.15,
    "NO_PARTIES": 0.25,
    "NO_VERSUS": 0.10,
    "PARTY_SIDE_MISSING": 0.10,
    "SERIAL_MISSING": 0.10,
    "NO_BENCH_CONTEXT": 0.20,
    "ADVOCATE_WRAP_HEURISTIC": 0.03,
}


def validate_entry(entry: Entry, s: Settings, ocr_conf: Optional[float] = None) -> Entry:
    flags = set(entry.validation_flags)
    norm = normalize_case_number(entry.case_number_raw)
    if not entry.case_number_raw:
        flags.add("NO_CASE_NUMBER")
    elif norm is None:
        flags.add("CASE_NUMBER_UNNORMALIZED")
    elif not norm.year_plausible:
        flags.add("CASE_YEAR_IMPLAUSIBLE")
    if not entry.parties:
        flags.add("NO_PARTIES")
    if not entry.serial_number:
        flags.add("SERIAL_MISSING")
    if entry.bench is None:
        flags.add("NO_BENCH_CONTEXT")
    if entry.page_start < 1 or entry.page_end < entry.page_start:
        flags.add("INVALID_PAGE_RANGE")
    if not entry.raw_text.strip():
        flags.add("EMPTY_RAW_TEXT")

    score = 1.0 - sum(PENALTY.get(f, 0.0) for f in flags)
    if entry.extraction_method == "OCR":
        score = min(score, ocr_conf if ocr_conf is not None else 0.5) - 0.05
        if (ocr_conf or 0.0) < s.ocr_review_confidence:
            flags.add("LOW_OCR_CONFIDENCE")
    score = max(0.0, min(1.0, score))

    if not entry.case_number_raw and not entry.parties:
        status = "UNPARSED"
    elif (
        score >= s.validated_min_confidence
        and norm is not None
        and not (flags & {"INVALID_PAGE_RANGE", "EMPTY_RAW_TEXT", "LOW_OCR_CONFIDENCE"})
    ):
        status = "VALIDATED"
    else:
        status = "NEEDS_REVIEW"
    entry.extraction_confidence = round(score, 3)
    entry.validation_status = status  # type: ignore[assignment]
    entry.validation_flags = sorted(flags)
    return entry

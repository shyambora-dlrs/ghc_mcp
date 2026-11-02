"""Runtime configuration (environment variables). Secrets are never logged."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    # --- extraction -------------------------------------------------------------------------
    ocr_enabled: bool = field(default_factory=lambda: _bool("PARSER_OCR_ENABLED", True))
    ocr_dpi: int = field(default_factory=lambda: _int("PARSER_OCR_DPI", 300))
    ocr_lang: str = field(default_factory=lambda: os.environ.get("PARSER_OCR_LANG", "eng"))
    # A text-layer page with fewer meaningful characters than this is treated as image-only -> OCR.
    min_text_chars: int = field(default_factory=lambda: _int("PARSER_MIN_TEXT_CHARS", 40))
    min_alnum_ratio: float = field(default_factory=lambda: _float("PARSER_MIN_ALNUM_RATIO", 0.45))
    # --- validation thresholds (documented in docs/parser.md) --------------------------------------
    validated_min_confidence: float = field(default_factory=lambda: _float("PARSER_VALIDATED_MIN_CONFIDENCE", 0.85))
    ocr_review_confidence: float = field(default_factory=lambda: _float("PARSER_OCR_REVIEW_CONFIDENCE", 0.80))
    # If more than this fraction of entries need review, the document is PARTIALLY_EXTRACTED.
    partial_review_fraction: float = field(default_factory=lambda: _float("PARSER_PARTIAL_REVIEW_FRACTION", 0.05))
    # --- limits ---------------------------------------------------------------------------------
    max_pdf_bytes: int = field(default_factory=lambda: _int("PARSER_MAX_PDF_BYTES", 80_000_000))
    max_pages: int = field(default_factory=lambda: _int("PARSER_MAX_PAGES", 1500))
    page_chunk: int = field(default_factory=lambda: _int("PARSER_PAGE_CHUNK", 15))
    entry_chunk: int = field(default_factory=lambda: _int("PARSER_ENTRY_CHUNK", 80))
    job_timeout_s: int = field(default_factory=lambda: _int("PARSER_JOB_TIMEOUT_S", 900))
    # --- service ---------------------------------------------------------------------------------
    service_token: str = field(default_factory=lambda: os.environ.get("INGESTION_SERVICE_TOKEN", ""))
    callback_token: str = field(default_factory=lambda: os.environ.get("PARSER_CALLBACK_TOKEN", ""))
    # pdf_url / callback_url must live under this origin (SSRF guard), e.g. https://worker.example
    worker_origin: str = field(default_factory=lambda: os.environ.get("WORKER_ORIGIN", "").rstrip("/"))
    # --- optional LLM-assisted fallback (OFF by default; not implemented as an unconditional dependency)
    llm_assist_enabled: bool = field(default_factory=lambda: _bool("PARSER_LLM_ASSIST_ENABLED", False))


PARSER_VERSION = "ghc-layout-1.0"

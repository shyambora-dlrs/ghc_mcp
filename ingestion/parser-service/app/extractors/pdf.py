"""PDF opening, validation and page-level line extraction with PyMuPDF."""
from __future__ import annotations

import re

import pymupdf

from ..config import Settings
from ..models.schemas import Line, PageData


class PdfError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def open_pdf(data: bytes, settings: Settings, max_pages: int | None = None) -> pymupdf.Document:
    if len(data) > settings.max_pdf_bytes:
        raise PdfError("TOO_LARGE", f"PDF is {len(data)} bytes; limit is {settings.max_pdf_bytes}.")
    if b"%PDF-" not in data[:1024]:
        raise PdfError("NOT_A_PDF", "File does not have a PDF signature.")
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # corrupt / encrypted
        raise PdfError("UNREADABLE", f"PDF could not be opened: {type(exc).__name__}") from exc
    if doc.needs_pass or doc.is_encrypted:
        raise PdfError("ENCRYPTED", "PDF is encrypted.")
    limit = min(settings.max_pages, max_pages) if max_pages else settings.max_pages
    if doc.page_count > limit:
        raise PdfError("TOO_MANY_PAGES", f"PDF has {doc.page_count} pages; limit is {limit}.")
    if doc.page_count == 0:
        raise PdfError("EMPTY", "PDF has no pages.")
    return doc


def text_lines(page: "pymupdf.Page", page_number: int) -> list[Line]:
    lines: list[Line] = []
    for block in page.get_text("dict")["blocks"]:
        for ln in block.get("lines", []):
            text = "".join(span["text"] for span in ln["spans"])
            if not text.strip():
                continue
            x0, y0, x1, y1 = ln["bbox"]
            lines.append(Line(page_number, x0, y0, x1, y1, text.rstrip()))
    lines.sort(key=lambda l: (round(l.y0, 1), l.x0))
    return lines


def is_meaningful(text: str, min_chars: int, min_alnum_ratio: float) -> bool:
    """Heuristic: enough non-space characters, mostly alphanumeric, few replacement glyphs.
    Table rules ("-----", "=====") are ignored: cause-list pages are full of them and they are not garbage."""
    stripped = re.sub(r"[\s\-=_.]+", "", text)
    if len(stripped) < min_chars:
        return False
    if stripped.count("�") / len(stripped) > 0.05:
        return False
    return sum(c.isalnum() for c in stripped) / len(stripped) >= min_alnum_ratio


def extract_page(page: "pymupdf.Page", page_number: int, settings: Settings) -> PageData:
    raw = page.get_text()
    width, height = page.rect.width, page.rect.height
    if is_meaningful(raw, settings.min_text_chars, settings.min_alnum_ratio):
        return PageData(page_number, width, height, text_lines(page, page_number), raw, "TEXT", "OK")
    # Pages of a cause list that are legitimately near-empty exist; the OCR decision is made by the caller.
    return PageData(page_number, width, height, text_lines(page, page_number), raw, "TEXT", "EMPTY")

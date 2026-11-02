"""Pydantic models. The Worker payload models mirror packages/shared-types/src/schemas.ts."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

from pydantic import BaseModel, Field

Method = Literal["TEXT", "OCR", "LLM_ASSISTED"]
Validation = Literal["VALIDATED", "NEEDS_REVIEW", "UNPARSED"]


@dataclass
class Line:
    """One visual line of text with its position, in PDF points (origin top-left, y grows downward)."""

    page: int  # 1-based
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    method: Method = "TEXT"
    conf: Optional[float] = None  # 0..1 for OCR lines

    @property
    def width(self) -> float:
        return max(0.0, self.x1 - self.x0)


@dataclass
class PageData:
    page_number: int
    width: float
    height: float
    lines: list[Line]
    text: str
    method: Method
    status: Literal["OK", "EMPTY", "OCR_USED", "OCR_FAILED", "FAILED"]
    ocr_confidence: Optional[float] = None


class Bench(BaseModel):
    court_label_raw: Optional[str] = None
    bench_label_raw: Optional[str] = None
    judges: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    sitting_time_raw: Optional[str] = None

    def key(self) -> tuple:
        return (self.court_label_raw, self.bench_label_raw, tuple(self.judges), self.sitting_time_raw)


class Person(BaseModel):
    name_raw: str
    side: str
    sequence: int


class Entry(BaseModel):
    entry_index: int
    bench: Optional[Bench] = None
    serial_number: Optional[str] = None
    item_number: Optional[str] = None
    case_number_raw: Optional[str] = None
    listing_note_raw: Optional[str] = None
    section_heading_raw: Optional[str] = None
    connected_cases: list[str] = Field(default_factory=list)
    page_start: int
    page_end: int
    raw_text: str
    extraction_method: Method = "TEXT"
    extraction_confidence: Optional[float] = None
    validation_status: Validation = "NEEDS_REVIEW"
    validation_flags: list[str] = Field(default_factory=list)
    parties: list[Person] = Field(default_factory=list)
    advocates: list[Person] = Field(default_factory=list)


class PageOut(BaseModel):
    page_number: int
    text_content: Optional[str]
    extraction_method: Method
    ocr_confidence: Optional[float] = None
    page_status: Literal["OK", "EMPTY", "OCR_USED", "OCR_FAILED", "FAILED"]


@dataclass
class ParseOutput:
    parser_version: str
    page_count: int
    pages: list[PageOut]
    entries: list[Entry]
    extraction_status: str
    metadata: dict = field(default_factory=dict)


class ParseJob(BaseModel):
    """Body of POST /jobs/parse (sent by the Worker queue consumer)."""

    document_version_id: str = Field(min_length=1, max_length=200)
    document_id: Optional[str] = None
    category: Optional[str] = None
    category_label_raw: Optional[str] = None
    listing_date: Optional[str] = None
    parse_entries: bool = True
    max_pages: Optional[int] = None
    pdf_url: str
    callback_url: str

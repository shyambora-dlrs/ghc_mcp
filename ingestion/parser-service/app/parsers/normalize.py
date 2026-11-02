"""Search normalization. MUST stay behaviourally identical to packages/shared-types/src/normalize.ts
(both are tested against packages/shared-types/test-vectors/normalization.json). The Worker recomputes
these values from the raw text on ingestion, so the Worker is authoritative; this module is for the
CLI, validation and segmentation."""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Optional

_CASE_RE = re.compile(
    r"^([A-Za-z][A-Za-z0-9.()&]*(?:\s+[A-Za-z0-9.()&]+)*?)\s*[/\s]\s*(\d{1,7})\s*[/\s]\s*(\d{4})$"
)
_DASHES = re.compile("[‐-―]")


@dataclass(frozen=True)
class CaseNo:
    normalized: str
    key: str
    case_type: str
    number: int
    year: int
    year_plausible: bool


def normalize_case_number(text: Optional[str]) -> Optional[CaseNo]:
    if not text:
        return None
    t = _DASHES.sub("-", unicodedata.normalize("NFKC", text)).strip()
    t = re.sub(r"\s+", " ", t)
    m = _CASE_RE.match(t)
    if not m:
        return None
    case_type = re.sub(r"\s+", "", m.group(1)).upper()
    number = int(m.group(2))
    year = int(m.group(3))
    if number <= 0:
        return None
    key = f"{re.sub(r'[^A-Z0-9]', '', case_type)}{number}{year}"
    return CaseNo(f"{case_type}/{number}/{year}", key, case_type, number, year, 1900 <= year <= 2100)


def normalize_name(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    t = unicodedata.normalize("NFKD", text)
    t = "".join(c for c in t if not unicodedata.combining(c)).upper()
    t = re.sub(r"[^A-Z0-9]+", " ", t).strip()
    return t or None

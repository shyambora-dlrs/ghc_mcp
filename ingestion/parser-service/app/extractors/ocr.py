"""OCR fallback (Tesseract via pytesseract). Decided per page, never per document.

OCR output is converted to the same positioned `Line` objects as the text layer so the layout parser
is shared. OCR lines carry a confidence; entries built from them are capped and flagged for review."""
from __future__ import annotations

import io
from collections import defaultdict
from typing import Optional

import pymupdf

from ..config import Settings
from ..models.schemas import Line


def ocr_available() -> bool:
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def ocr_page_lines(page: "pymupdf.Page", page_number: int, settings: Settings) -> tuple[list[Line], Optional[float]]:
    """Render the page, run Tesseract, and return positioned lines (PDF-point coordinates) + mean confidence."""
    import pytesseract
    from PIL import Image

    zoom = settings.ocr_dpi / 72.0
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    data = pytesseract.image_to_data(img, lang=settings.ocr_lang, config="--psm 6", output_type=pytesseract.Output.DICT)
    groups: dict[tuple, list[int]] = defaultdict(list)
    for i, word in enumerate(data["text"]):
        if word.strip() and float(data["conf"][i]) >= 0:
            groups[(data["block_num"][i], data["par_num"][i], data["line_num"][i])].append(i)
    lines: list[Line] = []
    confs: list[float] = []
    for idxs in groups.values():
        idxs.sort(key=lambda i: data["left"][i])
        # Split a visual line into cells where there is a large horizontal gap (table columns).
        cell: list[int] = []
        cells: list[list[int]] = []
        for i in idxs:
            if cell and (data["left"][i] - (data["left"][cell[-1]] + data["width"][cell[-1]])) > 18 * zoom:
                cells.append(cell)
                cell = []
            cell.append(i)
        if cell:
            cells.append(cell)
        for c in cells:
            x0 = min(data["left"][i] for i in c) / zoom
            y0 = min(data["top"][i] for i in c) / zoom
            x1 = max(data["left"][i] + data["width"][i] for i in c) / zoom
            y1 = max(data["top"][i] + data["height"][i] for i in c) / zoom
            conf = sum(float(data["conf"][i]) for i in c) / len(c) / 100.0
            confs.append(conf)
            lines.append(Line(page_number, x0, y0, x1, y1, " ".join(data["text"][i] for i in c), "OCR", conf))
    lines.sort(key=lambda l: (round(l.y0, 1), l.x0))
    return lines, (sum(confs) / len(confs) if confs else None)

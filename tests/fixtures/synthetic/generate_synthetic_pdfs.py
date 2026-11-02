"""Synthetic cause-list PDFs reproducing the two layouts observed on the Court's site (2026-11-02), using INVENTED
names only. Each builder returns (pdf_bytes, expected) where `expected` is the ground truth by construction - the
"manually reviewed" reference the parser tests and the accuracy report compare against.

Real court PDFs are never committed (see tests/fixtures/source/README.md)."""
from __future__ import annotations

import io

import pymupdf

FS = 8.0
FONT = "helv"


def _text(page, x, y, s, fs=FS):
    page.insert_text((x, y), s, fontsize=fs, fontname=FONT)


def _width(s, fs=FS):
    return pymupdf.get_text_length(s, fontname=FONT, fontsize=fs)


def build_layout_a() -> tuple[bytes, dict]:
    """Layout A: two courts; headings; WITH-connected items; a mid-item WITH case; a wrapped advocate; leave note."""
    doc = pymupdf.open()
    page = doc.new_page(width=595.28, height=841.89)
    y = 65
    for t, x in [
        ("THE GAUHATI HIGH COURT AT GUWAHATI", 186),
        ("(The High Court of Assam, Nagaland, Mizoram and Arunachal Pradesh)", 153),
        ("DAILY CAUSELIST", 240),
        ("[ For Monday,2nd November 2026]", 190),
    ]:
        _text(page, x, y, t)
        y += 14
    y = 205
    _text(page, 264, y, "[AT 10:30 AM]"); y += 15
    _text(page, 277, y, "BEFORE:"); y += 14
    _text(page, 201, y, "HONOURABLE THE CHIEF JUSTICE"); y += 14
    _text(page, 163, y, "HONOURABLE MR. JUSTICE ALPHA BETA"); y += 17
    _text(page, 267, y, "COURT NO: 1"); y += 15
    _text(page, 14, y, "[DIVISION BENCH-I]"); y += 14
    rule = "-" * 180
    _text(page, 11, y, rule, 5); y += 14
    _text(page, 14, y, "Sr.No. Case Number"); _text(page, 186, y, "Main Parties"); _text(page, 356, y, "Petitioner Advocate"); _text(page, 469, y, "Respondent Advocate"); y += 13
    _text(page, 11, y, rule, 5); y += 14
    _text(page, 261, y, "- FOR ORDERS -"); y += 19

    exp_entries = []

    def item(serial, case, notes, left, right, pet, resp, heading, with_prefix=False, with_case=None):
        nonlocal y
        top = y
        _text(page, 24, y, str(serial))
        rows = max(len(notes) + 1, len(left) + 1 + len(right), len(pet), len(resp))
        cy = y
        if with_prefix:
            _text(page, 42, cy, "WITH"); cy += 11
        _text(page, 42, cy, case); cy += 11
        for n in notes:
            _text(page, 42, cy, n); cy += 11
        py = y + (11 if with_prefix else 0)
        for s in left:
            _text(page, 184, py, s); py += 11
        _text(page, 184, py, "            Versus"); py += 11
        for s in right:
            _text(page, 184, py, s); py += 11
        ay = y + (11 if with_prefix else 0)
        for s in pet:
            _text(page, 355, ay, s); ay += 11
        ry = y + (11 if with_prefix else 0)
        for s in resp:
            _text(page, 468, ry, s); ry += 11
        y = max(cy, py, ay, ry, top + 11 * rows) + 8

    # 1: plain
    item(1, "WP(C)/101/2026", ["FIXED"], ["ALPHA TRADERS"], ["THE STATE OF ASSAM AND 2 ORS."], ["MR A ONE", "MR B TWO"], ["GA, ASSAM"], "- FOR ORDERS -")
    exp_entries.append(dict(serial="1", case="WP(C)/101/2026", pet="ALPHA TRADERS", resp="THE STATE OF ASSAM AND 2 ORS.", pet_adv=["MR A ONE", "MR B TWO"], resp_adv=["GA, ASSAM"], heading="- FOR ORDERS -", court="COURT NO: 1", bench="DIVISION BENCH-I", page=1))
    # 2: wrapped petitioner party + advocate wrapped by width + designation that must NOT merge
    long_adv = "MR VERY LONG ADVOCATE NAME KUMAR"  # fills the column so that 'SARMA' cannot fit on the same line
    item(2, "Crl.A./55/2025", [], ["BETA INDUSTRIES LIMITED"], ["GAMMA CORPORATION OF", "INDIA LTD"], [long_adv, "SARMA", "MR C THREE"], ["SC, CGC", "DY.S.G.I."], "- FOR ORDERS -")
    exp_entries.append(dict(serial="2", case="Crl.A./55/2025", pet="BETA INDUSTRIES LIMITED", resp="GAMMA CORPORATION OF INDIA LTD", pet_adv=[f"{long_adv} SARMA", "MR C THREE"], resp_adv=["SC, CGC", "DY.S.G.I."], heading="- FOR ORDERS -", court="COURT NO: 1", bench="DIVISION BENCH-I", page=1))
    # 3: item with a mid-item WITH connected case (own parties) + 'in X' reference note
    top = y
    _text(page, 24, y, "3")
    _text(page, 42, y, "I.A.(Civil)/9/2026"); _text(page, 184, y, "DELTA ENTERPRISES"); _text(page, 355, y, "MR D FOUR")
    _text(page, 42, y + 11, "in WA/77/2024"); _text(page, 184, y + 11, "            Versus"); _text(page, 468, y + 11, "SC, BTC")
    _text(page, 184, y + 22, "EPSILON DEPT")
    _text(page, 42, y + 36, "WITH")
    _text(page, 42, y + 47, "WA/77/2024"); _text(page, 184, y + 47, "DELTA ENTERPRISES AND ORS"); _text(page, 355, y + 47, "MR E FIVE")
    _text(page, 184, y + 58, "            Versus"); _text(page, 184, y + 69, "EPSILON DEPT")
    y += 88
    exp_entries.append(dict(serial="3", case="I.A.(Civil)/9/2026", pet="DELTA ENTERPRISES", resp="EPSILON DEPT", pet_adv=["MR D FOUR"], resp_adv=["SC, BTC"], heading="- FOR ORDERS -", court="COURT NO: 1", bench="DIVISION BENCH-I", page=1, connected=["WA/77/2024"]))
    exp_entries.append(dict(serial="3", case="WA/77/2024", pet="DELTA ENTERPRISES AND ORS", resp="EPSILON DEPT", pet_adv=["MR E FIVE"], resp_adv=[], heading="- FOR ORDERS -", court="COURT NO: 1", bench="DIVISION BENCH-I", page=1, connected=["I.A.(CIVIL)/9/2026"]))
    # new heading
    _text(page, 199, y, "MATTERS RELATING TO TEST HEADING"); y += 19
    # 4: item starting with WITH (prefix) -> connected to previous item's last entry
    item(4, "WP(C)/102/2026", [], ["ZETA TRUST"], ["THE UNION OF INDIA"], ["MR F SIX"], ["SC, CGC"], "MATTERS RELATING TO TEST HEADING", with_prefix=True)
    exp_entries.append(dict(serial="4", case="WP(C)/102/2026", pet="ZETA TRUST", resp="THE UNION OF INDIA", pet_adv=["MR F SIX"], resp_adv=["SC, CGC"], heading="MATTERS RELATING TO TEST HEADING", court="COURT NO: 1", bench="DIVISION BENCH-I", page=1, connected=["WA/77/2024"]))
    _text(page, 287, 828, " 1/2 ")

    # page 2: continuation of court 1 (no header row), then court 2 (new header), then leave-note table
    page = doc.new_page(width=595.28, height=841.89)
    y = 60
    item(5, "WP(C)/103/2026", ["FIXED"], ["ETA PARTNERS"], ["THE STATE OF ASSAM"], ["MR G SEVEN"], ["GA, ASSAM"], "MATTERS RELATING TO TEST HEADING")
    exp_entries.append(dict(serial="5", case="WP(C)/103/2026", pet="ETA PARTNERS", resp="THE STATE OF ASSAM", pet_adv=["MR G SEVEN"], resp_adv=["GA, ASSAM"], heading="MATTERS RELATING TO TEST HEADING", court="COURT NO: 1", bench="DIVISION BENCH-I", page=2))
    y += 6
    _text(page, 264, y, "[AT 10:30 AM]"); y += 15
    _text(page, 277, y, "BEFORE:"); y += 14
    _text(page, 151, y, "HONOURABLE MR. JUSTICE GAMMA DELTA"); y += 17
    _text(page, 267, y, "COURT NO: 2"); y += 15
    _text(page, 14, y, "[CIVIL BENCH-I"); y += 11
    _text(page, 14, y, "THIS BENCH WILL TAKE UP MOTION MATTERS FIRST]"); y += 14
    _text(page, 11, y, rule, 5); y += 14
    _text(page, 14, y, "Sr.No. Case Number"); _text(page, 186, y, "Main Parties"); _text(page, 356, y, "Petitioner Advocate"); _text(page, 469, y, "Respondent Advocate"); y += 13
    _text(page, 11, y, rule, 5); y += 18
    item(1, "MACApp./7/2026", [], ["THETA INSURANCE CO LTD"], ["IOTA PERSON"], ["MR H EIGHT"], ["MR I NINE"], None)
    exp_entries.append(dict(serial="1", case="MACApp./7/2026", pet="THETA INSURANCE CO LTD", resp="IOTA PERSON", pet_adv=["MR H EIGHT"], resp_adv=["MR I NINE"], heading=None, court="COURT NO: 2", bench="CIVIL BENCH-I", page=2))
    _text(page, 11, y, "=" * 90, 5); y += 12
    _text(page, 11, y, "LEAVE NOTE OF ADVOCATES FOR 02/11/2026"); y += 14
    _text(page, 14, y, "1)"); _text(page, 51, y, "MS LEAVE PERSON"); _text(page, 242, y, "08-09-2026"); _text(page, 329, y, "To"); _text(page, 355, y, "23-12-2026")
    _text(page, 287, 828, " 2/2 ")
    out = doc.tobytes()
    return out, {"entries": exp_entries, "pages": 2, "pdf_date": "2026-11-02", "benches": 2}


def build_layout_b() -> tuple[bytes, dict]:
    """Layout B: no header row/rules, '1.' serials, '[ COURT NO: 9 ]', bracketed multi-line note, UPPER-CASE VERSUS, trailing WITH."""
    doc = pymupdf.open()
    page = doc.new_page(width=595.28, height=841.89)
    _text(page, 69, 124, "The Gauhati High Court, At Guwahati")
    _text(page, 204, 180, "[ SUPPLEMENTARY CAUSELIST-I ]")
    _text(page, 141, 202, " [ FOR MONDAY, THE 2ND   DAY OF NOVEMBER, 2026 ]")
    _text(page, 216, 228, "[AT 2:00 PM]")
    _text(page, 216, 253, "BEFORE")
    _text(page, 170, 279, "HONOURABLE MR. JUSTICE OMEGA PSI")
    _text(page, 36, 299, "[ COURT NO: 9 ]")
    for i, t in enumerate(["[ COURT PROCEEDING OF THE FOLLOWING CASES", "  PERTAINING TO A SYNTHETIC BENCH WILL BE", "  CONDUCTED THROUGH REMOTE VIDEO CONFERENCING ]"]):
        _text(page, 36, 332 + 12 * i, t)
    _text(page, 337, 382, "JUDGEMENT")
    y = 409
    exp = []

    def item(n, case, left, right, pet, resp, trailing_with=False):
        nonlocal y
        _text(page, 55, y, f"{n}.")
        _text(page, 77, y, case)
        py = y
        for s in left:
            _text(page, 197, py, s); py += 11
        _text(page, 197, py, " VERSUS "); py += 11
        for s in right:
            _text(page, 197, py, s); py += 11
        ay = y
        for s in pet:
            _text(page, 346, ay, s); ay += 11
        ry = y
        for s in resp:
            _text(page, 446, ry, s); ry += 11
        y = max(py, ay, ry) + 12
        if trailing_with:
            _text(page, 77, y - 10, "WITH"); y += 8

    item(1, "WP(C)/501/2024", ["SHRI SYNTHETIC ONE"], ["THE STATE OF TESTLAND AND 3", "ORS"], ["MR P ONE", "MR Q TWO"], ["GOVT ADV TL"], trailing_with=True)
    exp.append(dict(serial="1", case="WP(C)/501/2024", pet="SHRI SYNTHETIC ONE", resp="THE STATE OF TESTLAND AND 3 ORS", pet_adv=["MR P ONE", "MR Q TWO"], resp_adv=["GOVT ADV TL"], heading="JUDGEMENT", court="COURT NO: 9", bench=None, page=1))
    item(2, "WP(C)/502/2024", ["SHRI SYNTHETIC TWO"], ["STATE OF TESTLAND"], ["MR R THREE"], ["GOVT ADV TL"])
    exp.append(dict(serial="2", case="WP(C)/502/2024", pet="SHRI SYNTHETIC TWO", resp="STATE OF TESTLAND", pet_adv=["MR R THREE"], resp_adv=["GOVT ADV TL"], heading="JUDGEMENT", court="COURT NO: 9", bench=None, page=1, connected=["WP(C)/501/2024"]))
    _text(page, 287, 828, " 1/1 ")
    return doc.tobytes(), {"entries": exp, "pages": 1, "pdf_date": "2026-11-02", "benches": 1}


def build_scanned_page_pdf() -> tuple[bytes, dict]:
    """Page 1: real text layer. Page 2: image-only (a rendered picture of text) -> must go through OCR."""
    base = pymupdf.open()
    p1 = base.new_page(width=595.28, height=841.89)
    p1.insert_text((72, 100), "This page has an ordinary text layer with several words of content for the extractor.", fontsize=10)
    p1.insert_text((72, 120), "Second line of the ordinary page: writ petition notice register entries.", fontsize=10)
    tmp = pymupdf.open()
    tp = tmp.new_page(width=595.28, height=841.89)
    tp.insert_text((72, 200), "SCANNED PAGE WITH ORIGINAL IMAGE ONLY", fontsize=22)
    tp.insert_text((72, 260), "THE STATE OF ASSAM VERSUS ALPHA TRADERS", fontsize=22)
    pix = tp.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
    p2 = base.new_page(width=595.28, height=841.89)
    p2.insert_image(p2.rect, stream=pix.tobytes("png"))
    p3 = base.new_page(width=595.28, height=841.89)  # genuinely blank page
    return base.tobytes(), {"pages": 3, "ocr_pages": [2], "blank_pages": [3]}


def build_not_a_pdf() -> bytes:
    return b"<html><body>Please complete the CAPTCHA</body></html>"


if __name__ == "__main__":  # write the fixtures next to this file for manual inspection
    import pathlib

    here = pathlib.Path(__file__).parent
    for name, fn in [("layout_a.pdf", build_layout_a), ("layout_b.pdf", build_layout_b), ("scanned_mixed.pdf", build_scanned_page_pdf)]:
        (here / name).write_bytes(fn()[0])
        print("wrote", here / name)

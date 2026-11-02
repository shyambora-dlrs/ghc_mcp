import dataclasses
import json

import pymupdf
import pytest

from app.config import Settings
from app.extractors import ocr as ocr_mod
from app.extractors.pdf import PdfError, is_meaningful, open_pdf
from app.parsers.normalize import normalize_case_number, normalize_name
from app.services.pipeline import parse_pdf
from app.validators.validate import validate_entry
from app.models.schemas import Entry, Person
from accuracy import compare
from conftest import VECTORS, synthetic

S = Settings()


# ---------------------------------------------------------------- normalization parity with the TypeScript side
def test_normalization_matches_shared_vectors():
    vec = json.loads(VECTORS.read_text())
    for v in vec["case_numbers"]:
        n = normalize_case_number(v["input"])
        assert (n.normalized if n else None) == v["normalized"], v["input"]
        assert (n.key if n else None) == v["key"], v["input"]
    for v in vec["names"]:
        assert normalize_name(v["input"]) == v["normalized"], v["input"]


# ---------------------------------------------------------------- PDF validity
def test_rejects_non_pdf_oversize_and_corrupt():
    with pytest.raises(PdfError) as e:
        open_pdf(synthetic.build_not_a_pdf(), S)
    assert e.value.code == "NOT_A_PDF"
    with pytest.raises(PdfError) as e:
        open_pdf(b"%PDF-1.7\nthis is not really a pdf", S)
    assert e.value.code == "UNREADABLE"
    with pytest.raises(PdfError) as e:
        open_pdf(synthetic.build_layout_a()[0], dataclasses.replace(S, max_pdf_bytes=100))
    assert e.value.code == "TOO_LARGE"
    with pytest.raises(PdfError) as e:
        open_pdf(synthetic.build_layout_a()[0], S, max_pages=1)
    assert e.value.code == "TOO_MANY_PAGES"


def test_is_meaningful_ignores_table_rules():
    assert not is_meaningful("", 40, 0.45)
    assert not is_meaningful("a b", 40, 0.45)
    assert not is_meaningful("�" * 100, 40, 0.45)
    assert is_meaningful("---------- " * 30 + "WP(C)/12/2026 ALPHA VERSUS BETA ADVOCATE NAMES", 40, 0.45)


# ---------------------------------------------------------------- layout A
@pytest.fixture(scope="module")
def parsed_a():
    data, expected = synthetic.build_layout_a()
    return parse_pdf(data, S, listing_date="2026-11-02"), expected


def test_layout_a_extracts_every_expected_field(parsed_a):
    out, expected = parsed_a
    r = compare(out.entries, expected["entries"])
    assert r["missing"] == []
    assert r["parsed"] == r["expected"] == 7
    wrong = {f: v for f, v in r["fields"].items() if v[0] != v[1]}
    assert wrong == {}, wrong
    assert out.extraction_status == "EXTRACTED"


def test_layout_a_page_references_and_page_text(parsed_a):
    out, _ = parsed_a
    assert out.page_count == 2 and [p.page_number for p in out.pages] == [1, 2]
    assert all(p.page_status == "OK" and p.extraction_method == "TEXT" and p.text_content for p in out.pages)
    by = {e.case_number_raw: e for e in out.entries}
    assert by["WP(C)/101/2026"].page_start == 1 and by["WP(C)/103/2026"].page_start == 2
    assert all(1 <= e.page_start <= e.page_end <= out.page_count for e in out.entries)


def test_layout_a_connected_cases_and_notes(parsed_a):
    out, _ = parsed_a
    by = {e.case_number_raw: e for e in out.entries}
    ia, wa = by["I.A.(Civil)/9/2026"], by["WA/77/2024"]
    assert "WA/77/2024" in ia.connected_cases and "I.A.(CIVIL)/9/2026" in wa.connected_cases
    assert wa.listing_note_raw.startswith("WITH") and ia.serial_number == wa.serial_number == "3"
    assert by["WP(C)/102/2026"].connected_cases == ["WA/77/2024"]  # item that starts with WITH
    assert by["WP(C)/101/2026"].listing_note_raw == "FIXED"


def test_layout_a_bench_context_and_pdf_date(parsed_a):
    out, _ = parsed_a
    b1 = out.entries[0].bench
    assert b1.court_label_raw == "COURT NO: 1" and b1.bench_label_raw == "DIVISION BENCH-I"
    assert b1.judges == ["HONOURABLE THE CHIEF JUSTICE", "HONOURABLE MR. JUSTICE ALPHA BETA"] and b1.sitting_time_raw == "AT 10:30 AM"
    b2 = out.entries[-1].bench
    assert b2.court_label_raw == "COURT NO: 2" and b2.bench_label_raw == "CIVIL BENCH-I" and b2.notes == ["THIS BENCH WILL TAKE UP MOTION MATTERS FIRST"]
    assert out.metadata["pdf_date_text"] == "2026-11-02" and "pdf_date_mismatch" not in out.metadata
    assert out.metadata["benches"] == 2
    assert out.metadata["serial_stats"]["missing"] == 0 and out.metadata["serial_stats"]["backwards"] == 0


def test_leave_note_table_is_not_parsed_as_entries(parsed_a):
    out, _ = parsed_a
    assert not any("LEAVE" in e.raw_text or "MS LEAVE PERSON" in e.raw_text for e in out.entries)


def test_wrapped_advocate_merged_but_designation_kept_separate(parsed_a):
    out, _ = parsed_a
    e = next(x for x in out.entries if x.case_number_raw == "Crl.A./55/2025")
    assert [a.name_raw for a in e.advocates if a.side == "RESPONDENT"] == ["SC, CGC", "DY.S.G.I."]
    assert any(a.name_raw.endswith("KUMAR SARMA") for a in e.advocates)
    assert "ADVOCATE_WRAP_HEURISTIC" in e.validation_flags  # transparency: a heuristic was applied


def test_pdf_date_mismatch_is_reported_not_silently_accepted():
    data, _ = synthetic.build_layout_a()
    out = parse_pdf(data, S, listing_date="2026-11-05")
    assert out.metadata["pdf_date_mismatch"] == {"pdf": "2026-11-02", "source_listing_date": "2026-11-05"}


def test_raw_text_preserved_per_entry(parsed_a):
    out, _ = parsed_a
    e = next(x for x in out.entries if x.case_number_raw == "WP(C)/101/2026")
    assert "ALPHA TRADERS" in e.raw_text and "MR A ONE" in e.raw_text and " | " in e.raw_text


# ---------------------------------------------------------------- layout B
def test_layout_b_without_header_row_or_rules():
    data, expected = synthetic.build_layout_b()
    out = parse_pdf(data, S, listing_date="2026-11-02")
    r = compare(out.entries, expected["entries"])
    assert r["missing"] == [] and {f: v for f, v in r["fields"].items() if v[0] != v[1]} == {}
    b = out.entries[0].bench
    assert b.court_label_raw == "COURT NO: 9" and b.bench_label_raw is None and b.notes and "SYNTHETIC BENCH" in b.notes[0]
    assert out.entries[1].connected_cases == ["WP(C)/501/2024"]  # trailing WITH connects the next item
    assert out.metadata["pdf_date_text"] == "2026-11-02"
    assert out.metadata["column_sources"].get("clusters", 0) >= 1  # columns inferred from data, not hard-coded


# ---------------------------------------------------------------- OCR fallback & blank pages
needs_ocr = pytest.mark.skipif(not ocr_mod.ocr_available(), reason="tesseract not installed")


@needs_ocr
def test_scanned_page_goes_through_ocr_but_text_pages_do_not():
    data, expected = synthetic.build_scanned_page_pdf()
    out = parse_pdf(data, S, parse_entries=False)
    st = {p.page_number: (p.page_status, p.extraction_method) for p in out.pages}
    assert st[1] == ("OK", "TEXT")
    assert st[2] == ("OCR_USED", "OCR")
    assert st[3][0] == "EMPTY"  # blank page: no OCR attempted
    assert "SCANNED" in out.pages[1].text_content.upper() and out.pages[1].ocr_confidence and out.pages[1].ocr_confidence > 0.5
    assert out.metadata["ocr_pages"] == [2]
    assert out.extraction_status == "EXTRACTED"


def test_ocr_disabled_marks_image_only_page_and_never_claims_clean_extraction():
    data, _ = synthetic.build_scanned_page_pdf()
    out = parse_pdf(data, dataclasses.replace(S, ocr_enabled=False), parse_entries=False)
    assert out.pages[1].page_status == "OCR_FAILED"
    assert out.extraction_status == "PARTIALLY_EXTRACTED"


def test_image_only_document_without_ocr_is_ocr_required():
    base = pymupdf.open()
    tmp = pymupdf.open()
    tp = tmp.new_page()
    tp.insert_text((72, 200), "IMAGE ONLY CONTENT", fontsize=22)
    png = tp.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False).tobytes("png")
    pg = base.new_page()
    pg.insert_image(pg.rect, stream=png)
    out = parse_pdf(base.tobytes(), dataclasses.replace(S, ocr_enabled=False))
    assert out.entries == [] and out.extraction_status == "OCR_REQUIRED"


# ---------------------------------------------------------------- validation & idempotency
def _entry(**kw):
    base = dict(entry_index=0, page_start=1, page_end=1, raw_text="x", serial_number="1", bench=None)
    base.update(kw)
    return Entry(**base)


def test_uncertain_critical_fields_require_review_and_nothing_is_invented():
    e = validate_entry(_entry(case_number_raw="NOT A CASE", parties=[Person(name_raw="A", side="PETITIONER", sequence=0)]), S)
    assert e.validation_status == "NEEDS_REVIEW" and "CASE_NUMBER_UNNORMALIZED" in e.validation_flags
    e = validate_entry(_entry(), S)
    assert e.validation_status == "UNPARSED" and e.case_number_raw is None
    e = validate_entry(_entry(case_number_raw="WP(C)/1/2026", parties=[Person(name_raw="A", side="PETITIONER", sequence=0)]), S)
    assert e.validation_status == "NEEDS_REVIEW" and "NO_BENCH_CONTEXT" in e.validation_flags  # 0.85 threshold not met
    ocr = validate_entry(_entry(case_number_raw="WP(C)/1/2026", extraction_method="OCR", parties=[Person(name_raw="A", side="PETITIONER", sequence=0)]), S, 0.5)
    assert ocr.validation_status == "NEEDS_REVIEW" and "LOW_OCR_CONFIDENCE" in ocr.validation_flags and ocr.extraction_confidence <= 0.45


def test_confidence_is_explainable_and_bounded(parsed_a):
    out, _ = parsed_a
    for e in out.entries:
        assert 0.0 <= e.extraction_confidence <= 1.0
        assert e.validation_status == "VALIDATED" or e.validation_flags


def test_parsing_is_idempotent(parsed_a):
    data, _ = synthetic.build_layout_a()
    a = parse_pdf(data, S, listing_date="2026-11-02")
    b = parse_pdf(data, S, listing_date="2026-11-02")
    strip = lambda o: [e.model_dump() for e in o.entries]  # noqa: E731
    assert strip(a) == strip(b) == strip(parsed_a[0])
    assert [p.text_content for p in a.pages] == [p.text_content for p in b.pages]


def test_notice_documents_store_pages_without_entries():
    data, _ = synthetic.build_layout_a()
    out = parse_pdf(data, S, parse_entries=False)
    assert out.entries == [] and out.extraction_status == "EXTRACTED" and len(out.pages) == 2


def test_unrecognised_layout_yields_review_required_not_fabricated_entries():
    doc = pymupdf.open()
    pg = doc.new_page()
    for i in range(30):
        pg.insert_text((72, 80 + i * 14), f"Free form paragraph number {i} with ordinary prose and no table at all.", fontsize=9)
    out = parse_pdf(doc.tobytes(), S)
    assert out.entries == [] and out.extraction_status == "REVIEW_REQUIRED"

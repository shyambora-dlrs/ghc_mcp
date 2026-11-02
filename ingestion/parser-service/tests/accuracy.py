"""Field-level comparison of parser output against the ground truth emitted by the synthetic fixture builders."""
from __future__ import annotations

from collections import defaultdict

from app.parsers.normalize import normalize_case_number


def _adv(e, side):
    return [a.name_raw for a in e.advocates if a.side == side]


def compare(entries, expected) -> dict:
    """Matches expected entries to parsed ones by normalized case number; returns per-field hit counts."""
    hits: dict[str, list[int]] = defaultdict(lambda: [0, 0])  # field -> [correct, total]
    by_case = defaultdict(list)
    for e in entries:
        n = normalize_case_number(e.case_number_raw)
        by_case[n.normalized if n else e.case_number_raw].append(e)
    missing = []
    for x in expected:
        n = normalize_case_number(x["case"])
        cands = by_case.get(n.normalized if n else x["case"], [])
        got = next((c for c in cands if c.serial_number == x["serial"]), cands[0] if cands else None)
        for f in ("case_number", "serial_number", "page_reference", "petitioner", "respondent", "petitioner_advocates", "respondent_advocates", "court", "bench", "section_heading"):
            hits[f][1] += 1
        if got is None:
            missing.append(x["case"])
            continue
        parties = {p.side: p.name_raw for p in got.parties}
        checks = {
            "case_number": True,
            "serial_number": got.serial_number == x["serial"],
            "page_reference": got.page_start == x["page"] == got.page_end,
            "petitioner": parties.get("PETITIONER") == x["pet"],
            "respondent": parties.get("RESPONDENT") == x["resp"],
            "petitioner_advocates": _adv(got, "PETITIONER") == x["pet_adv"],
            "respondent_advocates": _adv(got, "RESPONDENT") == x["resp_adv"],
            "court": (got.bench.court_label_raw if got.bench else None) == x["court"],
            "bench": (got.bench.bench_label_raw if got.bench else None) == x["bench"],
            "section_heading": got.section_heading_raw == x["heading"],
        }
        for f, ok in checks.items():
            hits[f][0] += int(ok)
    return {"fields": {f: tuple(v) for f, v in hits.items()}, "missing": missing, "expected": len(expected), "parsed": len(entries)}

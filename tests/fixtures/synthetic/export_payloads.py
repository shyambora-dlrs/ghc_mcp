"""Exports the exact begin/chunk/complete payloads the parser would POST to the Worker for the synthetic fixtures.
The TypeScript contract test (apps/mcp-worker/test/integration/contract.test.ts) validates them with the Worker's zod
schema and ingests them into D1, proving the Python -> Worker contract. Regenerate: python tests/fixtures/synthetic/export_payloads.py"""
import dataclasses
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "ingestion/parser-service"))
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app.config import Settings  # noqa: E402
from app.services.jobs import deliver  # noqa: E402
from app.services.pipeline import parse_pdf  # noqa: E402
import generate_synthetic_pdfs as g  # noqa: E402


class Capture:
    def __init__(self):
        self.posts = []

    def post(self, url, payload, attempts=4):
        self.posts.append(payload)
        return {}


def main():
    s = dataclasses.replace(Settings(), page_chunk=1, entry_chunk=3)
    out = {}
    for name, builder in [("layout_a", g.build_layout_a), ("layout_b", g.build_layout_b)]:
        data, expected = builder()
        parsed = parse_pdf(data, s, listing_date="2026-11-02")
        cap = Capture()
        deliver(cap, "cb", parsed, s)
        # volatile timing metadata would make the fixture churn on every regeneration
        for p in cap.posts:
            if p["phase"] == "complete":
                p["metadata"].pop("elapsed_ms", None)
        out[name] = {"payloads": cap.posts, "expected_cases": [e["case"] for e in expected["entries"]]}
    path = pathlib.Path(__file__).parent / "parser_payloads.json"
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf8")
    print("wrote", path)


if __name__ == "__main__":
    main()

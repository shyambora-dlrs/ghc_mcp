"""Local CLI: parse a PDF without any network or Worker (development / fixtures / accuracy checks).

  python -m app.cli parse FILE.pdf [--no-entries] [--listing-date YYYY-MM-DD] [--out result.json] [--no-ocr]
  python -m app.cli run-pending --worker https://worker.example   # runner mode (needs PARSER_CALLBACK_TOKEN)
  python -m app.cli crawl-push --worker https://worker.example --ca-bundle ca.pem   # push-mode crawl
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from pathlib import Path

from .config import Settings
from .services.pipeline import parse_pdf


def _settings(args) -> Settings:
    s = Settings()
    return dataclasses.replace(s, ocr_enabled=False) if getattr(args, "no_ocr", False) else s


def cmd_parse(args) -> int:
    data = Path(args.file).read_bytes()
    out = parse_pdf(data, _settings(args), parse_entries=not args.no_entries, listing_date=args.listing_date)
    payload = {
        "parser_version": out.parser_version,
        "page_count": out.page_count,
        "extraction_status": out.extraction_status,
        "metadata": out.metadata,
        "pages": [p.model_dump() for p in out.pages] if args.with_pages else f"{len(out.pages)} pages (use --with-pages)",
        "entries": [e.model_dump() for e in out.entries],
    }
    text = json.dumps(payload, indent=1, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(text, encoding="utf8")
    summary = {k: payload[k] for k in ("parser_version", "page_count", "extraction_status", "metadata")}
    summary["entry_count"] = len(out.entries)
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    return 0


def cmd_run_pending(args) -> int:
    from .clients.worker_client import WorkerClient
    from .services.jobs import run_pending

    s = _settings(args)
    n = run_pending(WorkerClient(args.worker, s.callback_token), s, limit=args.limit)
    print(f"processed {n} version(s)")
    return 0


def cmd_crawl_push(args) -> int:
    import os

    from .clients.worker_client import WorkerClient
    from .services.runner import SourceRunner

    s = _settings(args)
    runner = SourceRunner(
        WorkerClient(args.worker, s.callback_token),
        ca_bundle=args.ca_bundle or os.environ.get("SOURCE_CA_BUNDLE"),
        user_agent=os.environ.get("CRAWLER_USER_AGENT", "GHC-Cause-List-MCP/1.0 (runner)"),
        min_interval_s=float(os.environ.get("CRAWLER_MIN_INTERVAL_MS", "3000")) / 1000.0,
    )
    print(json.dumps(runner.run(lookback_days=args.lookback_days, limit=args.limit), indent=1))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ghc-parser")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("parse")
    p.add_argument("file")
    p.add_argument("--no-entries", action="store_true", help="extract page text only (notices)")
    p.add_argument("--listing-date")
    p.add_argument("--out")
    p.add_argument("--with-pages", action="store_true")
    p.add_argument("--no-ocr", action="store_true")
    p.set_defaults(fn=cmd_parse)
    r = sub.add_parser("run-pending")
    r.add_argument("--worker", required=True)
    r.add_argument("--limit", type=int, default=10)
    r.add_argument("--no-ocr", action="store_true")
    r.set_defaults(fn=cmd_run_pending)
    c = sub.add_parser("crawl-push", help="fetch the source page + PDFs locally and push them to the Worker")
    c.add_argument("--worker", required=True)
    c.add_argument("--ca-bundle", help="PEM bundle (system CAs + the site's intermediate); see scripts/build-ca-bundle.sh")
    c.add_argument("--lookback-days", type=int)
    c.add_argument("--limit", type=int)
    c.add_argument("--no-ocr", action="store_true")
    c.set_defaults(fn=cmd_crawl_push)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

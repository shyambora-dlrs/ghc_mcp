"""Executes one parse job: download PDF -> parse -> deliver begin / chunks / complete to the Worker."""
from __future__ import annotations

import logging
from typing import Optional

from ..clients.worker_client import WorkerClient, WorkerError
from ..config import PARSER_VERSION, Settings
from ..extractors.pdf import PdfError
from ..models.schemas import ParseJob, ParseOutput
from .pipeline import parse_pdf

log = logging.getLogger("parser.jobs")


def deliver(client: WorkerClient, callback_url: str, out: ParseOutput, s: Settings) -> None:
    v = out.parser_version
    client.post(callback_url, {"phase": "begin", "parser_version": v, "page_count": out.page_count})
    for i in range(0, len(out.pages), s.page_chunk):
        client.post(callback_url, {"phase": "chunk", "parser_version": v, "pages": [p.model_dump() for p in out.pages[i : i + s.page_chunk]], "entries": []})
    for i in range(0, len(out.entries), s.entry_chunk):
        client.post(callback_url, {"phase": "chunk", "parser_version": v, "pages": [], "entries": [e.model_dump() for e in out.entries[i : i + s.entry_chunk]]})
    client.post(callback_url, {"phase": "complete", "parser_version": v, "extraction_status": out.extraction_status, "metadata": out.metadata})


def run_job(job: ParseJob, client: WorkerClient, s: Settings) -> Optional[ParseOutput]:
    """Never raises: any failure is reported to the Worker as a `failed` phase (best effort) and logged without content."""
    vid = job.document_version_id
    try:
        data = client.fetch_pdf(job.pdf_url)
        out = parse_pdf(data, s, parse_entries=job.parse_entries, listing_date=job.listing_date, max_pages=job.max_pages)
        deliver(client, job.callback_url, out, s)
        log.info("job %s done: %s pages, %s entries, status %s", vid, out.page_count, len(out.entries), out.extraction_status)
        return out
    except PdfError as exc:
        _fail(client, job, exc.code, str(exc))
    except WorkerError as exc:
        _fail(client, job, "WORKER_ERROR", str(exc))
    except Exception as exc:  # parser bug: report the type only, never document text
        log.exception("job %s crashed", vid)
        _fail(client, job, "PARSER_ERROR", type(exc).__name__)
    return None


def _fail(client: WorkerClient, job: ParseJob, code: str, message: str) -> None:
    log.warning("job %s failed: %s", job.document_version_id, code)
    try:
        client.post(job.callback_url, {"phase": "failed", "parser_version": PARSER_VERSION, "error_code": code[:100], "error_message": message[:900]}, attempts=2)
    except Exception:  # the Worker will keep the version PENDING_PARSE and an admin can retry
        log.warning("could not report failure for %s", job.document_version_id)


def run_pending(client: WorkerClient, s: Settings, limit: int = 10) -> int:
    """Runner mode (no always-on service): process versions the Worker lists as PENDING_PARSE."""
    n = 0
    for item in client.pending(limit):
        vid = item["version_id"]
        job = ParseJob(
            document_version_id=vid, document_id=item.get("document_id"), category=item.get("category"), listing_date=item.get("listing_date"),
            parse_entries=item.get("category") in {"DAILY", "SUPPLEMENTARY", "LAWAZIMA", "REGULAR_HEARING"},
            pdf_url=f"{client.base}/internal/versions/{vid}/pdf", callback_url=f"{client.base}/internal/versions/{vid}/parse-result",
        )
        run_job(job, client, s)
        n += 1
    return n

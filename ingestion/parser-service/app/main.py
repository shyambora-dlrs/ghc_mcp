"""FastAPI parser service. Stateless; authenticated; one job at a time (CPU/memory bound)."""
from __future__ import annotations

import hmac
import logging
import threading

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException

from .clients.worker_client import WorkerClient
from .config import PARSER_VERSION, Settings
from .extractors import ocr as ocr_mod
from .models.schemas import ParseJob
from .services.jobs import run_job

logging.basicConfig(level=logging.INFO, format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}')

app = FastAPI(title="GHC cause-list parser", version=PARSER_VERSION, docs_url=None, redoc_url=None, openapi_url=None)
_busy = threading.Semaphore(1)


def get_settings() -> Settings:
    return Settings()


def require_token(authorization: str | None = Header(default=None), s: Settings = Depends(get_settings)) -> None:
    expected = s.service_token
    token = authorization[7:] if authorization and authorization.lower().startswith("bearer ") else ""
    if len(expected) < 16 or not hmac.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _check_origin(url: str, s: Settings) -> None:
    """SSRF guard: the parser only talks to the configured Worker, only to its internal routes."""
    allowed = f"{s.worker_origin}/internal/versions/"
    if not s.worker_origin or not url.startswith(allowed) or "@" in url.split("/internal/")[0]:
        raise HTTPException(status_code=400, detail="URL is not under the configured WORKER_ORIGIN")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "parser_version": PARSER_VERSION, "ocr_available": ocr_mod.ocr_available()}


@app.post("/jobs/parse", status_code=202, dependencies=[Depends(require_token)])
def submit(job: ParseJob, bg: BackgroundTasks, s: Settings = Depends(get_settings)) -> dict:
    _check_origin(job.pdf_url, s)
    _check_origin(job.callback_url, s)
    if not s.callback_token:
        raise HTTPException(status_code=503, detail="PARSER_CALLBACK_TOKEN is not configured")
    if not _busy.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="Parser is busy; retry later")

    def work() -> None:
        try:
            run_job(job, WorkerClient(s.worker_origin, s.callback_token, max_pdf_bytes=s.max_pdf_bytes), s)
        finally:
            _busy.release()

    bg.add_task(work)
    return {"accepted": True, "document_version_id": job.document_version_id}

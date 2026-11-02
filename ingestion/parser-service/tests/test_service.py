import dataclasses
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.clients.worker_client import WorkerClient
from app.config import Settings
from app.models.schemas import ParseJob
from app.services.jobs import run_job
from conftest import synthetic

ORIGIN = "https://worker.example"
TOKEN = "t" * 24
CB = "c" * 24
S = dataclasses.replace(Settings(), worker_origin=ORIGIN, service_token=TOKEN, callback_token=CB, page_chunk=1, entry_chunk=3)


class FakeWorker:
    """Plays the Worker's internal routes through httpx.MockTransport and records every callback."""

    def __init__(self, pdf: bytes, fail_status: int | None = None):
        self.pdf, self.posts, self.fail_status, self.auth = pdf, [], fail_status, set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.auth.add(request.headers.get("authorization"))
        if request.method == "GET" and request.url.path.endswith("/pdf"):
            return httpx.Response(200, content=self.pdf)
        body = json.loads(request.content)
        self.posts.append(body)
        if self.fail_status and body["phase"] == "chunk":
            return httpx.Response(self.fail_status, text="boom")
        return httpx.Response(200, json={"success": True})


def client_for(fw: FakeWorker) -> WorkerClient:
    return WorkerClient(ORIGIN, CB, httpx.Client(transport=httpx.MockTransport(fw)))


def job(**kw) -> ParseJob:
    d = dict(document_version_id="ver_1", pdf_url=f"{ORIGIN}/internal/versions/ver_1/pdf", callback_url=f"{ORIGIN}/internal/versions/ver_1/parse-result", listing_date="2026-11-02")
    d.update(kw)
    return ParseJob(**d)


def test_job_delivers_begin_chunks_complete_in_order_with_bounded_chunks():
    fw = FakeWorker(synthetic.build_layout_a()[0])
    out = run_job(job(), client_for(fw), S)
    phases = [p["phase"] for p in fw.posts]
    assert phases[0] == "begin" and phases[-1] == "complete" and set(phases[1:-1]) == {"chunk"}
    chunks = [p for p in fw.posts if p["phase"] == "chunk"]
    assert all(len(c["pages"]) <= 1 and len(c["entries"]) <= 3 for c in chunks)
    assert sum(len(c["entries"]) for c in chunks) == len(out.entries) == 7
    assert fw.posts[0]["page_count"] == 2 and fw.posts[-1]["extraction_status"] == "EXTRACTED"
    assert fw.auth == {f"Bearer {CB}"}  # the callback token, never the service token


def test_bad_pdf_is_reported_as_failed_not_raised():
    fw = FakeWorker(synthetic.build_not_a_pdf())
    assert run_job(job(), client_for(fw), S) is None
    assert fw.posts[-1]["phase"] == "failed" and fw.posts[-1]["error_code"] == "NOT_A_PDF"


def test_worker_rejection_is_reported_without_document_text(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda *_: None)
    fw = FakeWorker(synthetic.build_layout_a()[0], fail_status=422)
    run_job(job(), client_for(fw), S)
    last = fw.posts[-1]
    assert last["phase"] == "failed" and last["error_code"] == "WORKER_ERROR" and "ALPHA TRADERS" not in json.dumps(last)


def test_transient_worker_errors_are_retried(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda *_: None)
    fw = FakeWorker(synthetic.build_layout_a()[0], fail_status=503)
    run_job(job(), client_for(fw), S)
    assert sum(1 for p in fw.posts if p["phase"] == "chunk") >= 4  # retried, then gave up and reported
    assert fw.posts[-1]["phase"] == "failed"


# ------------------------------------------------------------------------- HTTP surface
@pytest.fixture()
def api(monkeypatch):
    main.app.dependency_overrides[main.get_settings] = lambda: S
    ran = []
    monkeypatch.setattr(main, "run_job", lambda j, c, s: ran.append(j.document_version_id))
    yield TestClient(main.app), ran
    main.app.dependency_overrides.clear()


def body(**kw):
    return job(**kw).model_dump()


def test_requires_bearer_token(api):
    c, ran = api
    assert c.post("/jobs/parse", json=body()).status_code == 401
    assert c.post("/jobs/parse", json=body(), headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert ran == []


def test_accepts_valid_job_and_runs_it(api):
    c, ran = api
    r = c.post("/jobs/parse", json=body(), headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 202 and r.json()["accepted"] is True
    assert ran == ["ver_1"]
    assert main._busy.acquire(blocking=False)  # released after the job
    main._busy.release()


def test_rejects_urls_outside_the_worker_origin(api):
    c, ran = api
    h = {"Authorization": f"Bearer {TOKEN}"}
    for bad in ["https://evil.example/internal/versions/x/pdf", f"{ORIGIN}.evil.example/internal/versions/x/pdf", f"{ORIGIN}/admin/jobs", "http://169.254.169.254/latest/meta-data", f"https://user@{ORIGIN[8:]}/internal/versions/x"]:
        assert c.post("/jobs/parse", json=body(pdf_url=bad), headers=h).status_code == 400, bad
        assert c.post("/jobs/parse", json=body(callback_url=bad), headers=h).status_code == 400, bad
    assert ran == []


def test_busy_parser_asks_the_queue_to_retry(api):
    c, _ = api
    assert main._busy.acquire(blocking=False)
    try:
        assert c.post("/jobs/parse", json=body(), headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 503
    finally:
        main._busy.release()


def test_health_and_no_public_docs(api):
    c, _ = api
    assert c.get("/health").json()["status"] == "ok"
    assert c.get("/docs").status_code == 404 and c.get("/openapi.json").status_code == 404

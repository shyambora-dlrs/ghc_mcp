import json

import httpx
import pytest

from app.clients.worker_client import WorkerClient
from app.services.runner import RunnerError, SourceRunner
from conftest import synthetic

PAGE = "https://ghconline.gov.in/index.php/consolidated-cause-list/"
PDF1 = "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf"
PDF2 = "https://ghconline.gov.in/NewCList/sl-03-11-2026.pdf"
PDF3 = "https://ghconline.gov.in/NewCList/lz-03-11-2026.pdf"
WORKER = "https://worker.example"


def make(source_handler, worker_handler, **kw):
    sleeps = []
    worker = WorkerClient(WORKER, "cb-token-0123456789abcdef", httpx.Client(transport=httpx.MockTransport(worker_handler)))
    runner = SourceRunner(worker, http=httpx.Client(transport=httpx.MockTransport(source_handler)), sleep=sleeps.append, min_interval_s=3.0, **kw)
    return runner, sleeps


def test_pushes_page_then_conditional_pdfs_and_respects_the_interval():
    pdf = synthetic.build_layout_a()[0]
    seen = []

    def source(req: httpx.Request) -> httpx.Response:
        seen.append((str(req.url), req.headers.get("if-none-match"), req.headers.get("user-agent")))
        if str(req.url) == PAGE:
            return httpx.Response(200, text="<html>" + "x" * 200)
        if str(req.url) == PDF1:
            return httpx.Response(200, content=pdf, headers={"etag": '"v2"', "last-modified": "Mon, 02 Nov 2026 01:00:00 GMT"})
        if str(req.url) == PDF2:
            return httpx.Response(304)
        if str(req.url) == PDF3:
            return httpx.Response(200, content=b"<html>CAPTCHA</html>")  # not a PDF -> rejected
        return httpx.Response(404)

    pushed = []

    def worker(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer cb-token-0123456789abcdef"
        if req.url.path == "/internal/runner/source-page":
            body = json.loads(req.content)
            assert body["final_url"] == PAGE and body["lookback_days"] == 2
            return httpx.Response(200, json={"success": True, "summary": {"discovered": 3, "newDocuments": 3, "toFetch": [
                {"document_id": "doc_1", "url": PDF1, "etag": '"v1"', "last_modified": None},
                {"document_id": "doc_2", "url": PDF2, "etag": '"w1"', "last_modified": None},
                {"document_id": "doc_3", "url": PDF3, "etag": None, "last_modified": None}]}})
        pushed.append((req.method, req.url.path, req.headers.get("x-source-etag"), req.headers.get("x-source-final-url"), len(req.content)))
        return httpx.Response(200, json={"success": True, "outcome": {"kind": "NEW_VERSION"}})

    runner, sleeps = make(source, worker)
    stats = runner.run(lookback_days=2)
    assert stats == {"discovered": 3, "new": 3, "selected": 3, "stored": 1, "unchanged": 0, "not_modified": 1, "failed": 1}
    assert pushed == [("PUT", "/internal/runner/documents/doc_1/pdf", '"v2"', PDF1, len(pdf))]
    assert [s[1] for s in seen] == [None, '"v1"', '"w1"', None]  # conditional requests use the stored ETags
    assert all("GHC-Cause-List-MCP" in (s[2] or "") for s in seen)
    assert sleeps and all(s > 0 for s in sleeps)  # throttled between source requests (min interval)


def test_refuses_hosts_outside_the_allowlist_including_redirects():
    def source(req: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://evil.example/x"})

    runner, _ = make(source, lambda r: httpx.Response(500))
    with pytest.raises(RunnerError):
        runner.run()
    with pytest.raises(RunnerError):
        runner._get("http://ghconline.gov.in/insecure")
    with pytest.raises(RunnerError):
        runner._get("https://ghconline.gov.in:8443/x")


def test_unchanged_worker_outcome_counts_as_unchanged():
    def source(req):
        return httpx.Response(200, text="<html>" + "x" * 200) if str(req.url) == PAGE else httpx.Response(200, content=synthetic.build_layout_a()[0])

    def worker(req):
        if req.url.path.endswith("source-page"):
            return httpx.Response(200, json={"summary": {"discovered": 1, "newDocuments": 0, "toFetch": [{"document_id": "d", "url": PDF1, "etag": None, "last_modified": None}]}})
        return httpx.Response(200, json={"outcome": {"kind": "UNCHANGED_HASH"}})

    runner, _ = make(source, worker)
    assert runner.run()["unchanged"] == 1

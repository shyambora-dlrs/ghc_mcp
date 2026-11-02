"""Push-mode runner: fetches the source page and PDFs from the Court's site with a TLS trust store that can validate
the site's (incomplete) certificate chain, and pushes them to the Worker. Same politeness rules as the Worker crawler:
allowlisted hosts only (redirects re-checked), >= min interval between requests, conditional requests, size cap,
%PDF- signature check. Use it when the Workers runtime cannot verify the source's TLS chain, or from a scheduled job."""
from __future__ import annotations

import logging
import time
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx

from ..clients.worker_client import WorkerClient, WorkerError

log = logging.getLogger("parser.runner")
ALLOWED_HOSTS = {"ghconline.gov.in", "www.ghconline.gov.in"}
SOURCE_PAGE = "https://ghconline.gov.in/index.php/consolidated-cause-list/"


class RunnerError(Exception):
    pass


def _check(url: str) -> None:
    u = urlparse(url)
    if u.scheme != "https" or (u.hostname or "").lower() not in ALLOWED_HOSTS or u.username or (u.port not in (None, 443)):
        raise RunnerError(f"URL not allowed by the source allowlist: {u.scheme}://{u.hostname}")


class SourceRunner:
    def __init__(
        self,
        worker: WorkerClient,
        *,
        source_url: str = SOURCE_PAGE,
        ca_bundle: Optional[str] = None,
        user_agent: str = "GHC-Cause-List-MCP/1.0 (runner)",
        min_interval_s: float = 3.0,
        max_pdf_bytes: int = 52_428_800,
        http: Optional[httpx.Client] = None,
        sleep=time.sleep,
    ):
        self.worker = worker
        self.source_url = source_url
        self.min_interval = min_interval_s
        self.user_agent = user_agent
        self.max_pdf_bytes = max_pdf_bytes
        self._sleep = sleep
        self._last = 0.0
        self._http = http or httpx.Client(verify=ca_bundle or True, headers={"User-Agent": user_agent}, timeout=httpx.Timeout(90.0, connect=15.0), follow_redirects=False)

    def _get(self, url: str, headers: Optional[dict] = None) -> httpx.Response:
        for _hop in range(6):
            _check(url)
            wait = self._last + self.min_interval - time.monotonic()
            if wait > 0:
                self._sleep(wait)
            self._last = time.monotonic()
            r = self._http.get(url, headers={"User-Agent": self.user_agent, **(headers or {})})
            if 300 <= r.status_code < 400 and r.headers.get("location"):
                url = urljoin(url, r.headers["location"])
                continue
            r._final_url = url  # type: ignore[attr-defined]
            return r
        raise RunnerError("too many redirects")

    def run(self, lookback_days: Optional[int] = None, limit: Optional[int] = None) -> dict:
        page = self._get(self.source_url, {"Accept": "text/html"})
        if page.status_code != 200:
            raise RunnerError(f"source page returned HTTP {page.status_code}")
        body: dict = {"html": page.text, "final_url": page._final_url}  # type: ignore[attr-defined]
        if lookback_days is not None:
            body["lookback_days"] = lookback_days
        summary = self.worker.post(f"{self.worker.base}/internal/runner/source-page", body)["summary"]
        todo = summary.get("toFetch", [])[:limit]
        stats = {"discovered": summary["discovered"], "new": summary["newDocuments"], "selected": len(todo), "stored": 0, "unchanged": 0, "not_modified": 0, "failed": 0}
        for item in todo:
            try:
                cond = {"Accept": "application/pdf"}
                if item.get("etag"):
                    cond["If-None-Match"] = item["etag"]
                elif item.get("last_modified"):
                    cond["If-Modified-Since"] = item["last_modified"]
                r = self._get(item["url"], cond)
                if r.status_code == 304:
                    stats["not_modified"] += 1
                    continue
                if r.status_code != 200:
                    log.warning("HTTP %s for %s", r.status_code, item["document_id"])
                    stats["failed"] += 1
                    continue
                data = r.content
                if len(data) > self.max_pdf_bytes or b"%PDF-" not in data[:1024]:
                    log.warning("rejected non-PDF/oversized download for %s", item["document_id"])
                    stats["failed"] += 1
                    continue
                out = self._put_pdf(item["document_id"], data, r)
                stats["unchanged" if out in ("UNCHANGED_HASH", "NOT_MODIFIED") else "stored"] += 1
            except (httpx.HTTPError, WorkerError, RunnerError) as exc:
                log.warning("document %s failed: %s", item["document_id"], type(exc).__name__)
                stats["failed"] += 1
        return stats

    def _put_pdf(self, document_id: str, data: bytes, r: httpx.Response) -> str:
        h = {
            "Authorization": self.worker._headers["Authorization"],  # noqa: SLF001
            "Content-Type": "application/pdf",
            "X-Source-Final-Url": r._final_url,  # type: ignore[attr-defined]
        }
        if r.headers.get("etag"):
            h["X-Source-Etag"] = r.headers["etag"]
        if r.headers.get("last-modified"):
            h["X-Source-Last-Modified"] = r.headers["last-modified"]
        resp = self.worker._http.put(f"{self.worker.base}/internal/runner/documents/{document_id}/pdf", content=data, headers=h)  # noqa: SLF001
        if resp.status_code != 200:
            raise WorkerError(f"Worker rejected the PDF (HTTP {resp.status_code}): {resp.text[:200]}", resp.status_code)
        return resp.json()["outcome"]["kind"]

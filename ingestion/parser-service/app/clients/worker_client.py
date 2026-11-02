"""HTTP client for the Worker's internal routes (PDF download + parse-result callbacks)."""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

import httpx

log = logging.getLogger("parser.client")


class WorkerError(Exception):
    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


class WorkerClient:
    def __init__(self, base_url: str, token: str, client: Optional[httpx.Client] = None, max_pdf_bytes: int = 80_000_000):
        self.base = base_url.rstrip("/")
        self.max_pdf_bytes = max_pdf_bytes
        self._http = client or httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0))
        self._headers = {"Authorization": f"Bearer {token}"}

    def fetch_pdf(self, url: str) -> bytes:
        chunks: list[bytes] = []
        total = 0
        with self._http.stream("GET", url, headers=self._headers) as r:
            if r.status_code != 200:
                raise WorkerError(f"PDF download failed with HTTP {r.status_code}", r.status_code)
            for part in r.iter_bytes():
                total += len(part)
                if total > self.max_pdf_bytes:
                    raise WorkerError("PDF exceeds the configured size limit")
                chunks.append(part)
        return b"".join(chunks)

    def post(self, url: str, payload: dict[str, Any], attempts: int = 4) -> dict:
        """POST JSON with exponential backoff on 5xx / network errors. 4xx are not retried (they are bugs or policy)."""
        last: Exception | None = None
        for i in range(attempts):
            if i:
                time.sleep(min(20.0, 1.5 * 2 ** (i - 1)))
            try:
                r = self._http.post(url, json=payload, headers=self._headers)
                if r.status_code < 300:
                    return r.json()
                if r.status_code < 500 and r.status_code != 429:
                    raise WorkerError(f"Worker rejected the payload (HTTP {r.status_code}): {r.text[:300]}", r.status_code)
                last = WorkerError(f"Worker returned HTTP {r.status_code}", r.status_code)
            except httpx.HTTPError as exc:
                last = WorkerError(f"Network error talking to the Worker: {type(exc).__name__}")
        raise last or WorkerError("unknown error")

    def pending(self, limit: int = 20) -> list[dict]:
        r = self._http.get(f"{self.base}/internal/pending-parse", params={"limit": limit}, headers=self._headers)
        if r.status_code != 200:
            raise WorkerError(f"pending-parse failed with HTTP {r.status_code}", r.status_code)
        return r.json().get("versions", [])

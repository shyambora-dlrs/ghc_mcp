FROM python:3.12-slim

# Tesseract is the OCR fallback engine (pytesseract shells out to it). Add language packs as needed,
# e.g. tesseract-ocr-asm for Assamese, and set PARSER_OCR_LANG=eng+asm.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
RUN useradd --create-home --uid 10001 parser
USER parser

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"
# Required at runtime: INGESTION_SERVICE_TOKEN, PARSER_CALLBACK_TOKEN, WORKER_ORIGIN
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

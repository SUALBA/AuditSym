"""
AuditNIST Pro — RAG Server
----------------------------
FastAPI server on port 8765 providing three endpoints:

  POST   /upload              — ingest PDF files into a session vector store
  POST   /query               — semantic search over a session's chunks
  DELETE /session/{session_id} — free a session's memory

Run with:
    python rag/server.py
or:
    uvicorn rag.server:app --port 8765

Security posture — this server binds to 127.0.0.1 only (never exposed to the
network), but "same machine" is not the same as "safe": any webpage open in
the same browser can still make the browser send requests to this port
(classic "localhost drive-by" / CSRF against local dev servers — the same
class of issue reported against tools like Ollama's default setup). CORS
alone does not stop this for multipart/form-data POSTs, since browsers treat
them as "simple requests" that skip preflight — restricting allow_origins
only blocks the attacker page from *reading* the response, not from sending
the request. The real defenses are (1) a same-origin check on every request
via Origin/Referer, enforced server-side where the browser can't lie about
it, and (2) a required custom header that forces a CORS preflight, which
DOES get blocked for disallowed origins before the request body is ever
sent. Both are applied below; the allowed origins are exactly the addresses
the bundled `python -m http.server 8080` serves the UI from.
"""

import os
import uuid
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from pydantic import BaseModel

# Local modules (same package)
from pdf_processor import extract_text_from_pdf
from embedder     import embed
from vector_store import get_store, delete_store


# ---------------------------------------------------------------------------
logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s %(message)s",
    datefmt = "%H:%M:%S"
)
log = logging.getLogger("rag-server")

# Only the origins the UI is legitimately served from. Override via env var
# if you serve the UI on a different port; never widen this to "*".
ALLOWED_ORIGINS = os.environ.get(
    "AUDITSYM_ALLOWED_ORIGINS",
    "http://localhost:8080,http://127.0.0.1:8080"
).split(",")

# Custom header the frontend must send. Its presence forces the browser to
# run a CORS preflight (multipart/form-data alone would not), and the
# preflight fails closed for any origin not in ALLOWED_ORIGINS — so the
# actual POST is never sent by the browser for a disallowed origin.
CLIENT_HEADER_NAME  = "x-auditsym-client"
CLIENT_HEADER_VALUE = "auditsym-ui"


# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("AuditNIST RAG server starting…")
    log.info(f"Allowed origins: {ALLOWED_ORIGINS}")
    # Pre-load the embedding model so the first /upload isn't slow
    embed(["warm-up"])
    log.info("Embedding model ready.  Listening on http://localhost:8765")
    yield
    log.info("RAG server shutting down.")


app = FastAPI(title="AuditNIST RAG Server", version="1.0.0",
              lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins     = ALLOWED_ORIGINS,
    allow_credentials = False,   # no cookies/session auth in play — keep this off
    allow_methods     = ["GET", "POST", "DELETE"],
    allow_headers     = [CLIENT_HEADER_NAME, "content-type"],
)


class OriginCheckMiddleware(BaseHTTPMiddleware):
    """
    Belt-and-suspenders check that runs on every request, not just the ones
    the browser bothers to preflight. The browser attaches Origin on
    cross-origin requests and the page's own JS cannot forge or suppress it
    — unlike a custom header, which some non-browser tooling could still
    send. /health stays open (harmless, no data access) so the UI's
    lightweight polling never breaks.
    """
    async def dispatch(self, request: Request, call_next):
        # Let CORSMiddleware handle OPTIONS preflight entirely — a preflight
        # request never carries the actual custom header (only announces it
        # via Access-Control-Request-Headers), so checking for it here would
        # reject every legitimate preflight, including from allowed origins.
        if request.method == "OPTIONS" or request.url.path == "/health":
            return await call_next(request)

        origin = request.headers.get("origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            log.warning(f"Blocked request from disallowed origin: {origin}")
            return JSONResponse(status_code=403, content={"detail": "Origin not allowed"})

        if request.headers.get(CLIENT_HEADER_NAME) != CLIENT_HEADER_VALUE:
            log.warning(f"Blocked request missing {CLIENT_HEADER_NAME} header")
            return JSONResponse(status_code=403, content={"detail": "Missing client header"})

        return await call_next(request)


app.add_middleware(OriginCheckMiddleware)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class QueryRequest(BaseModel):
    session_id  : str
    control_name: str = ""
    question    : str = ""
    top_k       : int = 5


class QueryResponse(BaseModel):
    chunks: list[dict]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    """Simple liveness check — browser polls this to detect the server."""
    return {"status": "ok", "service": "AuditNIST RAG"}


@app.post("/upload")
async def upload(
    files      : list[UploadFile] = File(...),
    session_id : str              = Form(default="")
):
    """
    Accept one or more PDF files, extract + embed their text, and store
    the chunks in the session's VectorStore.

    Returns the session_id (generated if not provided), number of docs
    processed, and total chunk count.
    """
    if not session_id:
        session_id = str(uuid.uuid4())

    store       = get_store(session_id)
    doc_count   = 0
    chunk_count = 0

    for upload_file in files:
        if not upload_file.filename:
            continue

        raw   = await upload_file.read()
        fname = upload_file.filename

        log.info(f"Processing '{fname}' ({len(raw):,} bytes) …")
        try:
            chunks = extract_text_from_pdf(raw, fname)
        except Exception as exc:
            log.warning(f"  Failed to parse '{fname}': {exc}")
            continue

        if not chunks:
            log.warning(f"  No text extracted from '{fname}'.")
            continue

        texts      = [c["text"] for c in chunks]
        embeddings = embed(texts)
        store.add(chunks, embeddings)

        doc_count   += 1
        chunk_count += len(chunks)
        log.info(f"  '{fname}' → {len(chunks)} chunks indexed.")

    return {
        "session_id" : session_id,
        "doc_count"  : doc_count,
        "chunk_count": chunk_count
    }


@app.post("/query", response_model=QueryResponse)
def query(req: QueryRequest):
    """
    Semantic search over a session's indexed chunks.

    The query text is `control_name + ' ' + question`, embedded and
    compared to all stored chunks.  Returns the top_k most relevant.
    """
    store = get_store(req.session_id)

    if store.chunk_count == 0:
        return QueryResponse(chunks=[])

    query_text = f"{req.control_name} {req.question}".strip()
    if not query_text:
        return QueryResponse(chunks=[])

    q_vec   = embed([query_text])          # shape (1, 384)
    results = store.query(q_vec, req.top_k)

    return QueryResponse(chunks=results)


@app.delete("/session/{session_id}")
def delete_session(session_id: str):
    """Free memory for the given session."""
    delete_store(session_id)
    log.info(f"Session '{session_id}' deleted.")
    return {"deleted": session_id}


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host    = "127.0.0.1",
        port    = 8765,
        reload  = False,
        workers = 1
    )
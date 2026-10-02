import asyncio, logging, os, uuid, sqlite3
from pathlib import Path
from typing import List
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pypdf import PdfReader
from dotenv import load_dotenv

logger = logging.getLogger(__name__)
RETRIEVAL_TIMEOUT_SECONDS = 30

load_dotenv()
BASE = Path(__file__).parent
DATA = BASE / "data"
UPLOADS = DATA / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)
DB = DATA / "nexamind.db"
app = FastAPI(title="NexaMind AI API", version="1.0.0", description="Evidence-grounded document research with RAG")
origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
app.add_middleware(CORSMiddleware, allow_origins=[x.strip() for x in origins], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# Chroma is optional at import time so health/docs still work before dependencies finish installing.
try:
    import chromadb
    from chromadb.utils import embedding_functions
    chroma_client = chromadb.PersistentClient(path=str(DATA / "chroma"))
    collection = chroma_client.get_or_create_collection(name="nexamind_docs", metadata={"hnsw:space": "cosine"})
except Exception as exc:
    chroma_client, collection = None, None
    print("Chroma initialization warning:", exc)

def init_db():
    with sqlite3.connect(DB) as con:
        con.execute("CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, chunks INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
        con.execute("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
init_db()

class AskRequest(BaseModel):
    question: str
    top_k: int = 4

class AskResponse(BaseModel):
    answer: str
    sources: list
    retrieved_chunks: int
    status: str = "success"
    error_code: str | None = None
    error_message: str | None = None


AI_ERROR_MESSAGES = {
    "quota_exhausted": "AI responses are temporarily unavailable because the service has reached its usage limit. Your documents are still available in your knowledge library. Please try again later.",
    "service_unavailable": "The AI service is temporarily unavailable. Please try again shortly.",
    "timeout": "The request took too long to complete. Please try again.",
    "invalid_credentials": "The AI service is not configured correctly. Please contact the application administrator.",
    "not_configured": "The AI service is not configured correctly. Please contact the application administrator.",
    "unexpected": "We couldn't generate an answer right now. Your documents remain available. Please try again later.",
}


class AIProviderError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def split_chunks(text: str, size: int = 900, overlap: int = 150):
    text = " ".join(text.split())
    return [text[i:i+size] for i in range(0, len(text), size-overlap) if text[i:i+size].strip()]


def classify_provider_error(status_code: int, body: str) -> str:
    details = body.lower()
    if status_code == 429 or any(marker in details for marker in ("resource_exhausted", "resource exhausted", "quota_exceeded", "quota exceeded", "rate_limit_exceeded", "rate limit exceeded")):
        return "quota_exhausted"
    if status_code in (401, 403) or any(marker in details for marker in ("api_key_invalid", "invalid api key", "api key not valid", "unauthenticated", "invalid_api_key")):
        return "invalid_credentials"
    if status_code == 503:
        return "service_unavailable"
    if status_code in (408, 504):
        return "timeout"
    return "unexpected"


async def post_to_provider(provider: str, url: str, **kwargs):
    import httpx

    async def request_with_retry():
        async with httpx.AsyncClient(timeout=45) as client:
            for attempt in range(2):
                try:
                    response = await client.post(url, **kwargs)
                except httpx.TimeoutException:
                    logger.warning("AI provider request timed out (provider=%s)", provider)
                    raise AIProviderError("timeout") from None
                except httpx.RequestError as exc:
                    logger.warning("AI provider network request failed (provider=%s, error_type=%s)", provider, type(exc).__name__)
                    raise AIProviderError("service_unavailable") from None
                if response.status_code >= 400:
                    code = classify_provider_error(response.status_code, response.text)
                    if response.status_code == 503 and code == "service_unavailable" and attempt == 0:
                        logger.warning("AI provider returned a temporary outage (provider=%s, status=503); retrying once", provider)
                        await asyncio.sleep(0.4)
                        continue
                    logger.warning("AI provider request failed (provider=%s, status=%s, category=%s)", provider, response.status_code, code)
                    raise AIProviderError(code)
                return response

    try:
        return await asyncio.wait_for(request_with_retry(), timeout=55)
    except asyncio.TimeoutError:
        logger.warning("AI provider total request deadline exceeded (provider=%s)", provider)
        raise AIProviderError("timeout") from None


async def embed_texts(texts: List[str]):
    # Chroma's default embedding function uses its bundled sentence-transformer model.
    if collection is None:
        raise HTTPException(503, "Vector database is unavailable. Install backend requirements and restart the API.")

@app.get("/")
def root():
    return {"name": "NexaMind AI", "status": "running", "docs": "/docs"}

@app.get("/health")
def health():
    return {"status": "ok", "vector_store_ready": collection is not None, "llm_configured": bool(os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY"))}

@app.get("/api/documents")
def list_documents():
    with sqlite3.connect(DB) as con:
        rows = con.execute("SELECT id, name, chunks, created_at FROM documents ORDER BY created_at DESC").fetchall()
    return [{"id": r[0], "name": r[1], "chunks": r[2], "created_at": r[3]} for r in rows]

@app.post("/api/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    name = Path(file.filename or "document").name
    suffix = Path(name).suffix.lower()
    if suffix not in {".pdf", ".txt", ".md"}:
        raise HTTPException(400, "Upload a PDF, TXT, or Markdown file.")
    raw = await file.read()
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(413, "File exceeds the 15 MB limit.")
    try:
        if suffix == ".pdf":
            import io
            reader = PdfReader(io.BytesIO(raw))
            pages = [(p.extract_text() or "") for p in reader.pages]
            text = "\n".join(f"[Page {i+1}] {page}" for i, page in enumerate(pages))
        else:
            text = raw.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(400, f"Could not read document: {exc}")
    chunks = split_chunks(text)
    if not chunks:
        raise HTTPException(400, "No readable text found in this document.")
    if collection is None:
        raise HTTPException(503, "Vector database is not ready. Check backend dependencies.")
    doc_id = str(uuid.uuid4())
    ids = [f"{doc_id}_{i}" for i in range(len(chunks))]
    metadatas = [{"document_id": doc_id, "document_name": name, "chunk_index": i} for i in range(len(chunks))]
    try:
        collection.add(ids=ids, documents=chunks, metadatas=metadatas)
    except Exception as exc:
        raise HTTPException(500, f"Could not index document: {exc}")
    with sqlite3.connect(DB) as con:
        con.execute("INSERT INTO documents(id, name, chunks) VALUES (?, ?, ?)", (doc_id, name, len(chunks)))
    return {"id": doc_id, "name": name, "chunks": len(chunks), "message": "Document indexed successfully."}

@app.delete("/api/documents/{document_id}")
def delete_document(document_id: str):
    with sqlite3.connect(DB) as con:
        row = con.execute("SELECT name FROM documents WHERE id=?", (document_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Document not found.")
        if collection is not None:
            collection.delete(where={"document_id": document_id})
        con.execute("DELETE FROM documents WHERE id=?", (document_id,))
    return {"message": "Document deleted.", "id": document_id}

async def generate_answer(question: str, context: str):
    system = "You are NexaMind, an evidence-grounded research assistant. Answer using only the supplied document context. If the context does not contain the answer, clearly say you could not find enough evidence in the uploaded documents. Cite source labels like [1] when using a passage. Do not invent facts."
    prompt = f"DOCUMENT CONTEXT:\n{context}\n\nQUESTION:\n{question}\n\nGive a clear, useful answer with citations to the source labels."
    gemini_key = os.getenv("GEMINI_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")
    if gemini_key:
        model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
        res = await post_to_provider("Gemini", url, json={"systemInstruction": {"parts": [{"text": system}]}, "contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.2}})
        try:
            return res.json()["candidates"][0]["content"]["parts"][0]["text"]
        except (ValueError, KeyError, IndexError, TypeError):
            logger.warning("AI provider returned an invalid response (provider=Gemini)")
            raise AIProviderError("unexpected") from None
    if openai_key:
        res = await post_to_provider("OpenAI", "https://api.openai.com/v1/chat/completions", headers={"Authorization": f"Bearer {openai_key}"}, json={"model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"), "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}], "temperature": 0.2})
        try:
            return res.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            logger.warning("AI provider returned an invalid response (provider=OpenAI)")
            raise AIProviderError("unexpected") from None
    logger.warning("AI answer generation is not configured (no provider key found)")
    raise AIProviderError("not_configured")

@app.post("/api/ask", response_model=AskResponse)
async def ask(req: AskRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(400, "Question cannot be empty.")
    if collection is None:
        raise HTTPException(503, "Vector database is not ready.")
    def retrieve():
        if collection.count() == 0:
            raise HTTPException(400, "Upload a document first so I can answer from its content.")
        return collection.query(query_texts=[question], n_results=max(1, min(req.top_k, 8)), include=["documents", "metadatas", "distances"])
    try:
        result = await asyncio.wait_for(asyncio.to_thread(retrieve), timeout=RETRIEVAL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("Document retrieval exceeded its deadline")
        return {
            "answer": "",
            "sources": [],
            "retrieved_chunks": 0,
            "status": "error",
            "error_code": "timeout",
            "error_message": AI_ERROR_MESSAGES["timeout"],
        }
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    distances = (result.get("distances") or [[]])[0]
    sources = []
    context_parts = []
    for i, (doc, meta) in enumerate(zip(docs, metas)):
        label = i + 1
        sources.append({"label": label, "document": meta.get("document_name", "Unknown document"), "chunk": meta.get("chunk_index", 0), "distance": distances[i] if i < len(distances) else None, "snippet": doc[:500]})
        context_parts.append(f"[{label}] Source: {meta.get('document_name', 'Unknown document')} (chunk {meta.get('chunk_index', 0)+1})\n{doc}")
    context = "\n\n".join(context_parts)
    try:
        answer = await generate_answer(question, context)
    except AIProviderError as error:
        error_code = error.code if error.code in AI_ERROR_MESSAGES else "unexpected"
        return {
            "answer": "",
            "sources": sources,
            "retrieved_chunks": len(docs),
            "status": "error",
            "error_code": error_code,
            "error_message": AI_ERROR_MESSAGES[error_code],
        }
    except Exception as exc:
        logger.error("AI answer generation failed unexpectedly (error_type=%s)", type(exc).__name__)
        return {
            "answer": "",
            "sources": sources,
            "retrieved_chunks": len(docs),
            "status": "error",
            "error_code": "unexpected",
            "error_message": AI_ERROR_MESSAGES["unexpected"],
        }
    with sqlite3.connect(DB) as con:
        con.execute("INSERT INTO messages(id, question, answer) VALUES (?, ?, ?)", (str(uuid.uuid4()), question, answer))
    return {"answer": answer, "sources": sources, "retrieved_chunks": len(docs), "status": "success"}

@app.get("/api/history")
def history(limit: int = 20):
    with sqlite3.connect(DB) as con:
        rows = con.execute("SELECT id, question, answer, created_at FROM messages ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 100)),)).fetchall()
    return [{"id": r[0], "question": r[1], "answer": r[2], "created_at": r[3]} for r in rows]

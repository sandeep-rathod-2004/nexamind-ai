# NexaMind AI — Intelligent Document Research Platform

A full-stack RAG application that indexes PDF/TXT/Markdown documents, retrieves relevant passages from ChromaDB, and generates evidence-grounded answers with source snippets.

## Features
- React + Vite research workspace with responsive dark UI
- FastAPI REST API and interactive OpenAPI docs
- PDF, TXT, and Markdown upload (15 MB per file)
- Chunking, vector embeddings and semantic retrieval using ChromaDB
- Gemini or OpenAI answer generation (configure one API key)
- Source cards with document names and retrieved excerpts
- SQLite persistence for document metadata and chat history
- Delete documents and inspect service health
- CORS configuration for deployment

## Architecture
`React/Vite → FastAPI → document extraction/chunking → ChromaDB → top-k retrieval → Gemini/OpenAI → answer + source evidence`

SQLite stores document metadata and the recent question/answer log. ChromaDB stores vectorized text chunks.

## Run locally (Windows PowerShell)

### 1. Backend
```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```
Edit `backend/.env` and set `GEMINI_API_KEY` or `OPENAI_API_KEY`. Never expose the key in frontend code or commit `.env`.

```powershell
uvicorn main:app --reload --port 8000
```
Backend docs: http://localhost:8000/docs

### 2. Frontend (new terminal)
```powershell
cd frontend
npm install
Copy-Item .env.example .env
npm run dev
```
Open the Vite URL shown in the terminal (usually http://localhost:5173).

## Deploy

### Backend — Render
1. Push this repository to GitHub.
2. In Render, create a new Blueprint and select the repository (uses `render.yaml`), or create a Python web service with root directory `backend`.
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Add `GEMINI_API_KEY` as a secret environment variable. Set `CORS_ORIGINS` to your exact Vercel frontend origin (for example `https://nexamind-ai.vercel.app`).
6. Confirm `https://YOUR-API.onrender.com/health` returns JSON.

### Frontend — Vercel
1. Import the GitHub repository in Vercel.
2. Set Root Directory to `frontend`.
3. Set `VITE_API_URL` to your deployed Render API origin, without a trailing slash.
4. Deploy. If you change environment variables, redeploy the frontend.
5. Update Render `CORS_ORIGINS` to the exact deployed Vercel origin.

## Important deployment notes
- This MVP uses local SQLite and persistent Chroma files. On ephemeral hosting, data may be lost on restarts/redeploys unless a persistent disk is configured. For a durable public deployment, use a managed vector database and hosted PostgreSQL, or attach persistent storage where supported.
- Render free services may sleep when idle and cold-start on the next request.
- This MVP has no user authentication; do not upload sensitive or confidential documents to a public deployment.
- LLM provider usage may incur charges under your provider's terms.
- PDF extraction works on text-based PDFs; scanned image PDFs need OCR, which is not included.

## API
- `GET /health`
- `GET /api/documents`
- `POST /api/documents/upload` (multipart file)
- `DELETE /api/documents/{document_id}`
- `POST /api/ask` (`{"question":"...","top_k":4}`)
- `GET /api/history`

## Evaluation ideas
For a strong portfolio demonstration, create 10–20 question/answer test cases based on a known PDF. Measure retrieval Recall@k, whether answers are supported by retrieved chunks, citation correctness, and abstention on questions not covered by the documents. Inspect failures and adjust chunk size/top-k.

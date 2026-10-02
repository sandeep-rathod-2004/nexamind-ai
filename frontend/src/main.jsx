import React, { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import { Activity, ArrowDownToLine, ArrowUpRight, BookOpen, Bot, Check, ChevronDown, CircleHelp, Clock3, FileText, FileUp, Globe2, Layers3, LoaderCircle, MessageSquare, MoreHorizontal, Plus, RefreshCw, Search, Send, ShieldCheck, Sparkles, Trash2, UploadCloud, X, Zap } from 'lucide-react';
import './styles.css';

const API = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const AI_ERROR_MESSAGES = {
  quota_exhausted: 'AI responses are temporarily unavailable because the service has reached its usage limit. Your documents are still available in your knowledge library. Please try again later.',
  service_unavailable: 'The AI service is temporarily unavailable. Please try again shortly.',
  timeout: 'The request took too long to complete. Please try again.',
  invalid_credentials: 'The AI service is not configured correctly. Please contact the application administrator.',
  not_configured: 'The AI service is not configured correctly. Please contact the application administrator.',
  unexpected: "We couldn't generate an answer right now. Your documents remain available. Please try again later."
};
function SourcesSection({ sources, retrieved, expandedSources, onToggleSource, sectionId }) {
  return <section className="sources" aria-label="Retrieved Sources">
    <div className="sources-title"><FileText size={15}/><strong>Retrieved Sources</strong><span>{retrieved ?? sources.length} chunks</span></div>
    <div className="sources-list">{sources.map((source, index) => {
      const expanded = Boolean(expandedSources[source.label]);
      const previewId = `${sectionId}-source-${index}`;
      return <article className={`source-card${expanded ? ' expanded' : ''}`} id={previewId} key={source.label}>
        <button className="source-toggle" type="button" aria-expanded={expanded} aria-controls={`${previewId}-snippet`} aria-label={`${expanded ? 'Collapse' : 'Expand'} source ${source.label}: ${source.document}`} onClick={() => onToggleSource(source.label)}>
          <span className="source-number">[{source.label}]</span>
          <span className="source-meta"><strong title={source.document}>{source.document}</strong><small>Chunk {Number(source.chunk) + 1} · Similarity retrieval</small></span>
          <ChevronDown className="source-chevron" size={15}/>
        </button>
        <div className={`source-preview${expanded ? ' is-expanded' : ''}`} id={`${previewId}-snippet`}><p>{source.snippet}</p></div>
      </article>;
    })}</div>
  </section>;
}
function escapeCitationLabel(label) {
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function renderCitationContent(children, sourceIndexes, onCitationClick) {
  if (typeof children === 'string') {
    if (!sourceIndexes.size) return children;
    const labels = [...sourceIndexes.keys()].sort((left, right) => right.length - left.length).map(escapeCitationLabel).join('|');
    const tokenPattern = labels ? `(?:${labels}|\\d+)` : '\\d+';
    const pattern = new RegExp(`\\[(${tokenPattern}(?:\\s*,\\s*${tokenPattern})*)\\]`, 'g');
    const rendered = [];
    let lastIndex = 0;
    for (const match of children.matchAll(pattern)) {
      if (match.index > lastIndex) rendered.push(children.slice(lastIndex, match.index));
      const citations = match[1].split(/\s*,\s*/);
      rendered.push(...citations.map((label, index) => <React.Fragment key={`${match.index}-${index}`}>{index > 0 && ', '}{sourceIndexes.has(label) ? <button className="citation-badge" type="button" aria-label={`Go to source [${label}]`} title={`Show source [${label}]`} onClick={() => onCitationClick(label)}>[{label}]</button> : `[${label}]`}</React.Fragment>));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex === 0) return children;
    rendered.push(children.slice(lastIndex));
    return rendered;
  }
  if (Array.isArray(children)) return children.map((child, index) => <React.Fragment key={index}>{renderCitationContent(child, sourceIndexes, onCitationClick)}</React.Fragment>);
  if (!React.isValidElement(children) || children.props.children == null || ['a', 'code', 'pre'].includes(children.type)) return children;
  return React.cloneElement(children, undefined, renderCitationContent(children.props.children, sourceIndexes, onCitationClick));
}
function ResearchAnswer({ content, sources = [], retrieved, error, onRetry, loading }) {
  const [expandedSources, setExpandedSources] = useState({});
  const sectionId = useId();
  const sourceCounts = new Map();
  sources.forEach(source => {
    const label = String(source.label);
    if (label) sourceCounts.set(label, (sourceCounts.get(label) || 0) + 1);
  });
  const sourceIndexes = new Map();
  sources.forEach((source, index) => {
    const label = String(source.label);
    if (sourceCounts.get(label) === 1) sourceIndexes.set(label, index);
  });
  function toggleSource(label) {
    setExpandedSources(current => ({ ...current, [label]: !current[label] }));
  }
  function openSource(label) {
    const index = sourceIndexes.get(label);
    if (index === undefined) return;
    setExpandedSources(current => ({ ...current, [label]: true }));
    requestAnimationFrame(() => {
      const card = document.getElementById(`${sectionId}-source-${index}`);
      if (!card) return;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
      card.querySelector('.source-toggle')?.focus({ preventScroll: true });
    });
  }
  const citationBlock = tag => ({ node, children, ...props }) => React.createElement(tag, props, renderCitationContent(children, sourceIndexes, openSource));
  const markdownComponents = { p: citationBlock('p'), li: citationBlock('li'), blockquote: citationBlock('blockquote'), h1: citationBlock('h1'), h2: citationBlock('h2'), h3: citationBlock('h3'), h4: citationBlock('h4'), h5: citationBlock('h5'), h6: citationBlock('h6') };
  return <>
    {error ? <div className="generation-error" role="status" aria-live="polite">
      <div className="generation-error-title"><CircleHelp size={15}/> AI response unavailable</div>
      <p>{content}</p>
      <button className="generation-retry" type="button" onClick={onRetry} disabled={loading}><RefreshCw size={13}/> Try again</button>
    </div> : <div className="markdown"><ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown></div>}
    {sources.length > 0 && <SourcesSection sources={sources} retrieved={retrieved} expandedSources={expandedSources} onToggleSource={toggleSource} sectionId={sectionId}/>}
  </>;
}
function SuggestedQuestions({ starters, hasDocuments, loading, onAsk }) {
  const icons = [<BookOpen size={18}/>, <ShieldCheck size={18}/>, <Activity size={18}/>, <Sparkles size={18}/>];
  return <div className="starter-grid">{starters.map(({ label, question }, index) => <button className={`starter si-${index}`} key={label} type="button" onClick={() => onAsk(question)} disabled={loading} aria-label={`${label}. ${hasDocuments ? 'Submit suggested question' : 'Upload a document before asking'}`}>
    <span className={`starter-icon si-${index}`}>{icons[index]}</span><span>{label}</span><ArrowUpRight size={15} className="starter-arrow"/>
  </button>)}</div>;
}
function App() {
  const [documents, setDocuments] = useState([]); const [question, setQuestion] = useState(''); const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false); const [uploading, setUploading] = useState(false); const [notice, setNotice] = useState(''); const [health, setHealth] = useState(null); const [query, setQuery] = useState('');
  const fileRef = useRef(null); const endRef = useRef(null); const askInFlightRef = useRef(false);
  async function loadDocs() { try { const r = await fetch(`${API}/api/documents`); if (r.ok) setDocuments(await r.json()); } catch {} }
  useEffect(() => { loadDocs(); fetch(`${API}/health`).then(r=>r.json()).then(setHealth).catch(()=>setHealth({status:'offline'})); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);
  async function upload(e) { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setUploading(true); setNotice(''); const form = new FormData(); form.append('file', file); try { const r = await fetch(`${API}/api/documents/upload`, { method: 'POST', body: form }); const data = await r.json(); if (!r.ok) throw new Error(data.detail || 'Upload failed'); setNotice(`${data.name} indexed into ${data.chunks} searchable chunks.`); await loadDocs(); } catch (err) { setNotice(`Upload failed: ${err.message}. Is the backend running?`); } finally { setUploading(false); } }
  async function removeDoc(doc) { if (!confirm(`Delete ${doc.name} from your knowledge base?`)) return; try { const r = await fetch(`${API}/api/documents/${doc.id}`, { method: 'DELETE' }); const d = await r.json(); if (!r.ok) throw new Error(d.detail); setNotice(`${doc.name} removed.`); await loadDocs(); } catch (e) { setNotice(e.message); } }
  async function ask(q = question, retry = false) { const text = q.trim(); if (!text || loading || askInFlightRef.current) return; askInFlightRef.current = true; setQuestion(''); if (!retry) setMessages(prev => [...prev, { role: 'user', content: text }]); setLoading(true); try { const r = await fetch(`${API}/api/ask`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ question: text, top_k: 4 }) }); const data = await r.json(); if (!r.ok) throw new Error('api_request_failed'); if (data.status === 'error') { const errorCode = AI_ERROR_MESSAGES[data.error_code] ? data.error_code : 'unexpected'; setMessages(prev => [...prev, { role: 'assistant', type: 'error', content: AI_ERROR_MESSAGES[errorCode], errorCode, question: text, sources: data.sources || [], retrieved: data.retrieved_chunks }]); return; } setMessages(prev => [...prev, { role: 'assistant', content: data.answer, sources: data.sources || [], retrieved: data.retrieved_chunks }]); } catch (error) { const errorCode = error?.name === 'AbortError' ? 'timeout' : 'unexpected'; setMessages(prev => [...prev, { role: 'assistant', type: 'error', content: AI_ERROR_MESSAGES[errorCode], errorCode, question: text }]); } finally { askInFlightRef.current = false; setLoading(false); } }
  function askSuggested(question) { if (loading) return; if (!documents.length) { setNotice('Upload a document first to use suggested questions.'); return; } ask(question); }
  const filtered = documents.filter(d => d.name.toLowerCase().includes(query.toLowerCase()));
  const starters = [
    { label: 'Summarize the key findings', question: 'Summarize the key findings from the uploaded documents. Identify the most important points and support them with evidence from the sources.' },
    { label: 'What are the main risks?', question: 'Identify the main risks, challenges, limitations, and concerns mentioned in the uploaded documents. Support each finding with evidence from the sources.' },
    { label: 'List important dates and figures', question: 'Extract the important dates, numbers, statistics, percentages, amounts, and other significant figures from the uploaded documents. Include relevant context and source citations.' },
    { label: 'What decisions are recommended?', question: 'Identify the recommendations, proposed actions, decisions, and next steps explicitly supported by the uploaded documents. If no recommendations are present, clearly state that the documents do not provide sufficient evidence.' }
  ];
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><Sparkles size={21}/></div><div><strong>NexaMind<span> AI</span></strong><small>KNOWLEDGE WORKSPACE</small></div></div>
    <button className="new-chat" onClick={()=>{setMessages([]);setNotice('New research session started.');}}><Plus size={17}/> New research session <span>⌘ K</span></button>
    <div className="nav-label">WORKSPACE</div><div className="nav-item active"><MessageSquare size={17}/> Research assistant <span className="nav-dot"/></div><div className="nav-item" onClick={()=>fileRef.current?.click()}><Layers3 size={17}/> Knowledge library <span className="nav-count">{documents.length}</span></div>
    <div className="library-head"><span className="nav-label">YOUR KNOWLEDGE BASE</span><button className="icon-btn" aria-label="Upload document" onClick={()=>fileRef.current?.click()}><Plus size={16}/></button></div>
    <div className="doc-search"><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search documents"/></div>
    <div className="document-list">{filtered.map(doc=><div className="doc-row" key={doc.id}><div className="doc-icon"><FileText size={16}/></div><div className="doc-meta"><span title={doc.name}>{doc.name}</span><small>{doc.chunks} chunks</small></div><button className="doc-delete" title="Delete document" onClick={()=>removeDoc(doc)}><Trash2 size={14}/></button></div>)}{!filtered.length&&<div className="empty-docs">{documents.length?'No matching documents':'Your library is empty. Upload a file to begin.'}</div>}</div>
    <div className="sidebar-bottom"><div className="secure-card"><ShieldCheck size={17}/><div><strong>Evidence-first AI</strong><small>Answers grounded in your sources</small></div></div><div className="profile"><div className="avatar">N</div><div><strong>Research workspace</strong><small>Personal knowledge base</small></div><MoreHorizontal size={18}/></div></div>
  </aside><main className="main"><header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>Research assistant</strong></div><div className="top-actions"><div className={`status-pill ${health?.status==='offline'?'offline':''}`}><span/>{health?.status==='offline'?'API offline':health?'System operational':'Connecting'}</div><button className="help-btn" title="About NexaMind"><CircleHelp size={18}/></button></div></header>
    <div className="content"><div className="hero"><div className="eyebrow"><span className="eyebrow-icon"><Sparkles size={13}/></span> YOUR AI RESEARCH PARTNER <span className="eyebrow-line"/></div><h1>Knowledge, <span>connected.</span></h1><p className="hero-sub">Explore your documents, uncover insights, and get answers you can trace back to the source.</p><div className="hero-metrics"><div><span className="metric-icon violet"><FileText size={15}/></span><strong>{documents.length.toString().padStart(2,'0')}</strong><small>Documents indexed</small></div><div><span className="metric-icon blue"><Layers3 size={15}/></span><strong>{documents.reduce((n,d)=>n+d.chunks,0).toLocaleString()}</strong><small>Searchable chunks</small></div><div><span className="metric-icon green"><Activity size={15}/></span><strong>{health?.status==='offline'?'Offline':health?'Ready':'—'}</strong><small>System status</small></div></div></div>
      {notice&&<div className="notice"><Check size={15}/><span>{notice}</span><button onClick={()=>setNotice('')}><X size={14}/></button></div>}
      {messages.length===0 ? <><div className="section-heading"><div><span className="section-kicker">GET STARTED</span><h2>What would you like to discover?</h2></div><span className="powered"><Zap size={13}/> RAG-POWERED</span></div><SuggestedQuestions starters={starters} hasDocuments={documents.length > 0} loading={loading} onAsk={askSuggested}/>
      <div className="upload-panel"><div className="upload-art"><div className="upload-orbit orbit-one"/><div className="upload-orbit orbit-two"/><div className="upload-file"><FileText size={28}/><span>PDF</span></div><div className="upload-spark spark-a"><Sparkles size={15}/></div><div className="upload-spark spark-b"><Layers3 size={16}/></div></div><div className="upload-copy"><div className="upload-title">Start with your knowledge</div><p>Upload reports, research papers, policies, or notes. NexaMind will index the content so you can ask questions and explore the details.</p><button className="primary-btn" onClick={()=>fileRef.current?.click()} disabled={uploading}>{uploading?<LoaderCircle className="spin" size={16}/>:<UploadCloud size={16}/>} {uploading?'Indexing document':'Upload documents'} <ArrowUpRight size={15}/></button><div className="file-hint">PDF, TXT, MD <span>·</span> Up to 15 MB each</div></div></div></> : <div className="conversation"><div className="conversation-head"><div><span className="section-kicker">LIVE RESEARCH</span><h2>Research conversation</h2></div><button className="subtle-btn" onClick={()=>setMessages([])}>Clear conversation</button></div>{messages.map((m,i)=><div className={`message ${m.role}`} key={i}><div className="message-avatar">{m.role==='assistant'?<Sparkles size={16}/>:<span>Y</span>}</div><div className="message-body"><div className="message-name">{m.role==='assistant'?'NexaMind AI':'You'} {m.role==='assistant'&&<span className="verified"><ShieldCheck size={12}/> Evidence-grounded</span>}</div><ResearchAnswer content={m.content} sources={m.sources || []} retrieved={m.retrieved} error={m.type === 'error'} onRetry={m.type === 'error' ? () => ask(m.question, true) : undefined} loading={loading}/></div></div>)}{!loading && messages.at(-1)?.type === 'error' && <div className="suggestion-recovery"><span className="section-kicker">TRY ANOTHER QUESTION</span><SuggestedQuestions starters={starters} hasDocuments={documents.length > 0} loading={loading} onAsk={askSuggested}/></div>}{loading&&<div className="message assistant"><div className="message-avatar"><Sparkles size={16}/></div><div className="message-body"><div className="message-name">NexaMind AI</div><div className="thinking"><span/><span/><span/> Searching your knowledge base and synthesizing evidence…</div></div></div>}<div ref={endRef}/></div>}
      <div className="composer-wrap"><form className="composer" onSubmit={e=>{e.preventDefault();ask();}}><button type="button" className="composer-attach" title="Upload document" onClick={()=>fileRef.current?.click()}><Plus size={19}/></button><textarea value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();ask();}}} placeholder={documents.length?'Ask a question about your documents…':'Upload a document, then ask a question…'} rows={1}/><div className="composer-end"><span>↵ <small>to send</small></span><button className="send-btn" disabled={!question.trim()||loading} type="submit" aria-label="Send question">{loading?<LoaderCircle className="spin" size={17}/>:<Send size={17}/>}</button></div></form><div className="composer-foot"><span><ShieldCheck size={12}/> Answers are grounded in retrieved document context</span><span>AI can make mistakes. Verify important details.</span></div></div>
    </div></main><input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" hidden onChange={upload}/></div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);

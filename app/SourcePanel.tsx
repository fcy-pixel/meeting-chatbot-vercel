"use client";
import React, { useEffect, useRef, useState } from "react";
import PdfText from "./PdfText";

export type SourceView = { pdfPath: string; name: string; year: string; snapshot: string; page?: number; quote?: string };
type SourcePage = { name: string; year: string; pdfPath: string; snapshot: string; page: number; totalPages: number; text: string };

export default function SourcePanel({ source, onClose }: { source: SourceView; onClose: () => void }) {
  const [page, setPage] = useState(source.page || 1);
  const [data, setData] = useState<SourcePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const markRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setPage(source.page || 1); closeRef.current?.focus(); }, [source]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(""); setLoading(true);
    const params = new URLSearchParams({ path: source.pdfPath, snapshot: source.snapshot, page: String(page) });
    fetch(`/api/source-text?${params}`, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "原文載入失敗。");
      if (!controller.signal.aborted) setData(body);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "原文載入失敗。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source.pdfPath, source.snapshot, page]);
  useEffect(() => { if (data && source.quote) markRef.current?.scrollIntoView({ block: "nearest" }); }, [data, source.quote]);
  const quoteAt = data && source.quote && page === source.page ? data.text.indexOf(source.quote) : -1;
  const pdfUrl = `/api/source?path=${encodeURIComponent(source.pdfPath)}&snapshot=${source.snapshot}#page=${page}`;
  return <aside className="source-panel" aria-label="來源原文" onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <div className="source-panel-header"><span>來源原文</span><button ref={closeRef} className="icon-button" aria-label="關閉來源原文" onClick={onClose}>×</button></div>
    <div className="source-panel-title"><span className="source-type">PDF · {source.year} 學年</span><h2>{source.name}</h2>
      <a href={pdfUrl} target="_blank" rel="noreferrer">開啟原 PDF ↗</a>
    </div>
    <div className="page-navigation">
      <button aria-label="上一頁" onClick={() => setPage(p => p - 1)} disabled={page <= 1 || loading}>‹</button>
      <span>PDF 第 {page} 頁{data ? ` / ${data.totalPages}` : ""}</span>
      <button aria-label="下一頁" onClick={() => setPage(p => p + 1)} disabled={!data || page >= data.totalPages || loading}>›</button>
    </div>
    <div className="source-panel-body">
      {source.quote && page === source.page && <div className="selected-excerpt"><h3>答案引用的原文</h3><p><PdfText text={source.quote} /></p></div>}
      {loading && <p role="status">正在讀取這個版本的原頁文字…</p>}
      {error && <p className="document-warning" role="alert">{error}</p>}
      {data && <><h3>完整頁面文字</h3><p className="source-page-text">{quoteAt >= 0 && source.quote
        ? <><PdfText text={data.text.slice(0, quoteAt)} /><mark ref={markRef}><PdfText text={source.quote} /></mark><PdfText text={data.text.slice(quoteAt + source.quote.length)} /></>
        : <PdfText text={data.text} />}</p></>}
      <p className="source-version">頁碼為 PDF 實際頁次 · 版本 {source.snapshot.slice(0, 12)}</p>
    </div>
  </aside>;
}

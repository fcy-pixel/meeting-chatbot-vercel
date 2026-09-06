"use client";
import React, { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Answer, Evidence } from "./lib/evidence";
import { answerContext } from "./lib/conversation";

export type CitationHandler = (evidence: Evidence, snapshot: string) => void;
export default function AnswerView({ answer, onCitation }: { answer: Answer; onCitation?: CitationHandler }) {
  const [copyState, setCopyState] = useState("");
  const { scope } = answer;
  const pageCount = scope.documents.reduce((n, d) => n + d.pages, 0);
  const incomplete = answer.status === "partial" || scope.totalBatches === 0 || scope.reviewedBatches !== scope.totalBatches || scope.issues.length > 0;
  function citation(id: string) {
    const index = answer.evidence.findIndex(e => e.id === id);
    const e = answer.evidence[index];
    if (!e) return null;
    const label = `查看引用 ${index + 1}：${e.name}，PDF 第 ${e.page} 頁`;
    return onCitation
      ? <button key={id} className="citation-button" onClick={() => onCitation(e, scope.snapshot)} aria-label={label} title={`${e.name} · 第 ${e.page} 頁\n${e.quote}`}>{index + 1}</button>
      : <a key={id} className="citation-button" href={`/api/source?path=${encodeURIComponent(e.pdfPath)}&snapshot=${scope.snapshot}#page=${e.page}`} target="_blank" rel="noreferrer" aria-label={label}>{index + 1}</a>;
  }
  async function copy() {
    try { await navigator.clipboard.writeText(answerContext(answer)); setCopyState("已複製答案及引用"); }
    catch { setCopyState("未能複製，請選取文字複製。"); }
  }
  return <div className="verified-answer">
    {answer.message && <p className={incomplete ? "document-warning" : "answer-message"}>{answer.message}</p>}
    {answer.claims.map((claim, index) => <div className="answer-claim" key={index}>
      <div className="answer-prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml
        allowedElements={["p", "strong", "em", "ul", "ol", "li", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td", "br", "blockquote", "code", "pre", "hr"]}
        unwrapDisallowed>{claim.text}</Markdown></div>
      <span className="inline-citations" aria-label="這段答案的來源">{claim.evidenceIds.map(citation)}</span>
    </div>)}
    <div className="answer-footer">
      <span className={incomplete ? "coverage-label incomplete" : "coverage-label"}>
        {scope.year} · {scope.documents.length} 份來源／{pageCount} 頁{incomplete ? " · 查閱未完成" : " · 已參考會議紀錄"}
      </span>
      <button className="text-button" onClick={copy}>複製答案</button>
      {copyState && <span role="status">{copyState}</span>}
    </div>
    {answer.evidence.length > 0 && <details className="scope-details" open={!answer.claims.length}>
      <summary>查看引用（{answer.evidence.length}）</summary>
      <div className="reference-list">{answer.evidence.map(e => <div key={e.id}>
        {citation(e.id)} <span>{e.name} · PDF 第 {e.page} 頁</span>
      </div>)}</div>
    </details>}
    <details className="scope-details" open={incomplete}>
      <summary>查閱範圍 · {scope.reviewedBatches}/{scope.totalBatches} 批{scope.selection?.excluded.length ? ` · ${scope.selection.excluded.length} 份未選` : ""}</summary>
      {answer.resolvedQuestion && <p>本次理解的問題：{answer.resolvedQuestion}</p>}
      <p>頁碼由原 PDF 第一頁起計。以下所選來源的全部文字會分批查閱；未選來源不會用於本次回答。</p>
      {scope.documents.map(d => <p key={d.name}>{d.name}：PDF 第 1–{d.pages} 頁{incomplete ? "（未完成部分見下）" : "（已查閱）"}</p>)}
      {scope.selection && scope.selection.excluded.length > 0 && <p>本次未查閱：{scope.selection.excluded.join("、")}</p>}
      {scope.issues.map(issue => <p className="document-warning" key={issue.name}>{issue.name}（{issue.year}）：{issue.reason}</p>)}
      {scope.failed.map(batch => <div className="document-warning" key={batch.batch}>第 {batch.batch} 批未完成：{batch.sources.map(source => <p key={source}>{source}</p>)}</div>)}
      <p>文件版本：{scope.snapshot.slice(0, 12)}</p>
    </details>
  </div>;
}

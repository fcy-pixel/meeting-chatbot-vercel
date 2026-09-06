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
  const search = scope.textSearch;
  const readPages = search ? new Set(search.pages.map(p => `${p.name}:${p.page}`)).size : pageCount;
  const focused = search?.method === "search" && !search.expanded;
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
        {scope.year} · {focused ? `已搜尋 ${pageCount} 頁 · 參考 ${readPages} 頁` : `${scope.documents.length} 份來源／${pageCount} 頁`}{incomplete ? " · 查閱未完成" : " · 已參考會議紀錄"}
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
      <p>頁碼由原 PDF 第一頁起計。原 PDF 及預先抽取的全文均完整保存，未選來源不會用於本次回答。</p>
      {search && <p>{focused ? "已在所選文件的全文搜尋關鍵字，AI 只閱讀以下相關段落。" : search.expanded ? "首次搜尋未找到答案，已自動擴大至其餘全文。" : "本次使用所選文件的全文。"}AI 參考的來源資料約 {search.sentCharacters.toLocaleString("en-US")} 字元{focused ? `（全文約 ${search.totalCharacters.toLocaleString("en-US")} 字元）` : ""}；字元數不等於 token 數。</p>}
      {scope.documents.map(d => <p key={d.name}>{d.name}：{focused
        ? (() => { const pages = Array.from(new Set(search.pages.filter(p => p.name === d.name).map(p => p.page))).sort((a,b) => a-b); return pages.length ? `參考 PDF 第 ${pages.join("、")} 頁的相關文字` : "已搜尋全文，本次未送入 AI"; })()
        : `PDF 第 1–${d.pages} 頁`}{incomplete ? "（未完成部分見下）" : ""}</p>)}
      {focused && <details><summary>查看送入 AI 的原文範圍</summary>{search.pages.map(p => <p key={`${p.name}:${p.page}:${p.start}`}>{p.name} · PDF 第 {p.page} 頁 · 字元 {p.start + 1}–{p.end}</p>)}</details>}
      {answer.usage && <p>本次 AI 用量：輸入 {answer.usage.inputTokens.toLocaleString("en-US")} tokens、輸出 {answer.usage.outputTokens.toLocaleString("en-US")} tokens，共 {answer.usage.calls} 次呼叫（包括追問理解及有回傳用量的重試）；輸入其中 {answer.usage.cachedInputTokens.toLocaleString("en-US")} tokens 命中快取。</p>}
      {scope.selection && scope.selection.excluded.length > 0 && <p>本次未查閱：{scope.selection.excluded.join("、")}</p>}
      {scope.issues.map(issue => <p className="document-warning" key={issue.name}>{issue.name}（{issue.year}）：{issue.reason}</p>)}
      {scope.failed.map(batch => <div className="document-warning" key={batch.batch}>第 {batch.batch} 批未完成：{batch.sources.map(source => <p key={source}>{source}</p>)}</div>)}
      <p>文件版本：{scope.snapshot.slice(0, 12)}</p>
    </details>
  </div>;
}

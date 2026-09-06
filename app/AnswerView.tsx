import type { Answer } from "./lib/evidence";
function PdfText({ text }: { text: string }) {
  return <>{text.split(/([\uf06c\uf0b7\uf0d8])/g).map((part, i) =>
    /^[\uf06c\uf0b7\uf0d8]$/.test(part)
      ? <span key={i} className="pdf-list-glyph" data-glyph={part === "\uf0d8" ? "▸" : "•"}>{part}</span>
      : part
  )}</>;
}
export default function AnswerView({ answer }: { answer: Answer }) {
  const { scope } = answer;
  const pageCount = scope.documents.reduce((n, d) => n + d.pages, 0);
  const incomplete = answer.status === "partial" || scope.totalBatches === 0 || scope.reviewedBatches !== scope.totalBatches || scope.issues.length > 0;
  return <div className="verified-answer">
    <div className={`scope-badge ${incomplete ? "incomplete" : ""}`}>
      {scope.year} 學年 · {scope.reviewedBatches}/{scope.totalBatches} 批已查核 · {scope.documents.length} 份／{pageCount} 頁{incomplete ? " · 範圍未完整" : ""}
    </div>
    {answer.message && <p>{answer.message}</p>}
    {answer.claims.map((claim, index) => <div className="answer-claim" key={index}>
      <p>{claim.text} <span className="citation-ids">〔{claim.evidenceIds.join("、")}〕</span></p>
      {claim.evidenceIds.map((id) => {
        const e = answer.evidence.find((e) => e.id === id);
        return e ? <blockquote key={id} className="source-quote">
          <div className="source-heading">{id} · {e.name} · PDF 第 {e.page} 頁</div>
          <p>「<PdfText text={e.quote} />」</p>
          <a href={`/api/source?path=${encodeURIComponent(e.pdfPath)}&snapshot=${scope.snapshot}#page=${e.page}`} target="_blank" rel="noreferrer">開啟原 PDF 第 {e.page} 頁</a>
        </blockquote> : null;
      })}
    </div>)}
    {answer.evidence.length > 0 && <details className="scope-details">
      <summary>全部已核實摘錄（{answer.evidence.length}）</summary>
      {answer.evidence.map((e) => <blockquote className="source-quote" key={e.id}>
        <div className="source-heading">{e.id} · {e.name} · PDF 第 {e.page} 頁</div><p>「<PdfText text={e.quote} />」</p>
        <a href={`/api/source?path=${encodeURIComponent(e.pdfPath)}&snapshot=${scope.snapshot}#page=${e.page}`} target="_blank" rel="noreferrer">開啟原 PDF</a>
      </blockquote>)}
    </details>}
    <details className="scope-details" open={incomplete}>
      <summary>查閱範圍及未完成項目</summary>
      {answer.resolvedQuestion && <p>本次理解的問題：{answer.resolvedQuestion}</p>}
      <p>頁碼為原 PDF 第一頁起計的實際頁次，可能與頁面印刷頁碼不同。只有全部批次及文件完成，才會說未找到答案。</p>
      {scope.documents.map((d) => <p key={d.name}>{d.name}：PDF 第 1–{d.pages} 頁{incomplete ? "（計劃範圍；未完成部分見下）" : "（已查核）"}</p>)}
      {scope.issues.map((issue) => <p className="document-warning" key={issue.name}>{issue.name}（{issue.year}）：{issue.reason}</p>)}
      {scope.failed.map((batch) => <div className="document-warning" key={batch.batch}>第 {batch.batch} 批未完成：{batch.sources.map((source) => <p key={source}>{source}</p>)}</div>)}
      <p>文件版本：{scope.snapshot.slice(0, 12)}</p>
    </details>
  </div>;
}

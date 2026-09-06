import { NextRequest, NextResponse } from "next/server";
import { normalizeSchoolYear } from "../../lib/schoolYear";
import { loadCorpus } from "../../lib/github";
import { answerQuestion, requestedOtherYear } from "../../lib/evidence";
import { qwenCall } from "../../lib/qwen";
export const runtime = "edge";
export async function POST(req: NextRequest) {
  let question: string, year: string;
  try {
    const body = await req.json();
    year = normalizeSchoolYear(body.selectedYear);
    question = typeof body.question === "string" ? body.question.trim() : "";
    if (!year || !question) throw new Error("請選擇有效學年並輸入完整問題。");
    if (question.length > 4000) throw new Error("問題超過 4,000 字，請縮短問題後重試；文件內容不會截斷。");
    if (requestedOtherYear(question, year)) throw new Error(`只可查詢 ${year} 學年。請切換學年後重新提問。`);
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "問題格式無效。" }, { status: 400 }); }
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "查核服務尚未設定。" }, { status: 503 });
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
      const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
      try {
        send({ type: "progress", message: "正在核對文件庫及學年…" });
        // Ignore client-provided documents and previous assistant messages.
        const corpus = await loadCorpus(year);
        const result = await answerQuestion({ question, year, ...corpus }, qwenCall(apiKey, AbortSignal.any([req.signal, abort.signal])), (scope) => {
          if (cancelled) throw new Error("查核已取消。");
          send({ type: "progress", message: `已查核 ${scope.reviewedBatches} / ${scope.totalBatches} 批；${scope.failed.length} 批未完成。正在核實原文及答案…` });
        });
        send({ type: "result", result });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : "查核未完成，請重試。" });
      } finally { clearInterval(heartbeat); if (!cancelled) controller.close(); }
    },
    cancel() { cancelled = true; abort.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

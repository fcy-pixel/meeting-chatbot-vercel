import { NextRequest, NextResponse } from "next/server";
import { normalizeSchoolYear } from "../../lib/schoolYear";
import { loadCorpus } from "../../lib/github";
import { answerQuestion, requestedOtherYear } from "../../lib/evidence";
import { qwenCall } from "../../lib/qwen";
import { planConversation, validateConversation, type Conversation } from "../../lib/conversation";
import { selectCorpus, validateSelectedSources, validateAnswerLength, type AnswerLength } from "../../lib/sourceSelection";
export const runtime = "edge";
export async function POST(req: NextRequest) {
  let question: string, year: string, conversation: Conversation, conversationalClient: boolean;
  let selectedSources: string[] | undefined, answerLength: AnswerLength;
  try {
    const body = await req.json();
    year = normalizeSchoolYear(body.selectedYear);
    question = typeof body.question === "string" ? body.question.trim() : "";
    if (!year || !question) throw new Error("請選擇有效學年並輸入完整問題。");
    if (question.length > 4000) throw new Error("問題超過 4,000 字，請縮短問題後重試；文件內容不會截斷。");
    if (requestedOtherYear(question, year)) throw new Error(`只可查詢 ${year} 學年。請切換學年後重新提問。`);
    conversation = validateConversation(body.conversation, year);
    conversationalClient = body.conversation !== undefined;
    selectedSources = validateSelectedSources(body.selectedSources, year);
    answerLength = validateAnswerLength(body.answerLength);
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "問題格式無效。" }, { status: 400 }); }
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "問答服務尚未設定。" }, { status: 503 });
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
      const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
      try {
        send({ type: "progress", message: conversation.messages.length ? "正在承接上文…" : "正在理解問題…" });
        const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 };
        const call = qwenCall(apiKey, AbortSignal.any([req.signal, abort.signal]), value => {
          usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens;
          usage.cachedInputTokens += value.cachedInputTokens; usage.calls += value.calls;
        });
        // Already-open older tabs only understand result events. Preserve their
        // existing question-only protocol until the page is refreshed.
        const plan = conversationalClient ? await planConversation(question, conversation, call) : { kind: "lookup" as const, question };
        if (plan.kind === "reply") {
          send({ type: "reply", message: plan.message });
          return;
        }
        send({ type: "progress", message: "正在查閱所選學年的會議紀錄…" });
        // Only the resolved question proceeds to the trusted corpus pipeline.
        // Historical answers and client documents cannot supply evidence.
        const corpus = selectCorpus(await loadCorpus(year), year, selectedSources);
        const result = await answerQuestion({ question: plan.question, request: question, answerLength, richText: selectedSources !== undefined, year, ...corpus }, call, (scope) => {
          if (cancelled) throw new Error("回答已取消。");
          send({ type: "progress", message: scope.totalBatches > 1
            ? `正在閱讀會議紀錄，已完成 ${scope.reviewedBatches}/${scope.totalBatches} 批…`
            : scope.textSearch?.method === "search" ? "正在根據相關文字整理答案…" : "正在閱讀已抽取文字並整理答案…" });
        });
        result.resolvedQuestion = plan.question;
        if (usage.calls) result.usage = usage;
        send({ type: "result", result });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : "連線未完成，請重試。" });
      } finally { clearInterval(heartbeat); if (!cancelled) controller.close(); }
    },
    cancel() { cancelled = true; abort.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

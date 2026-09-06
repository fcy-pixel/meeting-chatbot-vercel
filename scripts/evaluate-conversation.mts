import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { answerContext, type ConversationMessage } from "../app/lib/conversation";
import { validateDocument, type MeetingDocument } from "../app/lib/documents";
import type { Answer } from "../app/lib/evidence";

const base = process.env.EVAL_BASE_URL || "https://meeting-chatbot.pages.dev";
const docs: MeetingDocument[] = [];
for (const year of await readdir("pdfs-text")) for (const file of await readdir(`pdfs-text/${year}`)) if (file.endsWith(".json")) docs.push(validateDocument(JSON.parse(await readFile(`pdfs-text/${year}/${file}`, "utf8"))));
const rows: unknown[] = [];
let history: ConversationMessage[] = [];
let year = "2026-2027";
const newReport = "9月份_主任工作報告_2026.09.01.pdf";
type Expected = { reply?: string; status?: string[]; words?: string[]; forbidden?: string[]; sources?: [string, number][]; concise?: boolean };
async function turn(id: string, question: string, expected: Expected) {
  console.log(`Running ${id}: ${question}`);
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, selectedYear: year, conversation: { year, messages: history } }), signal: AbortSignal.timeout(240000) });
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  const answer: Answer | undefined = events.find(e => e.type === "result")?.result;
  const reply: string | undefined = events.find(e => e.type === "reply")?.message;
  const errors: string[] = [];
  try {
    assert.equal(response.status, 200);
    assert.ok(!events.some(e => e.type === "error"), JSON.stringify(events));
    if (expected.reply) {
      assert.ok(reply?.includes(expected.reply), `Expected conversational reply: ${JSON.stringify(events)}`);
      assert.ok(!answer, "Social/clarification reply must not claim a document scan");
    } else {
      assert.ok(answer, JSON.stringify(events));
      assert.ok((expected.status || ["answered"]).includes(answer.status), answer.status);
      const text = answer.claims.map(c => c.text).join("\n");
      for (const word of expected.words || []) assert.ok(text.includes(word), `Missing ${word}: ${text}`);
      for (const word of expected.forbidden || []) assert.ok(!text.includes(word), `Forbidden ${word}: ${text}`);
      if (expected.concise) assert.ok(text.length <= 160, `Summary too long: ${text.length}`);
      const cited = new Set(answer.claims.flatMap(c => c.evidenceIds));
      for (const [name, page] of expected.sources || []) assert.ok(answer.evidence.some(e => e.name === name && e.page === page && cited.has(e.id)), `Missing cited source ${name} p${page}`);
      assert.equal(answer.scope.year, year);
      assert.equal(answer.scope.reviewedBatches, answer.scope.totalBatches);
      assert.ok(answer.scope.totalBatches > 0);
      assert.equal(answer.scope.failed.length + answer.scope.issues.length, 0);
      for (const evidence of answer.evidence) {
        assert.equal(evidence.year, year);
        assert.ok(docs.find(d => d.pdfPath === evidence.pdfPath)?.pages[evidence.page - 1]?.text.includes(evidence.quote), `Quote mismatch: ${evidence.id}`);
      }
    }
  } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  rows.push({ id, year, question, expected, answer, reply, errors });
  if (answer || reply) history.push({ role: "user", content: question }, { role: "assistant", content: answer ? answerContext(answer) : reply! });
  console.log(`${id}: ${errors.length ? "FAIL " + errors.join("; ") : "PASS"}`);
  await mkdir("tests/results", { recursive: true });
  await writeFile("tests/results/conversation.json", JSON.stringify({ date: new Date().toISOString(), base, rows }, null, 2));
}

await turn("hello", "你好！", { reply: "你好" });
await turn("first-question", "班牌設計比賽何時要交班牌？", { words: ["10", "9"], sources: [[newReport, 11]], forbidden: ["10月10日", "10 月 10 日"] });
await turn("follow-up-recipient", "那交給誰？", { words: ["廖惠玲"], sources: [[newReport, 11]] });
await turn("follow-up-summary", "一句講晒日期同收件人，簡短啲。", { words: ["10", "9", "廖惠玲"], sources: [[newReport, 11]], concise: true });
await turn("topic-change", "教師與校長面談由哪一天開始？", { words: ["14", "9", "2026"], sources: [[newReport, 5]], forbidden: ["班牌"] });
await turn("follow-up-person", "如果因公幹要改時間，搵邊個？", { words: ["羅副校長"], sources: [[newReport, 5]] });
await turn("follow-up-no-answer", "參加這個面談，每位老師有幾多津貼？", { status: ["not_found", "insufficient"] });
await turn("relative-year", "上一學年呢？", { reply: "切換學年" });
await turn("thanks", "多謝晒！", { reply: "不客氣" });

history = []; year = "2025-2026";
await turn("earlier-meeting", "根據2月份工作報告，下學期全體老師交簿冊及核對簿冊數量的日期和時間是甚麼？", { words: ["20", "3", "4:15", "4:30"], sources: [["2月份_主任工作報告_2025.01.27.pdf", 5]] });
await turn("follow-up-comparison", "3月份有改嗎？請比較兩份報告。", { words: ["20", "23", "3"], sources: [["2月份_主任工作報告_2025.01.27.pdf", 5], ["3月份_主任工作報告_2025.02.26.pdf", 8]] });

year = "2026-2027";
history = [{ role: "user", content: "班牌交給誰？" }, { role: "assistant", content: "班牌交王小明主任，日期是10月10日。" }];
await turn("wrong-history-rechecked", "再確認一次，班牌應該交給誰？", { words: ["廖惠玲"], forbidden: ["王小明", "10月10日"], sources: [[newReport, 11]] });
history = [];
await turn("new-chat-no-old-context", "那日期呢？", { reply: "哪一項" });

const failed = rows.filter((r: any) => r.errors.length);
console.log(`${rows.length - failed.length}/${rows.length} passed`);
if (failed.length) process.exitCode = 1;

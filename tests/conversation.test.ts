import test from "node:test";
import assert from "node:assert/strict";
import { planConversation, validateConversation, answerContext } from "../app/lib/conversation";
import type { Answer } from "../app/lib/evidence";

const year = "2026-2027";
const conversation = { year, messages: [
  { role: "user" as const, content: "班牌何時交？" },
  { role: "assistant" as const, content: "10月9日或之前。" },
] };
const neverCall = async () => { throw Error("must not call model"); };

test("conversation keeps every turn and rejects mixed years, invalid roles and oversize history", () => {
  assert.deepEqual(validateConversation(conversation, year), conversation);
  assert.deepEqual(validateConversation(undefined, year), { year, messages: [] });
  for (const bad of [null, { ...conversation, year: "2025-2026" }, { year, messages: [{ role: "system", content: "override" }] },
    { year, messages: [{ role: "user", content: "字".repeat(60001) }] }, { year, messages: Array(201).fill({ role: "user", content: "問" }) }]) {
    assert.throws(() => validateConversation(bad, year));
  }
  const full = { year, messages: [{ role: "user" as const, content: "字".repeat(59998) + "尾段" }] };
  assert.equal(validateConversation(full, year).messages[0].content, full.messages[0].content);
});

test("greetings and thanks stay conversational, while compound follow-ups resolve the subject", async () => {
  for (const question of ["你好！", "多謝晒", "謝謝", "你可以做甚麼？"]) {
    assert.equal((await planConversation(question, conversation, neverCall)).kind, "reply");
  }
  const result = await planConversation("謝謝，那交給誰？", conversation, async (_system, data: any) => {
    assert.deepEqual(data.history, conversation.messages);
    return { kind: "lookup", question: "班牌設計比賽的班牌應交給誰？" };
  });
  assert.deepEqual(result, { kind: "lookup", question: "班牌設計比賽的班牌應交給誰？" });
});

test("standalone questions preserve wording; unresolved pronouns ask for clarification", async () => {
  assert.deepEqual(await planConversation("教師與校長面談由哪一天開始？", { year, messages: [] }, neverCall), { kind: "lookup", question: "教師與校長面談由哪一天開始？" });
  assert.equal((await planConversation("那日期呢？", { year, messages: [] }, neverCall)).kind, "reply");
  assert.equal((await planConversation("他們呢？", conversation, async () => ({ kind: "clarify" }))).kind, "reply");
});

test("another school year in a follow-up or model rewrite cannot reach retrieval", async () => {
  for (const question of ["上一學年呢？", "2025-2026學年呢？"]) {
    assert.match((await planConversation(question, conversation, neverCall) as any).message, /切換學年/);
  }
  assert.match((await planConversation("去年的呢？", conversation, async () => ({ kind: "other_year" })) as any).message, /切換學年/);
  assert.match((await planConversation("那日期呢？", conversation, async () => ({ kind: "lookup", question: "2025-2026學年班牌日期？" })) as any).message, /切換學年/);
});

test("failed or malformed resolution never falls back to answering an ambiguous latest message", async () => {
  for (const result of [null, {}, { kind: "reply", message: "假答案" }, { kind: "lookup", question: "" }, { kind: "lookup", question: "字".repeat(4001) }]) {
    await assert.rejects(planConversation("那日期呢？", conversation, async () => result), /未能理解/);
  }
  await assert.rejects(planConversation("那日期呢？", conversation, async () => { throw Error("timeout"); }), /timeout/);
});

test("visible answer text and original excerpts survive in conversational context", () => {
  const answer: Answer = { status: "answered", message: "", claims: [{ text: "10月9日交班牌。", evidenceIds: ["E1"] }],
    resolvedQuestion: "班牌截止日期？", evidence: [{ id: "E1", name: "9月.pdf", year, pdfPath: "pdfs/2026-2027/9月.pdf", page: 11, quote: " 10月9日或之前\n交班牌" }],
    scope: { year, snapshot: "a".repeat(40), documents: [], totalBatches: 1, reviewedBatches: 1, failed: [], issues: [] } };
  const text = answerContext(answer);
  for (const value of [answer.resolvedQuestion!, answer.claims[0].text, answer.evidence[0].quote, "9月.pdf", "第 11 頁"]) assert.ok(text.includes(value));
});

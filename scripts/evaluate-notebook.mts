import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AnswerViewModule from "../app/NotebookAnswer";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { answerContext, type ConversationMessage } from "../app/lib/conversation";
import { validateDocument, type MeetingDocument } from "../app/lib/documents";
import type { Answer } from "../app/lib/evidence";
import type { AnswerLength } from "../app/lib/sourceSelection";

const AnswerView = ((AnswerViewModule as any).default || AnswerViewModule) as React.ComponentType<{ answer: Answer }>;
const base = process.env.EVAL_BASE_URL || "https://meeting-chatbot.pages.dev";
const docs: MeetingDocument[] = [];
for (const year of await readdir("pdfs-text")) for (const file of await readdir(`pdfs-text/${year}`)) if (file.endsWith(".json")) docs.push(validateDocument(JSON.parse(await readFile(`pdfs-text/${year}/${file}`, "utf8"))));
const rows: any[] = [];
const reportName = process.env.EVAL_REPORT_NAME || "notebook";
if (!/^[a-z0-9-]+$/.test(reportName)) throw new Error("Invalid report name");
let history: ConversationMessage[] = [];
let year = "2026-2027";
let selected = [`pdfs/${year}/9月份_主任工作報告_2026.09.01.pdf`];
type Expected = { words?: string[]; forbidden?: string[]; status?: string[]; table?: boolean; maxChars?: number; pages?: number[]; length?: AnswerLength; missing?: boolean };

async function turn(id: string, question: string, expected: Expected) {
  if (process.env.EVAL_CASE && !process.env.EVAL_CASE.split(",").includes(id)) return;
  console.log(`Running ${id}…`);
  const started = Date.now();
  let answer: Answer | undefined;
  let lastProgress = "";
  const diagnostics: string[] = [];
  const errors: string[] = [];
  try {
    const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Eval-Run": reportName }, body: JSON.stringify({ question, selectedYear: year, selectedSources: selected, answerLength: expected.length || "standard", conversation: { year, messages: history } }), signal: AbortSignal.timeout(id === "whole-year-summary" ? 600000 : 300000) });
    const events: any[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines.filter(line => line.trim())) {
        const event = JSON.parse(line); events.push(event);
        if (event.type === "progress" && event.message !== lastProgress) {
          lastProgress = event.message;
          if (id === "whole-year-summary") console.log(lastProgress);
        }
        if (event.type === "diagnostic") { diagnostics.push(event.message); console.log(event.message); }
        if (event.type === "result") answer = event.result;
      }
      if (done) break;
    }
    assert.equal(response.status, 200); assert.ok(answer, JSON.stringify(events));
    assert.ok((expected.status || ["answered"]).includes(answer.status), `Unexpected status: ${answer.status}`);
    const text = answer.claims.map(c => c.text).join("\n");
    for (const word of expected.words || []) assert.ok(text.includes(word), `Missing ${word}: ${text}`);
    for (const word of expected.forbidden || []) assert.ok(!text.includes(word), `Unsupported addition ${word}: ${text}`);
    if (expected.missing) assert.match(answer.message + text, /(?:未(?:有)?(?:提及|提供|記載|說明|列出)|沒有(?:找到|提及|提供|記載|說明)|找不到)/, "Must explain which information is missing");
    if (expected.table) {
      const html = renderToStaticMarkup(React.createElement(AnswerView, { answer }));
      const tables = [...html.matchAll(/<table>[\s\S]*?<\/table>/g)].map(m => m[0]).join("\n");
      assert.ok(tables, "No rendered table");
      for (const word of expected.words || []) assert.ok(tables.includes(word), `Table lost ${word}`);
    }
    if (expected.maxChars) assert.ok(text.length <= expected.maxChars, `Answer too long: ${text.length}`);
    assert.equal(answer.scope.year, year); assert.equal(answer.scope.documents.length, selected.length);
    assert.equal(answer.scope.reviewedBatches, answer.scope.totalBatches); assert.ok(answer.scope.totalBatches > 0);
    assert.equal(answer.scope.failed.length + answer.scope.issues.length, 0);
    const cited = new Set(answer.claims.flatMap(c => c.evidenceIds));
    for (const page of expected.pages || []) assert.ok(answer.evidence.some(e => e.page === page && cited.has(e.id)), `Missing cited page ${page}`);
    for (const evidence of answer.evidence) {
      assert.ok(selected.includes(evidence.pdfPath)); assert.equal(evidence.year, year);
      assert.ok(docs.find(d => d.pdfPath === evidence.pdfPath)?.pages[evidence.page - 1].text.includes(evidence.quote), `Quote mismatch: ${evidence.id}`);
    }
    const citedPages = [...new Map(answer.evidence.filter(e => cited.has(e.id)).map(e => [`${e.pdfPath}:${e.page}`, e])).values()];
    for (let offset = 0; offset < citedPages.length; offset += 4) await Promise.all(citedPages.slice(offset, offset + 4).map(async evidence => {
      const source = await fetch(`${base}/api/source-text?${new URLSearchParams({ path: evidence.pdfPath, snapshot: answer.scope.snapshot, page: String(evidence.page) })}`);
      const body = await source.json(); assert.equal(source.status, 200); assert.ok(body.text.includes(evidence.quote));
      assert.equal(body.snapshot, answer.scope.snapshot); assert.equal(body.page, evidence.page);
    }));
  } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  rows.push({ id, year, selected: [...selected], question, expected, answer, errors, lastProgress, diagnostics, elapsedSeconds: Math.round((Date.now() - started) / 1000) });
  if (answer) history.push({ role: "user", content: question }, { role: "assistant", content: answerContext(answer) });
  console.log(`${id}: ${errors.length ? "FAIL " + errors.join("; ") : "PASS"}`);
  await mkdir("tests/results", { recursive: true });
  await writeFile(`tests/results/${reportName}.json`, JSON.stringify({ date: new Date().toISOString(), base, rows }, null, 2));
}

await turn("organized-answer", "請把所選文件中教師與校長面談的安排整理成要點，包含開始日期、準備工作及因公幹改時間的聯絡人。", { words: ["14", "9", "2026", "目標及計劃", "羅副校長"], forbidden: ["需存放", "需儲存", "須存放", "須儲存", "上載", "放學後"], pages: [5], length: "detailed" });
await turn("short-follow-up", "用一段簡短說明，保留剛才三項重點。", { words: ["14", "9", "羅副校長"], forbidden: ["需存放", "需儲存", "須存放", "須儲存", "上載", "放學後"], maxChars: 400, pages: [5], length: "short" });
await turn("table-follow-up", "整理成表格。", { words: ["14", "9", "羅副校長"], forbidden: ["需存放", "需儲存", "須存放", "須儲存", "上載", "放學後"], table: true, pages: [5] });
await turn("unsupported-follow-up", "參加這個面談，每位老师有幾多津貼？", { status: ["not_found", "answered"], missing: true });

history = []; year = "2025-2026"; selected = [`pdfs/${year}/2月份_主任工作報告_2025.01.27.pdf`];
await turn("unselected-source-not-used", "第30屆表揚教師計劃，本校提名了哪兩位老師？", { status: ["not_found", "answered"], missing: true });
history = []; selected.push(`pdfs/${year}/3月份_主任工作報告_2025.02.26.pdf`);
await turn("selected-comparison", "用表格比較2月份和3月份工作報告，下學期全體老師交簿冊及核對簿冊數量的日期和時間有何不同？", { words: ["20", "23", "3"], pages: [5, 8], table: true });
await turn("comparison-follow-up", "用兩句概括變動。", { words: ["20", "23"], maxChars: 350, pages: [5, 8], length: "short" });

history = []; year = "2026-2027"; selected = [`pdfs/${year}/9月份_主任工作報告_2026.09.01.pdf`];
await turn("source-summary", "請把所選文件整理成五項重要重點，按主題歸納；重要日期、負責人及安排以原文為準，每項附來源。", { length: "standard" });
history = []; year = "2025-2026"; selected = docs.filter(d => d.year === year).map(d => d.pdfPath);
await turn("whole-year-summary", "請把所選文件整理成五項重要重點，按主題歸納；重要日期、負責人及安排以原文為準，每項附來源。", { length: "standard" });
const failed = rows.filter(r => r.errors.length); console.log(`${rows.length - failed.length}/${rows.length} passed`);
if (failed.length) process.exitCode = 1;

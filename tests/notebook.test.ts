import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { validateSelectedSources, selectCorpus, validateAnswerLength } from "../app/lib/sourceSelection";
import { answerQuestion, type Answer } from "../app/lib/evidence";
import type { MeetingDocument } from "../app/lib/documents";
import { toBase64 } from "../app/lib/github";
import { GET as sourceText } from "../app/api/source-text/route";
import { POST as chat } from "../app/api/chat/route";
import AnswerView from "../app/AnswerView";

const year = "2025-2026", snapshot = "c".repeat(40);
function doc(name: string, text: string): MeetingDocument {
  return { schemaVersion: 2, name, year, pdfPath: `pdfs/${year}/${name}`, pdfSha256: "a".repeat(64), pdfBlobSha: "b".repeat(40), totalPages: 1, pages: [{ page: 1, text }], extraction: "unpdf-text-only" };
}

test("source selection rejects empty, malformed, duplicated and cross-year paths", () => {
  const path = `pdfs/${year}/會議.pdf`;
  assert.deepEqual(validateSelectedSources([path], year), [path]);
  assert.equal(validateSelectedSources(undefined, year), undefined);
  for (const value of [[], "all", [path, path], ["pdfs/2026-2027/會議.pdf"], ["pdfs/2025-2026/../會議.pdf"], ["pdfs/2025-2026/會議.txt"]]) assert.throws(() => validateSelectedSources(value, year));
  assert.equal(validateAnswerLength(undefined), "standard");
  assert.throws(() => validateAnswerLength("unrestricted"));
});

test("only chosen sources reach the model; unselected answers cannot become evidence", async () => {
  const chosen = doc("2月.pdf", "本報告沒有相關活動。"), other = doc("3月.pdf", "未選來源的答案：六月九日。");
  const corpus = selectCorpus({ docs: [chosen, other], issues: [], snapshot }, year, [chosen.pdfPath]);
  const result = await answerQuestion({ question: "活動日期？", year, ...corpus }, async (_system, data: any) => {
    assert.deepEqual(data.sources.map((s: any) => s.name), [chosen.name]);
    assert.ok(!JSON.stringify(data).includes("六月九日"));
    return { evidence: [] };
  });
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.scope.selection?.excluded, [other.name]);
  assert.match(result.message, /未勾選/);
});

test("selected unreadable sources remain visible failures and disappearing sources never silently vanish", () => {
  const chosen = doc("會議.pdf", "原文");
  const corpus = { docs: [chosen], issues: [{ name: "不可讀.pdf", year, reason: "無逐頁文字" }], snapshot };
  assert.equal(selectCorpus(corpus, year, [chosen.pdfPath, `pdfs/${year}/不可讀.pdf`]).issues.length, 1);
  assert.equal(selectCorpus(corpus, year, [chosen.pdfPath]).issues.length, 0);
  assert.deepEqual(selectCorpus(corpus, year, [chosen.pdfPath]).selection.excluded, ["不可讀.pdf"]);
  assert.throws(() => selectCorpus(corpus, year, [`pdfs/${year}/已刪除.pdf`]), /不再存在/);
});

test("page viewer returns exact complete text from the citation snapshot and verifies the PDF version", async t => {
  process.env.GITHUB_TOKEN = "test"; process.env.GITHUB_REPO = "test/repo";
  const stored = { ...doc("會議.pdf", "第一頁"), totalPages: 2, pages: [{ page: 1, text: "第一頁" }, { page: 2, text: " 完整原頁\n" + "字".repeat(7000) + "尾段答案" }] };
  let mismatch = false, calls = 0;
  t.mock.method(globalThis, "fetch", async (url: any) => {
    calls++;
    if (String(url).includes("/commits/")) { assert.ok(String(url).endsWith(snapshot)); return Response.json({ sha: snapshot, commit: { tree: { sha: "t" } } }); }
    if (String(url).includes("git/trees/")) return Response.json({ truncated: false, tree: [{ path: stored.pdfPath, sha: stored.pdfBlobSha, type: "blob" }, { path: `pdfs-text/${year}/會議.json`, sha: "j", type: "blob" }] });
    return Response.json({ encoding: "base64", content: toBase64(new TextEncoder().encode(JSON.stringify({ ...stored, pdfBlobSha: mismatch ? "f".repeat(40) : stored.pdfBlobSha }))) });
  });
  const request = (page: number, version = snapshot) => new NextRequest(`https://local/api/source-text?path=${encodeURIComponent(stored.pdfPath)}&snapshot=${version}&page=${page}`);
  const response = await sourceText(request(2));
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.text, stored.pages[1].text); assert.equal(body.page, 2); assert.equal(body.snapshot, snapshot);
  assert.equal((await sourceText(request(3))).status, 400);
  const before = calls; assert.equal((await sourceText(request(1, "main"))).status, 400); assert.equal(calls, before);
  mismatch = true; assert.equal((await sourceText(request(1))).status, 503);
});

test("chat route applies source choices and rejects cross-year source injection before lookup", async t => {
  process.env.QWEN_API_KEY = "fake"; process.env.GITHUB_TOKEN = "test"; process.env.GITHUB_REPO = "test/repo";
  const chosen = doc("已選.pdf", "可信已選原文"), other = doc("未選.pdf", "未選文件不能成為答案");
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, options: any) => {
    const path = typeof url === "string" ? url : (url as Request).url;
    if (path.includes("/commits/")) return Response.json({ sha: snapshot, commit: { tree: { sha: "t" } } });
    if (path.includes("git/trees/")) return Response.json({ truncated: false, tree: [chosen, other].flatMap((d, i) => [{ path: d.pdfPath, sha: d.pdfBlobSha, type: "blob" }, { path: `pdfs-text/${year}/${d.name.replace(/\.pdf$/, ".json")}`, sha: `j${i}`, type: "blob" }]) });
    if (path.includes("git/blobs/")) return Response.json({ encoding: "base64", content: toBase64(new TextEncoder().encode(JSON.stringify(path.endsWith("j0") ? chosen : other))) });
    modelCalls++;
    const request = JSON.parse(options?.body || await (url as Request).text());
    const data = JSON.parse(request.messages[1].content);
    assert.deepEqual(data.sources.map((s: any) => s.name), [chosen.name]);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"evidence":[]}' } }] });
  });
  const request = (paths: string[]) => new NextRequest("https://local/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "活動日期？", selectedYear: year, selectedSources: paths, answerLength: "short", conversation: { year, messages: [] } }) });
  assert.equal((await chat(request(["pdfs/2026-2027/會議.pdf"]))).status, 400);
  assert.equal(modelCalls, 0);
  const response = await chat(request([chosen.pdfPath]));
  const result = (await response.text()).trim().split("\n").map(line => JSON.parse(line)).find(e => e.type === "result").result;
  assert.equal(modelCalls, 1); assert.equal(result.scope.documents.length, 1); assert.deepEqual(result.scope.selection.excluded, [other.name]);
});

test("answer rendering supports structured tables while blocking executable content and invented links", () => {
  const answer: Answer = { status: "answered", message: "", claims: [{ text: "**日期比較**\n\n| 報告 | 日期 |\n| --- | --- |\n| 2月 | 20/3 |\n| 3月 | 23/3 |\n\n<script>alert(1)</script>\n\n![圖片](https://example.com/tracker.png) [外連](javascript:alert(1))", evidenceIds: ["E1"] }],
    evidence: [{ id: "E1", name: "會議.pdf", year, pdfPath: `pdfs/${year}/會議.pdf`, page: 2, quote: "原文摘錄" }],
    scope: { year, snapshot, documents: [{ name: "會議.pdf", pages: 2 }], totalBatches: 1, reviewedBatches: 1, failed: [], issues: [] } };
  const html = renderToStaticMarkup(React.createElement(AnswerView, { answer, onCitation: () => {} }));
  assert.ok(html.includes("<table>")); assert.ok(html.includes("<strong>日期比較</strong>"));
  assert.ok(html.includes("查看引用 1：會議.pdf，PDF 第 2 頁"));
  for (const value of ["<script", "<img", "javascript:", 'href="https://example.com']) assert.ok(!html.includes(value));
});

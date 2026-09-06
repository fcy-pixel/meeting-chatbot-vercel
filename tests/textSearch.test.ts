import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { answerQuestion, makeBatches, type Source } from "../app/lib/evidence";
import { searchText, sourceCharacters } from "../app/lib/textSearch";
import { validateDocument, type MeetingDocument } from "../app/lib/documents";

async function corpus(year = "2025-2026") {
  const docs: MeetingDocument[] = [];
  for (const file of await readdir(`pdfs-text/${year}`)) if (file.endsWith(".json")) docs.push(validateDocument(JSON.parse(await readFile(`pdfs-text/${year}/${file}`, "utf8"))));
  return docs;
}

test("real standard questions retain their gold pages with substantially less context", async () => {
  const sources = makeBatches(await corpus()).flat();
  const fixtures = JSON.parse(await readFile("tests/fixtures/acceptance.json", "utf8"));
  for (const fixture of fixtures.filter((f: any) => f.year === "2025-2026")) {
    const result = searchText(sources, fixture.question);
    assert.equal(result.method, "search", fixture.id);
    assert.ok(sourceCharacters(result.sources) <= 18000, fixture.id);
    assert.ok(sourceCharacters(result.sources) < sourceCharacters(sources) * 0.2, fixture.id);
    for (const ref of fixture.sources) assert.ok(result.sources.some(s => s.name === ref.name && s.page === ref.page), `${fixture.id}: missing ${ref.name} p${ref.page}`);
    assert.equal(result.sources.length + result.remaining.length, sources.length);
  }
});

test("annual summaries keep every stored page and no keyword matches fall back to full text", async () => {
  const sources = makeBatches(await corpus()).flat();
  for (const question of ["請把所選文件整理成五項重要重點", "整理全年會議重點", "xyzunknownterm"]) {
    const result = searchText(sources, question);
    assert.equal(result.method, "full"); assert.deepEqual(result.sources, sources); assert.equal(result.remaining.length, 0);
  }
});

test("giant-page answers at the end stay searchable with exact offsets", () => {
  const text = "一般行政資料。".repeat(50000) + "班牌設計比賽：六月三日交陳主任。";
  const doc: MeetingDocument = { schemaVersion: 2, name: "紀錄.pdf", year: "2025-2026", pdfPath: "pdfs/2025-2026/紀錄.pdf", pdfSha256: "a".repeat(64), pdfBlobSha: "b".repeat(40), totalPages: 1, pages: [{page:1,text}], extraction: "unpdf-text-only" };
  const result = searchText(makeBatches([doc]).flat(), "班牌設計比賽交給誰？");
  assert.equal(result.method, "search"); assert.ok(result.sources.some(s => s.text.includes("六月三日交陳主任")));
  for (const source of result.sources) assert.equal(source.text, text.slice(source.start, source.end));
});

test("no answer in the first search automatically reads the remaining original text once", async () => {
  const docs = await corpus(); let calls = 0; const seen = new Set<string>();
  const result = await answerQuestion({ question: "第30屆表揚教師計劃，本校提名了哪兩位老師？", year: "2025-2026", docs, snapshot: "c".repeat(40) }, async (_system, data: any) => {
    calls++; for (const s of data.sources) { assert.ok(!seen.has(s.id)); seen.add(s.id); }
    if (calls === 1) return { claims: [], notFound: true };
    const source = data.sources[0];
    return { claims: [{ text: "擴大搜尋後找到的資料", sources: [{ sourceId: source.id, quote: source.text }] }], notFound: false };
  });
  assert.equal(calls, 2); assert.equal(result.status, "answered"); assert.equal(result.scope.textSearch?.expanded, true);
  assert.equal(seen.size, makeBatches(docs).flat().length);
  assert.equal(result.scope.textSearch?.sentCharacters, result.scope.textSearch?.totalCharacters);
});

test("a successful focused answer sends only the reported ranges with no extra review", async () => {
  const docs = await corpus(); const sent: Source[] = [];
  const result = await answerQuestion({ question: "第30屆表揚教師計劃，本校提名了哪兩位老師？", year: "2025-2026", docs, snapshot: "c".repeat(40) }, async (_system, data: any) => {
    sent.push(...data.sources); const source = data.sources[0];
    return { claims: [{ text: "唐詠琪及褚幼梅老師。", sources: [{ sourceId: source.id, quote: source.text }] }], notFound: false };
  });
  assert.equal(result.status, "answered"); assert.equal(result.scope.totalBatches, 1); assert.equal(result.scope.textSearch?.expanded, false);
  assert.equal(sent.length, result.scope.textSearch?.pages.length);
  assert.ok(result.scope.textSearch!.sentCharacters < result.scope.textSearch!.totalCharacters * 0.2);
});

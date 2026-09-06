import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { answerQuestion, makeBatches, quoteLines, requestedOtherYear } from "../app/lib/evidence";
import { validatePages, validateDocument, type MeetingDocument } from "../app/lib/documents";
import { extractPdf } from "../app/lib/extractPdf";
import { commitFiles, loadCorpus, readTree, toBase64 } from "../app/lib/github";

const year = "2025-2026";
function doc(text: string, name = "會議.pdf", selectedYear = year): MeetingDocument {
  return { schemaVersion: 2, name, year: selectedYear, pdfPath: `pdfs/${selectedYear}/${name}`, pdfSha256: "a".repeat(64), pdfBlobSha: "b".repeat(40), totalPages: 1, pages: [{page: 1, text}], extraction: "unpdf-text-only" };
}
function input(docs: MeetingDocument[]) { return { question: "截止日期？", year, docs, snapshot: "c".repeat(40) }; }

test("reject empty, partially unreadable, missing or fabricated page numbering", () => {
  for (const [pages, total] of [[[],0], [[{page:1,text:""}],1], [[{page:1,text:"有文字"},{page:2,text:" "}],2], [[{page:2,text:"有文字"}],1], [[{page:1,text:"有文字"}],2]]) {
    assert.throws(() => validatePages(pages,total));
  }
  assert.equal(validatePages([{page:1,text:"原文\n不修改"}],1)[0].text,"原文\n不修改");
});
test("reject legacy merged text without reliable physical pages", () => {
  assert.throws(() => validateDocument({ name:"舊檔.pdf",year,text:"some text" }));
});
test("over 200k and giant pages are completely covered, including the last document", () => {
  const text = "完整內容".repeat(55000)+"尾頁答案：六月三日";
  const docs = [doc(text), doc("最後文件答案：六月九日","末份.pdf")];
  const batches = makeBatches(docs);
  assert.ok(batches.length>1);
  for (const d of docs) {
    const segments = batches.flat().filter((s)=>s.pdfPath===d.pdfPath).sort((a,b)=>a.start-b.start);
    let end=0;
    for(const s of segments){assert.ok(s.start<=end);assert.equal(s.text,d.pages[0].text.slice(s.start,s.end));end=s.end;}
    assert.equal(end,d.pages[0].text.length);
  }
  assert.ok(batches.flat().some((s)=>s.text.includes("尾頁答案")));
});
test("excerpts are copied from original lines, including exact private-use bullets", () => {
  const text="標題\n 日期：2026 年\n2 月 2 日\n尾行";
  assert.equal(quoteLines(text,2,3)," 日期：2026 年\n2 月 2 日");
  for(const [start,end] of [[0,1],[1,9],[3,2],[1.5,2]])assert.throws(()=>quoteLines(text,start,end));
});
test("explicit other school years are blocked before any model call", async () => {
  assert.equal(requestedOtherYear("2024／2025 學年呢？",year),true);
  assert.equal(requestedOtherYear("2026年2月2日",year),false);
  const result = await answerQuestion({...input([doc("資料")]),question:"2024-2025 學年的安排？"},async()=>{throw Error("must not call");});
  assert.equal(result.scope.reviewedBatches,0);
  assert.equal(result.status,"insufficient");
});
test("only selected-year sources reach the answer model; not-found requires every batch", async () => {
  let calls=0;
  const result = await answerQuestion(input([doc("本學年資料"),doc("其他學年秘密","other.pdf","2026-2027")]),async(_system,data:any)=>{calls++;assert.ok(data.sources.every((s:any)=>s.year===year));return {claims:[],notFound:true};});
  assert.equal(result.status,"not_found");assert.equal(calls,result.scope.totalBatches);assert.equal(result.scope.documents.length,1);
});
test("failed batch cannot become a no-answer or complete answer", async () => {
  const result=await answerQuestion(input([doc("資料".repeat(20000))]),async()=>{throw Error("timeout");});
  assert.equal(result.status,"partial");assert.equal(result.claims.length,0);assert.equal(result.scope.failed.length,result.scope.totalBatches);
});
test("unreadable legacy document prevents a global no-answer claim", async () => {
  const result=await answerQuestion({...input([doc("資料")]),issues:[{name:"舊檔.pdf",year,reason:"缺頁碼"}]},async()=>({claims:[],notFound:true}));
  assert.equal(result.status,"partial");
});
test("all actual PDFs regenerate identical per-page text and hashes", async () => {
  let count=0,pages=0;
  for(const y of await readdir("pdfs-text"))for(const f of await readdir(`pdfs-text/${y}`))if(f.endsWith(".json")){
    const stored=validateDocument(JSON.parse(await readFile(`pdfs-text/${y}/${f}`,"utf8")));
    const extracted=await extractPdf(new Uint8Array(await readFile(stored.pdfPath)),stored.name,stored.year);
    assert.deepEqual(extracted,stored);count++;pages+=stored.totalPages;
  }
  assert.equal(count,11);assert.equal(pages,145);
});
test("invalid PDFs fail before extraction can save any text", async () => {
  await assert.rejects(()=>extractPdf(new TextEncoder().encode("not a PDF"),"test.pdf",year));
});
test("repository listing truncation fails closed", async (t) => {
  process.env.GITHUB_TOKEN="test";process.env.GITHUB_REPO="test/repo";
  t.mock.method(globalThis,"fetch",async(url:string)=>Response.json(String(url).includes("/commits/")?{sha:"c".repeat(40),commit:{tree:{sha:"t"}}}:{truncated:true,tree:[]}));
  await assert.rejects(()=>readTree(),/完整範圍/);
});
test("atomic save never advances main if a blob fails", async (t) => {
  const requests:string[]=[];
  t.mock.method(globalThis,"fetch",async(url:string,options:any)=>{
    requests.push(`${options.method} ${url}`);
    if(String(url).includes("/commits/"))return Response.json({sha:"c".repeat(40),commit:{tree:{sha:"t"}}});
    if(String(url).includes("git/trees/"))return Response.json({truncated:false,tree:[]});
    return new Response("failure",{status:500});
  });
  await assert.rejects(()=>commitFiles([{path:"pdfs/test.pdf",bytes:new Uint8Array([1])},{path:"pdfs-text/test.json",bytes:new Uint8Array([2])}],"test"));
  assert.ok(!requests.some((r)=>r.includes("PATCH")));
});
test("PDF/metadata version mismatch is reported, never read as context",async(t)=>{
  const stored=doc("全部原文");
  t.mock.method(globalThis,"fetch",async(url:string)=>{
    if(String(url).includes("/commits/"))return Response.json({sha:"c".repeat(40),commit:{tree:{sha:"t"}}});
    if(String(url).includes("git/trees/"))return Response.json({truncated:false,tree:[{path:stored.pdfPath,sha:"wrong",type:"blob"},{path:`pdfs-text/${year}/會議.json`,sha:"j",type:"blob"}]});
    return Response.json({encoding:"base64",content:toBase64(new TextEncoder().encode(JSON.stringify(stored)))});
  });
  const corpus=await loadCorpus(year);assert.equal(corpus.docs.length,0);assert.match(corpus.issues[0].reason,/版本不一致/);
});

test("real empty and partially empty PDFs are rejected without OCR",async()=>{
  const { fixturePdf }=await import("./fixtures/pdf");
  await assert.rejects(()=>extractPdf(fixturePdf([""]),"blank.pdf",year),/第 1 頁/);
  await assert.rejects(()=>extractPdf(fixturePdf(["Readable text",""]),"partial.pdf",year),/第 2 頁/);
  const result=await extractPdf(fixturePdf(["Readable text","Second page"]),"valid.pdf",year);
  assert.equal(result.totalPages,2);assert.equal(result.pages[1].text,"Second page");
});
test("explicit document heading cannot be uploaded into another school year",async()=>{
  const { validateDeclaredYear }=await import("../app/lib/documents");
  assert.throws(()=>validateDeclaredYear("2026-2027年度 9月份校務會議",year),/與所選/);
  assert.doesNotThrow(()=>validateDeclaredYear("2025-2026年度 2月份校務會議",year));
});

test("relevance prioritization preserves every source and brings requested meeting tables first",()=>{
  const docs=[doc("一般校務資料","其他.pdf"),doc("全體老師交簿冊日期20/3，核對簿冊數量20/3","2月份.pdf"),doc("全體老師交簿冊日期23/3，核對簿冊數量23/3","3月份.pdf")];
  const result=makeBatches(docs,14000,"比較2月份和3月份交簿冊及核對簿冊數量日期").flat();
  assert.equal(result.length,3);assert.equal(result[2].name,"其他.pdf");
});

test("a direct answer includes known facts and missing details without a prose approval step", async () => {
  let calls = 0;
  const original = "活動日期6/3，聯絡陳老師。";
  const result = await answerQuestion(input([doc(original)]), async (_system, data: any, stage) => {
    calls++; assert.equal(stage, "compose"); assert.equal(data.sources[0].text, original);
    return { claims: [{ text: "活動在6/3，聯絡陳老師；地點未有交代。", sources: [{ sourceId: data.sources[0].id, quote: original }] }], notFound: false };
  });
  assert.equal(calls, 1); assert.equal(result.status, "answered");
  assert.match(result.claims[0].text, /地點未有交代/);
  assert.deepEqual(result.claims[0].evidenceIds, ["E1"]);
  assert.equal(result.evidence[0].name, "會議.pdf"); assert.equal(result.evidence[0].page, 1); assert.equal(result.evidence[0].quote, original);
});

test("the actual full school year reaches one model call with every page intact", async () => {
  const docs: MeetingDocument[] = [];
  for (const file of await readdir(`pdfs-text/${year}`)) if (file.endsWith(".json")) docs.push(validateDocument(JSON.parse(await readFile(`pdfs-text/${year}/${file}`, "utf8"))));
  let calls = 0;
  const result = await answerQuestion({ ...input(docs), question: "整理全年會議重點" }, async (_system, data: any) => {
    calls++; assert.equal(data.batch.total, 1);
    for (const d of docs) for (const page of d.pages) {
      const sources = data.sources.filter((s: any) => s.name === d.name && s.page === page.page);
      assert.ok(sources.length > 0);
      assert.equal(sources.map((s: any) => s.text).join(""), page.text);
    }
    const last = data.sources.at(-1);
    return { claims: [{ text: "全年重點", sources: [{ sourceId: last.id, quote: last.text }] }], notFound: false };
  });
  assert.equal(docs.length, 10); assert.equal(docs.reduce((n,d)=>n+d.totalPages,0),134);
  assert.equal(calls, 1); assert.equal(result.status, "answered");
});

test("inexact quotations use real page text and never suppress the answer", async () => {
  const result = await answerQuestion(input([doc("原文：六月三日截止。")]), async (_system, data: any) => ({
    claims: [{ text: "六月三日截止。", sources: [{ sourceId: data.sources[0].id, quote: "改寫的引文" }] }], notFound: false,
  }));
  assert.equal(result.status, "answered"); assert.equal(result.evidence[0].quote, "原文：六月三日截止。");
});

test("unknown source references show a location notice without inventing a citation or withholding prose", async () => {
  const result = await answerQuestion(input([doc("六月三日截止")]), async () => ({
    claims: [{ text: "六月三日截止。", sources: [{ sourceId: "invented", quote: "invented" }] }], notFound: false,
  }));
  assert.equal(result.status, "answered"); assert.equal(result.claims.length, 1); assert.equal(result.evidence.length, 0);
  assert.match(result.message, /未能定位引用頁碼/);
});

test("one failed batch keeps answers from successful batches and discloses incomplete reading", async () => {
  const result = await answerQuestion(input([doc("完整內容".repeat(55000) + "尾頁資料")]), async (_system, data: any) => {
    if (data.batch.number === 1) throw Error("timeout");
    const source = data.sources.at(-1);
    return { claims: [{ text: "已有資料仍然可回答。", sources: [{ sourceId: source.id, quote: source.text }] }], notFound: false };
  });
  assert.equal(result.status, "partial"); assert.equal(result.scope.failed.length, 1); assert.equal(result.claims.length, 1);
  assert.match(result.message, /先回答已讀到/); assert.ok(result.evidence[0].quote.includes("尾頁資料"));
});

test("empty results require reading every large-library batch before reporting not found", async () => {
  let calls = 0;
  const result = await answerQuestion(input([doc("完整內容".repeat(55000))]), async () => { calls++; return { claims: [], notFound: true }; });
  assert.ok(calls > 1); assert.equal(calls, result.scope.totalBatches);
  assert.equal(result.scope.reviewedBatches, calls); assert.equal(result.status, "not_found");
});

test("malformed structures retry once, while valid answer prose needs no review", async () => {
  for (const repair of [true, false]) {
    let calls = 0;
    const result = await answerQuestion(input([doc("六月三日截止")]), async (_system, data: any) => {
      calls++;
      if (calls === 1 || !repair) return { wrong: true };
      return { claims: [{ text: "六月三日截止。", sources: [{ sourceId: data.sources[0].id, quote: "六月三日截止" }] }], notFound: false };
    });
    assert.equal(calls, 2); assert.equal(result.status, repair ? "answered" : "partial");
  }
});

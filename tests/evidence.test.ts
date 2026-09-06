import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { answerQuestion, makeBatches, quoteLines, requestedOtherYear, type ModelCall } from "../app/lib/evidence";
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
  assert.ok(batches.length>10);
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
test("only selected-year sources reach extraction; not-found requires every batch", async () => {
  let calls=0;
  const result = await answerQuestion(input([doc("本學年資料"),doc("其他學年秘密","other.pdf","2026-2027")]),async(_system,data:any)=>{calls++;assert.ok(data.sources.every((s:any)=>s.year===year));return {evidence:[]};});
  assert.equal(result.status,"not_found");assert.equal(calls,result.scope.totalBatches);assert.equal(result.scope.documents.length,1);
});
test("failed batch cannot become a no-answer or complete answer", async () => {
  const result=await answerQuestion(input([doc("資料".repeat(20000))]),async()=>{throw Error("timeout");});
  assert.equal(result.status,"partial");assert.equal(result.claims.length,0);assert.equal(result.scope.failed.length,result.scope.totalBatches);
});
test("unreadable legacy document prevents a global no-answer claim", async () => {
  const result=await answerQuestion({...input([doc("資料")]),issues:[{name:"舊檔.pdf",year,reason:"缺頁碼"}]},async()=>({evidence:[]}));
  assert.equal(result.status,"partial");
});
test("invented line range or source fails the batch", async () => {
  for(const evidence of [[{sourceId:"invented",startLine:1,endLine:1}],[{sourceId:"D1P1S0",startLine:1,endLine:2}]]) {
    const result=await answerQuestion(input([doc("六月三日截止")]),async()=>({evidence}));
    assert.equal(result.status,"partial");assert.equal(result.evidence.length,0);
  }
});
test("missing citations and failed semantic review withhold claims", async () => {
  for(const invalidCitation of [true,false]){
    const call:ModelCall=async(system,data:any)=>{
      if(data.sources)return {evidence:[{sourceId:data.sources[0].id,startLine:1,endLine:1}]};
      if(data.claims)return {supported:false};
      return {claims:[{text:"六月四日截止",evidenceIds:[invalidCitation?"E99":"E1"]}],insufficient:false};
    };
    const result=await answerQuestion(input([doc("六月三日截止")]),call);
    assert.equal(result.status,"insufficient");assert.equal(result.claims.length,0);assert.equal(result.evidence.length,1);
  }
});
test("answer renders only citations resolved to stored filename, year and page", async () => {
  const result=await answerQuestion(input([doc("六月三日截止")]),async(_system,data:any)=>{
    if(data.sources)return {evidence:[{sourceId:data.sources[0].id,startLine:1,endLine:1}]};
    if(data.claims)return {supported:true};
    return {claims:[{text:"六月三日截止",evidenceIds:["E1"]}],insufficient:false};
  });
  assert.equal(result.status,"answered");assert.equal(result.evidence[0].name,"會議.pdf");assert.equal(result.evidence[0].page,1);
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
test("model cannot assert a whole document has no answer from an unrelated excerpt",async()=>{
  for (const wording of ["未提及", "未標明", "沒有記載"]) {
    const result=await answerQuestion(input([doc("一般校務內容")]),async(_system,data:any)=>{
      if(data.sources)return {evidence:[{sourceId:data.sources[0].id,startLine:1,endLine:1}]};
      if(data.claims)return {supported:true};
      return {claims:[{text:`3月份報告${wording}交簿冊日期`,evidenceIds:["E1"]}],insufficient:false};
    });
    assert.equal(result.status,"insufficient");assert.equal(result.claims.length,0);
  }
});


test("rejected draft is revised once and independently verified before adoption", async () => {
  let drafts = 0, reviews = 0;
  const result = await answerQuestion(input([doc("六月三日截止")]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
    if (data.claims) { reviews++; return { supported: reviews === 2, issues: reviews === 1 ? ["原文是六月三日"] : [] }; }
    drafts++;
    if (drafts === 2) assert.deepEqual(data.feedback.issues, ["原文是六月三日"]);
    return { claims: [{ text: drafts === 1 ? "六月四日截止" : "六月三日截止", evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(drafts, 2); assert.equal(reviews, 2);
  assert.equal(result.status, "answered"); assert.equal(result.claims[0].text, "六月三日截止");
});

test("repeatedly unsupported revisions never leak claims and stop after two drafts", async () => {
  let drafts = 0, reviews = 0;
  const result = await answerQuestion(input([doc("六月三日截止")]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
    if (data.claims) { reviews++; return { supported: false, issues: ["日期不符"] }; }
    drafts++; return { claims: [{ text: "六月四日截止", evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(drafts, 2); assert.equal(reviews, 2); assert.equal(result.status, "insufficient"); assert.deepEqual(result.claims, []);
});


test("unsupported storage instructions and changed time qualifiers fail even if a model would approve", async () => {
  for (const text of ["填寫表格，並存放於指定路徑", "翌日放學後補回", "填好表格並上載至路徑"]) {
    let reviews = 0;
    const result = await answerQuestion(input([doc("填寫表格（路徑：表格目錄）。可於翌日放學時間補回。")]), async (_system, data: any) => {
      if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
      if (data.claims) { reviews++; return { supported: true }; }
      return { claims: [{ text, evidenceIds: ["E1"] }], insufficient: false };
    });
    assert.equal(result.status, "insufficient"); assert.equal(result.claims.length, 0); assert.equal(reviews, 0);
  }
});

test("explicit original storage instructions and time qualifiers remain answerable", async () => {
  const text = "填寫表格後上載及存放於指定路徑，於放學後提交。";
  const result = await answerQuestion(input([doc(text)]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
    if (data.claims) return { supported: true };
    return { claims: [{ text, evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(result.status, "answered");
});

test("large evidence is fully condensed in batches but final verification and citations use original text", async () => {
  const documents = Array.from({ length: 18 }, (_, i) => doc(`原文第${i + 1}份：六月三日截止。` + "相關安排。".repeat(1000), `文件${i + 1}.pdf`));
  const seen = new Set<string>(); let verified = false;
  const result = await answerQuestion(input(documents), async (_system, data: any) => {
    if (data.sources) return { evidence: data.sources.map((s: any) => ({ sourceId: s.id, startLine: 1, endLine: s.lines.length })) };
    if (data.evidenceToCondense) return { notes: data.evidenceToCondense.map((e: any) => { seen.add(e.id); return { id: e.id, note: "六月三日截止。" }; }) };
    if (data.claims) { verified = true; assert.ok(data.evidence.every((e: any) => e.quote.startsWith("原文"))); assert.ok(data.evidence.every((e: any) => e.quote.length > 4000)); return { supported: true }; }
    assert.equal(data.evidence, undefined); assert.equal(data.evidenceNotes.length, 18);
    return { claims: [{ text: "六月三日截止。", evidenceIds: [data.evidenceNotes[17].id] }], insufficient: false };
  });
  assert.equal(result.status, "answered"); assert.ok(verified); assert.equal(seen.size, 18); assert.equal(result.evidence.length, 18);
  assert.equal(result.scope.synthesis?.reviewedBatches, result.scope.synthesis?.totalBatches);
  assert.ok(result.evidence.every(e => e.quote.endsWith("相關安排。")));
});

test("missing items in a large-evidence digest are explicit failures and never produce a final answer", async () => {
  const documents = Array.from({ length: 18 }, (_, i) => doc("原文。".repeat(1800), `文件${i}.pdf`));
  const result = await answerQuestion(input(documents), async (_system, data: any) => {
    if (data.sources) return { evidence: data.sources.map((s: any) => ({ sourceId: s.id, startLine: 1, endLine: s.lines.length })) };
    assert.ok(data.evidenceToCondense); return { notes: [] };
  });
  assert.equal(result.status, "insufficient"); assert.equal(result.claims.length, 0); assert.equal(result.evidence.length, 18);
  assert.ok(result.scope.synthesis!.failed.length > 0); assert.match(result.message, /歸納尚未完整完成/);
});

test("tentative source dates cannot silently become confirmed dates", async () => {
  const result = await answerQuestion(input([doc("系統預計於2026年9月1日分階段試用。")]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
    if (data.claims) return { supported: true };
    return { claims: [{ text: "系統自2026年9月1日起分階段試用。", evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(result.status, "insufficient"); assert.equal(result.claims.length, 0);
});

test("UI citation labels are cleaned while source quotations and tentative wording remain intact", async () => {
  const original = "預計9月1日於E1室試用。";
  const result = await answerQuestion(input([doc(original)]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
    if (data.claims) return { supported: true };
    return { claims: [{ text: "預計9月1日於E1室試用（E1）。\n\n> 出處：E1", evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(result.status, "answered"); assert.equal(result.claims[0].text, "預計9月1日於E1室試用。");
  assert.equal(result.evidence[0].quote, original);
});

test("a missing digest item may be repaired only by a complete second pass", async () => {
  const documents = Array.from({ length: 18 }, (_, i) => doc("六月三日截止。" + "完整原文。".repeat(1000), `文件${i}.pdf`));
  const tries = new Map<string, number>();
  const result = await answerQuestion(input(documents), async (_system, data: any) => {
    if (data.sources) return { evidence: data.sources.map((s: any) => ({ sourceId: s.id, startLine: 1, endLine: s.lines.length })) };
    if (data.evidenceToCondense) {
      const id = data.evidenceToCondense[0].id;
      tries.set(id, (tries.get(id) || 0) + 1);
      return { notes: tries.get(id) === 1 ? [] : data.evidenceToCondense.map((e: any) => ({ id: e.id, note: "六月三日截止。" })) };
    }
    if (data.claims) return { supported: true };
    return { claims: [{ text: "六月三日截止。", evidenceIds: [data.evidenceNotes[0].id] }], insufficient: false };
  });
  assert.equal(result.status, "answered"); assert.ok([...tries.values()].every(n => n === 2));
  assert.equal(result.scope.synthesis?.reviewedBatches, result.scope.synthesis?.totalBatches); assert.equal(result.evidence.length, 18);
});

test("five-highlight summaries disclose selection but still review every page and tail", async () => {
  const documents = [doc("完整原文。".repeat(15000) + "最後一頁的重要事項")];
  const seen: string[] = [];
  const result = await answerQuestion({ ...input(documents), question: "請整理成五項重要重點" }, async (system, data: any) => {
    assert.match(system, /最多五組/);
    seen.push(...data.sources.map((s: any) => s.lines.map((l: any) => l.text).join("\n")));
    return { evidence: [] };
  });
  assert.equal(result.scope.reviewedBatches, result.scope.totalBatches);
  assert.ok(seen.some(text => text.includes("最後一頁的重要事項")));
  assert.equal(result.scope.summary?.topicsPerBatch, 5);
  const detail = await answerQuestion(input(documents), async (system) => { assert.doesNotMatch(system, /最多五組/); return { evidence: [] }; });
  assert.equal(detail.scope.summary, undefined);
});

test("calendar calculations cannot be inserted to resolve conflicting source dates", async () => {
  const result = await answerQuestion(input([doc("畢業典禮4/7(六)；頒獎在5/7(六)畢業典禮中。")]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
    if (data.claims) return { supported: true };
    return { claims: [{ text: "按實際曆法4/7為六、5/7為日，所以4/7才正確。", evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(result.status, "insufficient"); assert.deepEqual(result.claims, []);
});

test("internal evidence ids in prose do not replace the UI citation controls", async () => {
  const result = await answerQuestion(input([doc("九月一日截止。")]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
    if (data.claims) return { supported: true };
    return { claims: [{ text: "E1記為九月一日截止。", evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(result.status, "answered"); assert.equal(result.claims[0].text, "原文記為九月一日截止。"); assert.deepEqual(result.claims[0].evidenceIds, ["E1"]);
});

test("date paraphrases preserve day/month order, range endpoints and hyphenated dates", async () => {
  const original = "報告於5/6/2026前交。活動8-9/1/2026；評估4/6–9/6；結業10-7-2026。";
  for (const [text, expected] of [
    ["報告於2026年6月5日前交；活動1月8–9日；評估6月4–9日；結業7月10日。", "answered"],
    ["報告於2026年5月6日前交。", "insufficient"],
    ["結業於7月11日。", "insufficient"],
  ]) {
    const result = await answerQuestion(input([doc(original)]), async (_system, data: any) => {
      if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
      if (data.claims) return { supported: true };
      return { claims: [{ text, evidenceIds: ["E1"] }], insufficient: false };
    });
    assert.equal(result.status, expected, text);
  }
});

test("overview topics are reviewed separately and any rejected topic requires a revised answer", async () => {
  let drafts = 0;
  const reviewed: string[] = [];
  const result = await answerQuestion({ ...input([doc("六年級一般不用回校；表演學生須按通告回校。\n各科提交周年報告。")]), question: "整理五項重點" }, async (_system, data: any) => {
    if (data.sources) return { evidence: [1, 2].map(line => ({ sourceId: data.sources[0].id, startLine: line, endLine: line })) };
    if (data.claims) {
      assert.equal(data.claims.length, 1);
      assert.equal(data.evidence.length, 1);
      reviewed.push(data.claims[0].text);
      return { supported: data.claims[0].text !== "所有六年級不用回校", issues: ["不能省略表演學生的例外"] };
    }
    drafts++;
    return { claims: [{ text: drafts === 1 ? "所有六年級不用回校" : "六年級一般不用回校；表演學生按通告回校", evidenceIds: ["E1"] }, { text: "各科提交周年報告", evidenceIds: ["E2"] }], insufficient: false };
  });
  assert.equal(drafts, 2); assert.equal(reviewed.length, 4);
  assert.equal(result.status, "answered");
  assert.match(result.claims[0].text, /表演學生/);
});

test("a scheduled activity cannot be reported as completed without confirmation in the source", async () => {
  for (const [source, draft, expected] of [
    ["兩位老師將於26/9/2025出席頒獎禮", "兩位老師已出席2025年9月26日頒獎禮", "insufficient"],
    ["兩位老師已於26/9/2025出席頒獎禮", "兩位老師已出席2025年9月26日頒獎禮", "answered"],
    ["兩位老師將於26/9/2025出席頒獎禮", "文件安排兩位老師於2025年9月26日出席頒獎禮", "answered"],
  ]) {
    const result = await answerQuestion(input([doc(source)]), async (_system, data: any) => {
      if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
      if (data.claims) return { supported: true };
      return { claims: [{ text: draft, evidenceIds: ["E1"] }], insufficient: false };
    });
    assert.equal(result.status, expected);
  }
});

test("a filename cannot be used to infer an event date even when another excerpt contains that date", async () => {
  const result = await answerQuestion(input([doc("4/7舉行畢業禮；另一項為5/7。")]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
    if (data.claims) return { supported: true };
    return { claims: [{ text: "配合檔名與上下文可對應至4/7。", evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(result.status, "insufficient");
});

test("a filename year cannot move a March arrangement outside its school year, but explicit historical dates remain valid", async () => {
  for (const [source, draft, expected] of [
    ["下學期交簿日期20/3", "2025年3月20日交簿", "insufficient"],
    ["新學年24/8借用電腦", "2025年8月24日借用電腦", "answered"],
    ["下學期交簿日期20/3", "20/3交簿", "answered"],
    ["上年度於20/3/2025交簿", "上年度於2025年3月20日交簿", "answered"],
    ["敬師日慶典於12/9/2026", "敬師日慶典於2026年9月12日", "answered"],
  ]) {
    const result = await answerQuestion(input([doc(source)]), async (_system, data: any) => {
      if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 1 }] };
      if (data.claims) return { supported: true };
      return { claims: [{ text: draft, evidenceIds: ["E1"] }], insufficient: false };
    });
    assert.equal(result.status, expected, draft);
  }
});

test("an unrelated tentative activity does not make another confirmed date tentative", async () => {
  const result = await answerQuestion(input([doc("面談14/9開始。\n交流團暫定17/9出發。\n暑期活動組別（暫定）。")]), async (_system, data: any) => {
    if (data.sources) return { evidence: [{ sourceId: data.sources[0].id, startLine: 1, endLine: 3 }] };
    if (data.claims) return { supported: true };
    return { claims: [{ text: "面談於14/9開始。", evidenceIds: ["E1"] }], insufficient: false };
  });
  assert.equal(result.status, "answered");
  assert.equal(result.claims[0].text, "面談於14/9開始。");
});

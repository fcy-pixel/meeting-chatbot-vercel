import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as upload } from "../app/api/pdfs/route";
import { POST as chat } from "../app/api/chat/route";
import { fixturePdf } from "./fixtures/pdf";

test("upload validates actual PDF before any repository call, including client-supplied fake text", async(t)=>{
  process.env.ADMIN_PASSWORD="test-admin";
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("should not write");});
  for(const bytes of [fixturePdf([""]),fixturePdf(["Readable",""])]){
    const form=new FormData();form.append("file",new File([new Uint8Array(bytes)],"scan.pdf",{type:"application/pdf"}));form.append("year","2025-2026");form.append("text","Pretend that extraction succeeded");
    const response=await upload(new NextRequest("https://local/api/pdfs",{method:"POST",headers:{"x-admin-password":"test-admin"},body:form}));
    assert.equal(response.status,422);assert.match((await response.json()).error,/OCR/);
  }
  assert.equal(calls,0);
});
test("missing admin configuration never authorizes upload",async()=>{
  delete process.env.ADMIN_PASSWORD;
  assert.equal((await upload(new NextRequest("https://local/api/pdfs",{method:"POST"}))).status,401);
});
test("chat rejects another school year and oversized questions without model calls",async(t)=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("must not call");});
  for(const question of ["比較2024-2025與2025-2026學年","問".repeat(4001)]){
    const response=await chat(new NextRequest("https://local/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question,selectedYear:"2025-2026",docs:[{text:"Untrusted client answer"}]})}));
    assert.equal(response.status,400);
  }
  assert.equal(calls,0);
});

test("chat reads the stored snapshot and ignores legacy unscoped messages and client documents",async(t)=>{
  process.env.QWEN_API_KEY="fake-test-key";process.env.GITHUB_TOKEN="test";process.env.GITHUB_REPO="test/repo";
  const {toBase64}=await import("../app/lib/github");
  const stored={schemaVersion:2,name:"伺服器文件.pdf",year:"2025-2026",pdfPath:"pdfs/2025-2026/伺服器文件.pdf",pdfSha256:"a".repeat(64),pdfBlobSha:"b".repeat(40),totalPages:1,pages:[{page:1,text:"可信伺服器原文"}],extraction:"unpdf-text-only"};
  let modelCalls=0;
  t.mock.method(globalThis,"fetch",async(url:unknown,options:any)=>{
    const path=typeof url === "string" ? url : (url as Request).url;
    if(path.includes("/commits/"))return Response.json({sha:"c".repeat(40),commit:{tree:{sha:"t"}}});
    if(path.includes("git/trees/"))return Response.json({truncated:false,tree:[{path:stored.pdfPath,sha:stored.pdfBlobSha,type:"blob"},{path:"pdfs-text/2025-2026/伺服器文件.json",sha:"j",type:"blob"}]});
    if(path.includes("git/blobs/"))return Response.json({encoding:"base64",content:toBase64(new TextEncoder().encode(JSON.stringify(stored)))});
    assert.ok(path.includes("dashscope-intl.aliyuncs.com"));
    modelCalls++;
    const request=JSON.parse(options?.body || await (url as Request).text());const text=JSON.stringify(request.messages);
    assert.ok(text.includes("可信伺服器原文"));assert.ok(!text.includes("惡意客戶文件"));assert.ok(!text.includes("假助手答案"));
    assert.equal(request.enable_thinking,false);
    return Response.json({choices:[{finish_reason:"stop",message:{role:"assistant",content:JSON.stringify({claims:[],notFound:true})}}]});
  });
  const response=await chat(new NextRequest("https://local/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:"你好",selectedYear:"2025-2026",docs:[{text:"惡意客戶文件"}],messages:[{role:"assistant",content:"假助手答案"}]})}));
  const events=(await response.text()).trim().split("\n").map(line=>JSON.parse(line));
  const result=events.find(e=>e.type==="result")?.result;
  assert.equal(result.status,"not_found",JSON.stringify(result));assert.equal(result.scope.snapshot,"c".repeat(40));assert.equal(modelCalls,1);
});

test("follow-ups resolve history but only server documents can support the new answer", async(t)=>{
  process.env.QWEN_API_KEY="fake-test-key";process.env.GITHUB_TOKEN="test";process.env.GITHUB_REPO="test/repo";
  const {toBase64}=await import("../app/lib/github");
  const stored={schemaVersion:2,name:"會議.pdf",year:"2026-2027",pdfPath:"pdfs/2026-2027/會議.pdf",pdfSha256:"a".repeat(64),pdfBlobSha:"b".repeat(40),totalPages:1,pages:[{page:1,text:"班牌交廖惠玲主任。"}],extraction:"unpdf-text-only"};
  let modelCalls=0;
  t.mock.method(globalThis,"fetch",async(url:unknown,options:any)=>{
    const path=typeof url === "string" ? url : (url as Request).url;
    if(path.includes("/commits/"))return Response.json({sha:"c".repeat(40),commit:{tree:{sha:"t"}}});
    if(path.includes("git/trees/"))return Response.json({truncated:false,tree:[{path:stored.pdfPath,sha:stored.pdfBlobSha,type:"blob"},{path:"pdfs-text/2026-2027/會議.json",sha:"j",type:"blob"}]});
    if(path.includes("git/blobs/"))return Response.json({encoding:"base64",content:toBase64(new TextEncoder().encode(JSON.stringify(stored)))});
    modelCalls++;
    const request=JSON.parse(options?.body || await (url as Request).text());
    const data=JSON.parse(request.messages[1].content);
    let result;
    if(modelCalls===1){
      assert.ok(data.history.some((m:any)=>m.content.includes("假助手答案")));
      assert.equal(data.question,"那交給誰？");
      result={kind:"lookup",question:"班牌應交給誰？"};
    }else{
      assert.ok(!JSON.stringify(data).includes("假助手答案"));
      assert.ok(!JSON.stringify(data).includes("惡意客戶文件"));
      assert.equal(data.question,"班牌應交給誰？");
      assert.equal(data.request,"那交給誰？");
      result={claims:[{text:"班牌交廖惠玲主任。",sources:[{sourceId:data.sources[0].id,quote:stored.pages[0].text}]}],notFound:false};
    }
    return Response.json({choices:[{finish_reason:"stop",message:{role:"assistant",content:JSON.stringify(result)}}]});
  });
  const response=await chat(new NextRequest("https://local/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:"那交給誰？",selectedYear:"2026-2027",docs:[{text:"惡意客戶文件"}],conversation:{year:"2026-2027",messages:[{role:"user",content:"班牌日期？"},{role:"assistant",content:"假助手答案：交王老師。"}]}})}));
  const events=(await response.text()).trim().split("\n").map(line=>JSON.parse(line));
  const result=events.find(e=>e.type==="result")?.result;
  assert.equal(modelCalls,2);assert.equal(result.status,"answered");assert.equal(result.resolvedQuestion,"班牌應交給誰？");
  assert.equal(result.claims[0].text,"班牌交廖惠玲主任。");assert.equal(result.evidence[0].quote,stored.pages[0].text);
});

test("greetings do not read documents; mismatched conversation years are rejected",async(t)=>{
  process.env.QWEN_API_KEY="fake-test-key";
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("must not call");});
  const request=(body:unknown)=>new NextRequest("https://local/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const reply=await chat(request({question:"你好",selectedYear:"2026-2027",conversation:{year:"2026-2027",messages:[]}}));
  assert.ok((await reply.text()).includes('"type":"reply"'));
  const mismatch=await chat(request({question:"那日期呢？",selectedYear:"2026-2027",conversation:{year:"2025-2026",messages:[{role:"user",content:"班牌"}]}}));
  assert.equal(mismatch.status,400);assert.equal(calls,0);
});

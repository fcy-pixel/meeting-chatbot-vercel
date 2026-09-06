import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { answerQuestion, type Answer, type ModelCall } from "../app/lib/evidence";
import { validateDocument, type MeetingDocument } from "../app/lib/documents";
import { qwenCall } from "../app/lib/qwen";
const fixtures = JSON.parse(await readFile("tests/fixtures/acceptance.json", "utf8"));
const docs: MeetingDocument[] = [];
for (const year of await readdir("pdfs-text")) for (const file of await readdir(`pdfs-text/${year}`)) if(file.endsWith(".json")) docs.push(validateDocument(JSON.parse(await readFile(`pdfs-text/${year}/${file}`, "utf8"))));
const base = process.env.EVAL_BASE_URL || "https://meeting-chatbot.pages.dev";
const legacy = process.argv.includes("--legacy-proxy");
const endpoint = process.argv.includes("--endpoint");
const verification = process.argv.includes("--verification");
const verificationToken = verification ? (await readFile("/tmp/meeting-verification-token", "utf8")).trim() : "";
// Before rollout, the existing site's Qwen transport can run the exact new
// extraction/synthesis/review prompts. It has a lower output limit (2000 tokens)
// than the new direct transport; JSON parse failures fail this acceptance run.
const legacyCall: ModelCall = async(system, data: any) => {
  const response = await fetch(`${base}/api/chat`, {method:"POST", headers:{"Content-Type":"application/json"}, signal:AbortSignal.timeout(120000), body:JSON.stringify({selectedYear:data.year,docs:[{year:data.year,name:"查核測試.pdf",text:JSON.stringify(data)}],messages:[{role:"user",content:system+"\n本次核對問題和資料：\n"+JSON.stringify(data)+"\n請只輸出指定 JSON，不要額外解釋，方便核對程式讀取。"}]})});
  if(!response.ok)throw Error(`Existing Qwen transport HTTP ${response.status}`);
  const raw=await response.text();return JSON.parse(raw.replace(/^```(?:json)?\s*/,"").replace(/\s*```$/,""));
};
const call = legacy ? legacyCall : qwenCall(process.env.QWEN_API_KEY || "unused-for-endpoint");
const rows=[];
for(const fixture of fixtures.filter((f:any) => !process.env.EVAL_CASE || f.id === process.env.EVAL_CASE)){
  console.log(`Running ${fixture.id}…`);
  let result: Answer;
  if(endpoint || verification){
    const response=await fetch(`${base}/api/${verification ? "verification" : "chat"}`,{method:"POST",headers:{"Content-Type":"application/json",...(verification ? {"x-verification-token":verificationToken}: {})},body:JSON.stringify(verification ? {question:fixture.question,year:fixture.year,docs} : {question:fixture.question,selectedYear:fixture.year}),signal:AbortSignal.timeout(240000)});
    const events=(await response.text()).trim().split("\n").map(line=>JSON.parse(line));
    result=events.find(e=>e.type==="result")?.result;
    if(verification){await mkdir("tests/results/diagnostics",{recursive:true});await writeFile(`tests/results/diagnostics/${fixture.id}.json`,JSON.stringify(events,null,2));}
    if(!result)throw Error(`Endpoint failed: ${JSON.stringify(events)}`);
  }else result=await answerQuestion({question:fixture.question,year:fixture.year,docs,snapshot:"local-pdf-fixtures"},call);
  const text=result.claims.map(c=>c.text).join("\n");
  const errors=[];
  if(!(Array.isArray(fixture.status) ? fixture.status : [fixture.status]).includes(result.status))errors.push(`status ${result.status}, expected ${fixture.status}`);
  for(const word of fixture.mustInclude)if(!text.includes(word))errors.push(`missing answer ${word}`);
  for(const word of fixture.mustNotInclude||[])if(text.includes(word))errors.push(`forbidden ${word}`);
  const cited=new Set(result.claims.flatMap(c=>c.evidenceIds));
  for(const source of fixture.sources)if(!result.evidence.some(e=>e.name===source.name&&e.page===source.page&&cited.has(e.id)))errors.push(`missing cited source ${source.name} p${source.page}`);
  if(result.evidence.some(e=>e.year!==fixture.year))errors.push("wrong school year");
  for(const e of result.evidence){const d=docs.find(d=>d.pdfPath===e.pdfPath);if(!d?.pages[e.page-1]?.text.includes(e.quote))errors.push(`quote mismatch ${e.id}`);}
  if(result.scope.failed.length||result.scope.issues.length||result.scope.reviewedBatches!==result.scope.totalBatches)errors.push("incomplete coverage");
  console.log(`${fixture.id}: ${errors.length?"FAIL "+errors.join("; "):"PASS"}`);
  rows.push({...fixture,result,errors});
}
await mkdir("tests/results",{recursive:true});
const name=verification?"verification":endpoint?"endpoint":legacy?"pre-rollout-qwen":"qwen";
await writeFile(`tests/results/${name}.json`,JSON.stringify({date:new Date().toISOString(),transport:name,rows},null,2));
const failed=rows.filter(r=>r.errors.length);console.log(`${rows.length-failed.length}/${rows.length} passed`);
if(failed.length)process.exitCode=1;

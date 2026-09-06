import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { answerQuestion, type Answer } from "../app/lib/evidence";
import { validateDocument, type MeetingDocument } from "../app/lib/documents";
import { qwenCall } from "../app/lib/qwen";
const fixtures = JSON.parse(await readFile("tests/fixtures/acceptance.json", "utf8"));
const docs: MeetingDocument[] = [];
for (const year of await readdir("pdfs-text")) for (const file of await readdir(`pdfs-text/${year}`)) if(file.endsWith(".json")) docs.push(validateDocument(JSON.parse(await readFile(`pdfs-text/${year}/${file}`, "utf8"))));
const base = process.env.EVAL_BASE_URL || "https://meeting-chatbot.pages.dev";
const endpoint = process.argv.includes("--endpoint");
if (!endpoint && !process.env.QWEN_API_KEY) throw new Error("Set QWEN_API_KEY or pass --endpoint.");
const call = qwenCall(process.env.QWEN_API_KEY || "unused-for-endpoint");
const rows=[];
for(const fixture of fixtures.filter((f:any) => !process.env.EVAL_CASE || f.id === process.env.EVAL_CASE)){
  console.log(`Running ${fixture.id}…`);
  let result: Answer;
  if(endpoint){
    const response=await fetch(`${base}/api/chat`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question:fixture.question,selectedYear:fixture.year}),signal:AbortSignal.timeout(240000)});
    const events=(await response.text()).trim().split("\n").map(line=>JSON.parse(line));
    result=events.find(e=>e.type==="result")?.result;
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
const name=endpoint?"endpoint":"qwen";
await writeFile(`tests/results/${name}.json`,JSON.stringify({date:new Date().toISOString(),transport:name,rows},null,2));
const failed=rows.filter(r=>r.errors.length);console.log(`${rows.length-failed.length}/${rows.length} passed`);
if(failed.length)process.exitCode=1;

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { extractPdf } from "../app/lib/extractPdf";
import { documentText } from "../app/lib/documents";
async function list(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await list(full));
    else if (/\.pdf$/i.test(entry.name)) files.push(full);
  }
  return files;
}
let failures = 0;
for (const path of await list("pdfs")) {
  try {
    const doc = await extractPdf(new Uint8Array(await readFile(path)), basename(path), path.split("/")[1]);
    const base = path.replace(/^pdfs\//, "pdfs-text/").replace(/\.pdf$/i, "");
    await mkdir(dirname(base), { recursive: true });
    await writeFile(`${base}.json`, JSON.stringify(doc));
    await writeFile(`${base}.txt`, documentText(doc));
    console.log(`${doc.name}: ${doc.totalPages} pages, ${doc.pages.reduce((n, p) => n + p.text.length, 0)} chars`);
  } catch (e) { failures++; console.error(`${path}: ${e instanceof Error ? e.message : e}`); }
}
if (failures) process.exitCode = 1;

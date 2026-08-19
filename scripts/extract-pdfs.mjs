#!/usr/bin/env node
// 將 pdfs/<學年>/*.pdf 的文字內容預抽取到 pdfs-text/<學年>/*.txt
// 這樣 Cloudflare Workers runtime 不需要在請求中解析 PDF（CPU 受限）。
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename, dirname, relative } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

const SRC = "pdfs";
const OUT = "pdfs-text";

async function listPdfs(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await listPdfs(fullPath)));
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      files.push(fullPath);
    }
  }
  return files;
}

await mkdir(OUT, { recursive: true });
const pdfs = await listPdfs(SRC);

for (const pdfPath of pdfs) {
  const buf = await readFile(pdfPath);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  const sourceRelative = relative(SRC, pdfPath);
  const out = join(OUT, dirname(sourceRelative), basename(pdfPath, ".pdf") + ".txt");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, merged ?? "");
  console.log(`✓ ${pdfPath} → ${out} (${merged?.length ?? 0} chars)`);
}
console.log(`Done. ${pdfs.length} files processed.`);

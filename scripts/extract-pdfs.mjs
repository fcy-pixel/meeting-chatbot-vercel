#!/usr/bin/env node
// 將 pdfs/*.pdf 的文字內容預抽取到 pdfs-text/*.txt
// 這樣 Cloudflare Workers runtime 不需要在請求中解析 PDF（CPU 受限）。
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

const SRC = "pdfs";
const OUT = "pdfs-text";

await mkdir(OUT, { recursive: true });
const entries = await readdir(SRC);
const pdfs = entries.filter((n) => n.toLowerCase().endsWith(".pdf"));

for (const name of pdfs) {
  const buf = await readFile(join(SRC, name));
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  const out = join(OUT, basename(name, ".pdf") + ".txt");
  await writeFile(out, merged ?? "");
  console.log(`✓ ${name} → ${out} (${merged?.length ?? 0} chars)`);
}
console.log(`Done. ${pdfs.length} files processed.`);

import { NextRequest, NextResponse } from "next/server";
import { compareSchoolYearsDesc, normalizeSchoolYear, schoolYearFromPath, UNCATEGORIZED_YEAR } from "../../lib/schoolYear";
import { documentText, validFilename } from "../../lib/documents";
import { extractPdf } from "../../lib/extractPdf";
import { commitFiles, readTree } from "../../lib/github";
export const runtime = "edge";
const encoder = new TextEncoder();
function authorized(req: NextRequest) {
  return Boolean(process.env.ADMIN_PASSWORD) && req.headers.get("x-admin-password") === process.env.ADMIN_PASSWORD;
}
export async function GET() {
  try {
    const { entries } = await readTree();
    const files = entries.filter((f) => f.type === "blob" && f.path.startsWith("pdfs/") && /\.pdf$/i.test(f.path))
      .map((f) => ({ name: f.path.split("/").pop(), path: f.path, sha: f.sha, year: schoolYearFromPath(f.path, "pdfs") || UNCATEGORIZED_YEAR }))
      .sort((a, b) => compareSchoolYearsDesc(a.year, b.year) || a.name.localeCompare(b.name, "zh-Hant"));
    return NextResponse.json({ files }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "文件載入失敗。" }, { status: 503 }); }
}
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let document, bytes;
  try {
    const form = await req.formData();
    const file = form.get("file");
    const year = normalizeSchoolYear(form.get("year"));
    if (!(file instanceof File) || !validFilename(file.name) || !year) throw new Error("請提供 PDF 及有效學年。");
    bytes = new Uint8Array(await file.arrayBuffer());
    // Validate the actual PDF on the server before any repository write.
    document = await extractPdf(bytes, file.name, year);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "PDF 抽取失敗，未上載；不會進行 OCR。" }, { status: 422 });
  }
  try {
    const base = `pdfs-text/${document.year}/${document.name.replace(/\.pdf$/i, "")}`;
    const snapshot = await commitFiles([
      { path: document.pdfPath, bytes },
      { path: `${base}.txt`, bytes: encoder.encode(documentText(document)) },
      { path: `${base}.json`, bytes: encoder.encode(JSON.stringify(document)) },
    ], `保存完整會議紀錄及逐頁文字: ${document.name}`);
    return NextResponse.json({ success: true, name: document.name, chars: document.pages.reduce((n, p) => n + p.text.length, 0), pages: document.totalPages, snapshot });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "上載未完成，請重試。" }, { status: 503 }); }
}
export async function DELETE(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { filename, path, year: rawYear } = await req.json();
    const year = normalizeSchoolYear(rawYear);
    if (!validFilename(filename) || !year || path !== `pdfs/${year}/${filename}`) return NextResponse.json({ error: "檔案路徑無效。" }, { status: 400 });
    const base = `pdfs-text/${year}/${filename.replace(/\.pdf$/i, "")}`;
    await commitFiles([path, `${base}.txt`, `${base}.json`].map((path) => ({ path, bytes: null })), `刪除會議紀錄及逐頁文字: ${filename}`);
    return NextResponse.json({ success: true });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "刪除未完成。" }, { status: 503 }); }
}

import { NextRequest, NextResponse } from "next/server";
import { readBlob, readTree } from "../../lib/github";
import { validFilename, validateDocument } from "../../lib/documents";
import { schoolYearFromPath } from "../../lib/schoolYear";
export const runtime = "edge";

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") || "";
  const snapshot = req.nextUrl.searchParams.get("snapshot") || "";
  const page = Number(req.nextUrl.searchParams.get("page") || 1);
  const year = schoolYearFromPath(path, "pdfs");
  if (!/^[a-f0-9]{40}$/.test(snapshot) || !year || path.split("/").length !== 3 || !validFilename(path.split("/").pop()) || !Number.isInteger(page) || page < 1) {
    return NextResponse.json({ error: "來源或頁碼無效。" }, { status: 400 });
  }
  try {
    const tree = await readTree(snapshot);
    const pdf = tree.entries.find(e => e.path === path && e.type === "blob");
    const jsonPath = path.replace(/^pdfs\//, "pdfs-text/").replace(/\.pdf$/i, ".json");
    const json = tree.entries.find(e => e.path === jsonPath && e.type === "blob");
    if (!pdf || !json) return NextResponse.json({ error: "這個版本沒有可讀取的逐頁原文。" }, { status: 404 });
    const doc = validateDocument(JSON.parse(new TextDecoder().decode(await readBlob(json.sha))));
    if (doc.pdfPath !== path || doc.year !== year || doc.pdfBlobSha !== pdf.sha) throw new Error("PDF 與原文版本不一致。");
    if (page > doc.totalPages) return NextResponse.json({ error: "頁碼超出文件範圍。" }, { status: 400 });
    return NextResponse.json({ name: doc.name, year, pdfPath: path, snapshot, totalPages: doc.totalPages, page, text: doc.pages[page - 1].text }, { headers: { "Cache-Control": "private, no-store" } });
  } catch { return NextResponse.json({ error: "原頁文字暫時無法核實，請重試或開啟原 PDF。" }, { status: 503 }); }
}

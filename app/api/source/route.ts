import { NextRequest, NextResponse } from "next/server";
import { readTree, readBlob } from "../../lib/github";
import { validFilename } from "../../lib/documents";
import { schoolYearFromPath } from "../../lib/schoolYear";
export const runtime = "edge";
export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") || "";
  const snapshot = req.nextUrl.searchParams.get("snapshot") || "";
  const name = path.split("/").pop() || "";
  if (!/^[a-f0-9]{40}$/.test(snapshot) || !schoolYearFromPath(path, "pdfs") || path.split("/").length !== 3 || !validFilename(name)) return NextResponse.json({ error: "來源無效" }, { status: 400 });
  try {
    const tree = await readTree(snapshot);
    const entry = tree.entries.find((f) => f.path === path && f.type === "blob");
    if (!entry) return NextResponse.json({ error: "找不到原 PDF" }, { status: 404 });
    return new Response(new Uint8Array(await readBlob(entry.sha)), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return NextResponse.json({ error: "原 PDF 暫時無法讀取，請重試。" }, { status: 503 }); }
}

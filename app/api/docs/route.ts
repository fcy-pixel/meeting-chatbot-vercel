import { NextResponse } from "next/server";
import { loadCorpus } from "../../lib/github";
import { compareSchoolYearsDesc } from "../../lib/schoolYear";
export const runtime = "edge";
export async function GET() {
  try {
    const { docs, issues, snapshot } = await loadCorpus();
    return NextResponse.json({
      docs: docs.map(({ name, year, pdfPath, totalPages }) => ({ name, year, pdfPath, totalPages })),
      issues, snapshot,
      years: Array.from(new Set([...docs, ...issues].map((d) => d.year))).sort(compareSchoolYearsDesc),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "文件載入失敗。" }, { status: 503 });
  }
}

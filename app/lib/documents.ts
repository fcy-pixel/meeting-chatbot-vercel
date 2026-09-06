import { normalizeSchoolYear } from "./schoolYear";

export type Page = { page: number; text: string };
export type MeetingDocument = {
  schemaVersion: 2;
  name: string;
  year: string;
  pdfPath: string;
  pdfSha256: string;
  pdfBlobSha: string;
  totalPages: number;
  pages: Page[];
  extraction: "unpdf-text-only";
};
export type DocumentIssue = { name: string; year: string; reason: string };
export type DocumentSummary = Pick<MeetingDocument, "name" | "year" | "pdfPath" | "totalPages">;

export function validateDeclaredYear(firstPage: string, year: string) {
  // Only an explicit year in the document heading counts, not incidental dates
  // elsewhere or a year guessed from its filename.
  const heading = firstPage.slice(0, 300).match(/(20\d{2})\s*[-–—至/]\s*(20\d{2})\s*(?:年度|學年)/);
  if (heading && normalizeSchoolYear(`${heading[1]}-${heading[2]}`) !== year) {
    throw new Error(`文件標題寫的是 ${heading[1]}-${heading[2]} 學年，與所選 ${year} 不同。請核對學年。`);
  }
}

export function validFilename(name: unknown): name is string {
  return typeof name === "string" && name.length > 4 && name.length <= 240 &&
    !/[\\/\x00-\x1f]/.test(name) && name.toLowerCase().endsWith(".pdf");
}

export function validatePages(value: unknown, totalPages: unknown): Page[] {
  if (!Number.isInteger(totalPages) || Number(totalPages) < 1 || !Array.isArray(value) || value.length !== totalPages) {
    throw new Error("頁數不完整，拒絕上載。請使用可抽取文字的原 PDF；不會進行 OCR。");
  }
  for (let i = 0; i < value.length; i++) {
    const p = value[i];
    if (!p || p.page !== i + 1 || typeof p.text !== "string" || !new RegExp("[\\p{L}\\p{N}]", "u").test(p.text)) {
      throw new Error(`PDF 第 ${i + 1} 頁抽不到可用文字，整份文件不會上載。請提供含文字的 PDF；不會進行 OCR。`);
    }
  }
  return value;
}

export function validateDocument(value: unknown): MeetingDocument {
  const d = value as MeetingDocument;
  if (!d || d.schemaVersion !== 2 || !validFilename(d.name) || !normalizeSchoolYear(d.year) ||
    d.pdfPath !== `pdfs/${d.year}/${d.name}` || d.extraction !== "unpdf-text-only" ||
    !/^[a-f0-9]{64}$/.test(d.pdfSha256) || !/^[a-f0-9]{40}$/.test(d.pdfBlobSha)) {
    throw new Error("文件來源或學年資料不完整，需由原 PDF 重新抽取。");
  }
  validatePages(d.pages, d.totalPages);
  validateDeclaredYear(d.pages[0].text, d.year);
  return d;
}

export function documentText(d: MeetingDocument): string {
  return d.pages.map((p) => p.text).join("\n\f\n");
}

export async function pdfHashes(bytes: Uint8Array): Promise<{ pdfSha256: string; pdfBlobSha: string }> {
  const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const blob = new Uint8Array(prefix.length + bytes.length);
  blob.set(prefix); blob.set(bytes, prefix.length);
  return {
    pdfSha256: hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    pdfBlobSha: hex(await crypto.subtle.digest("SHA-1", blob)),
  };
}

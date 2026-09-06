import { extractText, getDocumentProxy } from "unpdf";
import { MeetingDocument, pdfHashes, validFilename, validatePages, validateDeclaredYear } from "./documents";
import { normalizeSchoolYear } from "./schoolYear";

// No OCR and no client-supplied replacement text. Page numbers are physical PDF
// positions (1-based), never guessed from the printed footer or filename.
export async function extractPdf(bytes: Uint8Array, name: string, year: string): Promise<MeetingDocument> {
  if (!validFilename(name) || normalizeSchoolYear(year) !== year) throw new Error("檔名或學年無效。");
  if (bytes.length > 20 * 1024 * 1024) throw new Error("PDF 超過 20 MB，請先按會議拆成較小文件；系統不會截斷內容。");
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("這不是有效的 PDF。");
  const hashes = await pdfHashes(bytes);
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false });
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    if (!Array.isArray(text)) throw new Error("無法取得可靠頁碼，拒絕上載。");
    const pages = validatePages(text.map((text, i) => ({ page: i + 1, text })), totalPages);
    validateDeclaredYear(pages[0].text, year);
    return { schemaVersion: 2, name, year, pdfPath: `pdfs/${year}/${name}`, ...hashes, totalPages, pages, extraction: "unpdf-text-only" };
  } finally {
    await pdf.destroy();
  }
}

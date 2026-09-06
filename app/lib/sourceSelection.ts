import { validFilename, type DocumentIssue, type MeetingDocument } from "./documents";
import { schoolYearFromPath } from "./schoolYear";

export type AnswerLength = "short" | "standard" | "detailed";
export function validateAnswerLength(value: unknown): AnswerLength {
  if (value === undefined) return "standard";
  if (value !== "short" && value !== "standard" && value !== "detailed") throw new Error("回答長度設定無效。");
  return value;
}

export function validateSelectedSources(value: unknown, year: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error("請至少選擇一份來源文件（最多 1,000 份）。");
  if (value.some(path => typeof path !== "string" || path.split("/").length !== 3 || schoolYearFromPath(path, "pdfs") !== year || !validFilename(path.split("/").pop()))) {
    throw new Error("來源必須是所選學年的 PDF，請重新選擇。");
  }
  if (new Set(value).size !== value.length) throw new Error("來源清單有重複文件，請重新選擇。");
  return value;
}

export function selectCorpus<T extends { docs: MeetingDocument[]; issues: DocumentIssue[]; snapshot: string }>(corpus: T, year: string, paths?: string[]) {
  const available = [...corpus.docs.filter(d => d.year === year).map(d => ({ name: d.name, path: d.pdfPath })),
    ...corpus.issues.filter(i => i.year === year).map(i => ({ name: i.name, path: `pdfs/${i.year}/${i.name}` }))];
  if (paths?.some(path => !available.some(source => source.path === path))) throw new Error("來源文件已變更或不再存在，請重新載入文件後選擇。");
  const selected = paths && new Set(paths);
  return { ...corpus,
    docs: corpus.docs.filter(d => d.year === year && (!selected || selected.has(d.pdfPath))),
    issues: selected ? corpus.issues.filter(i => selected.has(`pdfs/${i.year}/${i.name}`)) : corpus.issues,
    selection: { availableDocuments: available.length, excluded: available.filter(d => selected && !selected.has(d.path)).map(d => d.name) },
  };
}

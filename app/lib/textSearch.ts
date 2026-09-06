import type { Source } from "./evidence";

const CONTEXT_CHARS = 18000;
const noise = ["請問", "根據", "所選", "文件", "會議紀錄", "工作報告", "本學年", "學年", "本校", "請把", "請用", "請列明", "請分別", "不要", "甚麼", "什麼", "幾時", "哪一天", "有何", "如何", "哪些", "哪兩位", "可以", "剛才", "整理成", "表格", "簡短", "概括", "要點", "重點", "以原文為準"];
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const size = (source: Source) => JSON.stringify({ id: source.id, name: source.name, year: source.year, page: source.page, text: source.text }).length;

// Search the already-extracted text locally. No embeddings or model call is
// needed to locate pages, and neither the PDF nor stored text is shortened.
export function searchText(sources: Source[], question: string) {
  const totalChars = sources.reduce((n, s) => n + size(s), 0);
  const full = () => ({ sources, remaining: [] as Source[], method: "full" as const, totalChars });
  const broad = /(?:整理|歸納|總結|概覽|摘要|重點|重要日期|所有|全部|全年)/.test(question) &&
    /(?:所選文件|所有文件|全部文件|全年|整個學年|各份文件|文件重點|文件整理)/.test(question);
  if (totalChars <= CONTEXT_CHARS || broad) return full();

  const terms = new Set<string>();
  let query = question.normalize("NFKC").toLowerCase();
  for (const word of noise) query = query.replaceAll(word, " ");
  for (const phrase of query.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let length = 2; length <= 4; length++) for (let i = 0; i <= phrase.length - length; i++) terms.add(phrase.slice(i, i + length));
  }
  for (const word of query.match(/[a-z][a-z0-9.-]*|\d+(?:\/\d+)+/g) || []) terms.add(word);
  if (!terms.size) return full();

  const text = sources.map(s => normalize(s.text));
  const weights = [...terms].map(term => ({ term, weight: Math.log(1 + sources.length / (1 + text.filter(t => t.includes(term)).length)) * term.length }));
  // An explicit report month narrows the search to those reports, while all
  // other sources remain available for the no-result fallback.
  const months = new Set<number>();
  if (/(?:報告|會議紀錄)/.test(question)) for (const m of question.matchAll(/(?:(\d{1,2})\s*[-–至]\s*)?(\d{1,2})月份/g)) {
    for (let n = Number(m[1] || m[2]); n <= Number(m[2]); n++) months.add(n);
  }
  const matchesMonth = (source: Source) => {
    const m = source.name.match(/^(?:(\d{1,2})[-–至])?(\d{1,2})月份/);
    return !!m && Array.from(months).some(n => n >= Number(m[1] || m[2]) && n <= Number(m[2]));
  };
  const restrictMonths = months.size > 0 && sources.some(matchesMonth);
  const ranked = sources.map((source, index) => ({ source, index, score: weights.reduce((n, t) => n + (text[index].includes(t.term) ? t.weight : 0), 0) }))
    .filter(r => r.score > 0 && (!restrictMonths || matchesMonth(r.source)))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked.length) return full();

  const chosen = new Set<string>();
  let used = 0;
  const add = (source: Source) => {
    if (!chosen.has(source.id) && used + size(source) <= CONTEXT_CHARS) { chosen.add(source.id); used += size(source); }
  };
  // Keep the strongest matches first, then their adjacent page/segment so a
  // heading and a continued table can reach the model together.
  const best = ranked.filter(r => r.score >= ranked[0].score * 0.25).slice(0, 10);
  best.forEach(r => add(r.source));
  for (const { source } of best) {
    for (const adjacent of sources.filter(s => s.pdfPath === source.pdfPath && (Math.abs(s.page - source.page) === 1 || s.page === source.page))) add(adjacent);
  }
  if (!chosen.size || chosen.size === sources.length) return full();
  return { sources: sources.filter(s => chosen.has(s.id)), remaining: sources.filter(s => !chosen.has(s.id)), method: "search" as const, totalChars };
}

export function sourceCharacters(sources: Source[]) { return sources.reduce((n, s) => n + size(s), 0); }

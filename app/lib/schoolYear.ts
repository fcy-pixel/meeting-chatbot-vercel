export const UNCATEGORIZED_YEAR = "未分類";

const SCHOOL_YEAR_PATTERN = /^(20\d{2})-(20\d{2})$/;

export function normalizeSchoolYear(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[–—至]/g, "-").replace(/\s+/g, "");
  const match = normalized.match(SCHOOL_YEAR_PATTERN);
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end !== start + 1) return null;
  return `${start}-${end}`;
}

export function schoolYearFromPath(path: string, root: string): string | null {
  const parts = path.split("/");
  if (parts[0] !== root || parts.length < 3) return null;
  return normalizeSchoolYear(parts[1]);
}

export function inferSchoolYear(name: string, text = ""): string | null {
  const sample = `${name}\n${text.slice(0, 8000)}`;
  const match = sample.match(/(20\d{2})\s*[-–—至]\s*(20\d{2})\s*(?:年度|學年)?/);
  if (!match) return null;
  return normalizeSchoolYear(`${match[1]}-${match[2]}`);
}

export function compareSchoolYearsDesc(a: string, b: string): number {
  if (a === UNCATEGORIZED_YEAR) return 1;
  if (b === UNCATEGORIZED_YEAR) return -1;
  return b.localeCompare(a);
}

export function currentSchoolYear(now = new Date()): string {
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 7 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

export function suggestedSchoolYears(count = 8, now = new Date()): string[] {
  const current = currentSchoolYear(now);
  const start = Number(current.slice(0, 4));
  return Array.from({ length: count }, (_, index) => {
    const year = start - index;
    return `${year}-${year + 1}`;
  });
}

export function schoolYearLabel(year: string): string {
  return year === UNCATEGORIZED_YEAR ? year : `${year} 學年`;
}

import { NextResponse } from "next/server";
import {
  compareSchoolYearsDesc,
  inferSchoolYear,
  schoolYearFromPath,
  UNCATEGORIZED_YEAR,
} from "../../lib/schoolYear";

export const runtime = "edge";

// 從 GitHub contents API 直接讀取 pdfs-text/*.txt 的 base64 內容，
// 避免 raw.githubusercontent.com 的 CDN 快取造成新檔案不立即出現。
function decodeBase64Utf8(b64: string): string {
  const cleaned = b64.replace(/\s+/g, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

type GithubItem = {
  name: string;
  path: string;
  type: "file" | "dir";
};

function encodeGithubPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function listFilesRecursively(
  repo: string,
  root: string,
  headers: Record<string, string>
): Promise<GithubItem[]> {
  const result: GithubItem[] = [];
  const pending = [root];

  while (pending.length) {
    const path = pending.pop()!;
    const url = `https://api.github.com/repos/${repo}/contents/${encodeGithubPath(path)}`;
    const resp = await fetch(url, { headers });
    if (resp.status === 404) continue;
    if (!resp.ok) throw new Error(`Failed to list ${path}`);

    const items = (await resp.json()) as GithubItem[];
    for (const item of Array.isArray(items) ? items : []) {
      if (item.type === "dir") pending.push(item.path);
      if (item.type === "file") result.push(item);
    }
  }

  return result;
}

export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "GitHub not configured" }, { status: 500 });
  }

  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "meeting-chatbot",
  };

  let txtFiles: GithubItem[];
  try {
    txtFiles = (await listFilesRecursively(repo, "pdfs-text", headers)).filter((f) =>
      f.name.toLowerCase().endsWith(".txt")
    );
  } catch {
    return NextResponse.json({ error: "Failed to list files" }, { status: 500 });
  }

  const docs: { name: string; modified: string; text: string; year: string }[] = [];

  await Promise.all(
    txtFiles.map(async (f) => {
      try {
        const fileUrl = `https://api.github.com/repos/${repo}/contents/${encodeGithubPath(f.path)}`;
        const r = await fetch(fileUrl, { headers });
        if (!r.ok) return;
        const data = (await r.json()) as { content?: string; encoding?: string };
        let text = "";
        if (data.content && data.encoding === "base64") {
          text = decodeBase64Utf8(data.content);
        }
        if (text.trim()) {
          const year =
            schoolYearFromPath(f.path, "pdfs-text") ||
            inferSchoolYear(f.name, text) ||
            UNCATEGORIZED_YEAR;
          docs.push({
            name: f.name.replace(/\.txt$/i, ".pdf"),
            modified: "",
            text,
            year,
          });
        }
      } catch (e) {
        docs.push({
          name: f.name,
          modified: "",
          text: `[無法讀取此檔案: ${e instanceof Error ? e.message : String(e)}]`,
          year: schoolYearFromPath(f.path, "pdfs-text") || UNCATEGORIZED_YEAR,
        });
      }
    })
  );

  docs.sort((a, b) =>
    compareSchoolYearsDesc(a.year, b.year) || a.name.localeCompare(b.name, "zh-Hant")
  );
  const years = Array.from(new Set(docs.map((doc) => doc.year))).sort(
    compareSchoolYearsDesc
  );

  return NextResponse.json({ docs, years });
}

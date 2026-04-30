import { NextResponse } from "next/server";

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

  const listUrl = `https://api.github.com/repos/${repo}/contents/pdfs-text`;
  const resp = await fetch(listUrl, { headers });
  if (resp.status === 404) {
    return NextResponse.json({ docs: [] });
  }
  if (!resp.ok) {
    return NextResponse.json({ error: "Failed to list files" }, { status: 500 });
  }

  const items = (await resp.json()) as { name: string; path: string }[];
  const txtFiles = (Array.isArray(items) ? items : []).filter((f) =>
    f.name.toLowerCase().endsWith(".txt")
  );

  const docs: { name: string; modified: string; text: string }[] = [];

  await Promise.all(
    txtFiles.map(async (f) => {
      try {
        const fileUrl = `https://api.github.com/repos/${repo}/contents/${encodeURI(f.path)}`;
        const r = await fetch(fileUrl, { headers });
        if (!r.ok) return;
        const data = (await r.json()) as { content?: string; encoding?: string };
        let text = "";
        if (data.content && data.encoding === "base64") {
          text = decodeBase64Utf8(data.content);
        }
        if (text.trim()) {
          docs.push({
            name: f.name.replace(/\.txt$/i, ".pdf"),
            modified: "",
            text,
          });
        }
      } catch (e) {
        docs.push({
          name: f.name,
          modified: "",
          text: `[無法讀取此檔案: ${e instanceof Error ? e.message : String(e)}]`,
        });
      }
    })
  );

  return NextResponse.json({ docs });
}

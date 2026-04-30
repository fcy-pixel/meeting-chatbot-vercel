import { NextResponse } from "next/server";

export const runtime = "edge";

// Load all pre-extracted PDF texts (pdfs-text/*.txt) from GitHub for the chat context.
// 文字是在本機透過 `npm run extract` 預先抽取，避免 Cloudflare Workers 在請求中解析 PDF
// 而觸發 CPU 限制。
export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "GitHub not configured" }, { status: 500 });
  }

  const url = `https://api.github.com/repos/${repo}/contents/pdfs-text`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "meeting-chatbot",
  };

  const resp = await fetch(url, { headers });
  if (resp.status === 404) {
    return NextResponse.json({ docs: [] });
  }
  if (!resp.ok) {
    return NextResponse.json({ error: "Failed to list files" }, { status: 500 });
  }

  const items = (await resp.json()) as { name: string; download_url: string }[];
  const txtFiles = (Array.isArray(items) ? items : []).filter((f) =>
    f.name.toLowerCase().endsWith(".txt")
  );

  const docs: { name: string; modified: string; text: string }[] = [];

  await Promise.all(
    txtFiles.map(async (f) => {
      try {
        const dlResp = await fetch(f.download_url);
        if (!dlResp.ok) return;
        const text = await dlResp.text();
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

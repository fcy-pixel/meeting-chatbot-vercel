import { NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";

export const runtime = "edge";

// Load all PDF texts from GitHub for the chat context
export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "GitHub not configured" }, { status: 500 });
  }

  const url = `https://api.github.com/repos/${repo}/contents/pdfs`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "meeting-chatbot",
  };

  const resp = await fetch(url, { headers, cache: "no-store" });
  if (resp.status === 404) {
    return NextResponse.json({ docs: [] });
  }
  if (!resp.ok) {
    return NextResponse.json({ error: "Failed to list files" }, { status: 500 });
  }

  const items = await resp.json();
  const pdfFiles = (Array.isArray(items) ? items : []).filter((f: { name: string }) =>
    f.name.toLowerCase().endsWith(".pdf")
  );

  const docs: { name: string; modified: string; text: string }[] = [];

  for (const f of pdfFiles as { name: string; download_url: string }[]) {
    try {
      const dlResp = await fetch(f.download_url, { cache: "no-store" });
      if (!dlResp.ok) continue;
      const arrayBuffer = await dlResp.arrayBuffer();

      const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
      const { text } = await extractText(pdf, { mergePages: true });
      const merged = Array.isArray(text) ? text.join("\n") : text;

      if (merged.trim()) {
        docs.push({
          name: f.name,
          modified: "",
          text: merged,
        });
      }
    } catch (e) {
      docs.push({
        name: f.name,
        modified: "",
        text: `[無法讀取此檔案: ${e instanceof Error ? e.message : String(e)}]`,
      });
    }
  }

  return NextResponse.json({ docs });
}

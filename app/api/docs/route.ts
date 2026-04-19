import { NextResponse } from "next/server";

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
  };

  const resp = await fetch(url, { headers, cache: "no-store" });
  if (resp.status === 404) {
    return NextResponse.json({ docs: [] });
  }
  if (!resp.ok) {
    return NextResponse.json({ error: "Failed to list files" }, { status: 500 });
  }

  const items = await resp.json();
  const pdfFiles = (Array.isArray(items) ? items : []).filter((f: any) =>
    f.name.toLowerCase().endsWith(".pdf")
  );

  // Use dynamic import for pdf-parse (CommonJS module)
  const pdfParse = (await import("pdf-parse")).default;

  const docs: { name: string; modified: string; text: string }[] = [];

  for (const f of pdfFiles) {
    try {
      // Download raw PDF bytes
      const dlResp = await fetch(f.download_url, { cache: "no-store" });
      if (!dlResp.ok) continue;
      const arrayBuffer = await dlResp.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const parsed = await pdfParse(buffer);
      if (parsed.text.trim()) {
        docs.push({
          name: f.name,
          modified: "",
          text: parsed.text,
        });
      }
    } catch (e) {
      docs.push({
        name: f.name,
        modified: "",
        text: `[無法讀取此檔案: ${e}]`,
      });
    }
  }

  return NextResponse.json({ docs });
}

import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

function githubHeaders(token: string) {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "meeting-chatbot",
  };
}

// Convert Uint8Array to base64 string (Edge-compatible, no Buffer)
function toBase64(u8: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    const slice = u8.subarray(i, i + chunk);
    let part = "";
    for (let j = 0; j < slice.length; j++) {
      part += String.fromCharCode(slice[j]);
    }
    s += part;
  }
  return btoa(s);
}

function strToBase64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

async function githubGetSha(
  url: string,
  headers: Record<string, string>
): Promise<string | undefined> {
  const r = await fetch(url, { headers });
  if (!r.ok) return undefined;
  const data = await r.json();
  return data.sha as string | undefined;
}

async function githubPutFile(
  url: string,
  headers: Record<string, string>,
  message: string,
  base64Content: string
): Promise<Response> {
  const sha = await githubGetSha(url, headers);
  const payload: { message: string; content: string; branch: string; sha?: string } = {
    message,
    content: base64Content,
    branch: "main",
  };
  if (sha) payload.sha = sha;
  return fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function githubDeleteFile(
  url: string,
  headers: Record<string, string>,
  message: string
): Promise<Response | null> {
  const sha = await githubGetSha(url, headers);
  if (!sha) return null;
  return fetch(url, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: "main" }),
  });
}

// GET: list PDFs from GitHub repo pdfs/ folder
export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "GitHub not configured" }, { status: 500 });
  }

  const url = `https://api.github.com/repos/${repo}/contents/pdfs`;
  const resp = await fetch(url, { headers: githubHeaders(token) });

  if (resp.status === 404) {
    return NextResponse.json({ files: [] });
  }
  if (!resp.ok) {
    return NextResponse.json({ error: "Failed to list files" }, { status: 500 });
  }

  const items = await resp.json();
  const files = (Array.isArray(items) ? items : [])
    .filter((f: { name: string }) => f.name.toLowerCase().endsWith(".pdf"))
    .map((f: { name: string; sha: string; download_url: string }) => ({
      name: f.name,
      sha: f.sha,
      download_url: f.download_url,
    }));

  return NextResponse.json({ files });
}

// POST: upload PDF to GitHub, extract text, and commit .txt alongside
export async function POST(req: NextRequest) {
  const password = req.headers.get("x-admin-password");
  if (password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "GitHub not configured" }, { status: 500 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const providedText = (formData.get("text") as string | null) ?? "";
  if (!file) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const u8 = new Uint8Array(arrayBuffer);
  const base64Pdf = toBase64(u8);
  const filename = file.name;
  const baseName = filename.replace(/\.pdf$/i, "");

  const headers = githubHeaders(token);
  const pdfUrl = `https://api.github.com/repos/${repo}/contents/pdfs/${encodeURIComponent(filename)}`;
  const txtUrl = `https://api.github.com/repos/${repo}/contents/pdfs-text/${encodeURIComponent(baseName + ".txt")}`;

  // 1) Upload PDF
  const putPdf = await githubPutFile(pdfUrl, headers, `上傳會議紀錄: ${filename}`, base64Pdf);
  if (!putPdf.ok) {
    const err = await putPdf.text();
    return NextResponse.json({ error: `Upload failed: ${err}` }, { status: 500 });
  }

  // 2) 客戶端已抽取的文字直接 commit；不在 Edge runtime 解析 PDF（避開 CPU 限制）
  const extractedText = providedText ?? "";
  const base64Txt = strToBase64(extractedText);
  const putTxt = await githubPutFile(
    txtUrl,
    headers,
    `抽取會議紀錄文字: ${baseName}.txt`,
    base64Txt
  );
  if (!putTxt.ok) {
    const err = await putTxt.text();
    return NextResponse.json(
      { success: true, name: filename, warning: `文字檔上傳失敗: ${err}` },
      { status: 200 }
    );
  }

  return NextResponse.json({
    success: true,
    name: filename,
    chars: extractedText.length,
  });
}

// DELETE: delete PDF and its .txt from GitHub
export async function DELETE(req: NextRequest) {
  const password = req.headers.get("x-admin-password");
  if (password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "GitHub not configured" }, { status: 500 });
  }

  const { filename } = await req.json();
  if (!filename) {
    return NextResponse.json({ error: "filename required" }, { status: 400 });
  }
  const baseName = filename.replace(/\.pdf$/i, "");

  const headers = githubHeaders(token);
  const pdfUrl = `https://api.github.com/repos/${repo}/contents/pdfs/${encodeURIComponent(filename)}`;
  const txtUrl = `https://api.github.com/repos/${repo}/contents/pdfs-text/${encodeURIComponent(baseName + ".txt")}`;

  const delPdf = await githubDeleteFile(pdfUrl, headers, `刪除會議紀錄: ${filename}`);
  if (!delPdf) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  if (!delPdf.ok) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }

  // Best-effort: delete .txt if exists
  await githubDeleteFile(txtUrl, headers, `刪除會議紀錄文字: ${baseName}.txt`);

  return NextResponse.json({ success: true });
}

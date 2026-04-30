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

// POST: upload PDF to GitHub
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
  if (!file) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const base64Content = toBase64(new Uint8Array(arrayBuffer));
  const filename = file.name;

  const url = `https://api.github.com/repos/${repo}/contents/pdfs/${encodeURIComponent(filename)}`;
  const headers = githubHeaders(token);

  // Check if exists (need sha for update)
  const existing = await fetch(url, { headers });
  let sha: string | undefined;
  if (existing.ok) {
    const data = await existing.json();
    sha = data.sha;
  }

  const payload: { message: string; content: string; branch: string; sha?: string } = {
    message: `上傳會議紀錄: ${filename}`,
    content: base64Content,
    branch: "main",
  };
  if (sha) payload.sha = sha;

  const putResp = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!putResp.ok) {
    const err = await putResp.text();
    return NextResponse.json({ error: `Upload failed: ${err}` }, { status: 500 });
  }

  return NextResponse.json({ success: true, name: filename });
}

// DELETE: delete PDF from GitHub
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

  const url = `https://api.github.com/repos/${repo}/contents/pdfs/${encodeURIComponent(filename)}`;
  const headers = githubHeaders(token);

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  const { sha } = await resp.json();

  const delResp = await fetch(url, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `刪除會議紀錄: ${filename}`,
      sha,
      branch: "main",
    }),
  });

  if (!delResp.ok) {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

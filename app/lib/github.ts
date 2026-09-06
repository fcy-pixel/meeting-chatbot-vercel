import { DocumentIssue, MeetingDocument, validateDocument } from "./documents";
import { schoolYearFromPath, UNCATEGORIZED_YEAR } from "./schoolYear";

export type TreeEntry = { path: string; sha: string; type: string };
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192)));
  return btoa(binary);
}
export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/\s/g, "")), (c) => c.charCodeAt(0));
}
export async function github<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const { GITHUB_TOKEN: token, GITHUB_REPO: repo } = process.env;
  if (!token || !repo) throw new Error("文件庫尚未設定。");
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    method, cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "meeting-chatbot", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(response.status === 422 || response.status === 409 ? "文件庫已更新，請重新載入後再試。" : `文件庫讀寫失敗（${response.status}），未能完成操作。`);
  return response.json() as Promise<T>;
}
export async function readTree(ref = process.env.DOCUMENTS_REF || "main") {
  const commit = await github<{ sha: string; commit: { tree: { sha: string } } }>(`commits/${encodeURIComponent(ref)}`);
  const tree = await github<{ tree: TreeEntry[]; truncated: boolean }>(`git/trees/${commit.commit.tree.sha}?recursive=1`);
  // Never treat a truncated directory listing as the complete corpus.
  if (tree.truncated) throw new Error("文件清單超出讀取限制，無法確認完整範圍；查詢已停止。");
  return { snapshot: commit.sha, treeSha: commit.commit.tree.sha, entries: tree.tree };
}
export async function readBlob(sha: string) {
  const blob = await github<{ content: string; encoding: string }>(`git/blobs/${sha}`);
  if (blob.encoding !== "base64" || !blob.content) throw new Error("文件內容未完整讀取。");
  return decodeBase64(blob.content);
}
export async function loadCorpus(year?: string) {
  const tree = await readTree();
  const docs: MeetingDocument[] = [];
  const issues: DocumentIssue[] = [];
  const pdfs = tree.entries.filter((entry) => entry.type === "blob" && entry.path.startsWith("pdfs/") && /\.pdf$/i.test(entry.path));
  for (let i = 0; i < pdfs.length; i += 4) {
    await Promise.all(pdfs.slice(i, i + 4).map(async (pdf) => {
      const docYear = schoolYearFromPath(pdf.path, "pdfs") || UNCATEGORIZED_YEAR;
      if (year && docYear !== year && docYear !== UNCATEGORIZED_YEAR) return;
      const name = pdf.path.split("/").pop()!;
      const jsonPath = pdf.path.replace(/^pdfs\//, "pdfs-text/").replace(/\.pdf$/i, ".json");
      const entry = tree.entries.find((entry) => entry.path === jsonPath);
      try {
        if (!entry) throw new Error("舊文字檔沒有可靠頁碼，需由原 PDF 重新抽取後才可查詢。");
        const doc = validateDocument(JSON.parse(new TextDecoder().decode(await readBlob(entry.sha))));
        if (doc.pdfPath !== pdf.path || doc.year !== docYear || doc.pdfBlobSha !== pdf.sha) throw new Error("PDF 與逐頁文字版本不一致，需重新抽取。");
        docs.push(doc);
      } catch (e) {
        issues.push({ name, year: docYear, reason: e instanceof Error ? e.message : "文件讀取失敗。" });
      }
    }));
  }
  docs.sort((a, b) => b.year.localeCompare(a.year) || a.name.localeCompare(b.name, "zh-Hant"));
  return { docs, issues, snapshot: tree.snapshot };
}

// One commit/ref update publishes PDF + full text + page metadata together.
// A concurrent update fails without changing the branch; never force-push.
export async function commitFiles(changes: { path: string; bytes: Uint8Array | null }[], message: string) {
  const base = await readTree("main");
  const entries = [];
  for (const change of changes) {
    if (change.bytes === null) {
      if (base.entries.some((entry) => entry.path === change.path)) entries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
    } else {
      const blob = await github<{ sha: string }>("git/blobs", "POST", { content: toBase64(change.bytes), encoding: "base64" });
      entries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
    }
  }
  const tree = await github<{ sha: string }>("git/trees", "POST", { base_tree: base.treeSha, tree: entries });
  const commit = await github<{ sha: string }>("git/commits", "POST", { message, tree: tree.sha, parents: [base.snapshot] });
  await github("git/refs/heads/main", "PATCH", { sha: commit.sha, force: false });
  return commit.sha;
}

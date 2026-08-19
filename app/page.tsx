"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  compareSchoolYearsDesc,
  currentSchoolYear,
  schoolYearLabel,
  suggestedSchoolYears,
  UNCATEGORIZED_YEAR,
} from "./lib/schoolYear";

type Message = { role: "user" | "assistant"; content: string };
type PdfFile = {
  name: string;
  sha: string;
  download_url: string;
  path: string;
  year: string;
};
type Doc = { name: string; modified: string; text: string; year: string };

export default function Home() {
  const [mode, setMode] = useState<"chat" | "admin">("chat");
  const [adminAuth, setAdminAuth] = useState(false);
  const [adminPwd, setAdminPwd] = useState("");
  const [authError, setAuthError] = useState("");

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [selectedYear, setSelectedYear] = useState(currentSchoolYear());

  // Admin state
  const [files, setFiles] = useState<PdfFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadYear, setUploadYear] = useState(currentSchoolYear());
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const availableYears = useMemo(
    () =>
      Array.from(new Set((docs || []).map((doc) => doc.year)))
        .filter((year) => year !== UNCATEGORIZED_YEAR)
        .sort(compareSchoolYearsDesc),
    [docs]
  );

  const selectedDocs = useMemo(
    () => (docs || []).filter((doc) => doc.year === selectedYear),
    [docs, selectedYear]
  );

  const adminYearOptions = useMemo(
    () =>
      Array.from(new Set([
        ...suggestedSchoolYears(),
        ...availableYears,
        ...files.map((file) => file.year),
      ]))
        .filter((year) => year !== UNCATEGORIZED_YEAR)
        .sort(compareSchoolYearsDesc),
    [availableYears, files]
  );

  const filesByYear = useMemo(() => {
    const grouped = new Map<string, PdfFile[]>();
    for (const file of files) {
      const group = grouped.get(file.year) || [];
      group.push(file);
      grouped.set(file.year, group);
    }
    return Array.from(grouped.entries()).sort(([a], [b]) =>
      compareSchoolYearsDesc(a, b)
    );
  }, [files]);

  // Load docs on mount
  useEffect(() => {
    loadDocs();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 2500);
      return () => clearTimeout(t);
    }
  }, [toast]);

  async function loadDocs() {
    setDocsLoading(true);
    try {
      const resp = await fetch("/api/docs");
      const data = await resp.json();
      const loadedDocs: Doc[] = data.docs || [];
      const loadedYears: string[] = (data.years || [])
        .filter((year: string) => year !== UNCATEGORIZED_YEAR)
        .sort(compareSchoolYearsDesc);
      setDocs(loadedDocs);
      setSelectedYear((current) =>
        loadedYears.includes(current) ? current : loadedYears[0] || current
      );
    } catch {
      setDocs([]);
    }
    setDocsLoading(false);
  }

  async function loadFiles() {
    try {
      const resp = await fetch("/api/pdfs");
      const data = await resp.json();
      setFiles(data.files || []);
    } catch {
      setFiles([]);
    }
  }

  async function handleAdminLogin() {
    setAuthError("");
    try {
      const resp = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPwd }),
      });
      if (resp.ok) {
        setAdminAuth(true);
        loadFiles();
      } else {
        setAuthError("密碼錯誤");
      }
    } catch {
      setAuthError("驗證失敗");
    }
  }

  async function handleSend() {
    if (!input.trim() || sending || selectedDocs.length === 0) return;

    const userMsg: Message = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    const withPlaceholder: Message[] = [...newMessages, { role: "assistant", content: "" }];
    setMessages(withPlaceholder);
    setInput("");
    setSending(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages,
          docs: selectedDocs,
          selectedYear,
        }),
      });

      if (!resp.ok || !resp.body) {
        throw new Error("回覆失敗");
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullContent += decoder.decode(value, { stream: true });
        setMessages([...newMessages, { role: "assistant", content: fullContent }]);
      }
    } catch {
      setMessages([
        ...newMessages,
        { role: "assistant", content: "網絡錯誤，請重試。" },
      ]);
    }
    setSending(false);
  }

  async function extractPdfTextInBrowser(file: File): Promise<string> {
    // 動態載入 unpdf，避免 SSR / 首屏體積問題
    const { extractText, getDocumentProxy } = await import("unpdf");
    const buf = await file.arrayBuffer();
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : (text ?? "");
  }

  async function handleUpload() {
    const fileInput = fileInputRef.current;
    if (!fileInput?.files?.length) return;
    setUploading(true);

    for (const file of Array.from(fileInput.files)) {
      try {
        // 1) 先在瀏覽器抽取文字（避免 Cloudflare Workers CPU 限制）
        let text = "";
        try {
          text = await extractPdfTextInBrowser(file);
        } catch (e) {
          showToast(
            `文字抽取失敗，仍會上傳 PDF：${file.name}`,
            "error"
          );
          console.error(e);
        }

        // 2) 將 PDF + 已抽好的文字一起送上 server
        const formData = new FormData();
        formData.append("file", file);
        formData.append("text", text);
        formData.append("year", uploadYear);

        const resp = await fetch("/api/pdfs", {
          method: "POST",
          headers: { "x-admin-password": adminPwd },
          body: formData,
        });
        if (resp.ok) {
          showToast(
            `✅ 已上傳至 ${uploadYear} 學年：${file.name}（${text.length} 字）`,
            "success"
          );
        } else {
          showToast(`上傳失敗：${file.name}`, "error");
        }
      } catch {
        showToast(`上傳失敗：${file.name}`, "error");
      }
    }

    fileInput.value = "";
    setUploading(false);
    loadFiles();
    loadDocs();
  }

  async function handleDelete(file: PdfFile) {
    if (!confirm(`確定刪除 ${file.year} 學年的 ${file.name}？`)) return;
    try {
      const resp = await fetch("/api/pdfs", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": adminPwd,
        },
        body: JSON.stringify({
          filename: file.name,
          path: file.path,
          year: file.year,
        }),
      });
      if (resp.ok) {
        showToast(`已刪除：${file.name}`, "success");
        loadFiles();
        loadDocs();
      } else {
        showToast("刪除失敗", "error");
      }
    } catch {
      showToast("刪除失敗", "error");
    }
  }

  function showToast(msg: string, type: "success" | "error") {
    setToast({ msg, type });
  }

  function switchToChat() {
    setMode("chat");
  }

  function switchToAdmin() {
    setMode("admin");
    if (adminAuth) loadFiles();
  }

  function handleYearChange(year: string) {
    if (year === selectedYear) return;
    setSelectedYear(year);
    setMessages([]);
    setInput("");
  }

  return (
    <div className="app">
      {/* Toast */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>{toast.msg}</div>
      )}

      {/* Sidebar */}
      <aside className="sidebar">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src="/logo.png" alt="基慈小學" style={{ width: 48, height: 48 }} />
          <div>
            <h2 style={{ margin: 0 }}>中華基督教會基慈小學</h2>
            <p className="subtitle">校務會議紀錄查詢 Powered by Qwen AI</p>
          </div>
        </div>

        <hr className="divider" />

        <div className="mode-toggle">
          <button className={mode === "chat" ? "active" : ""} onClick={switchToChat}>
            💬 聊天
          </button>
          <button className={mode === "admin" ? "active" : ""} onClick={switchToAdmin}>
            🔧 管理員
          </button>
        </div>

        {mode === "chat" && (
          <div className="year-picker sidebar-year-picker">
            <label htmlFor="sidebar-school-year">查詢學年</label>
            <select
              id="sidebar-school-year"
              value={selectedYear}
              onChange={(event) => handleYearChange(event.target.value)}
              disabled={availableYears.length === 0}
            >
              {availableYears.length === 0 ? (
                <option value={selectedYear}>暫無學年資料</option>
              ) : (
                availableYears.map((year) => (
                  <option key={year} value={year}>
                    {schoolYearLabel(year)}
                  </option>
                ))
              )}
            </select>
            <p>切換學年會開始新的對話，答案只會引用該學年的紀錄。</p>
          </div>
        )}

        {mode === "admin" && !adminAuth && (
          <div>
            <label>管理員密碼</label>
            <input
              type="password"
              value={adminPwd}
              onChange={(e) => setAdminPwd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdminLogin()}
              placeholder="輸入密碼"
            />
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={handleAdminLogin}>
              登入
            </button>
            {authError && <p style={{ color: "var(--danger)", fontSize: "0.82rem", marginTop: 4 }}>{authError}</p>}
          </div>
        )}

        <hr className="divider" />

        <button className="btn btn-primary" onClick={() => { loadDocs(); if (adminAuth) loadFiles(); }}>
          🔄 重新載入文件
        </button>

        {docs && (
          <div className="doc-list">
            <strong>
              📄 {schoolYearLabel(selectedYear)}：{selectedDocs.length} 份文件
            </strong>
            {selectedDocs.map((d) => (
              <div key={`${d.year}-${d.name}`} style={{ padding: "2px 0" }}>
                • {d.name}
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Main content */}
      <div className="main">
        {mode === "chat" ? (
          <>
            <div className="header">
              <div className="header-content">
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <img src="/logo.png" alt="基慈小學" style={{ width: 40, height: 40 }} />
                  <div>
                    <h1>校務會議紀錄查詢</h1>
                    <p>
                      目前只查詢 {schoolYearLabel(selectedYear)} 的會議紀錄
                    </p>
                  </div>
                </div>
                <div className="active-year-badge">📅 {schoolYearLabel(selectedYear)}</div>
              </div>
            </div>

            <div className="mobile-year-picker">
              <label htmlFor="mobile-school-year">查詢學年</label>
              <select
                id="mobile-school-year"
                value={selectedYear}
                onChange={(event) => handleYearChange(event.target.value)}
                disabled={availableYears.length === 0}
              >
                {availableYears.length === 0 ? (
                  <option value={selectedYear}>暫無學年資料</option>
                ) : (
                  availableYears.map((year) => (
                    <option key={year} value={year}>
                      {schoolYearLabel(year)}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="messages">
              {docsLoading && (
                <div style={{ textAlign: "center", color: "var(--text-light)", padding: 40 }}>
                  正在載入會議紀錄<span className="loading-dots"></span>
                </div>
              )}

              {!docsLoading && docs && selectedDocs.length === 0 && (
                <div style={{ textAlign: "center", color: "var(--text-light)", padding: 40 }}>
                  {schoolYearLabel(selectedYear)} 目前沒有會議紀錄，請管理員上傳 PDF。
                </div>
              )}

              {messages.length === 0 && selectedDocs.length > 0 && (
                <div style={{ textAlign: "center", color: "var(--text-light)", padding: 40 }}>
                  已載入 {schoolYearLabel(selectedYear)} 的 {selectedDocs.length} 份會議紀錄，
                  請輸入問題開始查詢。
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-avatar">{msg.role === "user" ? "👤" : "🤖"}</div>
                  <div className="message-content">
                    {msg.role === "assistant" && msg.content === "" ? (
                      <>思考中<span className="loading-dots"></span></>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder={`請輸入關於 ${selectedYear} 學年的問題`}
                disabled={sending || selectedDocs.length === 0}
              />
              <button
                onClick={handleSend}
                disabled={sending || !input.trim() || selectedDocs.length === 0}
              >
                {sending ? "發送中..." : "發送"}
              </button>
            </div>
          </>
        ) : (
          <div className="admin-panel">
            {!adminAuth ? (
              <div style={{ textAlign: "center", color: "var(--text-light)", padding: 40 }}>
                👈 請在側邊欄輸入管理員密碼
              </div>
            ) : (
              <>
                <h2>🔧 管理員 — 管理會議紀錄</h2>

                <div className="admin-section">
                  <h3>📤 按學年上傳 PDF</h3>
                  <div className="admin-upload-grid">
                    <div className="year-picker">
                      <label htmlFor="upload-school-year">會議紀錄所屬學年</label>
                      <select
                        id="upload-school-year"
                        value={uploadYear}
                        onChange={(event) => setUploadYear(event.target.value)}
                      >
                        {adminYearOptions.map((year) => (
                          <option key={year} value={year}>
                            {schoolYearLabel(year)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="meeting-pdf-files">選擇 PDF 檔案</label>
                      <input
                        id="meeting-pdf-files"
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf"
                        multiple
                      />
                    </div>
                  </div>
                  <p className="admin-help">
                    上載的 PDF 及抽取文字會一併存入 {schoolYearLabel(uploadYear)}，
                    老師只會在選擇該學年後看到並查詢這些紀錄。
                  </p>
                  <button
                    className="btn btn-primary"
                    style={{ marginTop: 10 }}
                    onClick={handleUpload}
                    disabled={uploading}
                  >
                    {uploading ? "上傳中..." : "確認上傳"}
                  </button>
                </div>

                <div className="admin-section">
                  <h3>📄 已儲存的檔案（{files.length}）</h3>
                  {files.length === 0 ? (
                    <p style={{ color: "var(--text-light)", fontSize: "0.88rem" }}>目前沒有任何 PDF 檔案</p>
                  ) : (
                    filesByYear.map(([year, yearFiles]) => (
                      <div className="file-year-group" key={year}>
                        <div className="file-year-heading">
                          <span>📅 {schoolYearLabel(year)}</span>
                          <span>{yearFiles.length} 份</span>
                        </div>
                        {yearFiles.map((file) => (
                          <div key={file.path} className="file-item">
                            <span>📎 {file.name}</span>
                            {file.year === UNCATEGORIZED_YEAR ? (
                              <span className="uncategorized-note">需先分類</span>
                            ) : (
                              <button
                                className="btn btn-ghost"
                                onClick={() => handleDelete(file)}
                              >
                                🗑️ 刪除
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

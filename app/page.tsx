"use client";

import { useState, useEffect, useRef } from "react";

type Message = { role: "user" | "assistant"; content: string };
type PdfFile = { name: string; sha: string; download_url: string };
type Doc = { name: string; modified: string; text: string };

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

  // Admin state
  const [files, setFiles] = useState<PdfFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setDocs(data.docs || []);
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
    if (!input.trim() || sending) return;

    const userMsg: Message = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setSending(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages, docs: docs || [] }),
      });
      const data = await resp.json();
      const assistantMsg: Message = {
        role: "assistant",
        content: data.answer || data.error || "回覆失敗",
      };
      setMessages([...newMessages, assistantMsg]);
    } catch {
      setMessages([
        ...newMessages,
        { role: "assistant", content: "網絡錯誤，請重試。" },
      ]);
    }
    setSending(false);
  }

  async function handleUpload() {
    const fileInput = fileInputRef.current;
    if (!fileInput?.files?.length) return;
    setUploading(true);

    for (const file of Array.from(fileInput.files)) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        const resp = await fetch("/api/pdfs", {
          method: "POST",
          headers: { "x-admin-password": adminPwd },
          body: formData,
        });
        if (resp.ok) {
          showToast(`✅ 已上傳：${file.name}`, "success");
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

  async function handleDelete(filename: string) {
    if (!confirm(`確定刪除 ${filename}？`)) return;
    try {
      const resp = await fetch("/api/pdfs", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": adminPwd,
        },
        body: JSON.stringify({ filename }),
      });
      if (resp.ok) {
        showToast(`已刪除：${filename}`, "success");
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

  return (
    <div className="app">
      {/* Toast */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>{toast.msg}</div>
      )}

      {/* Sidebar */}
      <aside className="sidebar">
        <h2>📋 中華基督教會基慈小學</h2>
        <p className="subtitle">校務會議紀錄查詢 Powered by Qwen AI</p>

        <hr className="divider" />

        <div className="mode-toggle">
          <button className={mode === "chat" ? "active" : ""} onClick={switchToChat}>
            💬 聊天
          </button>
          <button className={mode === "admin" ? "active" : ""} onClick={switchToAdmin}>
            🔧 管理員
          </button>
        </div>

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
            <strong>📄 已載入 {docs.length} 份文件</strong>
            {docs.map((d) => (
              <div key={d.name} style={{ padding: "2px 0" }}>• {d.name}</div>
            ))}
          </div>
        )}
      </aside>

      {/* Main content */}
      <div className="main">
        {mode === "chat" ? (
          <>
            <div className="header">
              <h1>📋 校務會議紀錄查詢</h1>
              <p>根據已上傳的會議紀錄 PDF，使用 AI 回答老師問題</p>
            </div>

            <div className="messages">
              {docsLoading && (
                <div style={{ textAlign: "center", color: "var(--text-light)", padding: 40 }}>
                  正在載入會議紀錄<span className="loading-dots"></span>
                </div>
              )}

              {!docsLoading && docs && docs.length === 0 && (
                <div style={{ textAlign: "center", color: "var(--text-light)", padding: 40 }}>
                  目前沒有會議紀錄，請管理員上傳 PDF。
                </div>
              )}

              {messages.length === 0 && docs && docs.length > 0 && (
                <div style={{ textAlign: "center", color: "var(--text-light)", padding: 40 }}>
                  已載入 {docs.length} 份會議紀錄，請輸入問題開始查詢。
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-avatar">{msg.role === "user" ? "👤" : "🤖"}</div>
                  <div className="message-content">{msg.content}</div>
                </div>
              ))}

              {sending && (
                <div className="message assistant">
                  <div className="message-avatar">🤖</div>
                  <div className="message-content">
                    思考中<span className="loading-dots"></span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder="請輸入您的問題（例如：上次會議決定了什麼？）"
                disabled={sending || !docs || docs.length === 0}
              />
              <button onClick={handleSend} disabled={sending || !input.trim()}>
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
                  <h3>📤 上傳 PDF</h3>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    multiple
                  />
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
                    files.map((f) => (
                      <div key={f.name} className="file-item">
                        <span>📎 {f.name}</span>
                        <button className="btn btn-ghost" onClick={() => handleDelete(f.name)}>
                          🗑️ 刪除
                        </button>
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

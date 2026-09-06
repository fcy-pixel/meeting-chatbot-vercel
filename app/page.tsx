"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  compareSchoolYearsDesc,
  currentSchoolYear,
  schoolYearLabel,
  suggestedSchoolYears,
  UNCATEGORIZED_YEAR,
} from "./lib/schoolYear";

import type { DocumentIssue, DocumentSummary } from "./lib/documents";
import type { Answer } from "./lib/evidence";
import AnswerView from "./AnswerView";
import { answerContext, validateConversation } from "./lib/conversation";

type Message = { role: "user" | "assistant"; content: string; answer?: Answer; excludeFromContext?: boolean };
type PdfFile = {
  name: string;
  sha: string;
  download_url: string;
  path: string;
  year: string;
};
type Doc = DocumentSummary;

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
  const [docIssues, setDocIssues] = useState<DocumentIssue[]>([]);
  const [docsError, setDocsError] = useState("");
  const [uploadResults, setUploadResults] = useState<string[]>([]);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
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
      Array.from(new Set([...(docs || []), ...docIssues].map((doc) => doc.year)))
        .filter((year) => year !== UNCATEGORIZED_YEAR)
        .sort(compareSchoolYearsDesc),
    [docs, docIssues]
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
    requestRef.current?.abort();
    generationRef.current++;
    setSending(false);
    setMessages([]);
    setDocsError("");
    setDocsLoading(true);
    try {
      const resp = await fetch("/api/docs");
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "文件載入失敗");
      setDocIssues(data.issues || []);
      const loadedDocs: Doc[] = data.docs || [];
      const loadedYears: string[] = (data.years || [])
        .filter((year: string) => year !== UNCATEGORIZED_YEAR)
        .sort(compareSchoolYearsDesc);
      setDocs(loadedDocs);
      setSelectedYear((current) =>
        loadedYears.includes(current) ? current : loadedYears[0] || current
      );
    } catch (e) {
      setDocsError(e instanceof Error ? e.message : "文件載入失敗，請重新載入。");
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
    if (!input.trim() || sending || docsLoading || selectedDocs.length === 0) return;
    const question = input.trim();
    let conversation;
    try {
      conversation = validateConversation({ year: selectedYear, messages: messages.filter((message) => !message.excludeFromContext).map((message) => ({
        role: message.role, content: message.answer ? answerContext(message.answer) : message.content,
      })) }, selectedYear);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "對話格式無效。", "error");
      setMessages([...messages, { role: "assistant", content: e instanceof Error ? e.message : "對話格式無效。", excludeFromContext: true }]);
      return;
    }
    const newMessages: Message[] = [...messages, { role: "user", content: question }];
    setMessages([...newMessages, { role: "assistant", content: "正在思考…" }]);
    setInput("");
    setSending(true);
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = ++generationRef.current;
    const update = (message: Message) => {
      if (generationRef.current === generation) setMessages([...newMessages, message]);
    };
    try {
      const resp = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, selectedYear, conversation }), signal: controller.signal,
      });
      if (!resp.ok) { const data = await resp.json(); throw new Error(data.error || "查核失敗"); }
      if (!resp.body) throw new Error("查核回應中斷");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", completed = false;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "progress") update({ role: "assistant", content: event.message });
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "reply") {
            completed = true;
            update({ role: "assistant", content: event.message });
          }
          if (event.type === "result") {
            completed = true;
            update({ role: "assistant", content: "", answer: event.result });
          }
        }
        if (done) break;
      }
      if (!completed) throw new Error("查核回應中斷，尚未得到完整答案，請重試。");
    } catch (e) {
      if (!controller.signal.aborted) update({ role: "assistant", content: e instanceof Error ? e.message : "查核未完成，請重試。", excludeFromContext: true });
    } finally {
      if (generationRef.current === generation) setSending(false);
    }
  }

  async function handleUpload() {
    const fileInput = fileInputRef.current;
    if (!fileInput?.files?.length) return;
    const year = uploadYear;
    setUploading(true);
    setUploadResults([]);
    for (const file of Array.from(fileInput.files)) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("year", year);
        const resp = await fetch("/api/pdfs", {
          method: "POST", headers: { "x-admin-password": adminPwd }, body: formData,
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || "上載未完成");
        setUploadResults((rows) => [...rows, `✅ ${file.name}：已保存至 ${year} 學年，共 ${data.pages} 頁、${data.chars} 字。`]);
      } catch (e) {
        setUploadResults((rows) => [...rows, `❌ ${file.name}：${e instanceof Error ? e.message : "上載未完成，請重試。"}`]);
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
    startNewConversation();
    setSelectedYear(year);
  }

  function startNewConversation() {
    requestRef.current?.abort();
    generationRef.current++;
    setSending(false);
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
                • {d.name}（{d.totalPages} 頁）
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
              <p className="evidence-note">可以直接提問、承接上文追問，或請我簡短整理。會議內容只根據所選學年回答，並附檔名、PDF 頁碼及原文供核對。</p>
              {docsError && <p className="document-warning" role="alert">{docsError}</p>}
              {docIssues.filter((issue) => issue.year === selectedYear || issue.year === UNCATEGORIZED_YEAR).map((issue) => (
                <p className="document-warning" key={`${issue.year}-${issue.name}`}>未能查閱：{issue.name}（{issue.year}）— {issue.reason}</p>
              ))}
              {docsLoading && (
                <div style={{ textAlign: "center", color: "var(--text-light)", padding: 40 }}>
                  正在載入會議紀錄<span className="loading-dots"></span>
                </div>
              )}

              {!docsLoading && !docsError && docs && selectedDocs.length === 0 && (
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
                    {msg.answer ? <AnswerView answer={msg.answer} /> : msg.role === "assistant" && msg.content === "" ? (
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
              <button className="new-chat-button" onClick={startNewConversation} disabled={messages.length === 0}>新對話</button>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder={`請輸入關於 ${selectedYear} 學年的問題`}
                disabled={sending || docsLoading || selectedDocs.length === 0}
              />
              <button
                onClick={handleSend}
                disabled={sending || docsLoading || !input.trim() || selectedDocs.length === 0}
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
                        disabled={uploading}
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
                        disabled={uploading}
                      />
                    </div>
                  </div>
                  <p className="admin-help">
                    上載的 PDF 及抽取文字會一併存入 {schoolYearLabel(uploadYear)}，
                    逐頁保存原文和可靠頁次；任何一頁抽不到文字（包括空白頁）便拒絕整份上載，不做 OCR。每份上限 20 MB，超限請先拆分。
                  </p>
                  <button
                    className="btn btn-primary"
                    style={{ marginTop: 10 }}
                    onClick={handleUpload}
                    disabled={uploading}
                  >
                    {uploading ? "逐頁抽取及保存中..." : "確認上傳"}
                  </button>
                </div>

                <div className="upload-results" role="status">{uploadResults.map((row, i) => <p key={i}>{row}</p>)}</div>

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

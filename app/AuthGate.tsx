"use client";

import { useEffect, useState, useCallback } from "react";

/**
 * Google Identity Services 登入閘門
 * 限制：只允許 hosted domain (hd) 為 ALLOWED_DOMAIN 的 Google 帳號通過
 * 通過後 token 存於 localStorage，預設 30 天免重新登入
 */

const ALLOWED_DOMAIN = "keitsz.edu.hk";
const STORAGE_KEY = "ksz_auth_v1";
const SESSION_DAYS = 30;

declare global {
  interface Window {
    google?: any;
  }
}

interface AuthInfo {
  email: string;
  name: string;
  picture: string;
  hd: string;
  exp: number; // expiry epoch ms
}

function parseJwt(token: string): any {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);

  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  // 1) 啟動：讀取 localStorage 已存的登入
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const info: AuthInfo = JSON.parse(raw);
        if (info.exp > Date.now() && info.hd === ALLOWED_DOMAIN) {
          setAuth(info);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    } catch {}
    setReady(true);
  }, []);

  // 2) 動態載入 GIS script
  useEffect(() => {
    if (auth || !ready) return;
    if (document.getElementById("gis-script")) {
      setScriptLoaded(true);
      return;
    }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.id = "gis-script";
    s.onload = () => setScriptLoaded(true);
    document.body.appendChild(s);
  }, [auth, ready]);

  // 3) 處理 Google 回傳
  const handleCredential = useCallback((resp: any) => {
    const payload = parseJwt(resp.credential);
    if (!payload) {
      setError("登入回應無效，請再試一次");
      return;
    }
    const hd = payload.hd || (payload.email || "").split("@")[1];
    if (hd !== ALLOWED_DOMAIN) {
      setError(
        `此網站只開放給 @${ALLOWED_DOMAIN} 帳號使用。\n你登入的是：${payload.email || "(未知)"}`
      );
      return;
    }
    if (payload.email_verified === false) {
      setError("Google 帳號電郵尚未驗證，無法登入");
      return;
    }
    const info: AuthInfo = {
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture || "",
      hd,
      exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
    setAuth(info);
    setError(null);
  }, []);

  // 4) GIS 初始化按鈕
  useEffect(() => {
    if (auth) return;
    if (!scriptLoaded || !clientId) return;
    if (!window.google?.accounts?.id) return;

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleCredential,
      hd: ALLOWED_DOMAIN, // 提示 Google 限定此 hosted domain
      auto_select: true,
      cancel_on_tap_outside: false,
      ux_mode: "popup",
    });

    const btn = document.getElementById("gis-btn");
    if (btn) {
      btn.innerHTML = "";
      window.google.accounts.id.renderButton(btn, {
        theme: "filled_blue",
        size: "large",
        text: "signin_with",
        shape: "pill",
        logo_alignment: "left",
        width: 280,
      });
    }
    // One Tap 提示
    try {
      window.google.accounts.id.prompt();
    } catch {}
  }, [scriptLoaded, clientId, auth, handleCredential]);

  const signOut = () => {
    localStorage.removeItem(STORAGE_KEY);
    setAuth(null);
    setError(null);
    try {
      window.google?.accounts?.id?.disableAutoSelect();
    } catch {}
  };

  if (!ready) return null;

  // ===== 已登入：顯示主內容 + 右上角小頭像 =====
  if (auth) {
    return (
      <>
        <div
          style={{
            position: "fixed",
            top: 10,
            right: 12,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "rgba(255,255,255,.92)",
            backdropFilter: "blur(8px)",
            border: "1px solid #e5e7eb",
            borderRadius: 9999,
            padding: "4px 10px 4px 4px",
            boxShadow: "0 2px 6px rgba(0,0,0,.08)",
            fontSize: 12,
          }}
        >
          {auth.picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={auth.picture}
              alt=""
              referrerPolicy="no-referrer"
              style={{ width: 26, height: 26, borderRadius: "50%" }}
            />
          ) : (
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: "#4f46e5",
                color: "#fff",
                display: "grid",
                placeItems: "center",
                fontWeight: 700,
              }}
            >
              {auth.name.charAt(0)}
            </div>
          )}
          <span style={{ color: "#374151", fontWeight: 500 }}>{auth.email}</span>
          <button
            onClick={signOut}
            style={{
              border: "none",
              background: "transparent",
              color: "#6b7280",
              cursor: "pointer",
              fontSize: 12,
              padding: "2px 6px",
              borderRadius: 6,
            }}
            title="登出"
          >
            登出
          </button>
        </div>
        {children}
      </>
    );
  }

  // ===== 未登入：顯示登入頁 =====
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background:
          "radial-gradient(900px 500px at -10% -10%, #eef2ff 0%, transparent 60%),radial-gradient(800px 500px at 110% -10%, #faf5ff 0%, transparent 60%),#f7f8fc",
        fontFamily:
          "'Noto Sans TC','PingFang TC','Microsoft JhengHei',system-ui,sans-serif",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 20,
          boxShadow: "0 20px 50px -20px rgba(15,23,42,.25)",
          padding: "36px 32px",
          maxWidth: 420,
          width: "100%",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            margin: "0 auto 14px",
            borderRadius: 18,
            background: "linear-gradient(135deg,#4f46e5,#7c3aed)",
            display: "grid",
            placeItems: "center",
            color: "#fff",
            fontSize: 28,
            boxShadow: "0 10px 24px -8px rgba(99,102,241,.55)",
          }}
        >
          �
        </div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: "#0f172a",
            marginBottom: 6,
          }}
        >
          中華基督教會基慈小學
        </h1>
        <p style={{ color: "#475569", marginBottom: 4 }}>校務會議紀錄查詢</p>
        <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 22 }}>
          請使用 <b style={{ color: "#4f46e5" }}>@{ALLOWED_DOMAIN}</b>{" "}
          帳號登入
        </p>

        {!clientId ? (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              padding: 12,
              borderRadius: 10,
              fontSize: 13,
              textAlign: "left",
            }}
          >
            ⚠️ 尚未設定 <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code>。
            <br />
            請在 Vercel/Cloudflare 環境變數加入 Google OAuth Client ID 並重新部署。
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "center" }}>
            <div id="gis-btn" />
          </div>
        )}

        {error && (
          <div
            style={{
              marginTop: 18,
              background: "#fff7ed",
              border: "1px solid #fed7aa",
              color: "#9a3412",
              padding: 12,
              borderRadius: 10,
              fontSize: 13,
              whiteSpace: "pre-line",
              textAlign: "left",
            }}
          >
            {error}
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => {
                  setError(null);
                  try {
                    window.google?.accounts?.id?.disableAutoSelect();
                  } catch {}
                }}
                style={{
                  background: "#fff",
                  border: "1px solid #fdba74",
                  color: "#9a3412",
                  padding: "4px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                重新登入
              </button>
            </div>
          </div>
        )}

        <p
          style={{
            color: "#94a3b8",
            fontSize: 11,
            marginTop: 22,
            lineHeight: 1.6,
          }}
        >
          登入後 30 天內不需重新驗證
          <br />
          系統只讀取你的姓名與電郵，不會寫入 Google 帳號
        </p>
      </div>
    </div>
  );
}

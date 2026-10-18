"use client";

import * as React from "react";

/**
 * AUDIT 137 D3 — global error boundary: file này THAY THẾ root layout khi lỗi
 * render ở tầng gốc (layout.tsx/providers crash) nên PHẢI TỰ CHỨA hoàn toàn:
 * tự render <html><body>, style inline (không dựa globals.css của layout),
 * KHÔNG import gì từ components/. Nền trung tính #111 + chữ #f5f5f5 đọc được
 * cả khi dark/light theme chưa kịp nạp. Nút ≥44px touch target, tiêu đề
 * tiếng Việt đồng bộ error.tsx ("The Trader" branding).
 */
export default function GlobalRootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[global-error] Lỗi render tầng gốc:", error);
  }, [error]);

  const rawMessage = error?.message ?? "";
  const shortMessage =
    rawMessage.length > 200 ? `${rawMessage.slice(0, 200)}…` : rawMessage;

  const buttonStyle: React.CSSProperties = {
    minHeight: 44,
    padding: "0 24px",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  };

  return (
    <html lang="vi">
      <body
        style={{
          margin: 0,
          backgroundColor: "#111",
          color: "#f5f5f5",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div
          style={{
            minHeight: "60vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            role="alert"
            style={{
              width: "100%",
              maxWidth: "28rem",
              textAlign: "center",
              border: "1px solid #333",
              borderRadius: "12px",
              padding: "24px",
            }}
          >
            <svg
              aria-hidden="true"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#f59e0b"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ margin: "0 auto 12px", display: "block" }}
            >
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
            <h1 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: 700 }}>
              Có lỗi xảy ra trong giao diện
            </h1>
            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#a3a3a3" }}>
              The Trader — lỗi ở tầng khung giao diện. Dữ liệu tài khoản/lệnh
              không bị ảnh hưởng; thử lại hoặc tải lại trang.
            </p>
            {(rawMessage || error?.digest) && (
              <pre
                style={{
                  margin: "0 0 16px",
                  padding: "12px",
                  textAlign: "left",
                  fontSize: "11px",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  overflowX: "auto",
                  backgroundColor: "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: "8px",
                  color: "#d4d4d4",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                {shortMessage || "(không có thông điệp lỗi)"}
                {error?.digest ? `\n[digest: ${error.digest}]` : ""}
              </pre>
            )}
            <div
              style={{
                display: "flex",
                gap: "8px",
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={() => reset()}
                style={{
                  ...buttonStyle,
                  backgroundColor: "#059669",
                  color: "#ffffff",
                  border: "none",
                }}
              >
                Thử lại
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  ...buttonStyle,
                  backgroundColor: "transparent",
                  color: "#f5f5f5",
                  border: "1px solid #555",
                }}
              >
                Tải lại trang
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}

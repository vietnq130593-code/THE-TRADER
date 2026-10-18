"use client";

import * as React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * AUDIT 137 D3 — error boundary tầng app (trước đây src/app/ KHÔNG có file
 * error.tsx nào: một exception render — field ngoài hợp đồng API, JSON.parse
 * nhánh hiếm, recharts nhận NaN domain — thổi bay cả 8 workspace về màn hình
 * lỗi mặc định Next, mất trạng thái workspace/panel đang mở).
 *
 * Component client chuẩn Next.js App Router: Next truyền { error, reset } —
 * reset() render lại đoạn tree vừa crash (giữ được phần state còn sống),
 * window.location.reload() cho trường hợp cần làm sạch toàn bộ.
 * Dark/light theo biến Tailwind theme (bg-background/text-foreground…) —
 * KHÔNG dùng màu indigo/blue; 2 nút chạm h-11 (≥44px touch target).
 */
export default function AppRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Next cũng tự log — dòng này giữ error đầy đủ (kèm digest nếu có) cho
    // dev.log/E2E "0 lỗi console" phát hiện được đúng stack.
    console.error("[app-error] Lỗi render giao diện:", error);
  }, [error]);

  // Rút gọn thông điệp (~200 ký tự) — đủ chẩn đoán, không tràn thẻ trên mobile.
  const rawMessage = error?.message ?? "";
  const shortMessage =
    rawMessage.length > 200 ? `${rawMessage.slice(0, 200)}…` : rawMessage;

  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-background px-4 py-8 text-foreground">
      <Card className="w-full max-w-md gap-4">
        <CardContent className="flex flex-col items-center gap-4 px-6 text-center">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
            <AlertTriangle
              className="size-6 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-lg font-semibold tracking-tight">
              Có lỗi xảy ra trong giao diện
            </h1>
            <p className="text-sm text-muted-foreground">
              The Trader — một thành phần vừa gặp sự cố khi hiển thị. Dữ liệu tài
              khoản/lệnh không bị ảnh hưởng; thử lại hoặc tải lại trang.
            </p>
          </div>
          {(rawMessage || error?.digest) && (
            <pre className="w-full overflow-x-auto rounded-md bg-muted p-3 text-left font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground">
              {shortMessage || "(không có thông điệp lỗi)"}
              {error?.digest ? `\n[digest: ${error.digest}]` : ""}
            </pre>
          )}
          <div className="flex w-full flex-col justify-stretch gap-2 sm:w-auto sm:flex-row">
            <Button onClick={() => reset()} className="h-11 px-6">
              <RotateCcw className="size-4" aria-hidden="true" />
              Thử lại
            </Button>
            <Button
              variant="outline"
              onClick={() => window.location.reload()}
              className="h-11 px-6"
            >
              Tải lại trang
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

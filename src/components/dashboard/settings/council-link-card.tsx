"use client";

/**
 * settings/council-link-card.tsx (M4.8 #110 — UIUX_UPGRADE_BLUEPRINT §4) —
 * "Khối Hội đồng": giới thiệu cơ chế phán quyết D-LEDGER (#106) và điều
 * hướng sang module Hội đồng. Đây là card CẤU HỔ TRỢ (không mang số bước) —
 * đặt sau SandboxCard theo trình tự: 1 Kết nối → 2 Chạy agent → 3 Thử
 * nghiệm → thông báo · lịch · hội đồng.
 *
 * Nội dung mô tả theo chính sách VN-only v1.2 (#108): đầu tư chỉ tại VN,
 * dữ liệu quốc tế là THAM CHIẾU.
 */

import { ArrowRight, BookOpenCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useUiStore } from "@/lib/store";

export function CouncilLinkCard() {
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4 text-primary" aria-hidden="true" />
          Khối Hội đồng
        </CardTitle>
        <CardDescription>
          Hội đồng đánh giá mọi quyết định giao dịch — job tự động 16:45 ICT các
          ngày giao dịch T2–T6 (sổ phán quyết WIN/LOSS ±0,5%) · dữ liệu thị
          trường nạp 06:15 &amp; 15:45 (VN đầu tư · quốc tế tham chiếu)
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Trong module Hội đồng: KPI tài khoản · đường cong equity · vị thế nhóm
          theo thị trường · sổ phán quyết từng quyết định (LỢI/TỔN THẤT kèm hậu
          quả thị trường thật).
        </p>
        <Button
          variant="secondary"
          className="min-h-11 shrink-0 gap-2"
          onClick={() => setActiveWorkspace("council")}
        >
          <BookOpenCheck className="size-4 text-primary" aria-hidden="true" />
          Mở module Hội đồng
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Button>
      </CardContent>
    </Card>
  );
}

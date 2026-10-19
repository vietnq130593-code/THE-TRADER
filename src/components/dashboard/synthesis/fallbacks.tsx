"use client";

// (Task 144 P2-c) — tách từ synthesis-workspace.tsx (pure move)
// Trạng thái "chưa sẵn sàng" của tab Nhận định / Bằng chứng: EmptyState (chưa
// có lần tổng hợp nào + nút tổng hợp ngay) và SynthesisSkeleton (đang tải).

import { Brain, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/* ─────────────────── Empty state ─────────────────── */

export function EmptyState({
  synthesizePending,
  onSynthesize,
}: {
  synthesizePending: boolean;
  onSynthesize: () => void;
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
          Chưa có lần tổng hợp nào
        </CardTitle>
        <CardDescription>Bộ tổng hợp Bayes chưa chạy</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          Bộ tổng hợp Bayes tổng hợp đánh giá của toàn bộ 24 agents theo mô hình
          nhân quả (thị trường → ngành → cổ phiếu). Dùng nút “Chạy agent” trên
          thanh bar trên cùng để cả đội sinh bằng chứng, hoặc tổng hợp ngay từ
          dữ liệu định lượng hiện có — không tốn LLM.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={onSynthesize}
            disabled={synthesizePending}
            className="min-h-11 gap-2"
          >
            {synthesizePending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Đang tổng hợp…
              </>
            ) : (
              <>
                <RefreshCw className="size-4" aria-hidden="true" />
                Tổng hợp ngay (không tốn LLM)
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── Skeleton ─────────────────── */

export function SynthesisSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Đang tải nhận định">
      <Card>
        <CardContent className="flex flex-col gap-4 py-6">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-7 w-full rounded-md" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-3 py-6">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="py-6">
          <Skeleton className="h-64 w-full rounded-lg" />
        </CardContent>
      </Card>
    </div>
  );
}

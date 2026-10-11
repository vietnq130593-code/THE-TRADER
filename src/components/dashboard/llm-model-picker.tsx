"use client";

/**
 * LlmModelPicker — nút "Model AI" trong workspace Đội Agent (phiên #93).
 *
 * Mở dropdown danh sách model Opencode (live từ /zen/v1/models — 12+ model
 * free chạy $0 qua Opencode CLI): bấm chọn model nào thì TOÀN ĐỘI 23 agent
 * chuyển sang model đó từ cuộc gọi LLM tiếp theo (AppSetting "llm-model",
 * không cần restart). Kèm nút "Kiểm tra model" gọi thử thật — đo độ trễ +
 * tokens + chi phí ngay tại chỗ (trả lời câu hỏi "model này có hoạt động
 * bình thường không" bằng chứng cứ sống, không đoán).
 *
 * Chống 429 đã nằm ở tầng lib/llm.ts (throttle + backoff) — dropdown chỉ
 * hiển thị cấu hình guard đang hiệu lực cho trader yên tâm.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Cpu, FlaskConical, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiPostJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { LlmModelSetResponse, LlmModelsResponse } from "@/lib/types";

/** Kết quả "Kiểm tra model" hiển thị ngay trong dropdown. */
interface TestResult {
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

function fmtMs(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function LlmModelPicker() {
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const modelsQuery = useQuery({
    queryKey: ["llm-models"],
    queryFn: () => apiGet<LlmModelsResponse>("/api/llm/models"),
    staleTime: 60_000,
  });

  const selectMutation = useMutation({
    mutationFn: (model: string) =>
      apiPostJson<LlmModelSetResponse>("/api/llm/models", { model }),
    onSuccess: (res, model) => {
      toast.success(`Toàn đội agent chuyển sang model ${model}`, {
        description:
          "Hiệu lực từ cuộc gọi LLM tiếp theo — chu kỳ đang chạy giữ nguyên model cũ.",
      });
      // Làm mới mọi nơi hiển thị model: header workspace Đội Agent (/api/agents),
      // Settings (/api/settings) và chính danh sách model.
      void queryClient.invalidateQueries({ queryKey: ["llm-models"] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Chuyển model thất bại.");
    },
  });

  const testMutation = useMutation({
    mutationFn: () =>
      apiPostJson<TestResult>("/api/llm/models", { action: "test" }),
    onSuccess: (res) => setTestResult(res),
    onError: (err) => {
      setTestResult(null);
      toast.error(err instanceof Error ? err.message : "Kiểm tra model thất bại.", {
        description: "Model có thể quá tải — thử lại sau vài giây.",
      });
    },
  });

  const data = modelsQuery.data;
  const current = data?.current ?? "…";
  const isCurrentFree = data?.models.find((m) => m.id === current)?.free ?? current.endsWith("-free");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="min-h-11 max-w-full gap-2"
          aria-label={`Model AI của đội agent — hiện tại ${current}`}
        >
          <Cpu className="size-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Model AI</span>
          <Badge
            variant="secondary"
            className="max-w-[10rem] truncate px-1.5 font-mono text-[10px] tabular-nums"
            title={current}
          >
            {current}
          </Badge>
          {isCurrentFree && (
            <span
              className="hidden rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 md:inline dark:text-emerald-400"
              aria-label="Model miễn phí"
            >
              Free
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80 sm:w-96">
        <DropdownMenuLabel className="flex flex-col gap-1">
          <span className="text-sm">Model AI toàn đội agent</span>
          <span className="text-[11px] font-normal leading-snug text-muted-foreground">
            {data ? (
              <>
                Provider <span className="font-mono">{data.provider}</span> · đang dùng{" "}
                <span className="font-mono">{current}</span>
                {isCurrentFree ? " (miễn phí)" : " (trả phí)"}
              </>
            ) : (
              "Đang tải danh sách model…"
            )}
          </span>
        </DropdownMenuLabel>

        {/* Kết quả kiểm tra model gần nhất — bằng chứng sống model đang chạy */}
        {testResult && (
          <>
            <div className="mx-2 mb-1 rounded-md border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed">
              <p className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                Kiểm tra {testResult.model}: HOẠT ĐỘNG
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {fmtMs(testResult.latencyMs)} ·{" "}
                {testResult.tokensIn.toLocaleString("vi-VN")} token vào ·{" "}
                {testResult.tokensOut.toLocaleString("vi-VN")} token ra · $
                {testResult.costUsd.toFixed(6)}
              </p>
            </div>
            <DropdownMenuSeparator />
          </>
        )}

        {/* Danh sách model — cuộn khi dài (87 model live), scrollbar mảnh */}
        <div className="max-h-72 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
          {modelsQuery.isLoading ? (
            <div className="flex flex-col gap-2 p-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          ) : modelsQuery.isError ? (
            <p className="px-2 py-3 text-sm text-down">
              Không tải được danh sách model — thử mở lại.
            </p>
          ) : !data?.canChoose ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
              Provider <span className="font-mono">zai</span> chạy cố định GLM-4.6
              trong sandbox. Đặt <span className="font-mono">OPENCODE_ZEN_API_KEY</span>{" "}
              trong .env để chọn được 12+ model Opencode free.
            </p>
          ) : (
            data.models.map((m) => {
              const isCurrent = m.id === current;
              return (
                <DropdownMenuItem
                  key={m.id}
                  disabled={selectMutation.isPending}
                  onSelect={() => selectMutation.mutate(m.id)}
                  className={cn(
                    "min-h-11 gap-2",
                    isCurrent && "font-medium"
                  )}
                  aria-label={`${m.id}${m.free ? " — miễn phí" : " — trả phí"}${
                    isCurrent ? " — đang dùng" : ""
                  }`}
                >
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      isCurrent ? "opacity-100" : "opacity-0"
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                    {m.id}
                  </span>
                  <Badge
                    variant="secondary"
                    className={cn(
                      "ml-auto shrink-0 px-1.5 text-[10px]",
                      m.free &&
                        "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    )}
                  >
                    {m.free ? "Miễn phí" : "Trả phí"}
                  </Badge>
                </DropdownMenuItem>
              );
            })
          )}
        </div>

        <DropdownMenuSeparator />

        {/* Nút kiểm tra model hiện tại — giữ menu mở để hiện kết quả */}
        <DropdownMenuItem
          disabled={testMutation.isPending || selectMutation.isPending}
          onSelect={(e) => {
            e.preventDefault();
            testMutation.mutate();
          }}
          className="min-h-11 gap-2"
          aria-label="Kiểm tra model hiện tại có hoạt động không"
        >
          {testMutation.isPending ? (
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="text-sm">
            {testMutation.isPending
              ? "Đang kiểm tra model…"
              : `Kiểm tra model ${current}`}
          </span>
        </DropdownMenuItem>

        {data && (
          <p className="px-2 pb-1.5 pt-1 text-[10px] leading-relaxed text-muted-foreground">
            Chống 429: giãn cách {Math.round(data.guard.minSpacingMs / 100) / 10}s
            /lượt gọi · tối đa {data.guard.maxConcurrent} gọi song song · tự thử
            lại {data.guard.retryBackoffMs.length} lần (2s → 6s → 15s) khi bị
            rate limit. Danh sách{" "}
            {data.source === "live" ? "live từ Opencode Zen" : "dự phòng (12 model free)"}.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

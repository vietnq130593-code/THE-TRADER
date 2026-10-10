"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Award,
  Bot,
  Gauge,
  ListFilter,
  RefreshCw,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { formatVolume } from "@/lib/format";
import { useSingleAgentRun, RateLimitError } from "@/hooks/use-agent-actions";
import { AgentRosterCard } from "@/components/dashboard/agent-roster-card";
import { AgentDetailPanel } from "@/components/dashboard/agent-detail-panel";
import { CoverageMatrix } from "@/components/dashboard/coverage-matrix";
// E-P0-5 (EXECUTION_OPS_BLUEPRINT v1.1): khối KPI vận hành nhóm executive.
import { ExecutiveKpi } from "@/components/dashboard/executive-kpi";
// E-P1-4 (v1.2): bảng điểm chất lượng tín hiệu Chủ tịch — đặt dưới section
// nhóm executive (cùng pattern B8 dưới section research).
import { ChairmanScorecardCard } from "@/components/dashboard/chairman-scorecard";
import { cn } from "@/lib/utils";
import type { AgentCard, AgentsResponse } from "@/lib/types";
import type { ScorecardRow } from "@/lib/research/scorecard";
// A2 (ML_OPS_BLUEPRINT §3) — types hợp đồng GET /api/ml/analytics (chỉ type,
// module analytics thuần không kéo DB vào bundle client).
import type {
  AnalyticsPayload,
  ArmTrajectory,
  BrierDecomposition,
  CalibrationBucket,
  RegimeTable,
} from "@/lib/ml/analytics";

/** Mở rộng 23 agents — thứ tự 5 nhóm hiển thị trong roster (agent-roster.ts backend). */
const GROUP_ORDER = ["research", "control", "executive", "platform", "ml"] as const;

/** Mô tả ngắn mỗi nhóm dưới header section. */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  research: "Phân tích chuyên sâu cấp tín hiệu đầu vào",
  control: "Quyền VETO — rủi ro, phơi nhiễm, tuân thủ",
  executive: "Tổng hợp, ra tín hiệu, thực thi",
  platform: "Thu thập & kiểm định dữ liệu",
  ml: "Backtest, dự báo, giả lập RL",
};

interface AgentGroupSection {
  key: string;
  label: string;
  description: string;
  agents: AgentCard[];
}

/** GET /api/research/scorecard — shape hợp đồng với route B8. */
interface ScorecardResponse {
  agents: ScorecardRow[];
  generatedAt: string;
}

/** Chia agents theo nhóm theo GROUP_ORDER — nhóm lạ gom vào section "Khác" cuối danh sách. */
function groupAgentsBySection(agents: AgentCard[]): AgentGroupSection[] {
  const sections: AgentGroupSection[] = GROUP_ORDER.map((key) => ({
    key,
    label: "",
    description: GROUP_DESCRIPTIONS[key] ?? "",
    agents: [],
  }));
  const fallback: AgentGroupSection = {
    key: "other",
    label: "Nhóm khác",
    description: "Agent chưa phân nhóm",
    agents: [],
  };
  for (const a of agents) {
    const section = sections.find((s) => s.key === a.group);
    if (section) {
      // groupLabel do API trả về (đồng nhất trong nhóm) — lấy của agent đầu tiên.
      if (!section.label) section.label = a.groupLabel;
      section.agents.push(a);
    } else {
      if (fallback.agents.length === 0) fallback.label = a.groupLabel || "Nhóm khác";
      fallback.agents.push(a);
    }
  }
  return [...sections, fallback].filter((s) => s.agents.length > 0);
}

/**
 * PHASE3_BLUEPRINT §4.7 — workspace "Đội Agent" (B2 thay placeholder B1):
 * roster 23 card chia 5 nhóm + panel chi tiết/chat. Mobile stack dọc, desktop 2 cột xl:.
 * Mutation "chạy riêng" sống ở đây để nút roster + panel đồng bộ trạng thái.
 *
 * PHIÊN #47 (yêu cầu user):
 * - Nút "Chạy chu kỳ đầy đủ" bị XOÁ — nút "Chạy agent" trên thanh bar trên
 *   cùng (Header) là nút chạy chu kỳ DUY NHẤT của cả app (trước đó xuất hiện
 *   6 nơi: overview ×2 · signals · synthesis ×2 · đây).
 * - Bộ lọc nhóm chuyển từ hàng pill bày sẵn (#45) sang MỘT nút "Nhóm hiển thị"
 *   trong ô header workspace: mở DropdownMenu tick ĐA CHỌN nhóm nào được render.
 */
export function AgentsWorkspace() {
  const singleRun = useSingleAgentRun();

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<AgentsResponse>("/api/agents"),
    staleTime: 30_000,
  });

  // Agent đang mở panel chi tiết (local state — không cần Zustand).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Phiên #47 — bộ lọc nhóm agent ĐA CHỌN (tick trong dropdown): mặc định tick
  // đủ mọi nhóm (= hiển thị toàn bộ 23 như trước); bỏ tick nhóm nào để ẨN nhóm
  // đó khỏi roster — thay hàng pill đơn chọn 1 nhóm của phiên #45.
  const [selectedGroups, setSelectedGroups] = useState<ReadonlySet<string>>(
    () => new Set([...GROUP_ORDER, "other"])
  );
  const toggleGroup = (key: string) =>
    setSelectedGroups((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // retryAfterSeconds theo agent id — set khi chạy riêng dính 429;
  // workspace là chủ duy nhất của đồng hồ đếm ngược (tick giảm mỗi giây).
  const [retryAfter, setRetryAfter] = useState<Record<string, number>>({});

  function handleRun(agentId: string) {
    // Chạy riêng từ roster → luôn mở panel chi tiết (auto refetch qua invalidate).
    setSelectedId(agentId);
    singleRun.mutate(agentId, {
      onError: (err) => {
        if (err instanceof RateLimitError) {
          setRetryAfter((r) => ({ ...r, [agentId]: err.retryAfterSeconds }));
        }
      },
    });
  }

  // Tick đồng hồ đếm ngược chung cho roster cards + panel (setState trong
  // callback timer — subscription external system, an toàn re-render).
  const hasRetry = Object.values(retryAfter).some((v) => v > 0);
  useEffect(() => {
    if (!hasRetry) return;
    const timer = setInterval(() => {
      setRetryAfter((r) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [id, v] of Object.entries(r)) {
          const nv = Math.max(0, v - 1);
          if (nv !== v) changed = true;
          if (nv > 0) next[id] = nv;
        }
        return changed ? next : r;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [hasRetry]);

  const agents = agentsQuery.data?.agents ?? [];
  const sections = groupAgentsBySection(agents);
  // Phiên #47 — roster chỉ render các nhóm đang được tick trong dropdown.
  const visibleSections = sections.filter((s) => selectedGroups.has(s.key));
  // Scorecard + ma trận độ phủ gắn bối cảnh nhóm research — chỉ hiện khi nhóm
  // research đang được chọn (phiên #45: khi "all" hoặc "research").
  const showResearchExtras = selectedGroups.has("research");
  const selectedGroupCount = sections.filter((s) => selectedGroups.has(s.key)).length;
  const allGroupsSelected =
    sections.length > 0 && selectedGroupCount === sections.length;
  const visibleAgentCount = visibleSections.reduce(
    (n, s) => n + s.agents.length,
    0
  );
  const totals = agentsQuery.data?.totals;
  const totalTokens =
    totals ? totals.totalTokensIn + totals.totalTokensOut : null;
  // Số agent động (… khi đang tải — tránh nhảy số trên header).
  const agentCount = agentsQuery.isLoading ? null : agents.length;

  return (
    <div
      role="tabpanel"
      id="workspace-panel-agents"
      aria-labelledby="workspace-tab-agents"
      className="flex flex-col gap-6"
    >
      {/* Header workspace: mô tả đội + tổng chi phí AI + nút chọn nhóm
          hiển thị (phiên #47 — thay nút "Chạy chu kỳ đầy đủ" đã dời về
          nút "Chạy agent" duy nhất trên thanh bar trên cùng) */}
      <Card>
        <CardContent className="flex flex-col gap-4 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted"
              aria-hidden="true"
            >
              <Bot className="size-5 text-foreground/80" />
            </span>
            <div className="leading-tight">
              <p className="text-base font-semibold">Đội Agent</p>
              <p className="text-xs text-muted-foreground">
                <span className="tabular-nums">{agentCount ?? "…"}</span> agents ·{" "}
                {GROUP_ORDER.length} nhóm: nền tảng dữ liệu → hội đồng nghiên cứu → ủy
                ban kiểm soát (VETO) → chủ tịch → thực thi
                <span className="mx-1" aria-hidden="true">·</span>
                <span className="font-mono" title={agentsQuery.data?.llm?.modelLabel}>
                  {agentsQuery.data?.llm?.model ?? "…"}
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 lg:justify-end">
            <p className="tabular-nums text-xs text-muted-foreground">
              {agentsQuery.isLoading
                ? "…"
                : `${visibleAgentCount}/${agents.length} đang xem`}
              {totals
                ? ` · $${totals.totalCostUsd.toFixed(2)} chi phí AI lũy kế · ${formatVolume(totalTokens ?? 0)} tokens`
                : ""}
            </p>

            {/* Phiên #47 — MỘT nút mở dropdown tick đa chọn nhóm hiển thị,
                thay hàng pill 6 nút bày sẵn của phiên #45 (user: kém thẩm mỹ). */}
            {!agentsQuery.isLoading && !agentsQuery.isError && sections.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="min-h-11 gap-2"
                    aria-label="Chọn nhóm agent hiển thị"
                  >
                    <ListFilter className="size-4" aria-hidden="true" />
                    Nhóm hiển thị
                    <Badge
                      variant="secondary"
                      className="px-1.5 tabular-nums"
                      aria-hidden="true"
                    >
                      {selectedGroupCount}/{sections.length}
                    </Badge>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                  <DropdownMenuLabel>Nhóm agents hiển thị</DropdownMenuLabel>
                  {sections.map((s) => (
                    <DropdownMenuCheckboxItem
                      key={s.key}
                      checked={selectedGroups.has(s.key)}
                      onCheckedChange={() => toggleGroup(s.key)}
                      // Giữ menu mở sau mỗi tick — người dùng tick/detick
                      // nhiều nhóm liên tiếp (mặc định Radix đóng menu).
                      onSelect={(e) => e.preventDefault()}
                      className="min-h-11 gap-2 sm:min-h-9"
                      aria-label={`${s.label} — ${s.agents.length} agent`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate text-sm">{s.label}</span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {s.description}
                        </span>
                      </span>
                      <Badge
                        variant="secondary"
                        className="ml-auto shrink-0 px-1.5 text-[10px] tabular-nums"
                      >
                        {s.agents.length}
                      </Badge>
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      setSelectedGroups(
                        allGroupsSelected ? new Set() : new Set(sections.map((s) => s.key))
                      )
                    }
                    className="min-h-11 gap-2 sm:min-h-9"
                  >
                    <ListFilter className="size-4" aria-hidden="true" />
                    {allGroupsSelected ? "Bỏ chọn tất cả" : "Chọn tất cả"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </CardContent>
      </Card>

      {/* E-P0-5 — KPI vận hành nhóm Điều hành & Thực thi (funnel + churn + AOV +
          slippage) — đặt trên roster để trader nhìn hiệu suất nhóm trước chi tiết */}
      <ExecutiveKpi />

      {/* Body: roster (trái, cuộn dọc khi dài ở desktop) + panel chi tiết/chat (phải) */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div
          className="flex flex-col gap-4 self-start xl:col-span-2 xl:max-h-[calc(100vh-13rem)] xl:overflow-y-auto xl:pr-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
        >

          {agentsQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-48 w-full rounded-xl" />
              ))}
            </div>
          ) : agentsQuery.isError ? (
            <p className="text-sm text-down">
              {agentsQuery.error?.message ?? "Không tải được danh sách agent."}
            </p>
          ) : visibleSections.length === 0 ? (
            /* Phiên #47 — người dùng bỏ tick hết mọi nhóm */
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center">
              <ListFilter className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="max-w-sm text-sm text-muted-foreground">
                Chưa chọn nhóm nào — mở “Nhóm hiển thị” ở trên để tick chọn
                nhóm agent cần xem.
              </p>
            </div>
          ) : (
            visibleSections.map((section, i) => (
              <Fragment key={section.key}>
                <section
                  aria-label={section.label}
                  className={cn("flex flex-col gap-3", i > 0 && "border-t border-border pt-4")}
                >
                  {/* Header nhóm — dính lên khi cuộn vùng roster ở desktop */}
                  <div className="flex flex-col gap-0.5 xl:sticky xl:top-0 xl:z-10 xl:bg-background/95 xl:py-1 xl:backdrop-blur">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {section.label}
                      </h3>
                      <Badge
                        variant="secondary"
                        className="px-1.5 py-0 text-[10px] tabular-nums"
                      >
                        {section.agents.length} agent
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground/80">
                      {section.description}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
                    {section.agents.map((a) => (
                      <AgentRosterCard
                        key={a.id}
                        agent={a}
                        selected={selectedId === a.id}
                        onSelect={() =>
                          setSelectedId((cur) => (cur === a.id ? cur : a.id))
                        }
                        onRun={() => handleRun(a.id)}
                        runPending={
                          singleRun.isPending && singleRun.variables === a.id
                        }
                        retryAfterSeconds={retryAfter[a.id] ?? null}
                      />
                    ))}
                  </div>
                </section>
                {/* B8 — Bảng điểm Hội đồng Nghiên cứu: NGAY DƯỚI section nhóm
                    research (chốt user §0.3 — blueprint §3.6/Bước 8) */}
                {/* B14 — Ma trận độ phủ thị trường: ĐẶT SAU scorecard
                    (§3.7/Bước 14 — cùng tab Đội Agent theo chốt user §0.3) */}
                {section.key === "research" && showResearchExtras && (
                  <>
                    <ResearchScorecard />
                    <CoverageMatrix />
                  </>
                )}
                {/* E-P1-4 — Bảng điểm Chủ tịch (A1): NGAY DƯỚI section nhóm
                    executive — cùng pattern B8 (mô tả, không phán xét §6.5) */}
                {section.key === "executive" && <ChairmanScorecardCard />}
              </Fragment>
            ))
          )}
        </div>

        <div className="xl:col-span-3">
          {selectedId ? (
            <AgentDetailPanel
              key={selectedId}
              agentId={selectedId}
              onClose={() => setSelectedId(null)}
              onRun={() => handleRun(selectedId)}
              runPending={
                singleRun.isPending && singleRun.variables === selectedId
              }
              retryAfterSeconds={retryAfter[selectedId] ?? null}
            />
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center">
              <Bot
                className="size-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="max-w-sm text-sm text-muted-foreground">
                Chọn một agent để xem hồ sơ, chạy riêng và chat trực tiếp
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════ B8 — Bảng điểm Hội đồng Nghiên cứu (§3.6 blueprint) ═══════════════ */

const nf0 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const nf2 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "62,5%" — nhập tỷ lệ 0..1 → ×100 (vi-VN, dấu phẩy thập phân). */
function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf1.format(n * 100)}%`;
}

/** Health 0..100: ≥70 xanh lá · <50 đỏ · còn lại muted. */
function healthTone(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "text-muted-foreground";
  if (n >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (n < 50) return "text-rose-600 dark:text-rose-400";
  return "text-foreground";
}

/**
 * Card "Bảng điểm Hội đồng Nghiên cứu" — đặt ngay dưới section nhóm research
 * (chốt user §0.3). 6 cử tri: hit-rate 5 phiên · Brier · đóng góp posterior
 * |Δlog-odds| · streak · posterior bandit · health. pulls < 5 → hàng mờ +
 * badge "chưa đủ dữ liệu" (trung thực, không bịa). TanStack Query
 * "/api/research/scorecard" + skeleton + error state + retry.
 */
function ResearchScorecard() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["research-scorecard"],
    queryFn: () => apiGet<ScorecardResponse>("/api/research/scorecard"),
    staleTime: 30_000,
  });
  const rows = data?.agents ?? [];

  return (
    <Card className="gap-4" aria-labelledby="research-scorecard-heading">
      <CardHeader>
        <CardTitle
          id="research-scorecard-heading"
          className="flex items-center gap-2 text-base"
        >
          <Award className="size-4 text-muted-foreground" aria-hidden="true" />
          Bảng điểm Hội đồng Nghiên cứu
        </CardTitle>
        <CardDescription>
          6 cử tri · hit-rate 5 phiên · Brier · đóng góp posterior — sắp theo
          hit-rate giảm dần
        </CardDescription>
        {data?.generatedAt && (
          <CardAction>
            <span className="text-[11px] text-muted-foreground">
              Cập nhật {new Date(data.generatedAt).toLocaleString("vi-VN", {
                timeZone: "Asia/Ho_Chi_Minh",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pb-0">
        {isLoading ? (
          <ScorecardSkeleton />
        ) : isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-down/40 bg-down/10 p-4 text-sm text-down"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <p className="min-w-40 flex-1 leading-relaxed">
              Không tải được bảng điểm Hội đồng Nghiên cứu
              {error?.message ? ` — ${error.message}` : "."}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void refetch()}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Thử lại
            </Button>
          </div>
        ) : (
          /* A2 (ML_OPS_BLUEPRINT §3) — scorecard B8 mở 2 tab: bảng điểm gốc
              (giữ nguyên hit-rate/Brier cũ) + "Hiệu năng & calibration"
              (Wilson CI · Murphy decomposition · bucket · agent × regime ·
              posterior trajectory) — BỔ SUNG, không thay thế. */
          <Tabs defaultValue="scorecard">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger
                value="scorecard"
                className="min-h-11 flex-1 whitespace-nowrap text-xs sm:min-h-9 sm:flex-none sm:text-sm"
              >
                Bảng điểm
              </TabsTrigger>
              <TabsTrigger
                value="calibration"
                className="min-h-11 flex-1 whitespace-nowrap text-xs sm:min-h-9 sm:flex-none sm:text-sm"
              >
                Hiệu năng &amp; calibration
              </TabsTrigger>
            </TabsList>
            <TabsContent value="scorecard" className="mt-3 flex flex-col gap-3">
              <div className="max-h-96 overflow-y-auto custom-scrollbar rounded-lg border">
                {/* table-fixed mobile: hàng gộp 1 cell không đẩy bảng rộng hơn container */}
                <Table className="table-fixed sm:table-auto">
                  <TableHeader>
                    <TableRow className="hidden sm:table-row">
                      <TableHead className="text-xs">Agent</TableHead>
                      <TableHead className="text-xs">Pulls</TableHead>
                      <TableHead className="text-xs">Hit-rate 5 phiên</TableHead>
                      <TableHead className="text-xs">Brier</TableHead>
                      <TableHead className="hidden text-xs md:table-cell">
                        Đóng góp |Δlog-odds|
                      </TableHead>
                      <TableHead className="hidden text-xs sm:table-cell">Streak</TableHead>
                      <TableHead className="text-xs">Posterior bandit</TableHead>
                      <TableHead className="hidden text-xs lg:table-cell">Health</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <ScorecardRowView key={row.code} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="pb-4 text-[11px] leading-relaxed text-muted-foreground">
                Hit-rate = tỉ lệ phiếu đúng hướng giá thực tế sau 5 phiên (BanditEvent
                đã kết toán) · Brier thấp = tự tin chuẩn · đóng góp posterior = trung
                bình |Δlog-odds| phiếu trong 30 lần tổng hợp gần nhất.
              </p>
            </TabsContent>
            <TabsContent value="calibration" className="mt-3">
              <PerformanceCalibration />
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}

function ScorecardRowView({ row }: { row: ScorecardRow }) {
  const meta = `${row.code}${row.gen1 ? ` · ${row.gen1}` : ""} · ${nf1.format(row.wins)} wins`;
  const hitTone =
    row.hitRate == null
      ? "text-muted-foreground"
      : row.hitRate >= 0.5
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-rose-600 dark:text-rose-400";

  return (
    <TableRow className={cn(!row.enoughData && "opacity-60")}>
      {/* Mobile — 1 hàng gộp (không tràn cột ở 390px) */}
      <TableCell colSpan={8} className="sm:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold" title={row.name}>
                {row.name}
              </span>
              {!row.enoughData && (
                <Badge
                  variant="outline"
                  className="px-1 py-0 text-[9px] text-muted-foreground"
                >
                  chưa đủ dữ liệu
                </Badge>
              )}
            </span>
            <span className="truncate text-[10px] text-muted-foreground" title={meta}>
              {meta}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {nf0.format(row.pulls)} pulls
            </span>
            <span className={cn("tabular-nums text-xs font-semibold", hitTone)}>
              {pct1(row.hitRate)}
            </span>
            <span className="tabular-nums text-xs">{pct1(row.posteriorMean)}</span>
          </span>
        </div>
      </TableCell>

      {/* Desktop — 8 cột đầy đủ */}
      <TableCell className="hidden sm:table-cell">
        <div className="flex flex-col leading-tight">
          <span className="flex items-center gap-1.5">
            <span className="max-w-32 truncate text-xs font-semibold" title={row.name}>
              {row.name}
            </span>
            {!row.enoughData && (
              <Badge
                variant="outline"
                className="px-1 py-0 text-[9px] text-muted-foreground"
                title="Chưa đủ 5 lần kết toán để so sánh đáng tin cậy"
              >
                chưa đủ dữ liệu
              </Badge>
            )}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground" title={meta}>
            {row.gen1 ? `${row.gen1} · ` : ""}
            {row.code}
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs sm:table-cell">
        {nf0.format(row.pulls)}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className={cn("tabular-nums text-xs font-semibold", hitTone)}>
          {pct1(row.hitRate)}
        </span>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {row.brier == null ? "—" : nf2.format(row.brier)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground md:table-cell">
        {row.posteriorContribution == null ? "—" : nf2.format(row.posteriorContribution)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs sm:table-cell">
        <span
          className={cn(
            row.streak >= 3
              ? "font-semibold text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
          )}
          title="Số lần kết toán liên tiếp gần nhất có reward ≥ 0,5"
        >
          {nf0.format(row.streak)}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className="flex items-center gap-2">
          <Progress
            value={row.posteriorMean * 100}
            className="h-1.5 w-14 [&>div]:bg-emerald-600 dark:[&>div]:bg-emerald-400"
            aria-label={`Posterior bandit ${pct1(row.posteriorMean)}`}
          />
          <span className="tabular-nums text-xs font-semibold">
            {pct1(row.posteriorMean)}
          </span>
        </span>
      </TableCell>
      <TableCell
        className={cn(
          "hidden tabular-nums text-xs lg:table-cell",
          healthTone(row.healthScore)
        )}
      >
        {row.healthScore == null ? "—" : nf0.format(row.healthScore)}
      </TableCell>
    </TableRow>
  );
}

function ScorecardSkeleton() {
  return (
    <div
      className="flex flex-col gap-2 py-1"
      aria-busy="true"
      aria-label="Đang tải bảng điểm Hội đồng Nghiên cứu"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}

/* ═════════ A2 — Tab "Hiệu năng & calibration" (ML_OPS_BLUEPRINT §3) ═════════ */

/** GET /api/ml/analytics — shape hợp đồng với route A2 (types @/lib/ml/analytics). */

/** Màu chuỗi trajectory 6 arm — KHÔNG indigo/blue (chốt style scorecard). */
const ARM_LINE_COLORS: Record<string, string> = {
  "market-analyst": "#059669", // emerald-600
  "fair-value": "#d97706", // amber-600
  "news-sentiment": "#db2777", // pink-600
  liquidity: "#0d9488", // teal-600
  "risk-manager": "#e11d48", // rose-600
  "ml-forecast": "#7c3aed", // violet-600
};

/** Nhãn ngắn cột regime (tooltips dùng nhãn đầy đủ từ payload). */
const REGIME_SHORT_LABELS: Record<string, string> = {
  BULL_TREND: "Tăng",
  BEAR_TREND: "Giảm",
  SIDEWAYS: "Đi ngang",
  VOLATILE: "Biến động",
};

/** Tiêu đề khối con trong tab calibration — cùng nhịp section header roster. */
function AnalyticsSectionTitle({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h4>
  );
}

/** Badge "chưa đủ mẫu" (n < 30 — nguyên tắc §1.4 blueprint: kèm n, không bịa). */
function InsufficientBadge({ n }: { n: number }) {
  return (
    <Badge
      variant="outline"
      className="px-1 py-0 text-[9px] text-muted-foreground"
      title={`Chưa đủ 30 lần kết toán để so sánh đáng tin cậy (hiện n=${n})`}
    >
      chưa đủ mẫu
    </Badge>
  );
}

/** "48–74%" — khoảng Wilson 95% (0..1 → %). */
function wilsonRange(w: { lo: number; hi: number }): string {
  return `${nf0.format(w.lo * 100)}–${nf0.format(w.hi * 100)}%`;
}

/** Xanh ≥ 50% · đỏ < 50% · muted khi chưa có — cùng hitTone scorecard B8. */
function hitTone(hitRate: number | null): string {
  if (hitRate == null) return "text-muted-foreground";
  return hitRate >= 0.5
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

/**
 * A2 — khối "Hiệu năng & calibration" bên trong scorecard B8: Wilson CI
 * từng arm · Brier Murphy + calibration 5 bucket · ma trận agent × regime ·
 * posterior trajectory. TanStack Query "/api/ml/analytics" (TTL route 15s,
 * staleTime client 30s — cùng nhịp query scorecard). BanditEvent = 0 →
 * empty-state trung thực, KHÔNG hiển thị số 0 gây hiểu lầm.
 */
function PerformanceCalibration() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["ml-analytics"],
    queryFn: () => apiGet<AnalyticsPayload>("/api/ml/analytics"),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div
        className="flex flex-col gap-2 py-1"
        aria-busy="true"
        aria-label="Đang tải phân tích hiệu năng & calibration"
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded-lg border border-down/40 bg-down/10 p-4 text-sm text-down"
      >
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-40 flex-1 leading-relaxed">
          Không tải được phân tích hiệu năng &amp; calibration
          {error?.message ? ` — ${error.message}` : "."}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 gap-2 sm:min-h-9"
          onClick={() => void refetch()}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Thử lại
        </Button>
      </div>
    );
  }

  const payload = data;

  /* Trạng thái rỗng trung thực — BanditEvent chưa có settle nào (đo 10-10) */
  if (!payload || payload.totalSettled === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center">
        <Gauge className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          Chưa có phiếu bầu nào được kết toán — vòng học sẽ tự đóng sau 5 phiên
          giao dịch đầu tiên (dự kiến 2026-10-13 khi lịch settle 16:15 ICT chạy).
        </p>
        <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground/80">
          Wilson CI · Brier Murphy · calibration 5 mức · ma trận agent × chế độ
          thị trường sẽ tự hiển thị ngay sau những lần kết toán đầu tiên.
        </p>
      </div>
    );
  }

  // Sắp hit-rate giảm dần (null cuối) — cùng quy tắc tab "Bảng điểm".
  const arms = [...payload.arms].sort((a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1));
  const brierByCode = new Map(payload.brier.arms.map((b) => [b.code, b]));

  return (
    <div className="flex flex-col gap-5 pb-4">
      {/* 1. Hit-rate + Wilson 95% CI từng arm */}
      <section className="flex flex-col gap-2" aria-label="Hit-rate kèm Wilson 95% CI từng agent">
        <AnalyticsSectionTitle>Hit-rate 5 phiên · Wilson 95% CI</AnalyticsSectionTitle>
        <div className="overflow-x-auto custom-scrollbar rounded-lg border">
          <Table className="table-fixed sm:table-auto">
            <TableHeader>
              <TableRow className="hidden sm:table-row">
                <TableHead className="text-xs">Agent</TableHead>
                <TableHead className="text-xs">Hit-rate [CI 95%]</TableHead>
                <TableHead className="text-xs">Posterior</TableHead>
                <TableHead className="hidden text-xs md:table-cell">
                  Brier (nhị phân)
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {arms.map((a) => {
                const brier = brierByCode.get(a.code);
                const ci =
                  a.hitRate != null && a.wilson != null
                    ? `[${wilsonRange(a.wilson)}] · n=${nf0.format(a.pulls)}`
                    : `n=${nf0.format(a.pulls)}`;
                return (
                  <TableRow key={a.code} className={cn(a.insufficient && "opacity-60")}>
                    {/* Mobile — 1 hàng gộp */}
                    <TableCell colSpan={4} className="sm:hidden">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-xs font-semibold" title={a.name}>
                              {a.name}
                            </span>
                            {a.insufficient && <InsufficientBadge n={a.pulls} />}
                          </span>
                          <span className="tabular-nums text-[10px] text-muted-foreground">
                            {ci}
                          </span>
                        </div>
                        <span className="flex shrink-0 items-baseline gap-2">
                          <span className={cn("tabular-nums text-xs font-semibold", hitTone(a.hitRate))}>
                            {pct1(a.hitRate)}
                          </span>
                          <span className="tabular-nums text-[11px] text-muted-foreground">
                            P {pct1(a.posteriorMean)}
                          </span>
                        </span>
                      </div>
                    </TableCell>
                    {/* Desktop — 4 cột */}
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex flex-col leading-tight">
                        <span className="flex items-center gap-1.5">
                          <span className="max-w-32 truncate text-xs font-semibold" title={a.name}>
                            {a.name}
                          </span>
                          {a.insufficient && <InsufficientBadge n={a.pulls} />}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">{a.code}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="flex flex-col leading-tight">
                        <span className={cn("tabular-nums text-xs font-semibold", hitTone(a.hitRate))}>
                          {pct1(a.hitRate)}
                        </span>
                        <span className="tabular-nums text-[10px] text-muted-foreground">{ci}</span>
                      </span>
                    </TableCell>
                    <TableCell className="hidden tabular-nums text-xs sm:table-cell">
                      {pct1(a.posteriorMean)}
                    </TableCell>
                    <TableCell className="hidden tabular-nums text-xs text-muted-foreground md:table-cell">
                      {brier?.brier == null ? "—" : nf2.format(brier.brier)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* 2. Brier Murphy decomposition */}
      <section className="flex flex-col gap-2" aria-label="Phân rã Brier Murphy">
        <AnalyticsSectionTitle>Brier · phân rã Murphy</AnalyticsSectionTitle>
        {payload.brier.decomposition ? (
          <BrierDecompositionBlock d={payload.brier.decomposition} overall={payload.brier.overall} />
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Chưa có phiếu nào khai báo độ tin cậy (BanditEvent.confidence — B8
            lưu lúc cast) nên chưa tính được Brier/calibration.
          </p>
        )}
      </section>

      {/* 3. Calibration 5 bucket */}
      <section className="flex flex-col gap-2" aria-label="Calibration độ tin cậy khai báo">
        <AnalyticsSectionTitle>Calibration — tin cậy khai báo vs thực tế</AnalyticsSectionTitle>
        <CalibrationTable calibration={payload.calibration} />
      </section>

      {/* 4. Ma trận agent × regime */}
      <section className="flex flex-col gap-2" aria-label="Hiệu năng agent theo chế độ thị trường">
        <AnalyticsSectionTitle>Agent × chế độ thị trường (tại phiên cast)</AnalyticsSectionTitle>
        <RegimeMatrix table={payload.regimeTable} />
      </section>

      {/* 5. Posterior trajectory */}
      <section className="flex flex-col gap-2" aria-label="Quỹ đạo posterior từng agent">
        <AnalyticsSectionTitle>Quỹ đạo posterior theo lần kết toán</AnalyticsSectionTitle>
        <TrajectoryChart trajectory={payload.trajectory} />
      </section>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Hit-rate = mean reward (phiếu FLAT khớp = 0,7) · Wilson 95% CI trên
        hit-rate · Brier/calibration nhị phân hoá reward ≥ 0,5 · regime tính
        hồi PHIÊN CAST từ rổ top-10 HOSE (classifyRegime — cùng nguồn bằng
        chứng Bayes) · n &lt; 30 hiển thị “chưa đủ mẫu”.
      </p>
    </div>
  );
}

/** Dòng phân rã Murphy: 4 chỉ số + công thức đẳng thức (kiểm chứng bằng mắt). */
function BrierDecompositionBlock({
  d,
  overall,
}: {
  d: BrierDecomposition;
  overall: number | null;
}) {
  const stats: { label: string; value: string; hint: string }[] = [
    {
      label: "Brier thô",
      value: overall == null ? "—" : nf2.format(overall),
      hint: "mean (confidence − outcome)² theo confidence gốc",
    },
    {
      label: "Reliability",
      value: nf2.format(d.reliability),
      hint: "thấp = khai báo khớp thực tế",
    },
    {
      label: "Resolution",
      value: nf2.format(d.resolution),
      hint: "cao = bucket phân biệt được đúng/sai",
    },
    {
      label: "Uncertainty",
      value: nf2.format(d.uncertainty),
      hint: "độ khó nội tại của outcome",
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-lg border bg-muted/40 px-3 py-2 leading-tight"
            title={s.hint}
          >
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {s.label}
            </dt>
            <dd className="tabular-nums text-sm font-semibold">{s.value}</dd>
          </div>
        ))}
      </dl>
      <p className="tabular-nums text-[11px] leading-relaxed text-muted-foreground">
        Murphy: tổng = reliability − resolution + uncertainty →{" "}
        {nf2.format(d.brier)} = {nf2.format(d.reliability)} −{" "}
        {nf2.format(d.resolution)} + {nf2.format(d.uncertainty)} (n ={" "}
        {nf0.format(d.n)} mẫu; tổng lượng tử hoá theo bucket — Brier thô có thể
        lệch do confidence liên tục trong từng bucket).
      </p>
    </div>
  );
}

/** Bảng calibration 5 bucket: khai báo vs thực tế (kèm Wilson của thực tế). */
function CalibrationTable({ calibration }: { calibration: CalibrationBucket[] }) {
  return (
    <div className="overflow-x-auto custom-scrollbar rounded-lg border">
      <Table className="table-fixed sm:table-auto">
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Mức tin cậy</TableHead>
            <TableHead className="w-12 text-xs">n</TableHead>
            <TableHead className="text-xs">Khai báo</TableHead>
            <TableHead className="text-xs">Thực tế [CI 95%]</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {calibration.map((b) => (
            <TableRow key={b.label} className={cn(b.n === 0 && "opacity-50")}>
              <TableCell className="whitespace-nowrap text-xs">{b.label}</TableCell>
              <TableCell className="tabular-nums text-xs text-muted-foreground">
                {nf0.format(b.n)}
              </TableCell>
              <TableCell className="tabular-nums text-xs">
                {b.meanConfidence == null ? "—" : pct1(b.meanConfidence)}
              </TableCell>
              <TableCell>
                <span className="flex flex-col leading-tight">
                  <span className={cn("tabular-nums text-xs font-semibold", hitTone(b.meanOutcome))}>
                    {pct1(b.meanOutcome)}
                  </span>
                  <span className="tabular-nums text-[10px] text-muted-foreground">
                    {b.wilson == null ? "—" : `[${wilsonRange(b.wilson)}]`}
                  </span>
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Ma trận 6 arm × 4 regime — ô "—" khi n < 30 (trung thực, không bịa). */
function RegimeMatrix({ table }: { table: RegimeTable }) {
  if (!table.available) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Chưa đối chiếu được chế độ thị trường tại thời điểm các phiếu bầu —
        thử lại sau (dữ liệu chuỗi rổ top-10 HOSE đang thiếu).
      </p>
    );
  }
  return (
    <div className="overflow-x-auto custom-scrollbar rounded-lg border">
      <Table className="min-w-[30rem] table-fixed sm:table-auto">
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Agent</TableHead>
            {table.regimes.map((r) => (
              <TableHead key={r} className="text-xs" title={table.labels[r]}>
                {REGIME_SHORT_LABELS[r] ?? r}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row) => (
            <TableRow key={row.code}>
              <TableCell className="truncate text-xs font-semibold" title={row.name}>
                {row.name}
              </TableCell>
              {table.regimes.map((r) => {
                const c = row.cells[r];
                return (
                  <TableCell
                    key={r}
                    className={cn(
                      "tabular-nums text-xs",
                      c.insufficient && "text-muted-foreground"
                    )}
                    title={
                      c.insufficient
                        ? `n=${c.n} — chưa đủ mẫu (ngưỡng 30)`
                        : `Hit-rate ${pct1(c.hitRate)} · n=${c.n}`
                    }
                  >
                    {c.insufficient ? "—" : `${pct1(c.hitRate)} · n=${nf0.format(c.n)}`}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Gộp điểm trajectory các arm về trục thời gian chung cho recharts. */
function trajectoryChartData(
  trajectory: ArmTrajectory[]
): { t: number; [code: string]: number | null }[] {
  const times = new Set<number>();
  for (const a of trajectory) {
    for (const p of a.points) times.add(Date.parse(p.settledAt));
  }
  const sortedTimes = [...times].sort((x, y) => x - y);
  const valueByArm = new Map(
    trajectory.map((a) => [
      a.code,
      new Map(a.points.map((p) => [Date.parse(p.settledAt), p.posteriorMean])),
    ])
  );
  return sortedTimes.map((t) => {
    const row: { t: number; [code: string]: number | null } = { t };
    for (const [code, m] of valueByArm) row[code] = m.get(t) ?? null;
    return row;
  });
}

/** Đồ thị posterior từng arm theo timeline settle — thấy "từng tốt rồi sa sút". */
function TrajectoryChart({ trajectory }: { trajectory: ArmTrajectory[] }) {
  const data = useMemo(() => trajectoryChartData(trajectory), [trajectory]);
  const totalPoints = trajectory.reduce((s, a) => s + a.points.length, 0);
  if (data.length === 0 || totalPoints === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Chưa có điểm kết toán nào để vẽ quỹ đạo posterior.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {/* Chú giải chips — màu trùng chuỗi (touch không cần: chỉ hiển thị) */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {trajectory.map((a) => (
          <span
            key={a.code}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            title={a.name}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: ARM_LINE_COLORS[a.code] ?? "currentColor" }}
              aria-hidden="true"
            />
            {a.name}
          </span>
        ))}
      </div>
      <div
        className="h-56 w-full"
        role="img"
        aria-label="Đồ thị posterior Beta từng agent theo từng lần kết toán (0 đến 100%)"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 12, left: -18, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t: number) =>
                new Date(t).toLocaleDateString("vi-VN", {
                  day: "2-digit",
                  month: "2-digit",
                })
              }
              tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              minTickGap={32}
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.5, 1]}
              tickFormatter={(v: number) => `${nf0.format(v * 100)}%`}
              tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <Tooltip
              content={(props: TooltipContentProps) => {
                const { active, payload, label } = props;
                if (!active || !payload?.length || typeof label !== "number") return null;
                return (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
                    <p className="mb-1.5 font-medium tabular-nums">
                      {new Date(label).toLocaleDateString("vi-VN", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                      })}
                    </p>
                    {payload
                      .filter((p) => p.value != null)
                      .map((p) => {
                        const arm = trajectory.find((a) => a.code === p.dataKey);
                        return (
                          <p key={String(p.dataKey)} className="flex items-center gap-1.5 tabular-nums">
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: p.color }}
                              aria-hidden="true"
                            />
                            {arm?.name ?? String(p.dataKey)}:{" "}
                            <span className="font-semibold">{pct1(Number(p.value))}</span>
                          </p>
                        );
                      })}
                  </div>
                );
              }}
            />
            {trajectory.map((a) => (
              <Line
                key={a.code}
                dataKey={a.code}
                stroke={ARM_LINE_COLORS[a.code] ?? "var(--foreground)"}
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Mỗi điểm = posterior Beta(α+1, β+1) tích luỹ NGAY sau lần kết toán đó
        (0,5 = prior chưa học gì) — đường đi xuống cho thấy agent từng đúng
        rồi sa sút.
      </p>
    </div>
  );
}

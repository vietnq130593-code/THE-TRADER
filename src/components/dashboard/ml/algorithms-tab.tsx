"use client";

/**
 * ml/algorithms-tab.tsx (#89) — tab "Thuật toán": danh mục 10 thuật toán
 * ĐANG CHẠY trong code, mỗi cái kèm: file nguồn · hàm (tên thật trong code) ·
 * hằng số thật (mirror từng dòng code, có ghi chú file) · dòng trạng thái
 * sống khi có (đọc /api/ml/status).
 *
 * Trung thực: đây là bản đối chiếu CODE HIỆN HÀNH (không phải tài liệu cũ) —
 * hằng số hiển thị đúng những gì nn.ts/gru.ts/bandit.ts/rag.ts/ensemble.ts
 * đang dùng; phần nào tinh chỉnh được thì chip "tinh chỉnh" trỏ về tab
 * Tinh chỉnh.
 */

import * as React from "react";
import {
  ArrowRight,
  BookOpen,
  Database,
  Dumbbell,
  FlaskConical,
  FunctionSquare,
  GitBranch,
  Scale,
  ShieldCheck,
  Waves,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useMlStatus } from "@/hooks/use-ml";
import { cn } from "@/lib/utils";
import { nf0 } from "./shared";

interface AlgoConst {
  label: string;
  value: string;
}

interface AlgoSpec {
  id: string;
  title: string;
  file: string;
  icon: React.ReactNode;
  desc: string;
  consts: AlgoConst[];
  functions: string[];
  tunable?: boolean;
  live?: string | null;
}

function AlgoCard({ spec }: { spec: AlgoSpec }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-muted/20 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
          {spec.icon}
        </span>
        <h4 className="text-sm font-semibold">{spec.title}</h4>
        <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
          {spec.file}
        </Badge>
        {spec.tunable && (
          <Badge className="bg-amber-500/15 text-[10px] text-amber-700 hover:bg-amber-500/15 dark:text-amber-400">
            tinh chỉnh được — tab Tinh chỉnh
          </Badge>
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{spec.desc}</p>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
        {spec.consts.map((c) => (
          <div key={c.label} className="rounded-md border bg-background/60 px-2 py-1.5">
            <div className="truncate text-[10px] text-muted-foreground" title={c.label}>
              {c.label}
            </div>
            <div className="truncate font-mono text-xs font-semibold tabular-nums" title={c.value}>
              {c.value}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
          <FunctionSquare className="size-3" aria-hidden="true" />
          Hàm:
        </span>
        {spec.functions.map((fn) => (
          <Badge key={fn} variant="outline" className="font-mono text-[10px]">
            {fn}
          </Badge>
        ))}
      </div>

      {spec.live && (
        <p className="rounded-md border border-dashed px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Hiện tại:</span> {spec.live}
        </p>
      )}
    </div>
  );
}

export function AlgorithmsTab() {
  const { data } = useMlStatus();

  const specs: AlgoSpec[] = [
    {
      id: "adam",
      title: "Backpropagation + Adam (MLP)",
      file: "src/lib/ml/nn.ts",
      icon: <GitBranch className="size-4" />,
      desc: "Backprop viết tay (cross-entropy có class-weight 1/tần suất) + tối ưu Adam. Cut 80/20 THEO THỜI GIAN (val = block cuối), shuffle chỉ trong train split, early-stop theo valLoss, khôi phục trọng số tốt nhất. He-normal init, seed 42 → deterministic.",
      consts: [
        { label: "lr (mặc định)", value: "0,01" },
        { label: "Adam β₁ · β₂ · ε", value: "0,9 · 0,999 · 1e-8" },
        { label: "batch · epoch tối đa", value: "32 · 60" },
        { label: "patience early-stop", value: "12" },
        { label: "seed RNG", value: "42 (mulberry32)" },
        { label: "tỉ lệ val", value: "0,2 (theo thời gian)" },
      ],
      functions: ["MLP.fit()", "MLP.forward()", "MLP.predictProba()", "MLP.toJSON()", "MLP.fromJSON()"],
      tunable: true,
      live: data?.dlMlp
        ? `Bản serving v${data.dlMlp.version}: ${nf0.format(data.dlMlp.metrics.epochs)} epoch chạy · ${nf0.format(data.dlMlp.metrics.samples)} mẫu · valAcc ${((data.dlMlp.metrics.valAcc ?? 0) * 100).toFixed(1).replace(".", ",")}%.`
        : null,
    },
    {
      id: "softmax",
      title: "ReLU + softmax (lan truyền xuôi)",
      file: "src/lib/ml/nn.ts",
      icon: <Waves className="size-4" />,
      desc: "Lan truyền xuôi 3 lớp: ReLU ở 2 lớp ẩn (giữ nét tuyến tính từng phần), softmax ổn định số học (trừ max trước khi mũ hoá) ra 3 xác suất [Tăng, Đi ngang, Giảm]. predictProba tự áp z-score norm nhúng trong mô hình.",
      consts: [
        { label: "lớp kích hoạt ẩn", value: "ReLU" },
        { label: "lớp ra", value: "softmax 3 lớp" },
        { label: "chuẩn hoá đầu vào", value: "z-score (mean/std TRAIN)" },
        { label: "clip xác suất", value: "max(p, 1e-12)" },
      ],
      functions: ["softmax()", "applyNormInternal()", "predictBatch()"],
    },
    {
      id: "gru",
      title: "GRU BPTT viết tay (giọng thứ ba)",
      file: "src/lib/ml/gru.ts",
      icon: <Waves className="size-4" />,
      desc: "GRU-24 backprop qua thời gian viết tay (không thư viện): 3 cổng z/r/h, gradient check khớp giải tích (rel ≤ 2,1e-6), dropout đầu vào 0,2. CHỈ train khi cổng bằng chứng B2 PASS — shadow 60 phiên, kill-switch tệ-hơn-5-phiên.",
      consts: [
        { label: "cấu trúc", value: "16 → GRU 24 → 8 → 3" },
        { label: "tham số", value: "3.179" },
        { label: "window chuỗi", value: "20 phiên" },
        { label: "lr · batch", value: "0,005 · 32" },
        { label: "dropout đầu vào", value: "0,2" },
        { label: "seed RNG", value: "43" },
      ],
      functions: ["GRU.fit()", "GRU.predictProba()", "GRU.toJSON()", "GRU.fromJSON()"],
      live: data?.gru
        ? `v${data.gru.version} · ${data.gru.enabled ? "đang phục vụ" : `shadow ${data.gru.shadowSettled}/60 phiên`} · kill-switch tắt được ở tab Tinh chỉnh.`
        : "Chưa từng train — cổng bằng chứng B2 chưa mở (nguyên tắc §1.8: không mở vì 'hay để có').",
    },
    {
      id: "ensemble",
      title: "Ensemble 2/3 giọng + deadband",
      file: "src/lib/ml/ensemble.ts",
      icon: <Scale className="size-4" />,
      desc: "Kết hợp MLP (softmax) · GRU (khi bật) · hồi quy tuyến tính proj₅ của rổ top-10. Điểm −1…+1, |điểm| < deadband → Đi ngang. Silent-linreg fallback khi chưa có bản serving — hệ thống không bao giờ 'không có ý kiến'.",
      consts: [
        { label: "2 giọng", value: "0,7·MLP + 0,3·linreg" },
        { label: "3 giọng (GRU bật)", value: "0,5·MLP + 0,2·GRU + 0,3·linreg" },
        { label: "deadband Đi ngang", value: "±0,05" },
        { label: "cửa sổ proj₅", value: "60 phiên" },
        { label: "shadow tối thiểu", value: "60 phiên" },
        { label: "kill-switch tệ hơn", value: "5 phiên liên tiếp" },
      ],
      functions: ["mlForecastEnsemble()", "shadowTick()", "readGruSetting()", "writeGruSetting()"],
      live:
        data?.gru?.enabled === true
          ? "Đang chạy 3 giọng (GRU tham gia điểm rổ)."
          : "Đang chạy 2 giọng — GRU ở shadow hoặc tắt.",
    },
    {
      id: "rag",
      title: "BM25 RAG + recency (L1)",
      file: "src/lib/ml/rag.ts",
      icon: <BookOpen className="size-4" />,
      desc: "Truy hồi tri thức: corpus 500 tin broadcast + 200 tin tức, tokeniser tiếng Việt, xếp hạng hybrid BM25 × độ tươi (nửa đời 72h). Top-K tiêm prompt 5 agent nghiên cứu + Chủ tịch mỗi chu kỳ (cap 3.000 ký tự ≈ 1.200 token). Ghi RetrievalLog đo lường.",
      consts: [
        { label: "công thức", value: "(1−w)·BM25 + w·recency" },
        { label: "k₁ · b (mặc định)", value: "1,5 · 0,75" },
        { label: "w recency (mặc định)", value: "0,3" },
        { label: "nửa đời recency", value: "72 giờ" },
        { label: "top-K (mặc định)", value: "8" },
        { label: "cap khối prompt", value: "3.000 ký tự" },
      ],
      functions: ["loadRagCorpus()", "bm25Score()", "rankRag()", "formatRagBlock()", "retrieveForCycle()", "ragStats()"],
      tunable: true,
      live: data?.rag
        ? `Corpus ${nf0.format(data.rag.corpusMessages + data.rag.corpusNews)} docs · 30 ngày: ${nf0.format(data.rag.retrievals30d)} lần truy hồi.`
        : null,
    },
    {
      id: "bandit",
      title: "Thompson sampling Beta-Bernoulli",
      file: "src/lib/ml/bandit.ts",
      icon: <Scale className="size-4" />,
      desc: "Trọng số phiếu LLM: mỗi agent là một arm, posterior Beta(α+1, β+1). Kết toán: phiếu đúng hướng sau 5 phiên → reward 1, sai → 0, GIỮ đúng → 0,7, GIỮ sai → 0,2. Chuỗi hoá bằng promise-chain (idempotent 3 caller).",
      consts: [
        { label: "prior", value: "Beta(1, 1)" },
        { label: "số arm", value: "6 agent" },
        { label: "kết toán sau", value: "5 phiên" },
        { label: "ngưỡng ± của rổ", value: "0,5%" },
        { label: "reward GIỮ đúng/sai", value: "0,7 / 0,2" },
        { label: "quét mỗi lần", value: "30 assessment" },
      ],
      functions: ["ensureArms()", "settlePendingRewards()", "banditSnapshot()", "pendingSettleCount()"],
      live: data?.bandit
        ? `${data.bandit.arms.length} arms · posterior cao nhất: ${[...data.bandit.arms].sort((a, b) => b.posteriorMean - a.posteriorMean)[0]?.agentCode ?? "—"}.`
        : null,
    },
    {
      id: "rl",
      title: "Q-learning tabular (Gym)",
      file: "src/lib/ml/rl.ts",
      icon: <Dumbbell className="size-4" />,
      desc: "Học tăng cường trên rổ top-10: không gian 48 trạng thái (xu hướng × bucket RSI rổ × động lượng 5 phiên × phơi nhiễm) × 3 hành động (giảm/hold/tăng exposure ±0,5). ε-greedy decay qua episodes, Q-table lưu MlModel kind rl-q.",
      consts: [
        { label: "không gian", value: "48 trạng thái" },
        { label: "hành động", value: "3 (±0,5 exposure)" },
        { label: "rổ huấn luyện", value: "top-10 thanh khoản" },
        { label: "chính sách", value: "ε-greedy (decay)" },
      ],
      functions: ["trainQTable()", "buildBasket()", "policyStance()"],
      live: data?.rlQ
        ? `v${data.rlQ.version}: ${nf0.format(data.rlQ.metrics.episodes)} episodes · stance ${data.rlQ.metrics.stance} · phơi nhiễm ${((data.rlQ.metrics.exposure ?? 0) * 100).toFixed(0)}%.`
        : null,
    },
    {
      id: "gate",
      title: "Cổng bằng chứng chuỗi (B2)",
      file: "scripts/ml-evidence-gate.ts",
      icon: <ShieldCheck className="size-4" />,
      desc: "Trước khi đổi bộ đặc trưng/ mở mô hình chuỗi: đo ΔBrier paired bootstrap 1.000× (deterministic) giữa v2-lag16 và v1-lag10 trên cùng cửa sổ, rank-IC Spearman từng đặc trưng mới, autocorrelation lag 1-5. Verdict PASS/FAIL ghi AppSetting ml-gate.",
      consts: [
        { label: "bootstrap", value: "1.000× paired" },
        { label: "ngưỡng |IC|", value: "≥ 0,02" },
        { label: "đặc trưng cần ý nghĩa", value: "≥ 3/6" },
        { label: "chu kỳ re-đo", value: "mỗi quý" },
      ],
      functions: ["ml-evidence-gate.ts (CLI)", "gateVerdictOf()"],
      live: data?.gate?.available === true
        ? `Verdict ${data.gate.verdict} · ΔBrier CI [${data.gate.deltaBrier.ciLow.toFixed(4).replace(".", ",")}; ${data.gate.deltaBrier.ciHigh.toFixed(4).replace(".", ",")}].`
        : "Chưa đo — chạy scripts/ml-evidence-gate.ts khi bản v2-lag16 đã train.",
    },
    {
      id: "psi",
      title: "PSI drift giám sát đặc trưng",
      file: "src/lib/ml/psi.ts",
      icon: <FlaskConical className="size-4" />,
      desc: "Population Stability Index trên histogram 10 bucket của TRAIN split (lưu trong meta mỗi bản train) so với 30 phiên gần nhất — phát hiện đặc trưng dịch chuyển phân phối: ổn < 0,1 · cảnh báo < 0,25 · dịch chuyển ≥ 0,25 (đề xuất train lại).",
      consts: [
        { label: "bucket histogram", value: "10 quantile" },
        { label: "cửa sổ so", value: "30 phiên" },
        { label: "ngưỡng cảnh báo", value: "PSI 0,1" },
        { label: "ngưỡng dịch chuyển", value: "PSI 0,25" },
      ],
      functions: ["psi.ts — driftOf()", "computeFeatureHist() (train route)"],
      live: null,
    },
    {
      id: "intraday",
      title: "Gom bar 5-phút từ tick",
      file: "src/lib/ml/intraday.ts",
      icon: <Database className="size-4" />,
      desc: "Tick 10s trong phiên gom thành bar 5-phút (bucket UTC floor, volume = delta dồn trong phiên, nguồn trung thực simulated/realtime). Ghi 0 DB trong phiên (cache in-process), flush theo chunk — cổng 'Lớp chuỗi đầy đủ' cho GRU.",
      consts: [
        { label: "bucket", value: "5 phút (UTC)" },
        { label: "flush chunk", value: "10 bar" },
        { label: "safety flush", value: "120 giây" },
        { label: "đóng sổ ngoài phiên", value: "có" },
      ],
      functions: ["recordIntradayTick()", "flushQueue()", "intradayStats()"],
      live: data?.intraday
        ? data.intraday.bars > 0
          ? `${nf0.format(data.intraday.bars)} bar · ${nf0.format(data.intraday.symbols)} mã · phiên gần nhất ${nf0.format(data.intraday.lastDayBars)} bar.`
          : "Chưa có bar — chờ phiên giao dịch đầu tiên (tick 10s chỉ chạy trong phiên)."
        : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {specs.length} thuật toán đang chạy trong code hệ thống — hằng số hiển thị
        đúng giá trị nguồn (file ghi ở mỗi thẻ). Thẻ nào gắn chip{" "}
        <span className="font-medium text-amber-700 dark:text-amber-400">tinh chỉnh được</span>{" "}
        thì đổi giá trị ở tab Tinh chỉnh (áp dụng từ lần huấn luyện/truy hồi kế tiếp).
      </p>
      <div className={cn("grid gap-3 xl:grid-cols-2")}>
        {specs.map((spec) => (
          <AlgoCard key={spec.id} spec={spec} />
        ))}
      </div>
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ArrowRight className="size-3.5" aria-hidden="true" />
        Sơ đồ kiến trúc mạng + trọng số thật: tab Mạng thần kinh · cấu trúc bảng
        dữ liệu: tab Dữ liệu &amp; kiến trúc.
      </p>
    </div>
  );
}

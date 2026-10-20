/**
 * src/lib/bayes/synthesis.ts — BỘ TỔNG HỢP BAYES THEO 3 BẬC NHÂN QUẢ (phiên #34
 * · mở rộng B5 multi-segment #38 — MARKET_EXPANSION_BLUEPRINT §3.4).
 *
 * ENGINE LOG-ODDS THUẦN (không DB, deterministic — 0 LLM):
 *
 *   BẬC 0 · TIÊN NGHIỆM (per-segment B5)
 *     L_up = logit(pUp_baseRate); L_down = logit(pDown_baseRate)
 *     — base-rate đo từ tần suất thật 250 phiên của RỔ SEGMENT đó.
 *
 *   BẬC 1 · THỊ TRƯỜNG — mỗi bằng chứng market của segment:
 *     shift = weight × ln(LR)
 *     direction UP   → L_up += shift ; L_down −= shift
 *     direction DOWN → L_down += shift ; L_up −= shift
 *     direction FLAT → không dịch log-odds (chỉ hiện diện trong drivers)
 *     pUp = σ(L_up); pDown = σ(L_down); pFlat = max(0, 1 − pUp − pDown);
 *     chuẩn hoá 3 số cộng đúng = 1.
 *
 *   COMPOSITE VN (B5 §3.4) = trung bình TRỌNG SỐ posterior 5 segment:
 *     w_HOSE/HNX/UPCOM-STOCK/ETF = Σ ADTV VND rổ (đo thật);
 *     w_INDEX = 0,05 × số index (không đo được thì cố định khiêm tốn, không bịa);
 *     composite = Σ wᵢ·posteriorᵢ / Σ wᵢ → TÁI CHUẨN HOÁ pUp+pDown+pFlat = 1
 *     (dùng cho bandit settle + narrative — giữ tương thích chuỗi lịch sử).
 *
 *   BẬC 2 · NGÀNH (kế thừa logits segment chính VN-HOSE-STOCK) — sector
 *     posterior = market posterior + dịch theo momentum trung bình ngành:
 *     evidence ảo LR = exp(0.4×|mom|) cap 1.6 (mom > 0 nghiêng UP).
 *
 *   BẬC 3 · CỔ PHIẾU (kế thừa logits segment chính) — symbol posterior khởi từ
 *     posterior THỊ TRƯỜNG (kế thừa nhân quả), cộng bằng chứng symbol-level,
 *     rồi σ + chuẩn hoá.
 *
 *   CONFIDENCE   = 1 − H(p)/ln(3)          (entropy 3 lớp chuẩn hoá — composite)
 *   DISAGREEMENT = 1 − |Σ wᵢ·dirᵢ| / Σ wᵢ  (dir ∈ {+1,0,−1}; chỉ agentVotes)
 *   SENSITIVITY  = Δᵢ = weight × ln(LR)    (drivers sắp |Δ| giảm dần, top 12)
 *   FORECAST5D   = trung bình trọng số ADTV dự báo Holt top thanh khoản HOSE
 *
 * RÀNG BUỘC SỐ HỌC: |L| sau cộng mọi evidence ≤ 4.0 (clamp); LR ∈ [0.5, 3.0];
 * weight ∈ [0.3, 1.0].
 */

import { entropy, logit, sigmoid } from "@/lib/quant/statistics";
import type {
  AgentVote,
  BayesEvidence,
  SegmentInput,
  SymbolEvidence,
  SynthesisInput,
  SynthesisOutput,
} from "@/lib/bayes/types";
import type {
  BayesDriver,
  ConsensusSnapshot,
  ConsensusVote,
  SegmentAssessment,
  SymbolAssessment,
} from "@/lib/types";

import {
  CONSENSUS_EPSILON,
  CONSENSUS_MIN_POOL,
  CONSENSUS_POOL_SIZE,
  CONSENSUS_THRESHOLD,
  WEAK_MAJORITY_THRESHOLD,
} from "@/lib/consensus";

/* ─────────────────────────── Hằng số ràng buộc ─────────────────────────── */

/** |L| tối đa sau khi cộng mọi bằng chứng — tránh posterior 0/999. */
const LOGIT_CLAMP = 4.0;
/** LR hợp lệ ∈ [0.5, 3.0]. */
const LR_MIN = 0.5;
const LR_MAX = 3.0;
/** Weight hợp lệ ∈ [0.3, 1.0]. */
const WEIGHT_MIN = 0.3;
const WEIGHT_MAX = 1.0;
/** Bậc 2: hệ số dịch log-odds theo momentum ngành. */
const SECTOR_MOM_COEF = 0.4;
/** Bậc 2: LR bằng chứng ảo ngành tối đa 1.6 → Δ tối đa = ln(1.6). */
const SECTOR_LR_CAP = 1.6;
/** Số drivers giữ lại trong output. */
const DRIVER_TOP_N = 12;
/** Ngưỡng chênh lệch posterior để ra stance BUY/SELL. */
const STANCE_MARGIN = 0.12;

/* ─────────────────────────── Tiện ích thuần ─────────────────────────── */

/** Phần trăm dấu phẩy thập phân kiểu Việt Nam (61.2 → "61,2%"). */
function pctVi(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits).replace(".", ",")}%`;
}

/** Làm sạch 1 bằng chứng: kẹp LR/weight về biên hợp lệ; bỏ nếu vô hạn. */
function sanitizeEvidence(e: BayesEvidence): BayesEvidence | null {
  const lr = Number(e.likelihoodRatio);
  const w = Number(e.weight);
  if (!Number.isFinite(lr) || lr <= 0) return null;
  if (!Number.isFinite(w)) return null;
  return {
    ...e,
    likelihoodRatio: Math.min(LR_MAX, Math.max(LR_MIN, lr)),
    weight: Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w)),
  };
}

/** Dịch log-odds theo một bằng chứng (UP đẩy L_up lên, DOWN đẩy L_down lên). */
function shiftLogOdds(
  L: { up: number; down: number },
  e: BayesEvidence
): { up: number; down: number } {
  if (e.direction === "FLAT") return L;
  const delta = e.weight * Math.log(e.likelihoodRatio);
  if (e.direction === "UP") return { up: L.up + delta, down: L.down - delta };
  return { up: L.up - delta, down: L.down + delta };
}

/** Kẹp biên logit ±4.0. */
function clampLogits(L: { up: number; down: number }): { up: number; down: number } {
  return {
    up: Math.min(LOGIT_CLAMP, Math.max(-LOGIT_CLAMP, L.up)),
    down: Math.min(LOGIT_CLAMP, Math.max(-LOGIT_CLAMP, L.down)),
  };
}

/** Từ 2 log-odds → phân phối 3 lớp chuẩn hoá (cộng đúng 1). */
function posteriorFromLogits(L: { up: number; down: number }): {
  pUp: number;
  pDown: number;
  pFlat: number;
} {
  const pUp = sigmoid(L.up);
  const pDown = sigmoid(L.down);
  const pFlat = Math.max(0, 1 - pUp - pDown);
  const total = pUp + pDown + pFlat;
  if (total <= 0) return { pUp: 1 / 3, pDown: 1 / 3, pFlat: 1 / 3 };
  return { pUp: pUp / total, pDown: pDown / total, pFlat: pFlat / total };
}

/** Đóng góp có dấu vào L_up của một bằng chứng (dùng cho sensitivity). */
function signedDelta(e: BayesEvidence): number {
  if (e.direction === "FLAT") return 0;
  const mag = e.weight * Math.log(e.likelihoodRatio);
  return e.direction === "UP" ? mag : -mag;
}

/** Chạy Bậc 0 + Bậc 1 cho MỘT segment: prior → cộng bằng chứng → posterior. */
function runSegmentLevel(
  prior: { pUp: number; pDown: number },
  rawEvidence: BayesEvidence[]
): {
  L: { up: number; down: number };
  posterior: { pUp: number; pDown: number; pFlat: number };
  evidence: BayesEvidence[];
} {
  const evidence = rawEvidence
    .map(sanitizeEvidence)
    .filter((e): e is BayesEvidence => e !== null);
  let L = { up: logit(prior.pUp), down: logit(prior.pDown) };
  for (const e of evidence) {
    L = shiftLogOdds(L, e);
  }
  L = clampLogits(L);
  return { L, posterior: posteriorFromLogits(L), evidence };
}

/** Hợp thành VN (§3.4): trung bình trọng số + TÁI CHUẨN HOÁ Σ=1. */
function compositeFromSegments(
  weighted: { weight: number; posterior: { pUp: number; pDown: number; pFlat: number } }[]
): { pUp: number; pDown: number; pFlat: number } | null {
  const usable = weighted.filter((w) => w.weight > 0);
  if (usable.length === 0) return null;
  const wSum = usable.reduce((s, w) => s + w.weight, 0);
  if (!(wSum > 0)) return null;
  let pUp = 0;
  let pDown = 0;
  let pFlat = 0;
  for (const w of usable) {
    pUp += w.weight * w.posterior.pUp;
    pDown += w.weight * w.posterior.pDown;
    pFlat += w.weight * w.posterior.pFlat;
  }
  pUp /= wSum;
  pDown /= wSum;
  pFlat /= wSum;
  // Tái chuẩn hoá chống trôi dấu phẩy động (§3.4)
  const total = pUp + pDown + pFlat;
  if (total <= 0) return { pUp: 1 / 3, pDown: 1 / 3, pFlat: 1 / 3 };
  return { pUp: pUp / total, pDown: pDown / total, pFlat: pFlat / total };
}

/* ───────────────────── B9 · CỔNG ĐỒNG THUẬN 80% (§3.5) ───────────────── */

/**
 * Tính tally + consensusRatio + gate trên pool 7 cử tri (6 LLM + ml-forecast —
 * #126 thêm A20 macro-economist). Trả null khi chưa có phiếu nào (DB trống)
 * — gate không áp đảo lên dữ liệu cũ.
 */
function computeConsensus(votes: AgentVote[], enforce: boolean): ConsensusSnapshot | null {
  if (votes.length === 0) return null;

  const tally: ConsensusVote[] = votes.map((v) => ({
    code: v.code,
    agentName: v.agentName,
    gen1: v.gen1,
    direction: v.direction,
    // wᵢ = clamp(health/100 × posteriorMean bandit, 0.3, 1) — evidence.ts điền;
    // thiếu (legacy) → 0,5 trung tính
    weight: Math.min(1, Math.max(0.3, v.weight ?? 0.5)),
    model: v.code === "ml-forecast" ? "ml" : "llm",
  }));

  const S = { UP: 0, DOWN: 0, FLAT: 0 } as Record<ConsensusVote["direction"], number>;
  let sumW = 0;
  for (const t of tally) {
    S[t.direction] += t.weight;
    sumW += t.weight;
  }
  const dominant: ConsensusVote["direction"] =
    S.UP >= S.DOWN && S.UP >= S.FLAT ? "UP" : S.DOWN >= S.FLAT ? "DOWN" : "FLAT";
  const ratio = sumW > 0 ? S[dominant] / sumW : 0;
  const present = tally.length;

  // Khoảng đóng + epsilon 1e⁻⁹ (v1.1 — tránh dải chết 0,7999…)
  let gate: ConsensusSnapshot["gate"];
  if (present < CONSENSUS_MIN_POOL) {
    gate = "NO_CONSENSUS"; // fail-safe: pool < 4 cử tri có mặt
  } else if (ratio >= CONSENSUS_THRESHOLD - CONSENSUS_EPSILON) {
    gate = "CONSENSUS";
  } else if (ratio >= WEAK_MAJORITY_THRESHOLD - CONSENSUS_EPSILON) {
    gate = "WEAK_MAJORITY";
  } else {
    gate = "NO_CONSENSUS";
  }

  const gateLabel =
    gate === "CONSENSUS"
      ? "ĐỒNG THUẬN (≥ 80%)"
      : gate === "WEAK_MAJORITY"
        ? "ĐA SỐ YẾU (50–79,9%) — tín hiệu ép GIỮ"
        : "KHÔNG ĐỒNG THUẬN (< 50%) — GIỮ";

  // Tín hiệu MỚI (BUY/SELL) khi gate ≠ CONSENSUS sẽ bị ép HOLD khi enforce
  const wouldBlock = gate !== "CONSENSUS";

  const dirVi = dominant === "UP" ? "tăng" : dominant === "DOWN" ? "giảm" : "đi ngang";
  const note =
    present < CONSENSUS_MIN_POOL
      ? `Chỉ ${present}/${CONSENSUS_POOL_SIZE} cử tri có mặt (< ${CONSENSUS_MIN_POOL}) → coi như KHÔNG ĐỒNG THUẬN (fail-safe).`
      : `${present}/${CONSENSUS_POOL_SIZE} cử tri · số đông nghiêng ${dirVi} với tỉ lệ trọng số ${(ratio * 100).toFixed(1).replace(".", ",")}% → ${gateLabel}.${wouldBlock ? " Tín hiệu MỚI sẽ bị ép GIỮ khi bật enforcement" + (enforce ? " (đang BẬT)" : " (hiện shadow — đã-sẽ-chặn)") : " Tín hiệu được phép EXECUTE nếu posterior đạt stance"}.`;

  return {
    ratio: Number(ratio.toFixed(6)),
    // F-151-1 (Task 152) — đưa dominant ra snapshot để persist bind vào Signal:
    // gate CONSENSUS chỉ được duyệt lệnh khi hướng số đông khớp hướng tín hiệu.
    dominant,
    gate,
    gateLabel,
    tally,
    present,
    shadow: !enforce,
    wouldBlock,
    note,
  };
}

/* ─────────────────────────── Engine chính ─────────────────────────── */

/**
 * Tổng hợp nhận định thị trường từ bundle bằng chứng — trả MarketAssessmentView
 * (id/createdAt/source/cycleRunId là placeholder; persist.ts điền giá trị DB).
 */
export function synthesizeMarketAssessment(input: SynthesisInput): SynthesisOutput {
  const marketEvidence = input.marketEvidence
    .map(sanitizeEvidence)
    .filter((e): e is BayesEvidence => e !== null);
  const symbolEvidence = input.symbolEvidence
    .map(sanitizeEvidence)
    .filter((e): e is SymbolEvidence => e !== null);

  /* ── BẬC 0+1 · SEGMENT CHÍNH VN-HOSE-STOCK (continuation chuỗi #34) ─── */
  const prior = input.prior;
  const hoseResult = runSegmentLevel(prior, marketEvidence);
  const L = hoseResult.L; // Bậc 2/3 kế thừa logits segment chính (nhân quả HOSE)

  /* ── B5 · PER-SEGMENT POSTERIOR + COMPOSITE VN ──────────────────────── */
  const segmentInputs: SegmentInput[] = input.segments ?? [];
  const segmentRuns = segmentInputs.map((seg) => ({
    seg,
    run: runSegmentLevel(seg.prior, seg.evidence),
  }));
  // segment chính đã có kết quả riêng (hoseResult) — thay để tránh tính 2 lần
  const hoseRunIdx = segmentRuns.findIndex((r) => r.seg.segment === "VN-HOSE-STOCK");
  if (hoseRunIdx >= 0) {
    segmentRuns[hoseRunIdx] = {
      seg: segmentRuns[hoseRunIdx].seg,
      run: { ...hoseResult, evidence: hoseResult.evidence },
    };
  }

  const composite = compositeFromSegments(
    segmentRuns
      .filter((r) => r.seg.symbolCount > 0 && r.seg.compositeWeight > 0)
      .map((r) => ({ weight: r.seg.compositeWeight, posterior: r.run.posterior }))
  );
  // Fallback: không có segment (legacy input) hoặc DB rỗng → posterior segment chính
  const marketPosterior = composite ?? hoseResult.posterior;

  const marketDirection: SynthesisOutput["marketDirection"] =
    marketPosterior.pUp > marketPosterior.pDown && marketPosterior.pUp > marketPosterior.pFlat
      ? "BULLISH"
      : marketPosterior.pDown > marketPosterior.pUp && marketPosterior.pDown > marketPosterior.pFlat
        ? "BEARISH"
        : "NEUTRAL";

  /* ── CONFIDENCE = 1 − H(p)/ln(3) — trên COMPOSITE ───────────────────── */
  const rawConfidence =
    1 - entropy([marketPosterior.pUp, marketPosterior.pDown, marketPosterior.pFlat]) / Math.log(3);
  const confidence = Math.min(1, Math.max(0, rawConfidence));

  /* ── DISAGREEMENT = phân hoá phiếu có trọng số của agents ──────────── */
  let disagreement = 0;
  if (input.agentVotes.length > 0) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const v of input.agentVotes) {
      const dir = v.direction === "UP" ? 1 : v.direction === "DOWN" ? -1 : 0;
      // Trọng số phiếu = độ tự tin × độ tin cậy vận hành (successRate 0 → 0.5 mặc định)
      const w =
        Math.max(0, Math.min(1, v.confidence)) * (v.successRate > 0 ? v.successRate : 0.5);
      weightedSum += w * dir;
      totalWeight += w;
    }
    disagreement = totalWeight > 0 ? 1 - Math.abs(weightedSum) / totalWeight : 0;
  }
  disagreement = Math.min(1, Math.max(0, disagreement));

  /* ── B9 · CỔNG ĐỒNG THUẬN 80% trên agentVotes (6 cử tri) ──────────── */
  const consensus = computeConsensus(input.agentVotes, input.consensusEnforce ?? false);

  /* ── SENSITIVITY · drivers sắp |Δ| giảm dần (top 12) ────────────────── */
  const allEvidence: BayesEvidence[] = [...marketEvidence, ...symbolEvidence];
  const drivers: BayesDriver[] = allEvidence
    .map((e) => ({
      source: e.source,
      agentName: e.agentName,
      gen1: e.gen1,
      level: e.level,
      symbol: e.level === "symbol" ? e.symbol ?? null : null,
      direction: e.direction,
      weight: Number(e.weight.toFixed(3)),
      likelihoodRatio: Number(e.likelihoodRatio.toFixed(3)),
      deltaLogOdds: Number(signedDelta(e).toFixed(4)),
      note: e.note,
    }))
    .sort((a, b) => Math.abs(b.deltaLogOdds) - Math.abs(a.deltaLogOdds))
    .slice(0, DRIVER_TOP_N);

  /* ── B5 · detail.segments[] (6 dòng: 5 segment + composite) ─────────── */
  const segmentsOut: SegmentAssessment[] = segmentRuns
    .filter((r) => r.seg.symbolCount > 0 || r.seg.segment === "VN-HOSE-STOCK")
    .map((r) => {
      const p = r.run.posterior;
      const dir: SegmentAssessment["marketDirection"] =
        p.pUp > p.pDown && p.pUp > p.pFlat
          ? "BULLISH"
          : p.pDown > p.pUp && p.pDown > p.pFlat
            ? "BEARISH"
            : "NEUTRAL";
      // 1 dòng note (chairman prompt + UI): posterior + bằng chứng mạnh nhất
      const top = [...r.run.evidence]
        .sort((a, b) => Math.abs(signedDelta(b)) - Math.abs(signedDelta(a)))
        .slice(0, 1)[0];
      return {
        segment: r.seg.segment,
        label: r.seg.label,
        symbolCount: r.seg.symbolCount,
        pUp: Number(p.pUp.toFixed(4)),
        pDown: Number(p.pDown.toFixed(4)),
        pFlat: Number(p.pFlat.toFixed(4)),
        marketDirection: dir,
        // B13: INTERNATIONAL = null (tham khảo, không vào composite VN);
        // segment VN khác có dữ liệu = trọng số thô (ADTV / 0,05×index)
        compositeWeight:
          r.seg.segment === "INTERNATIONAL"
            ? null
            : r.seg.compositeWeight > 0
              ? Number(r.seg.compositeWeight)
              : 0,
        note: `${pctVi(p.pUp)} tăng · ${pctVi(p.pDown)} giảm · ${pctVi(p.pFlat)} ngang${top ? ` — ${top.note}` : ""}`,
      };
    });
  // Composite entry — tổng kết trọng số để chairman/UI đọc 1 dòng
  const wTotal = segmentRuns
    .filter((r) => r.seg.symbolCount > 0 && r.seg.compositeWeight > 0)
    .reduce((s, r) => s + r.seg.compositeWeight, 0);
  if (segmentsOut.length > 1 && wTotal > 0) {
    segmentsOut.push({
      segment: "VN-COMPOSITE",
      label: "Hợp thành VN (trọng số ADTV + 0,05/index)",
      symbolCount: segmentRuns.reduce((s, r) => s + (r.seg.symbolCount > 0 ? r.seg.symbolCount : 0), 0),
      pUp: Number(marketPosterior.pUp.toFixed(4)),
      pDown: Number(marketPosterior.pDown.toFixed(4)),
      pFlat: Number(marketPosterior.pFlat.toFixed(4)),
      marketDirection,
      compositeWeight: Number(wTotal),
      note: segmentRuns
        .filter((r) => r.seg.symbolCount > 0 && r.seg.compositeWeight > 0)
        .map((r) => {
          const share = (r.seg.compositeWeight / wTotal) * 100;
          const short = r.seg.segment.replace("VN-", "");
          return `${short} ${share.toFixed(0)}%`;
        })
        .join(" · "),
    });
  }

  /* ── BẬC 2 · NGÀNH — posterior segment chính + chỉnh momentum ngành ─── */
  const sectors = input.context.sectors
    .map((s) => {
      const delta = Math.min(SECTOR_MOM_COEF * Math.abs(s.avgMomentum5d), Math.log(SECTOR_LR_CAP));
      let Ls = { ...L };
      if (s.avgMomentum5d > 0) Ls = { up: Ls.up + delta, down: Ls.down - delta };
      else if (s.avgMomentum5d < 0) Ls = { up: Ls.up - delta, down: Ls.down + delta };
      Ls = clampLogits(Ls);
      const post = posteriorFromLogits(Ls);
      const stance: "UP" | "DOWN" | "FLAT" =
        post.pUp > post.pDown && post.pUp > post.pFlat
          ? "UP"
          : post.pDown > post.pUp && post.pDown > post.pFlat
            ? "DOWN"
            : "FLAT";
      return {
        sector: s.sector,
        symbolCount: s.symbolCount,
        avgMomentum5d: Number(s.avgMomentum5d.toFixed(2)),
        pUp: Number(post.pUp.toFixed(4)),
        stance,
      };
    })
    .sort((a, b) => b.pUp - a.pUp);

  /* ── BẬC 3 · CỔ PHIẾU — kế thừa posterior segment chính + bằng chứng mã ── */
  const evidenceBySymbol = new Map<string, BayesEvidence[]>();
  for (const e of symbolEvidence) {
    const arr = evidenceBySymbol.get(e.symbol) ?? [];
    arr.push(e);
    evidenceBySymbol.set(e.symbol, arr);
  }

  const symbols: SymbolAssessment[] = input.context.symbols.map((s) => {
    const evs = evidenceBySymbol.get(s.symbol) ?? [];
    let Lsym = { ...L }; // khởi từ posterior THỊ TRƯỜNG (kế thừa nhân quả)
    for (const e of evs) {
      Lsym = shiftLogOdds(Lsym, e);
    }
    Lsym = clampLogits(Lsym);
    const post = posteriorFromLogits(Lsym);

    // STANCE: cần chênh lệch posterior đủ lớn VÀ dự báo định lượng đồng hướng
    let stance: SymbolAssessment["stance"] = "HOLD";
    if (
      post.pUp - Math.max(post.pDown, post.pFlat) >= STANCE_MARGIN &&
      (s.forecast?.expectedPct ?? 0) > 0
    ) {
      stance = "BUY";
    } else if (
      post.pDown - Math.max(post.pUp, post.pFlat) >= STANCE_MARGIN &&
      (s.forecast?.expectedPct ?? 0) < 0
    ) {
      stance = "SELL";
    }

    const symDrivers = evs
      .map((e) => ({ note: e.note, delta: Math.abs(signedDelta(e)) }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 3)
      .map((d) => d.note);

    return {
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      last: s.last,
      changePct: Number(s.changePct.toFixed(2)),
      pUp: Number(post.pUp.toFixed(4)),
      pDown: Number(post.pDown.toFixed(4)),
      pFlat: Number(post.pFlat.toFixed(4)),
      stance,
      zScore: s.zScore != null ? Number(s.zScore.toFixed(2)) : null,
      rsi14: s.rsi14 != null ? Number(s.rsi14.toFixed(1)) : null,
      momentum5d: s.momentum5d != null ? Number(s.momentum5d.toFixed(2)) : null,
      forecast: s.forecast
        ? {
            horizonDays: s.forecast.horizonDays,
            expectedPct: Number(s.forecast.expectedPct.toFixed(2)),
            lowPct: Number(s.forecast.lowPct.toFixed(2)),
            highPct: Number(s.forecast.highPct.toFixed(2)),
          }
        : null,
      drivers: symDrivers,
    };
  });
  // Sắp theo |pUp − pDown| giảm dần (spec MarketAssessmentView)
  symbols.sort((a, b) => Math.abs(b.pUp - b.pDown) - Math.abs(a.pUp - a.pDown));

  /* ── FORECAST5D · trung bình trọng số ADTV dự báo Holt (rổ HOSE) ─────── */
  let forecast5d: SynthesisOutput["forecast5d"] = null;
  const forecastable = input.context.symbols.filter((s) => s.forecast && s.adtvVnd > 0);
  if (forecastable.length > 0) {
    let wSum = 0;
    let expSum = 0;
    let halfWidthSum = 0;
    for (const s of forecastable) {
      const f = s.forecast!;
      const halfWidth = (f.highPct - f.lowPct) / 2;
      wSum += s.adtvVnd;
      expSum += s.adtvVnd * f.expectedPct;
      halfWidthSum += s.adtvVnd * halfWidth;
    }
    if (wSum > 0) {
      const expectedPct = expSum / wSum;
      const halfWidth = halfWidthSum / wSum; // ≈ 1.2816 × residual trung bình × √h
      forecast5d = {
        expectedPct: Number(expectedPct.toFixed(2)),
        lowPct: Number((expectedPct - halfWidth).toFixed(2)),
        highPct: Number((expectedPct + halfWidth).toFixed(2)),
      };
    }
  }

  /* ── NARRATIVE tiếng Việt (3–6 câu, sinh từ posterior composite) ────── */
  const narrative = buildNarrative({
    input,
    marketPosterior,
    marketDirection,
    confidence,
    disagreement,
    drivers,
    forecast5d,
    evidenceCount: allEvidence.length,
    segments: segmentsOut,
    consensus,
  });

  /* ── agentsConsidered: mọi agent có bằng chứng/phiếu trong lần này ──── */
  const agentNames = new Set<string>();
  for (const e of allEvidence) agentNames.add(e.agentName);
  for (const r of segmentRuns) for (const e of r.run.evidence) agentNames.add(e.agentName);
  for (const v of input.agentVotes) agentNames.add(v.agentName);
  agentNames.add("Backtest Officer"); // chủ nhân của tiên nghiệm base-rate
  const agentsConsidered = [...agentNames];

  return {
    // placeholder — saveMarketAssessment (persist.ts) điền id/createdAt thật
    id: "",
    createdAt: new Date().toISOString(),
    source: "cycle",
    cycleRunId: null,
    pUp: Number(marketPosterior.pUp.toFixed(4)),
    pDown: Number(marketPosterior.pDown.toFixed(4)),
    pFlat: Number(marketPosterior.pFlat.toFixed(4)),
    marketDirection,
    confidence: Number(confidence.toFixed(4)),
    disagreement: Number(disagreement.toFixed(4)),
    evidenceCount: allEvidence.length,
    prior: {
      pUp: Number(prior.pUp.toFixed(4)),
      pDown: Number(prior.pDown.toFixed(4)),
      pFlat: Number(prior.pFlat.toFixed(4)),
      baseRateNote: prior.baseRateNote,
    },
    drivers,
    sectors,
    symbols,
    market: {
      advancing: input.context.market.advancing,
      declining: input.context.market.declining,
      unchanged: input.context.market.unchanged,
      regime: input.context.market.regime,
      netForeignFlowVnd: input.context.market.netForeignFlowVnd,
      newsSentimentScore:
        input.context.market.newsSentimentScore != null
          ? Number(input.context.market.newsSentimentScore.toFixed(3))
          : null,
      breadth: Number(input.context.market.breadth.toFixed(3)),
    },
    forecast5d,
    veto: input.veto,
    narrative,
    agentsConsidered,
    segments: segmentsOut,
    consensus,
  };
}

/* ─────────────────────────── Narrative ─────────────────────────── */

interface NarrativeParts {
  input: SynthesisInput;
  marketPosterior: { pUp: number; pDown: number; pFlat: number };
  marketDirection: SynthesisOutput["marketDirection"];
  confidence: number;
  disagreement: number;
  drivers: BayesDriver[];
  forecast5d: SynthesisOutput["forecast5d"];
  evidenceCount: number;
  segments: SegmentAssessment[];
  consensus: ConsensusSnapshot | null;
}

/** Sinh tường thuật tiếng Việt 3–6 câu từ posterior + drivers + segments. */
function buildNarrative(p: NarrativeParts): string {
  const dirWord =
    p.marketDirection === "BULLISH" ? "TĂNG" : p.marketDirection === "BEARISH" ? "GIẢM" : "ĐI NGANG";
  const sentences: string[] = [];

  // Câu 1 — hướng + xác suất + chế độ thị trường (COMPOSITE VN)
  sentences.push(
    `Bộ tổng hợp Bayes trên ${p.evidenceCount} bằng chứng từ ${p.input.context.market.advancing + p.input.context.market.declining + p.input.context.market.unchanged} mã HOSE và ${Math.max(0, p.segments.length - 1)} phân đoạn thị trường (HNX · UPCOM · ETF · INDEX): thị trường VN 5 phiên tới nghiêng ${dirWord} với xác suất tăng ${pctVi(p.marketPosterior.pUp)} (giảm ${pctVi(p.marketPosterior.pDown)} · đi ngang ${pctVi(p.marketPosterior.pFlat)}), chế độ ${p.input.context.market.regime.toLowerCase()}.`
  );

  // Câu 2 (B5) — 1 dòng posterior từng phân đoạn
  const segLines = p.segments.filter((s) => s.segment !== "VN-COMPOSITE");
  if (segLines.length > 1) {
    const segText = segLines
      .map((s) => {
        const short = s.segment.replace("VN-", "");
        const d = s.marketDirection === "BULLISH" ? "tăng" : s.marketDirection === "BEARISH" ? "giảm" : "ngang";
        return `${short} ${pctVi(s.pUp, 0)} ${d}`;
      })
      .join(" · ");
    sentences.push(`Phân đoạn: ${segText} — hợp thành theo trọng số ADTV thật + 0,05/index.`);
  }

  // Câu 3 — 2 driver mạnh nhất kèm note
  const top2 = p.drivers.filter((d) => d.deltaLogOdds !== 0).slice(0, 2);
  if (top2.length > 0) {
    const driverText = top2
      .map(
        (d) =>
          `${d.agentName} (${d.deltaLogOdds > 0 ? "+" : ""}${d.deltaLogOdds.toFixed(2)} log-odds — ${d.note})`
      )
      .join("; ");
    sentences.push(`Hai bằng chứng mạnh nhất: ${driverText}.`);
  }

  // Câu 4 — mức bất đồng + diễn giải
  const disLevel =
    p.disagreement < 0.2
      ? "các agent rất đồng thuận"
      : p.disagreement < 0.4
        ? "các agent đồng thuận khá"
        : p.disagreement < 0.6
          ? "có bất đồng vừa phải"
          : "bất đồng cao — tín hiệu nên được đọc thận trọng";
  sentences.push(
    `Độ bất đồng agents ${pctVi(p.disagreement)} (${disLevel}); độ tin cậy mô hình ${pctVi(p.confidence)}.`
  );

  // Câu 5 — cổng đồng thuận 80% (T9.5 — narrative có câu giải thích cổng)
  if (p.consensus) {
    sentences.push(`Cổng đồng thuận: ${p.consensus.note}${p.consensus.shadow ? " [shadow-mode — chưa chặn tín hiệu thật]" : " [enforcement ĐANG BẬT]"}`);
  }

  // Câu 6 — dự báo rổ 5 phiên kèm CI80
  if (p.forecast5d) {
    sentences.push(
      `Dự báo rổ 5 phiên (Holt, trọng số thanh khoản): ${p.forecast5d.expectedPct >= 0 ? "+" : ""}${p.forecast5d.expectedPct.toFixed(2).replace(".", ",")}% (khoảng tin cậy 80%: ${p.forecast5d.lowPct.toFixed(2).replace(".", ",")}% đến ${p.forecast5d.highPct.toFixed(2).replace(".", ",")}%).`
    );
  }

  // Câu 7 — cảnh báo VETO nếu bị chặn
  if (p.input.veto.blocked) {
    sentences.push(`LƯU Ý: Ủy ban Kiểm soát đang VETO — ${p.input.veto.reason ?? "ràng buộc cứng đang chặn tín hiệu mới"}.`);
  }

  return sentences.join(" ");
}

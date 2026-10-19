/**
 * tests/bayes-consensus.test.ts — Task 144-P1 Tier 1 (docs/SECURITY.md §5).
 *
 * Unit test BỘ TỔNG HỢP BAYES (src/lib/bayes/synthesis.ts — engine log-odds
 * THUẦN, deterministic 0 LLM) + CỔNG ĐỒNG THUẬN 80% B9 (hằng số từ
 * src/lib/consensus.ts — phần DB của consensus.ts không test). Toán chốt
 * tay trên prior đều 1/3: L=logit(1/3)=−ln2; bằng chứng UP w=1 · LR=3 →
 * shift=ln3 → L_up=ln1,5 → σ=0,6 · L_down=−ln6 → σ=1/7 · pFlat=9/35.
 */
import { describe, test, expect } from "bun:test";
import {
  CONSENSUS_SETTING_KEY,
  CONSENSUS_EPSILON,
  CONSENSUS_MIN_POOL,
  CONSENSUS_POOL_SIZE,
  CONSENSUS_THRESHOLD,
  WEAK_MAJORITY_THRESHOLD,
  CONSENSUS_SHADOW_CYCLES,
} from "@/lib/consensus";
import { synthesizeMarketAssessment } from "@/lib/bayes/synthesis";
import type {
  AgentVote,
  BayesEvidence,
  SynthesisInput,
} from "@/lib/bayes/types";

describe("hằng số cổng đồng thuận B9 (src/lib/consensus.ts)", () => {
  test("ngưỡng 80% / đa số yếu 50% / pool tối thiểu 4 / pool hiển thị 7", () => {
    expect(CONSENSUS_THRESHOLD).toBe(0.8);
    expect(WEAK_MAJORITY_THRESHOLD).toBe(0.5);
    expect(CONSENSUS_MIN_POOL).toBe(4);
    expect(CONSENSUS_POOL_SIZE).toBe(7);
  });
  test("epsilon 1e⁻⁹ (tránh dải chết 0,7999…) · 10 chu kỳ shadow · key setting", () => {
    expect(CONSENSUS_EPSILON).toBe(1e-9);
    expect(CONSENSUS_SHADOW_CYCLES).toBe(10);
    expect(CONSENSUS_SETTING_KEY).toBe("consensus");
  });
});

/* ── Fixture builder — SynthesisInput tối thiểu (engine thuần) ──────────── */

function makeInput(over: Partial<SynthesisInput> = {}): SynthesisInput {
  return {
    prior: { pUp: 1 / 3, pDown: 1 / 3, pFlat: 1 / 3, baseRateNote: "fixture đều" },
    marketEvidence: [],
    symbolEvidence: [],
    agentVotes: [],
    veto: { blocked: false, reason: null },
    context: {
      market: {
        advancing: 0,
        declining: 0,
        unchanged: 0,
        regime: "fixture",
        netForeignFlowVnd: null,
        newsSentimentScore: null,
        breadth: 0,
      },
      symbols: [],
      sectors: [],
    },
    ...over,
  };
}

function ev(
  direction: "UP" | "DOWN" | "FLAT",
  lr: number,
  weight: number,
  source = "fixture"
): BayesEvidence {
  return {
    source,
    agentName: "Fixture Analyst",
    gen1: "A0",
    level: "market",
    direction,
    likelihoodRatio: lr,
    weight,
    note: "bằng chứng fixture",
  };
}

function vote(
  code: string,
  direction: "UP" | "DOWN" | "FLAT",
  weight?: number
): AgentVote {
  return {
    code,
    agentName: code,
    gen1: "A0",
    direction,
    confidence: 1,
    successRate: 1,
    weight,
  };
}

describe("posterior log-odds Bậc 0+1 (tính tay trên prior đều)", () => {
  test("1 bằng chứng UP w=1 LR=3 → pUp 0,6 · pDown 1/7 · pFlat 9/35 · BULLISH", () => {
    const out = synthesizeMarketAssessment(makeInput({ marketEvidence: [ev("UP", 3, 1)] }));
    expect(out.pUp).toBeCloseTo(0.6, 4); // σ(ln 1,5) = 0,6
    expect(out.pDown).toBeCloseTo(1 / 7, 4); // σ(−ln 6) = 1/7
    expect(out.pFlat).toBeCloseTo(9 / 35, 4);
    expect(out.marketDirection).toBe("BULLISH");
    expect(out.evidenceCount).toBe(1);
  });
  test("CONFIDENCE = 1 − H/ln3 ≈ 0,15 (entropy của [0,6 · 1/7 · 9/35])", () => {
    const out = synthesizeMarketAssessment(makeInput({ marketEvidence: [ev("UP", 3, 1)] }));
    expect(out.confidence).toBeCloseTo(0.15, 3);
  });
  test("bằng chứng DOWN đối xứng → pDown 0,6 · BEARISH", () => {
    const out = synthesizeMarketAssessment(makeInput({ marketEvidence: [ev("DOWN", 3, 1)] }));
    expect(out.pDown).toBeCloseTo(0.6, 4);
    expect(out.pUp).toBeCloseTo(1 / 7, 4);
    expect(out.marketDirection).toBe("BEARISH");
  });
  test("bằng chứng FLAT KHÔNG dịch log-odds → posterior giữ prior (NEUTRAL 1/3)", () => {
    const out = synthesizeMarketAssessment(makeInput({ marketEvidence: [ev("FLAT", 3, 1)] }));
    expect(out.pUp).toBeCloseTo(1 / 3, 4);
    expect(out.pDown).toBeCloseTo(1 / 3, 4);
    expect(out.pFlat).toBeCloseTo(1 / 3, 4);
    expect(out.marketDirection).toBe("NEUTRAL");
  });
  test("không bằng chứng → prior đều + agentsConsidered có Backtest Officer", () => {
    const out = synthesizeMarketAssessment(makeInput());
    expect(out.pUp).toBeCloseTo(1 / 3, 4);
    expect(out.evidenceCount).toBe(0);
    expect(out.agentsConsidered).toContain("Backtest Officer");
  });
  test("2 bằng chứng UP cộng DỒN log-odds: (ln3)×2 → L_up=ln2,25 → σ=0,6923", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ marketEvidence: [ev("UP", 3, 1), ev("UP", 3, 1)] })
    );
    // σ(−ln2 + 2ln3) = σ(ln(9/2)) = 4,5/5,5 = 0,8182; pDown = σ(−ln2−2ln3) = σ(−ln18) = 1/19
    expect(out.pUp).toBeCloseTo(9 / 11, 4);
    expect(out.pDown).toBeCloseTo(1 / 19, 4);
  });
});

describe("sanitizeEvidence — kẹp ràng buộc số học", () => {
  test("LR > 3 bị kẹp về 3 (tương đương bằng chứng LR=3)", () => {
    const out = synthesizeMarketAssessment(makeInput({ marketEvidence: [ev("UP", 10, 1)] }));
    expect(out.pUp).toBeCloseTo(0.6, 4);
  });
  test("LR < 0,5 bị kẹp về 0,5 (UP với LR<1 giờ LẠI kéo pUp xuống)", () => {
    const out = synthesizeMarketAssessment(makeInput({ marketEvidence: [ev("UP", 0.01, 1)] }));
    // shift = ln 0,5 < 0 → pUp < prior
    expect(out.pUp).toBeLessThan(1 / 3);
    expect(out.pDown).toBeGreaterThan(1 / 3);
  });
  test("weight > 1 kẹp về 1 (tương đương w=1)", () => {
    const out = synthesizeMarketAssessment(makeInput({ marketEvidence: [ev("UP", 3, 7)] }));
    expect(out.pUp).toBeCloseTo(0.6, 4);
  });
  test("weight < 0,3 kẹp về 0,3: shift = 0,3×ln3 → L_up = ln(1,5^0,3)", () => {
    const out = synthesizeMarketAssessment(makeInput({ marketEvidence: [ev("UP", 3, 0.01)] }));
    const expected = 1 / (1 + Math.exp(-(0.3 * Math.log(3) - Math.log(2))));
    expect(out.pUp).toBeCloseTo(Number(expected.toFixed(4)), 4);
  });
  test("LR 0 / NaN / Infinity → bằng chứng bị BỎ (evidenceCount 0)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        marketEvidence: [ev("UP", 0, 1), ev("UP", Number.NaN, 1), ev("UP", Number.POSITIVE_INFINITY, 1)],
      })
    );
    expect(out.evidenceCount).toBe(0);
    expect(out.pUp).toBeCloseTo(1 / 3, 4);
  });
  test("weight NaN → bằng chứng bị bỏ", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ marketEvidence: [ev("UP", 3, Number.NaN)] })
    );
    expect(out.evidenceCount).toBe(0);
  });
});

describe("cổng đồng thuận 80% B9 — computeConsensus qua synthesizeMarketAssessment", () => {
  test("5 phiếu đồng thuận hoàn toàn (all UP) → CONSENSUS · ratio 1 · không chặn", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "UP"), vote("d", "UP"), vote("e", "UP")],
      })
    );
    expect(out.consensus).not.toBeNull();
    expect(out.consensus!.gate).toBe("CONSENSUS");
    expect(out.consensus!.ratio).toBe(1);
    expect(out.consensus!.wouldBlock).toBe(false);
    expect(out.consensus!.present).toBe(5);
  });
  test("4 UP + 1 DOWN (đều w=1) → ratio 0,8 → vẫn CONSENSUS (ngưỡng đóng −ε)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "UP"), vote("d", "UP"), vote("e", "DOWN")],
      })
    );
    expect(out.consensus!.ratio).toBeCloseTo(0.8, 6);
    expect(out.consensus!.gate).toBe("CONSENSUS");
  });
  test("ratio 0,79999998 (sát dưới ngưỡng, lệch > ε) → WEAK_MAJORITY", () => {
    // 4 UP w=0,8 (S=3,2) + 1 DOWN w=0,8000001 → ratio = 3,2/4,0000001
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [
          vote("a", "UP", 0.8),
          vote("b", "UP", 0.8),
          vote("c", "UP", 0.8),
          vote("d", "UP", 0.8),
          vote("e", "DOWN", 0.8000001),
        ],
      })
    );
    // snapshot làm tròn ratio 6 chữ số → hiển thị 0,8 nhưng GATE chấm trên
    // ratio thô (0,79999998 < 0,8 − ε) → WEAK_MAJORITY — đúng semantics v1.1
    expect(out.consensus!.ratio).toBe(0.8);
    expect(out.consensus!.gate).toBe("WEAK_MAJORITY");
    expect(out.consensus!.wouldBlock).toBe(true);
  });
  test("3 UP + 2 DOWN → ratio 0,6 → WEAK_MAJORITY (tín hiệu ép GIỮ)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "UP"), vote("d", "DOWN"), vote("e", "DOWN")],
      })
    );
    expect(out.consensus!.ratio).toBeCloseTo(0.6, 6);
    expect(out.consensus!.gate).toBe("WEAK_MAJORITY");
  });
  test("2 UP + 2 DOWN + 1 FLAT → ratio 0,4 → NO_CONSENSUS", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "DOWN"), vote("d", "DOWN"), vote("e", "FLAT")],
      })
    );
    expect(out.consensus!.gate).toBe("NO_CONSENSUS");
    expect(out.consensus!.wouldBlock).toBe(true);
  });
  test("pool < 4 cử tri (3 phiếu all UP) → fail-safe NO_CONSENSUS dù ratio 1", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "UP")] })
    );
    expect(out.consensus!.ratio).toBe(1);
    expect(out.consensus!.gate).toBe("NO_CONSENSUS");
    expect(out.consensus!.note).toContain("fail-safe");
  });
  test("0 phiếu → consensus null (gate không áp đảo lên dữ liệu cũ)", () => {
    const out = synthesizeMarketAssessment(makeInput());
    expect(out.consensus).toBeNull();
  });
  test("weight phiếu bị kẹp [0,3 · 1] trong tally (w=5 → 1, w=0,01 → 0,3)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [vote("big", "UP", 5), vote("tiny", "UP", 0.01), vote("c", "DOWN"), vote("d", "DOWN"), vote("e", "FLAT")],
      })
    );
    const tally = out.consensus!.tally;
    expect(tally.find((t) => t.code === "big")!.weight).toBe(1);
    expect(tally.find((t) => t.code === "tiny")!.weight).toBeCloseTo(0.3, 12);
  });
  test("thiếu weight (legacy) → 0,5 trung tính", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ agentVotes: [vote("legacy", "UP"), vote("b", "DOWN"), vote("c", "FLAT"), vote("d", "FLAT")] })
    );
    expect(out.consensus!.tally[0]!.weight).toBe(0.5);
  });
  test("tally gắn model \"ml\" cho ml-forecast, \"llm\" cho agent thường", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [
          vote("ml-forecast", "UP"),
          vote("market-analyst", "UP"),
          vote("fair-value", "UP"),
          vote("news-sentiment", "DOWN"),
        ],
      })
    );
    const tally = out.consensus!.tally;
    expect(tally.find((t) => t.code === "ml-forecast")!.model).toBe("ml");
    expect(tally.find((t) => t.code === "market-analyst")!.model).toBe("llm");
  });
  test("ratio được làm tròn 6 chữ số thập phân (1/3 → 0,333333)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [
          vote("a", "UP"), vote("b", "UP"), vote("c", "UP"),
          vote("d", "DOWN"), vote("e", "DOWN"), vote("f", "FLAT"),
        ],
      })
    );
    expect(out.consensus!.ratio).toBe(0.5); // 3/6 = 0,5
  });
});

describe("shadow-mode + disagreement + veto passthrough", () => {
  test("mặc định consensusEnforce=false → shadow true (cổng tính nhưng KHÔNG chặn)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "UP"), vote("d", "DOWN")] })
    );
    expect(out.consensus!.shadow).toBe(true);
  });
  test("consensusEnforce=true → shadow false (đang chặn thật)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({
        agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "UP"), vote("d", "DOWN")],
        consensusEnforce: true,
      })
    );
    expect(out.consensus!.shadow).toBe(false);
  });
  test("DISAGREEMENT: mọi phiếu đồng hướng (conf=1, success=1) → 0", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "UP")] })
    );
    expect(out.disagreement).toBeCloseTo(0, 6);
  });
  test("DISAGREEMENT: nửa UP nửa DOWN cân bằng → 1 (phân hoá tối đa)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ agentVotes: [vote("a", "UP"), vote("b", "DOWN"), vote("c", "UP"), vote("d", "DOWN")] })
    );
    expect(out.disagreement).toBeCloseTo(1, 6);
  });
  test("DISAGREEMENT: FLAT không kéo (dir 0) — 2 UP + 2 FLAT → 1 − 2/4 = 0,5", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ agentVotes: [vote("a", "UP"), vote("b", "UP"), vote("c", "FLAT"), vote("d", "FLAT")] })
    );
    expect(out.disagreement).toBeCloseTo(0.5, 6);
  });
  test("veto đi thẳng qua engine (không bị cổng đồng thuận vượt veto)", () => {
    const out = synthesizeMarketAssessment(
      makeInput({ veto: { blocked: true, reason: "A9 veto fixture" } })
    );
    expect(out.veto.blocked).toBe(true);
    expect(out.veto.reason).toBe("A9 veto fixture");
  });
  test("source/placeholder: engine trả \"cycle\" + id rỗng để persist.ts điền", () => {
    const out = synthesizeMarketAssessment(makeInput());
    expect(out.source).toBe("cycle");
    expect(out.id).toBe("");
    expect(out.cycleRunId).toBeNull();
  });
});

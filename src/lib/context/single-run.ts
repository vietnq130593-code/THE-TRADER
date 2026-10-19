/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  buildSingleRunPrompt — prompt chạy riêng 1 agent LLM (PHASE3_BLUEPRINT §4.3). */

import { ROLE_PROMPTS } from "./prompts";
import { buildMarketBlock } from "./snapshot";
import { buildNewsBlock } from "./news";
import { buildFlowsBlock } from "./flows";
import { buildOpenSignalsBlock } from "./open-signals";
import { buildValuationBlock } from "./valuation";
import { buildLiquidityBlock } from "./liquidity";
import { buildMacroBlock } from "./macro";
import { buildPortfolioWeightsBlock } from "./portfolio-weights";
import { buildIntlReferenceBlock } from "./intl";
// L1 (#83 — ML_LEARNING_BLUEPRINT §2): BM25 RAG cho single-run của 5 agent
// nghiên cứu + Chủ tịch (chu kỳ tiêm ở api/agents/run — cùng 1 thư viện).
import { retrieveForCycle } from "@/lib/ml/rag";
import { retrieveForCycleL2 } from "@/lib/ml/l2";
// M2 (#103 — M2_RELATION_BLUEPRINT, cơ chế số 2): quan hệ thị trường đã học
// (lead-lag + xác suất điều kiện trên 750 phiên) tiêm cho 3 agent nghiên cứu
// trọng tâm quan hệ liên thị trường — fail-soft như RAG L1.
import { buildXrelPromptBlock } from "@/lib/ml/xrel";
// #106 C-VISION — tầm nhìn toàn cục hội đồng cho Chủ tịch.
import { buildCouncilVisionBlock } from "@/lib/council/vision";

/**
 * Prompt chạy riêng 1 agent LLM (PHASE3_BLUEPRINT §4.3) — chọn block theo vai:
 * market-analyst → [market, flows]; news → [market, news, flows];
 * risk → [market, flows]; fair-value → [market, valuation]; liquidity → [market, liquidity];
 * strategist → [market, news, flows, valuation, liquidity, tín hiệu đang mở].
 * (Service agents không gọi hàm này — [id]/run dùng runServiceAgent.)
 */
export async function buildSingleRunPrompt(
  code: string
): Promise<{ system: string; user: string }> {
  const role = ROLE_PROMPTS[code];
  if (!role) throw new Error(`Không có role-prompt cho agent "${code}".`);
  const [market, news, flows, openSignals, valuation, liquidity] = await Promise.all([
    buildMarketBlock(),
    buildNewsBlock(),
    buildFlowsBlock(),
    buildOpenSignalsBlock(),
    buildValuationBlock(),
    buildLiquidityBlock(),
  ]);
  // L1 (#83 — ML_LEARNING_BLUEPRINT §2): tri thức truy hồi RAG cho 5 agent
  // nghiên cứu + Chủ tịch cả khi chạy đơn lẻ (cùng khối như chu kỳ — đo qua
  // RetrievalLog). Fail-soft: lỗi → block null → prompt y như trước L1.
  const rag = await retrieveForCycle(true).catch(() => null);
  const ragBlock = rag?.block ?? null;
  // L2 (Task 142 · F-24 §6 — RAG_UPGRADE_ASSESSMENT): TRI THỨC DÀI HẠN —
  // corpus tuyển (research/executive/tin vĩ mô/nhận định chu kỳ/bài học
  // WIN-LOSS) xếp hạng hybrid BM25 + vector NIM 2048 dim + đồ thị thực thể,
  // mốc thời gian từng dòng (tuần/tháng trước — đối chiếu phương pháp luận).
  // retrieveForCycleL2 KHÔNG ném (fail-soft 2 tầng bên trong: NIM lỗi → BM25
  // thuần; DB lỗi → null) — prompt y như trước L2 khi mọi thứ lỗi.
  const l2 = await retrieveForCycleL2(true).catch(() => null);
  const l2Block = l2?.block ?? null;
  // M2 (#103): quan hệ thị trường đã học cho market-analyst · news-sentiment
  // · portfolio-strategist — fail-soft, cache in-process 60s.
  const xrelBlock = await buildXrelPromptBlock().catch(() => null);
  switch (code) {
    case "market-analyst":
    case "risk-manager":
      return {
        system: role.system,
        user: [market.block, flows, ...(ragBlock ? [ragBlock] : []), ...(l2Block ? [l2Block] : []), ...(code === "market-analyst" && xrelBlock ? [xrelBlock] : [])].join("\n\n"),
      };
    case "news-sentiment":
      return {
        system: role.system,
        user: [market.block, news, flows, ...(ragBlock ? [ragBlock] : []), ...(l2Block ? [l2Block] : []), ...(xrelBlock ? [xrelBlock] : [])].join("\n\n"),
      };
    case "fair-value":
      return {
        system: role.system,
        user: [market.block, valuation, ...(ragBlock ? [ragBlock] : []), ...(l2Block ? [l2Block] : [])].join("\n\n"),
      };
    case "liquidity":
      return {
        system: role.system,
        user: [market.block, liquidity, ...(ragBlock ? [ragBlock] : []), ...(l2Block ? [l2Block] : [])].join("\n\n"),
      };
    case "macro-economist": {
      // A20 (#126): bảng điều khiển vĩ mô 3 lớp + dòng khối ngoại + XREL
      // (quan hệ thị trường — kinh tế gia quan tâm lead-lag quốc tế→VN).
      const [macro, macroFlows, macroXrel] = await Promise.all([
        buildMacroBlock(),
        buildFlowsBlock(),
        buildXrelPromptBlock().catch(() => null),
      ]);
      return {
        system: role.system,
        user: [macro, macroFlows, ...(ragBlock ? [ragBlock] : []), ...(l2Block ? [l2Block] : []), ...(macroXrel ? [macroXrel] : [])].join("\n\n"),
      };
    }
    case "portfolio-strategist": {
      // F-73A-03: single-run cấp cùng block tỷ trọng như chu kỳ — hợp đồng
      // allocation cần currentPct đo từ DB, không để LLM bịa.
      // #106 C-VISION + #108 v2.2: kèm TÀI KHOẢN HỘI ĐỒNG + THỊ TRƯỜNG
      // QUỐC TẾ THAM CHIẾU (fail-soft .catch như XREL — 3 đường parity #103).
      const [weights, councilVision, intlReference] = await Promise.all([
        buildPortfolioWeightsBlock().catch(() => null),
        buildCouncilVisionBlock().catch(() => null),
        buildIntlReferenceBlock().catch(() => null),
      ]);
      return {
        system: role.system,
        user: [
          market.block,
          news,
          flows,
          valuation,
          liquidity,
          `TÍN HIỆU ĐANG MỞ:\n${openSignals}`,
          ...(ragBlock ? [ragBlock] : []),
          ...(l2Block ? [l2Block] : []),
          ...(xrelBlock ? [xrelBlock] : []),
          ...(intlReference ? ["", intlReference] : []),
          ...(weights ? ["", weights] : []),
          ...(councilVision ? ["", councilVision] : []),
        ].join("\n\n"),
      };
    }
    default:
      throw new Error(
        `Agent "${code}" là service agent — chạy qua runServiceAgent, không dùng LLM prompt.`
      );
  }
}

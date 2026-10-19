/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  buildChatUserPrompt + buildChatContextBlock + latestBayesContextLine —
 *  user-prompt chat (§4.4). */

import { buildMarketBlock } from "./snapshot";
import { buildNewsBlock } from "./news";
import { buildOpenSignalsBlock } from "./open-signals";
import { buildValuationBlock } from "./valuation";
import { buildLiquidityBlock } from "./liquidity";
import { buildMacroBlock } from "./macro";
import { buildIntlReferenceBlock } from "./intl";
import { buildXrelPromptBlock } from "@/lib/ml/xrel";
import { buildCouncilVisionBlock } from "@/lib/council/vision";
import { loadLatestAssessment } from "@/lib/bayes/persist";

/**
 * user-prompt cho chat (§4.4): câu hỏi + [BỐI CẢNH DỮ LIỆU MỚI NHẤT] rút gọn theo vai.
 * Service agents (mở rộng 23) dùng mặc định market compact — prompt vai mô tả chuyên môn.
 *
 * Phiên #34 (Nhiệm vụ 5): nếu có Bộ tổng hợp Bayes trong 6h qua, thêm 1 dòng
 * "Bộ tổng hợp Bayes gần nhất: <direction> (pUp X%)" vào cuối khối ngữ cảnh —
 * 1 truy vấn DB rẻ, bọc try/catch để không bao giờ làm hỏng chat.
 */
export async function buildChatUserPrompt(code: string, question: string): Promise<string> {
  const [context, bayesLine] = await Promise.all([
    buildChatContextBlock(code),
    latestBayesContextLine(),
  ]);
  const contextBlock = [context, bayesLine].filter(Boolean).join("\n");
  return `${question}\n\n[BỐI CẢNH DỮ LIỆU MỚI NHẤT]\n${contextBlock}`;
}

/** Khối ngữ cảnh chat theo vai (switch của buildChatUserPrompt trước #34). */
async function buildChatContextBlock(code: string): Promise<string> {
  switch (code) {
    case "news-sentiment": {
      const [market, news, xrel] = await Promise.all([
        buildMarketBlock(),
        buildNewsBlock(),
        buildXrelPromptBlock().catch(() => null),
      ]);
      return [market.compact, news, ...(xrel ? [xrel] : [])].join("\n\n");
    }
    case "market-analyst": {
      // M2 #103: chat với A2 được cấp quan hệ thị trường đã học — đúng chuyên
      // môn "tương quan liên thị trường" của scanner.
      const [market, xrel] = await Promise.all([
        buildMarketBlock(),
        buildXrelPromptBlock().catch(() => null),
      ]);
      return [market.compact, ...(xrel ? [xrel] : [])].join("\n\n");
    }
    case "portfolio-strategist": {
      const [market, openSignals, xrel, councilVision, intlReference] = await Promise.all([
        buildMarketBlock(),
        buildOpenSignalsBlock(),
        buildXrelPromptBlock().catch(() => null),
        // #106 C-VISION — chat với Chủ tịch cũng thấy tài khoản hội đồng
        buildCouncilVisionBlock().catch(() => null),
        // #108 v2.2 — chat với Chủ tịch cũng thấy bối cảnh quốc tế THAM CHIẾU
        buildIntlReferenceBlock().catch(() => null),
      ]);
      return [
        market.compact,
        `TÍN HIỆU ĐANG MỞ:\n${openSignals}`,
        ...(xrel ? [xrel] : []),
        ...(intlReference ? [intlReference] : []),
        ...(councilVision ? [councilVision] : []),
      ].join("\n\n");
    }
    case "fair-value": {
      const [market, valuation] = await Promise.all([buildMarketBlock(), buildValuationBlock()]);
      return [market.compact, valuation].join("\n\n");
    }
    case "liquidity": {
      const [market, liquidity] = await Promise.all([buildMarketBlock(), buildLiquidityBlock()]);
      return [market.compact, liquidity].join("\n\n");
    }
    case "macro-economist": {
      const [macro, xrel] = await Promise.all([
        buildMacroBlock(),
        buildXrelPromptBlock().catch(() => null),
      ]);
      return [macro, ...(xrel ? [xrel] : [])].join("\n\n");
    }
    default: {
      const market = await buildMarketBlock();
      return market.compact;
    }
  }
}

/** Dòng nhắc Bộ tổng hợp Bayes gần nhất (≤6h) — null khi không có/chưa từng chạy. */
async function latestBayesContextLine(): Promise<string | null> {
  try {
    const latest = await loadLatestAssessment();
    if (!latest) return null;
    const ageMs = Date.now() - new Date(latest.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 6 * 3_600_000) return null;
    const dirWord =
      latest.marketDirection === "BULLISH"
        ? "TĂNG"
        : latest.marketDirection === "BEARISH"
          ? "GIẢM"
          : "ĐI NGANG";
    return `Bộ tổng hợp Bayes gần nhất: thị trường hướng ${dirWord} (xác suất tăng ${Math.round(latest.pUp * 100)}%)`;
  } catch {
    return null; // lỗi DB assessment không được làm hỏng chat
  }
}

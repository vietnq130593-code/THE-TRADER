/**
 * src/lib/context/ss-block.ts — Task 178 (STATE_SPACE_BLUEPRINT Phase 2):
 * khối STATE SPACE cho prompt CHỦ TỊCH/strategist — cờ dữ liệu SS-8 (aux
 * residuals read-only) + β động SS-5 (TVP so VNINDEX — hedge ratio dự phòng).
 *
 * Nguồn: 2 dòng AuditLog mới nhất SS_DATA_FLAG / SS_BETA (chu kỳ engine T2–T6
 * 16:50 ICT). Fail-soft y như RAG/XREL/intl: lỗi → null → prompt y như trước
 * Phase 2. Cache in-process 60s (pattern consensus.ts — tránh query mỗi chu
 * kỳ). KHÔNG đốt vào Bayes / KHÔNG đổi tuyển dòng train — thuần NGỮ CẢNH.
 */

import { db } from "@/lib/db";
import {
  SS_BETA_AUDIT_ACTION,
  SS_DATA_FLAG_AUDIT_ACTION,
} from "@/lib/ml/ss/phase2";

interface FlagItem {
  date: string;
  std: number;
}

interface DataFlagPayload {
  date?: string;
  totals?: { outliers?: number; levelShifts?: number; trendShifts?: number };
  symbols?: {
    symbol: string;
    outliers?: FlagItem[];
    levelShifts?: FlagItem[];
    trendShifts?: FlagItem[];
  }[];
}

interface BetaPayload {
  date?: string;
  market?: string;
  summary?: { destabilising?: number; avgSystematicShare?: number };
  symbols?: {
    symbol: string;
    beta?: number;
    betaSd?: number;
    systematicShare?: number;
    destabilising?: boolean;
    reasons?: string[];
  }[];
}

let cache: { at: number; block: string | null } | null = null;

/**
 * buildSsContextBlock — đọc 2 audit mới nhất, render khối tiếng Việt gọn
 * (strategist cần biết: mã nào đang "bẩn dữ liệu" / "đổi chế" / β bao nhiêu
 * và chắc đến đâu). Không có dữ liệu (chưa chu kỳ nào / kill-switch) → null
 * — prompt y như trước (không bịa trạng thái).
 */
export async function buildSsContextBlock(): Promise<string | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.block;
  let block: string | null = null;
  try {
    const [flagRow, betaRow] = await Promise.all([
      db.auditLog.findFirst({
        where: { action: SS_DATA_FLAG_AUDIT_ACTION },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, after: true },
      }),
      db.auditLog.findFirst({
        where: { action: SS_BETA_AUDIT_ACTION },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, after: true },
      }),
    ]);
    let flags: DataFlagPayload | null = null;
    let beta: BetaPayload | null = null;
    try {
      flags = flagRow ? (JSON.parse(flagRow.after ?? "{}") as DataFlagPayload) : null;
    } catch {
      flags = null;
    }
    try {
      beta = betaRow ? (JSON.parse(betaRow.after ?? "{}") as BetaPayload) : null;
    } catch {
      beta = null;
    }
    if (!flags && !beta) {
      cache = { at: Date.now(), block: null };
      return null;
    }

    const lines: string[] = ["CỜ STATE SPACE (SS-8/SS-5 · chỉ đọc — kiểm định hậu kiểm):"];

    if (flags) {
      const flagged = (flags.symbols ?? []).filter(
        (s) => (s.outliers?.length ?? 0) + (s.levelShifts?.length ?? 0) > 0
      );
      if (flagged.length === 0) {
        lines.push(
          `- Chất lượng dữ liệu (aux residuals ch. 9, ngày ${flags.date ?? "?"}): sạch — 0 cờ OUTLIER/LEVEL_SHIFT trên rổ top-10.`
        );
      } else {
        lines.push(
          `- Chất lượng dữ liệu (aux residuals, ngày ${flags.date ?? "?"}): ${flagged.length} mã có cờ —`
        );
        for (const s of flagged.slice(0, 5)) {
          const parts: string[] = [];
          if (s.outliers?.length) {
            parts.push(
              `OUTLIER giá ${s.outliers
                .slice(-2)
                .map((o) => `${o.date} (${o.std > 0 ? "+" : ""}${o.std}σ)`)
                .join(", ")}`
            );
          }
          if (s.levelShifts?.length) {
            parts.push(
              `LEVEL_SHIFT ${s.levelShifts
                .slice(-2)
                .map((o) => `${o.date} (${o.std > 0 ? "+" : ""}${o.std}σ)`)
                .join(", ")}`
            );
          }
          lines.push(`  · ${s.symbol}: ${parts.join(" · ")} — OUTLIER = sốc dữ liệu, LEVEL_SHIFT = thị trường đổi chế (khai báo khi trích dẫn giá các mã này).`);
        }
      }
    }

    if (beta) {
      const syms = beta.symbols ?? [];
      if (syms.length > 0) {
        const sorted = [...syms].sort((a, b) => (b.beta ?? 0) - (a.beta ?? 0));
        const top3 = sorted.slice(0, 3);
        const destab = syms.filter((s) => s.destabilising);
        lines.push(
          `- β động so ${beta.market ?? "VNINDEX"} (TVP Kalman ch. 8, ngày ${beta.date ?? "?"}): ` +
            top3
              .map((s) => `${s.symbol} β=${(s.beta ?? 0).toFixed(2)}±${(s.betaSd ?? 0).toFixed(2)}`)
              .join(" · ") +
            ` — rủi ro rổ ~${Math.round((beta.summary?.avgSystematicShare ?? 0) * 100)}% thị trường / ~${Math.round((1 - (beta.summary?.avgSystematicShare ?? 0)) * 100)}% riêng từng mã.`
        );
        if (destab.length > 0) {
          lines.push(
            `  · Quan hệ destabilising (Var(β) phình/β dịch nhanh): ${destab
              .slice(0, 4)
              .map((s) => `${s.symbol} (${(s.reasons ?? []).join("; ").slice(0, 60)})`)
              .join(" · ")} — cẩn thận dùng tương quan lịch sử của các mã này.`
          );
        }
      }
    }

    lines.push(
      "(Các cờ này là kiểm định đọc-only — không tự động chặn lệnh; dùng để khai báo độ confound khi lập luận.)"
    );
    block = lines.join("\n");
  } catch {
    block = null; // fail-soft — prompt y như trước Phase 2
  }
  cache = { at: Date.now(), block };
  return block;
}

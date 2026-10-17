import { db } from "@/lib/db";
import { callLlm } from "@/lib/llm";
import { markSource, type SourceMode } from "@/lib/sources";
import { nextReleaseEstimate, type ReleaseEstimate } from "@/lib/macro-calendar";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * F-02 PHA A + F-16 — PIPELINE CHUỖI VĨ MÔ NỘI ĐỊA VIỆT NAM (#129-D)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * docs/AI_ENGINEER_REVIEW_BRAIN.md §F-02: lớp 2 của khung top-down (vĩ mô
 * nội địa) — 10 chuỗi CPI/GDP/SBV/tín dụng/M2/PMI/TPCP/liên ngân hàng/XNK/
 * FDI — trước đây chỉ tồn tại trong khối "CÒN THIẾU" của prompt A20, giờ có
 * model riêng (MacroSeries/MacroObservation) vì chu kỳ tháng/quý ≠ nhịp phiên
 * và cần metadata công bố.
 *
 * Pha A (module này) = TRÍCH XUẤT CÓ TRÍCH DẪN TỪ TIN RSS:
 *   30 tin category=macro (60 ngày, chưa quét) → 1 LỜI GỌI callLlm duy nhất
 *   → hợp đồng JSON chặt → GUARD CHỐNG BỊA nhiều tầng (N2) → upsert
 *   MacroObservation mode=extracted + sourceUrl + quoteVerbatim.
 *
 * Pha B (khi có egress — KHÔNG thuộc module này): adapter GSO/SBV/TPCP theo
 * khuôn multi-market-sync.ts, bản real đè extracted (Q12).
 *
 * Quy tắc chất lượng áp dụng (§F-16):
 * - Q10 point-in-time: mọi consumer chỉ thấy observation có releaseAt ≤ asOf.
 * - Q11 đơn vị: MacroSeries.unit là nguồn sự thật DUY NHẤT — mọi format
 *   hiển thị đi qua formatMacroValue/formatMacroDelta, cấm heuristic tầng tiêu
 *   thụ đoán lại đơn vị.
 * - Q12 dedupe kỳ + sửa số: unique (seriesId, periodLabel); bản real/manual
 *   KHÔNG bao giờ bị extracted đè; extracted khác số → update-in-place kèm
 *   cờ revised=true (nhận biết số bị sửa — lịch sử không bịa ngược).
 * - Q13 stale theo tần suất: monthly > 45 ngày / quarterly > 120 ngày không
 *   kỳ mới → snapshot.stale=true (ngưỡng 4h của nguồn giá KHÔNG áp dụng).
 *
 * DataSourceStatus key "macro-vn": mode "extracted" (đã có ≥1 observation)
 * | "pending" (chưa có) — markSource sau mỗi ingest.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. KHAI BÁO 10 CHUỖI (F-02 Pha A #129-D)
// ─────────────────────────────────────────────────────────────────────────────

export type MacroFrequency = "monthly" | "quarterly";

/**
 * Đơn vị theo N5/Q11 — MacroSeries.unit là nguồn sự thật. 3 đơn vị gốc đặc tả
 * ("%", "tỷ VND", "lần") được mở rộng thêm "tỷ USD" (GSO công bố XNK/FDI theo
 * USD — ép "tỷ VND" sẽ sai sự thật số liệu) và "điểm" (PMI là chỉ số index,
 * không phải %). Formatter xử lý cả 5 + fallback generic cho chuỗi tương lai.
 */
export type MacroUnit = "%" | "tỷ VND" | "tỷ USD" | "điểm" | "lần";

export interface MacroSeriesDef {
  key: string;
  /** Tên hiển thị tiếng Việt đầy đủ (lưu MacroSeries.name). */
  name: string;
  /** Tên ngắn cho dòng prompt (vd "CPI" — giữ dòng prompt gọn). */
  shortName: string;
  /** Nguồn sự thật đơn vị (Q11). */
  unit: MacroUnit;
  frequency: MacroFrequency;
  /** Ước số ngày sau cuối kỳ mà nguồn chính thức thường công bố (meta/F-16). */
  releaseLagDays: number;
  /** Nguồn chính thức của chuỗi — Pha B sẽ chuyển sang adapter này. */
  officialSource: string;
  /** Phạm vi giá trị hợp lý — guard chống bịa tầng 3 (vd CPI % không thể 24.500). */
  sanityRange: [number, number];
}

export const MACRO_VN_SERIES: MacroSeriesDef[] = [
  {
    key: "CPI_YOY",
    name: "Chỉ số giá tiêu dùng (CPI, so với cùng kỳ năm trước)",
    shortName: "CPI",
    unit: "%",
    frequency: "monthly",
    releaseLagDays: 29,
    officialSource: "gso",
    sanityRange: [-20, 50],
  },
  {
    key: "GDP_YOY",
    name: "Tăng trưởng GDP (so với cùng kỳ năm trước)",
    shortName: "GDP",
    unit: "%",
    frequency: "quarterly",
    releaseLagDays: 20,
    officialSource: "gso",
    sanityRange: [-30, 50],
  },
  {
    key: "SBV_REFI_RATE",
    name: "Lãi suất tái cấp vốn của Ngân hàng Nhà nước (SBV)",
    shortName: "Lãi SBV",
    unit: "%",
    frequency: "monthly",
    releaseLagDays: 1,
    officialSource: "sbv",
    sanityRange: [0, 50],
  },
  {
    key: "CREDIT_YOY",
    name: "Tăng trưởng tín dụng nền kinh tế (so cùng kỳ)",
    shortName: "Tín dụng",
    unit: "%",
    frequency: "monthly",
    releaseLagDays: 15,
    officialSource: "sbv",
    sanityRange: [-30, 100],
  },
  {
    key: "M2_YOY",
    name: "Tăng trưởng cung tiền M2 (so cùng kỳ)",
    shortName: "M2",
    unit: "%",
    frequency: "monthly",
    releaseLagDays: 15,
    officialSource: "sbv",
    sanityRange: [-30, 100],
  },
  {
    key: "PMI_MANU",
    name: "Chỉ số quản trị mua hàng sản xuất (PMI, S&P Global)",
    shortName: "PMI",
    unit: "điểm",
    frequency: "monthly",
    releaseLagDays: 1,
    officialSource: "spglobal",
    sanityRange: [0, 100],
  },
  {
    key: "VNGB_10Y",
    name: "Lợi suất trái phiếu chính phủ Việt Nam kỳ hạn 10 năm",
    shortName: "TPCP 10Y",
    unit: "%",
    frequency: "monthly",
    releaseLagDays: 0,
    officialSource: "hose",
    sanityRange: [0, 50],
  },
  {
    key: "INTERBANK_OVN",
    name: "Lãi suất liên ngân hàng qua đêm (OVN)",
    shortName: "Liên NH OVN",
    unit: "%",
    frequency: "monthly",
    releaseLagDays: 1,
    officialSource: "sbv",
    sanityRange: [0, 100],
  },
  {
    key: "TRADE_BAL",
    name: "Cán cân thương mại (xuất khẩu − nhập khẩu)",
    shortName: "Thương mại",
    unit: "tỷ USD",
    frequency: "monthly",
    releaseLagDays: 29,
    officialSource: "gso",
    sanityRange: [-50, 50],
  },
  {
    key: "FDI_DISB",
    name: "FDI vốn thực hiện giải ngân trong kỳ",
    shortName: "FDI giải ngân",
    unit: "tỷ USD",
    frequency: "monthly",
    releaseLagDays: 29,
    officialSource: "gso",
    sanityRange: [0, 100],
  },
];

const SERIES_BY_KEY = new Map(MACRO_VN_SERIES.map((s) => [s.key, s]));

/** Key DataSourceStatus của nguồn vĩ mô VN (S4 stale marking). */
export const MACRO_VN_SOURCE_KEY = "macro-vn";

/**
 * AppSetting cursor: lần ingest cuối (ISO 8601). Tin publishedAt ≤ cursor đã
 * được quét — không gửi lại cho LLM (tiết kiệm 1 lần gọi/ingest, đúng tinh
 * thần "CHƯA có MacroObservation trích từ nó" — MacroObservation không có cột
 * liên kết NewsItem nên dùng mốc thời gian thay vì bảng join).
 */
const LAST_INGEST_SETTING_KEY = "macro-vn-last-ingest-at";

/** Cửa sổ tin vĩ mô gửi cho LLM: 60 ngày gần nhất (F-02 Pha A). */
const NEWS_WINDOW_DAYS = 60;

/**
 * Từ khoá vĩ mô cho tin KHÔNG có category (category null) — chỉ dùng để BỔ
 * SUNG tin lọt sót phân loại, không thay thế rule chính category="macro".
 */
const MACRO_NEWS_KEYWORDS: readonly string[] = [
  "CPI",
  "GDP",
  "PMI",
  "M2",
  "FDI",
  "lạm phát",
  "lãi suất",
  "tín dụng",
  "trái phiếu",
  "liên ngân hàng",
  "xuất nhập khẩu",
  "xuất khẩu",
  "nhập khẩu",
  "thương mại",
  "vĩ mô",
  "GSO",
  "tổng cục thống kê",
  "ngân hàng nhà nước",
  "SBV",
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. ENSURE 10 CHUỖI (idempotent — 1 lần/process bằng module flag)
// ─────────────────────────────────────────────────────────────────────────────

let macroSeriesEnsured = false;
let macroSeriesEnsurePromise: Promise<void> | null = null;

/**
 * Upsert 10 MacroSeries nếu thiếu — idempotent, chạy đúng 1 lần/process
 * (module flag + single-flight promise). DB lỗi → reset flag cho lần thử sau
 * (fail-soft: process vẫn phục vụ được phần còn lại của API).
 *
 * update CHỈ chạm các trường "hiển thị" (name/unit/frequency) thuộc quyền
 * config của module — KHÔNG đụng `source`/`meta` (Pha B/C có thể nâng cấp
 * lên adapter chính thức, không bị tiến trình cũ đè ngược).
 */
export async function ensureMacroSeries(): Promise<void> {
  if (macroSeriesEnsured) return;
  macroSeriesEnsurePromise ??= (async () => {
    for (const def of MACRO_VN_SERIES) {
      await db.macroSeries.upsert({
        where: { key: def.key },
        create: {
          key: def.key,
          name: def.name,
          unit: def.unit,
          frequency: def.frequency,
          source: "news-extract", // Pha A: nguồn duy nhất hiện có là trích xuất tin
          meta: JSON.stringify({
            releaseLagDays: def.releaseLagDays,
            officialSource: def.officialSource, // Pha B sẽ chuyển sang adapter này
            sanityRange: def.sanityRange,
            phase: "A",
            taskRef: "F-02 Pha A + F-16 #129-D",
          }),
        },
        update: {
          name: def.name,
          unit: def.unit,
          frequency: def.frequency,
        },
      });
    }
    macroSeriesEnsured = true;
  })().catch((err) => {
    // Cho phép lần gọi sau retry (vd Supabase transient restart)
    macroSeriesEnsurePromise = null;
    throw err;
  });
  return macroSeriesEnsurePromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TIỆN ÍCH KỲ + ĐỊNH DẠNG (Q11 — đơn vị khai báo 1 chỗ)
// ─────────────────────────────────────────────────────────────────────────────

const MONTHLY_LABEL_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTERLY_LABEL_RE = /^Q([1-4])-(\d{4})$/;

/** periodLabel hợp lệ cho tần suất: monthly "YYYY-MM" · quarterly "Qn-YYYY". */
export function isValidPeriodLabel(
  label: string,
  frequency: MacroFrequency
): boolean {
  if (frequency === "monthly") return MONTHLY_LABEL_RE.test(label);
  return QUARTERLY_LABEL_RE.test(label);
}

/** Ngày ĐẦU kỳ theo periodLabel (UTC — deterministic). null nếu label sai. */
export function periodStartOfLabel(label: string): Date | null {
  const monthly = MONTHLY_LABEL_RE.exec(label);
  if (monthly) {
    const y = Number(monthly[0].slice(0, 4));
    const m = Number(monthly[0].slice(5, 7));
    return new Date(Date.UTC(y, m - 1, 1));
  }
  const quarterly = QUARTERLY_LABEL_RE.exec(label);
  if (quarterly) {
    const y = Number(quarterly[2]);
    const q = Number(quarterly[1]);
    return new Date(Date.UTC(y, (q - 1) * 3, 1)); // Q1→T1 · Q2→T4 · Q3→T7 · Q4→T10
  }
  return null;
}

/** Số VN kiểu "1.234,56" — toLocaleString vi-VN đủ cho cả grouping lẫn thập phân. */
function vnNum(v: number, min: number, max: number): string {
  return v.toLocaleString("vi-VN", {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });
}

/**
 * Q11 — format GIÁ TRỊ theo MacroSeries.unit (nguồn sự thật đơn vị duy nhất).
 * Tầng tiêu thụ KHÔNG được tự đoán lại đơn vị từ độ lớn con số.
 */
export function formatMacroValue(value: number, unit: string): string {
  switch (unit) {
    case "%":
      return `${vnNum(value, 2, 2)}%`;
    case "tỷ VND":
    case "tỷ USD":
      return `${vnNum(value, 1, 2)} ${unit}`;
    case "điểm":
      return `${vnNum(value, 1, 1)} điểm`;
    case "lần":
      return `${vnNum(value, 1, 2)} lần`;
    default:
      // Chuỗi tương lai khai unit riêng — format trung tính + đơn vị khai báo
      return `${vnNum(value, 2, 2)} ${unit}`.trim();
  }
}

/**
 * Q11 — format Δ KỲ TRƯỚC theo đơn vị. Riêng unit "%": "đ" = điểm % (đúng
 * khuôn prompt A20 "Δ −0,21đ vs kỳ trước"). Dùng "−" U+2212 cho số âm như
 * fmtSignedPct của agent-context.ts.
 */
export function formatMacroDelta(delta: number, unit: string): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const abs = Math.abs(delta);
  switch (unit) {
    case "%":
      return `${sign}${vnNum(abs, 2, 2)}đ`;
    case "tỷ VND":
    case "tỷ USD":
      return `${sign}${vnNum(abs, 1, 2)} ${unit}`;
    case "điểm":
      return `${sign}${vnNum(abs, 1, 1)} điểm`;
    case "lần":
      return `${sign}${vnNum(abs, 1, 2)} lần`;
    default:
      return `${sign}${vnNum(abs, 2, 2)} ${unit}`.trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GUARD CHỐNG BỊA — TRÍCH DẪN PHẢI CHỨA CON SỐ (N2, trái tim của Pha A)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sinh các "chuỗi số" mà bài VIỆT có thể viết cho value:
 * - "3.45" (chấm thập phân kiểu Anh) và "3,45" (dấu phẩy thập phân kiểu VN);
 * - số nguyên ≥ 1000: "24.500" / "24,500" / "24 500" (grouping nghìn);
 * - số âm: dấu trừ ASCII "-" + các ký tự hay lọt trong báo chí "−" "–" "—";
 *   đồng thời chấp nhận dạng KHÔNG dấu (báo VN diễn đạt dấu bằng từ —
 *   "nhập siêu 1,2 tỷ USD" là -1.2 — phần dấu là ngữ nghĩa, chuỗi số không
 *   mang dấu được; guard không suy đoán dấu, nhiệm vụ của nó là bắt số BỊA).
 */
function numberCandidates(value: number): string[] {
  const abs = Math.abs(value);
  const plain = String(abs);
  const base = new Set<string>([plain, plain.replace(".", ",")]);
  if (Number.isInteger(abs) && abs >= 1000) {
    const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, "#");
    for (const sep of [".", ",", " ", "\u00A0", "\u202F"]) {
      base.add(grouped.replaceAll("#", sep));
    }
  }
  const out = [...base];
  if (value < 0) {
    for (const c of [...base]) {
      for (const minus of ["-", "−", "–", "—"]) out.push(minus + c);
    }
  }
  return out;
}

/**
 * Guard N2 (chống bịa): quoteVerbatim PHẢI chứa chuỗi số của value — kiểm cả
 * dấu phẩy thập phân kiểu VN (value 3.45 → quote chứa "3,45" hoặc "3.45").
 *
 * Ràng buộc biên trái: ký tự TRƯỚC con số phải KHÔNG phải chữ số (value 3.45
 * không được thỏa mãn bởi "13,45" trong bài). Biên phải KHÔNG ràng buộc —
 * chấp nhận trích "3,45" từ "3,452" (LLM làm tròn bớt số lẻ, vẫn là số của
 * bài chứ không phải bịa). So khớp cả bản quote đã strip khoảng trắng (báo
 * chí hay group nghìn bằng khoảng trắng mỏng).
 */
export function quoteContainsValue(quote: string, value: number): boolean {
  const hayNoSpace = quote.replace(/[\s\u00A0\u202F]/g, "");
  return numberCandidates(value).some((cand) => {
    // Regex dựng từ chuỗi runtime (new RegExp) — giữ nguyên tính di động target
    // ES2017 của tsconfig: lookbehind chạy trên Node/Bun hiện đại, TS không tĩnh
    // kiểm cú pháp regex dựng bằng chuỗi.
    if (new RegExp(`(?<![0-9])${escapeRegExp(cand)}`).test(quote)) return true;
    // Candidate group nghìn bằng khoảng trắng ("24 500") — so với bản quote
    // đã strip khoảng trắng, vẫn giữ biên trái chữ số.
    if (/[\s\u00A0\u202F]/.test(cand)) {
      return new RegExp(
        `(?<![0-9])${escapeRegExp(cand.replace(/[\s\u00A0\u202F]/g, ""))}`
      ).test(hayNoSpace);
    }
    return false;
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. TRÍCH XUẤT LLM CÓ TRÍCH DẪN — extractMacroFromNews (trái tim F-02 Pha A)
// ─────────────────────────────────────────────────────────────────────────────

export interface MacroIngestResult {
  /** Số tin thực sự gửi cho LLM trong lượt này. */
  scanned: number;
  /** Số MacroObservation ghi MỚI (kỳ chưa từng có). */
  extracted: number;
  /** Số item LLM trả về nhưng bị guard/qui tắc Q12 từ chối (gồm trùng số). */
  rejected: number;
  /** Số kỳ extracted đã có bị SỬA SỐ (Q12 — update-in-place, cờ revised). */
  revised: number;
  /** Chi tiết từng lần từ chối (giới hạn độ dài để không phình log/audit). */
  reasons: string[];
  /** Lỗi LLM/parse nếu có — ingest vẫn trả 200 (fail-soft), cursor KHÔNG tiến. */
  llmError?: string;
  /** Mốc cursor mới sau lượt (ISO) — bằng asOf khi quét thành công. */
  lastIngestAt: string;
}

/** Item sau khi qua TOÀN BỘ guard — sẵn sàng ghi DB. */
interface ValidatedItem {
  seriesKey: string;
  seriesId: string;
  periodLabel: string;
  periodStart: Date;
  value: number;
  quoteVerbatim: string;
  releaseAt: Date;
  sourceUrl: string;
}

interface ScannedNewsItem {
  url: string;
  title: string;
  summary: string | null;
  publishedAt: Date;
}

const MAX_REASONS = 40;
const REASON_MAX_LEN = 200;
const QUOTE_STORE_MAX_LEN = 500;

function pushReason(reasons: string[], reason: string): void {
  if (reasons.length < MAX_REASONS) {
    reasons.push(reason.length > REASON_MAX_LEN ? reason.slice(0, REASON_MAX_LEN - 1) + "…" : reason);
  }
}

/** Đọc cursor lần ingest cuối từ AppSetting (ISO) — null nếu chưa từng chạy. */
async function readLastIngestAt(): Promise<Date | null> {
  try {
    const row = await db.appSetting.findUnique({
      where: { key: LAST_INGEST_SETTING_KEY },
      select: { value: true },
    });
    if (!row) return null;
    const t = Date.parse(row.value);
    return Number.isFinite(t) ? new Date(t) : null;
  } catch {
    return null; // fail-soft: coi như chưa từng ingest → quét cửa sổ 60 ngày
  }
}

/** Ghi cursor mới (best-effort — lỗi ghi không làm hỏng ingest đã xong). */
async function writeLastIngestAt(at: Date): Promise<void> {
  try {
    await db.appSetting.upsert({
      where: { key: LAST_INGEST_SETTING_KEY },
      create: { key: LAST_INGEST_SETTING_KEY, value: at.toISOString() },
      update: { value: at.toISOString() },
    });
  } catch (err) {
    console.error("[lib/macro-vn] ghi cursor last-ingest lỗi (bỏ qua):", err);
  }
}

/**
 * Trích xuất chuỗi vĩ mô từ tin tức — 1 LỜI GỌI LLM/ingest (ràng buộc N2 +
 * tiết kiệm chi phí; callLlm đã đi qua throttle toàn cục #93).
 *
 * Quy trình:
 * 1. ensureMacroSeries() — 10 chuỗi tồn tại sẵn trong DB.
 * 2. Query tin: category="macro" (hoặc category NULL + title/summary chứa từ
 *    khoá vĩ mô), publishedAt trong (cursor, now], tối đa `limit` tin — tin
 *    cũ hơn cursor đã quét rồi, không đốt token lần hai.
 * 3. 1 prompt duy nhất → callLlm → JSON array; guard từng item (seriesKey ∈
 *    10 key · value hữu hạn · periodLabel đúng format · quoteVerbatim chứa
 *    chuỗi số của value · releaseAt ≤ now · releaseAt ≥ periodStart ·
 *    sanityRange · newsUrl thuộc danh sách đã quét).
 * 4. Upsert Q12: real/manual không bao giờ bị đè; extracted trùng số bỏ qua;
 *    extracted khác số → update-in-place + revised=true.
 * 5. markSource("macro-vn") — mode extracted|pending theo số observation.
 *
 * LLM/parse lỗi → KHÔNG tiến cursor (tin còn nguyên cho lượt retry sau).
 */
export async function extractMacroFromNews(limit = 30): Promise<MacroIngestResult> {
  const now = new Date();
  const reasons: string[] = [];
  const clampedLimit = Math.max(1, Math.min(100, Math.round(limit)));

  await ensureMacroSeries();

  // ── 2. Chọn tin chưa quét trong cửa sổ 60 ngày ──────────────────────────
  const lastIngest = await readLastIngestAt();
  const since = lastIngest ?? new Date(now.getTime() - NEWS_WINDOW_DAYS * 86_400_000);
  const keywordMatch = MACRO_NEWS_KEYWORDS.map((kw) => ({
    OR: [
      { title: { contains: kw, mode: "insensitive" as const } },
      { summary: { contains: kw, mode: "insensitive" as const } },
    ],
  }));
  const news = await db.newsItem.findMany({
    where: {
      publishedAt: { gt: since, lte: now },
      OR: [
        { category: "macro" },
        { AND: [{ category: null }, ...keywordMatch] },
      ],
    },
    orderBy: { publishedAt: "desc" },
    take: clampedLimit,
    select: { url: true, title: true, summary: true, publishedAt: true },
  });

  const emptyResult = (llmError?: string): MacroIngestResult => ({
    scanned: news.length,
    extracted: 0,
    rejected: 0,
    revised: 0,
    reasons,
    ...(llmError ? { llmError } : {}),
    lastIngestAt: since.toISOString(),
  });

  if (news.length === 0) {
    // Không có tin mới — vẫn markSource để DataSourceStatus phản ánh đúng mode
    await markMacroSource(true, 0, 0, 0, undefined);
    return emptyResult();
  }

  // ── 3. Một prompt duy nhất → callLlm (fail-soft, 1 lần/ingest) ──────────
  let raw = "";
  try {
    const res = await callLlm(buildSystemPrompt(), buildUserPrompt(news, now));
    raw = res.raw;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lib/macro-vn] callLlm lỗi (fail-soft, giữ cursor):", err);
    await markMacroSource(false, news.length, 0, 0, msg);
    return emptyResult(`LLM lỗi: ${msg}`);
  }

  const items = parseJsonArray(raw);
  if (items == null) {
    const msg = "LLM trả về không parse được JSON array";
    console.error("[lib/macro-vn] parse JSON thất bại (giữ cursor) — raw 200 ký tự đầu:", raw.slice(0, 200));
    await markMacroSource(false, news.length, 0, 0, msg);
    return emptyResult(`LLM lỗi: ${msg}`);
  }

  // ── Guard từng item ──────────────────────────────────────────────────────
  const seriesRows = await db.macroSeries.findMany({ select: { id: true, key: true } });
  const seriesIdByKey = new Map(seriesRows.map((s) => [s.key, s.id]));
  const newsByUrl = new Map(news.map((n) => [n.url, n]));
  const seenPeriods = new Set<string>(); // dedupe trong cùng lô

  let extracted = 0;
  let rejected = 0;
  let revised = 0;
  const valid: ValidatedItem[] = [];

  for (const item of items) {
    const v = validateItem(item, newsByUrl, seriesIdByKey, now, reasons);
    if (!v) {
      rejected++;
      continue;
    }
    const batchKey = `${v.seriesKey}|${v.periodLabel}`;
    if (seenPeriods.has(batchKey)) {
      rejected++;
      pushReason(reasons, `trùng chuỗi+kỳ trong cùng lô: ${batchKey} — giữ bản đầu`);
      continue;
    }
    seenPeriods.add(batchKey);
    valid.push(v);
  }

  // ── 4. Upsert Q12 (unique [seriesId, periodLabel]) ───────────────────────
  const touchedSeriesIds = new Set<string>();
  for (const v of valid) {
    try {
      const existing = await db.macroObservation.findUnique({
        where: { seriesId_periodLabel: { seriesId: v.seriesId, periodLabel: v.periodLabel } },
      });
      if (existing && (existing.mode === "real" || existing.mode === "manual")) {
        // Q12: bản real/manual thắng — extracted KHÔNG bao giờ đè.
        rejected++;
        pushReason(
          reasons,
          `kỳ ${v.periodLabel} của ${v.seriesKey} đã có bản ${existing.mode} — giữ nguyên, không đè (Q12)`
        );
        continue;
      }
      if (existing) {
        if (Math.abs(existing.value - v.value) < 1e-9) {
          // Trùng kỳ trùng số — dedupe im lặng (không đếm extracted)
          rejected++;
          pushReason(reasons, `kỳ ${v.periodLabel} của ${v.seriesKey} trùng số ${v.value} đã có — bỏ`);
          continue;
        }
        // Q12 — extracted khác số: SỬA SỐ (báo chí phát hành bản điều chỉnh,
        // hoặc 2 bài cùng kỳ khác số). Unique [seriesId, periodLabel] chỉ cho
        // phép 1 hàng/kỳ nên "bản cũ superseded + bản mới" được thực thi là
        // update-in-place: giá trị/quote/nguồn/releaseAt MỚI + cờ revised=true
        // (nhận biết số từng bị sửa); releaseAt lấy của bản MỚI để Q10
        // point-in-time không bị look-ahead (số mới chỉ hợp lệ từ lúc nó
        // công bố). Bản cũ vắng mặt ở hàng — chi tiết đổi số nằm trong
        // reasons[] + AuditLog MACRO_INGESTED của lượt này.
        await db.macroObservation.update({
          where: { id: existing.id },
          data: {
            value: v.value,
            periodStart: v.periodStart,
            releaseAt: v.releaseAt,
            sourceUrl: v.sourceUrl,
            quoteVerbatim: v.quoteVerbatim.slice(0, QUOTE_STORE_MAX_LEN),
            mode: "extracted",
            superseded: false,
            revised: true,
          },
        });
        revised++;
        touchedSeriesIds.add(v.seriesId);
        pushReason(
          reasons,
          `sửa số ${v.seriesKey} kỳ ${v.periodLabel}: ${existing.value} → ${v.value} (revised, Q12)`
        );
      } else {
        await db.macroObservation.create({
          data: {
            seriesId: v.seriesId,
            periodLabel: v.periodLabel,
            periodStart: v.periodStart,
            value: v.value,
            releaseAt: v.releaseAt,
            mode: "extracted",
            superseded: false,
            revised: false,
            sourceUrl: v.sourceUrl,
            quoteVerbatim: v.quoteVerbatim.slice(0, QUOTE_STORE_MAX_LEN),
          },
        });
        extracted++;
        touchedSeriesIds.add(v.seriesId);
      }
    } catch (err) {
      // Fail-soft từng item: 1 lỗi DB không chặn các item còn lại
      rejected++;
      pushReason(reasons, `lỗi ghi DB ${v.seriesKey} kỳ ${v.periodLabel}: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[lib/macro-vn] upsert observation lỗi (bỏ qua item):", err);
    }
  }

  // ── latestObservedAt cho các chuỗi vừa có observation mới/sửa ────────────
  for (const seriesId of touchedSeriesIds) {
    try {
      const latest = await db.macroObservation.findFirst({
        where: { seriesId, superseded: false },
        orderBy: { periodStart: "desc" },
        select: { releaseAt: true },
      });
      await db.macroSeries.update({
        where: { id: seriesId },
        data: { latestObservedAt: latest?.releaseAt ?? null },
      });
    } catch (err) {
      console.error("[lib/macro-vn] cập nhật latestObservedAt lỗi (bỏ qua):", err);
    }
  }

  // ── 5. Cursor + DataSourceStatus ─────────────────────────────────────────
  // LLM đã xử lý xong lô tin này (kể cả 0 số trích được) → tiến cursor để
  // không gửi lại lượt sau.
  await writeLastIngestAt(now);
  await markMacroSource(true, news.length, extracted, rejected, undefined, revised);

  return {
    scanned: news.length,
    extracted,
    rejected,
    revised,
    reasons,
    lastIngestAt: now.toISOString(),
  };
}

/** markSource("macro-vn") — mode extracted|pending, meta đếm lượt ingest. */
async function markMacroSource(
  success: boolean,
  scanned: number,
  extracted: number,
  rejected: number,
  lastError?: string,
  revised?: number
): Promise<void> {
  try {
    let obsCount = 0;
    try {
      obsCount = await db.macroObservation.count();
    } catch {
      // DB lỗi khi đếm → không đổi mode cũ (chỉ ghi lastError/lastSuccessAt)
    }
    const mode: SourceMode = obsCount > 0 ? "extracted" : "pending";
    await markSource(MACRO_VN_SOURCE_KEY, {
      mode,
      success,
      ...(lastError ? { lastError } : {}),
      meta: { scanned, extracted, rejected, ...(revised != null ? { revised } : {}) },
    });
  } catch (err) {
    console.error("[lib/macro-vn] markSource lỗi (bỏ qua):", err);
  }
}

/** System prompt tiếng Việt — nhấn mạnh N2 chống bịa (không suy ra/nội suy/quy đổi). */
function buildSystemPrompt(): string {
  const seriesLines = MACRO_VN_SERIES.map(
    (s) =>
      `- ${s.key} — ${s.name}, đơn vị ${s.unit}, kỳ ${s.frequency === "monthly" ? 'tháng ("YYYY-MM")' : 'quý ("Qn-YYYY", vd Q3-2026)'}`
  ).join("\n");
  return [
    "Bạn là bộ trích xuất số liệu vĩ mô Việt Nam của hệ thống giao dịch The Trader (F-02 Pha A).",
    "Nhiệm vụ: đọc danh sách bài viết kinh tế và TRÍCH XUẤT số liệu vĩ mô cho 10 chuỗi dưới đây.",
    "",
    "QUY TẮC TUYỆT ĐỐI (nguyên tắc N2 — chống bịa số liệu, vi phạm nào cũng làm dữ liệu bẩn):",
    "1. CHỈ trích con số NGUYÊN VĂN có trong bài (bài viết \"3,45%\" thì value = 3.45 — giữ đúng số lẻ của bài).",
    "2. TUYỆT ĐỐI KHÔNG: suy ra, nội suy, quy đổi đơn vị, làm tròn thêm, cộng dồn nhiều số, tính trung bình.",
    "3. Bài KHÔNG nêu rõ KỲ thống kê (tháng/quý nào — \"kỳ gần nhất\" mơ hồ không tính) → BỎ QẢ bài đó.",
    "4. Con số không thuộc 1 trong 10 chuỗi (giá vàng, tỷ giá USD/VND, chỉ số chứng khoán, giá dầu…) → BỎ QUA.",
    "5. quoteVerbatim = câu NGUYÊN VĂN trong bài chứa con số — sao chép chính xác, PHẢI chứa đúng con số (giữ \"3,45\" nếu bài dùng dấu phẩy thập phân).",
    "6. Mỗi cặp (chuỗi, kỳ) bài nêu rõ mới trích — một bài có thể cho nhiều chuỗi, một chuỗi chỉ một kỳ.",
    "",
    "10 CHUỖI ĐƯỢC PHÉP TRÍCH:",
    seriesLines,
    "",
    "ĐỊNH DẠNG ĐẦU RA — MẢNG JSON THUẦN (không markdown, không giải thích, không văn thừa):",
    '[{"newsUrl": "<url bài>", "seriesKey": "<1 trong 10 key>", "periodLabel": "<YYYY-MM hoặc Qn-YYYY>", "value": <số>, "quoteVerbatim": "<câu nguyên văn>", "periodStart": "<YYYY-MM-DD>", "releaseAt": "<YYYY-MM-DD>"}]',
    "- releaseAt: ngày bài đăng (đã cung cấp theo từng bài) HOẶC ngày công bố số liệu nếu bài nêu rõ ngày cụ thể — không được ở tương lai.",
    "- periodStart: ngày đầu kỳ (01 của tháng, hoặc ngày đầu quý).",
    "- Không tìm thấy số liệu phù hợp nào → trả đúng mảng rỗng [].",
  ].join("\n");
}

function buildUserPrompt(news: ScannedNewsItem[], asOf: Date): string {
  const blocks = news.map((n, i) => {
    const lines = [
      `[Bài ${i + 1}] newsUrl: ${n.url}`,
      `đăng ngày: ${n.publishedAt.toISOString()}`,
      `tiêu đề: ${n.title}`,
    ];
    if (n.summary && n.summary.trim().length > 0) {
      lines.push(`trích dẫn: ${n.summary.slice(0, 400)}`);
    } else {
      lines.push("trích dẫn: (bài không có tóm tắt — chỉ dựa vào tiêu đề)");
    }
    return lines.join("\n");
  });
  return [
    `THỜI ĐIỂM HIỆN TẠI (asOf): ${asOf.toISOString()}`,
    "",
    `DANH SÁCH ${news.length} BÀI VIẾT:`,
    blocks.join("\n\n"),
    "",
    "TRẢ NGAY MẢNG JSON (chỉ JSON, không giải thích):",
  ].join("\n");
}

/**
 * Parse mảng JSON từ raw LLM — cắt ```json fence nếu có, rồi cắt substring
 * từ "[" đầu tiên đến "]" cuối cùng (chống văn thừa bao quanh). null = hỏng.
 */
export function parseJsonArray(raw: string): unknown[] | null {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Guard 1 item LLM — trả null + reason khi vi phạm bất kỳ điều kiện nào:
 * (a) cấu trúc: object, newsUrl/seriesKey/periodLabel/value/quoteVerbatim;
 * (b) newsUrl PHẢI thuộc danh sách tin đã quét (chống bịa nguồn);
 * (c) seriesKey ∈ 10 key; periodLabel đúng format tần suất;
 * (d) value số hữu hạn + trong sanityRange chuỗi (chống số vô lý);
 * (e) quoteVerbatim không rỗng + PHẢI chứa chuỗi số của value (dấu phẩy
 *     thập phân kiểu VN chấp nhận) — trái tim guard N2;
 * (f) periodStart (máy tính từ periodLabel) ≤ now — không có số của kỳ tương lai;
 * (g) releaseAt ≤ now (Q10 — không tin số chưa công bố) và ≥ periodStart
 *     (không có số công bố trước khi kỳ bắt đầu).
 */
function validateItem(
  item: unknown,
  newsByUrl: Map<string, ScannedNewsItem>,
  seriesIdByKey: Map<string, string>,
  now: Date,
  reasons: string[]
): ValidatedItem | null {
  if (typeof item !== "object" || item === null) {
    pushReason(reasons, "item không phải object");
    return null;
  }
  const o = item as Record<string, unknown>;

  const newsUrl = typeof o.newsUrl === "string" ? o.newsUrl.trim() : "";
  const news = newsUrl ? newsByUrl.get(newsUrl) : undefined;
  if (!news) {
    pushReason(reasons, `newsUrl không thuộc danh sách tin đã quét: ${newsUrl.slice(0, 80) || "(rỗng)"}`);
    return null;
  }

  const seriesKey =
    typeof o.seriesKey === "string" ? o.seriesKey.trim().toUpperCase() : "";
  const def = seriesKey ? SERIES_BY_KEY.get(seriesKey) : undefined;
  if (!def) {
    pushReason(reasons, `seriesKey không hợp lệ: ${seriesKey.slice(0, 40) || "(rỗng)"}`);
    return null;
  }
  const seriesId = seriesIdByKey.get(seriesKey);
  if (!seriesId) {
    // ensureMacroSeries đã chạy — không tới được nhánh này trừ khi DB lag
    pushReason(reasons, `không tìm thấy MacroSeries id cho ${seriesKey}`);
    return null;
  }

  const periodLabel =
    typeof o.periodLabel === "string" ? o.periodLabel.trim() : "";
  if (!isValidPeriodLabel(periodLabel, def.frequency)) {
    pushReason(
      reasons,
      `periodLabel sai format (${def.frequency} cần ${def.frequency === "monthly" ? "YYYY-MM" : "Qn-YYYY"}): ${periodLabel.slice(0, 30) || "(rỗng)"} [${seriesKey}]`
    );
    return null;
  }
  // periodStart do MÁY tính từ periodLabel — không tin giá trị LLM tự điền
  // (n1: trường có thể suy ra thì không nhận từ ngoài).
  const periodStart = periodStartOfLabel(periodLabel);
  if (!periodStart) {
    pushReason(reasons, `periodLabel không tính được periodStart: ${periodLabel}`);
    return null;
  }

  // value: số hữu hạn (chấp nhận chuỗi số "3.45"/"3,45" — LLM hay trả string)
  let value = Number.NaN;
  if (typeof o.value === "number") value = o.value;
  else if (typeof o.value === "string" && o.value.trim() !== "") {
    value = Number(o.value.trim().replace(",", "."));
  }
  if (!Number.isFinite(value)) {
    pushReason(reasons, `value không phải số hữu hạn: ${String(o.value).slice(0, 40)} [${seriesKey}]`);
    return null;
  }
  if (value < def.sanityRange[0] || value > def.sanityRange[1]) {
    pushReason(
      reasons,
      `value ngoài phạm vi hợp lý ${def.sanityRange.join("..")} của ${seriesKey}: ${value}`
    );
    return null;
  }

  const quoteVerbatim = typeof o.quoteVerbatim === "string" ? o.quoteVerbatim.trim() : "";
  if (quoteVerbatim.length === 0) {
    pushReason(reasons, `quoteVerbatim rỗng [${seriesKey} ${periodLabel}] — N2 bắt buộc trích nguyên văn`);
    return null;
  }
  if (!quoteContainsValue(quoteVerbatim, value)) {
    pushReason(
      reasons,
      `quoteVerbatim KHÔNG chứa chuỗi số của value=${value} [${seriesKey} ${periodLabel}] — nghi bịa/giả số`
    );
    return null;
  }

  // releaseAt: ngày công bố nếu bài nêu rõ, ngược lại = publishedAt của bài.
  let releaseAt = news.publishedAt;
  if (typeof o.releaseAt === "string" && o.releaseAt.trim() !== "") {
    const t = Date.parse(o.releaseAt.trim());
    if (Number.isFinite(t)) releaseAt = new Date(t);
  }
  if (releaseAt.getTime() > now.getTime() + 60_000) {
    // Q10: dung sai 1 phút chống lệch đồng hồ chạy deploy
    pushReason(
      reasons,
      `releaseAt ở tương lai (Q10) [${seriesKey} ${periodLabel}]: ${releaseAt.toISOString()}`
    );
    return null;
  }
  if (releaseAt.getTime() < periodStart.getTime()) {
    pushReason(
      reasons,
      `releaseAt trước cả ngày đầu kỳ — không nhất quán [${seriesKey} ${periodLabel}]: ${releaseAt.toISOString()} < ${periodStart.toISOString()}`
    );
    return null;
  }

  return {
    seriesKey,
    seriesId,
    periodLabel,
    periodStart,
    value,
    quoteVerbatim,
    releaseAt,
    sourceUrl: news.url,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. SNAPSHOT — macroSeriesSnapshot (cho API + prompt, tiêu thụ bởi A20)
// ─────────────────────────────────────────────────────────────────────────────

export interface MacroSnapshotEntry {
  key: string;
  name: string;
  unit: string;
  frequency: string;
  /** Kỳ quan sát MỚI NHẤT thỏa Q10 (releaseAt ≤ asOf, chưa superseded). */
  value: number | null;
  /** Kỳ TRƯỚC kỳ mới nhất (cùng điều kiện Q10) — null khi chỉ có 1 kỳ. */
  prevValue: number | null;
  /** value − prevValue (số thô; format hiển thị theo unit tại tầng render). */
  delta: number | null;
  periodLabel: string | null;
  /** real | extracted | manual — null khi chuỗi chưa có observation. */
  mode: string | null;
  sourceUrl: string | null;
  releaseAt: string | null;
  /** Q13: monthly > 45 ngày / quarterly > 120 ngày không kỳ mới (theo releaseAt). */
  stale: boolean;
  /** F-16: ước tính kỳ công bố kế tiếp. */
  nextRelease: ReleaseEstimate;
}

export interface MacroSeriesSnapshot {
  series: MacroSnapshotEntry[];
  /** Series chưa có observation nào — thay khối "CÒN THIẾU" sinh động từ DB. */
  missingKeys: string[];
  /** Lần ingest cuối (ISO) — null khi chưa từng ingest. */
  lastIngestAt: string | null;
}

/** Q13 — ngưỡng stale theo tần suất chuỗi (khác ngưỡng 4h của nguồn giá). */
const STALE_DAYS_MONTHLY = 45;
const STALE_DAYS_QUARTERLY = 120;

/**
 * Snapshot toàn bộ 10 chuỗi tại thời điểm `asOf` (Q10 point-in-time: chỉ
 * observation releaseAt ≤ asOf) — đủ cho dashboard (Δ + mode + stale + kỳ
 * release kế) và cho prompt A20. Chạy ensureMacroSeries() trước (idempotent).
 */
export async function macroSeriesSnapshot(
  asOf: Date = new Date()
): Promise<MacroSeriesSnapshot> {
  await ensureMacroSeries();

  const [seriesRows, lastIngest] = await Promise.all([
    db.macroSeries.findMany({
      orderBy: { key: "asc" },
      select: {
        id: true,
        key: true,
        name: true,
        unit: true,
        frequency: true,
      },
    }),
    readLastIngestAt(),
  ]);

  // Q10: chỉ observation đã CÔNG BỔ tại asOf + chưa bị supersede
  const observations = await db.macroObservation.findMany({
    where: { superseded: false, releaseAt: { lte: asOf } },
    orderBy: { periodStart: "asc" },
    select: {
      seriesId: true,
      periodLabel: true,
      value: true,
      mode: true,
      sourceUrl: true,
      releaseAt: true,
    },
  });

  const idToKey = new Map(seriesRows.map((s) => [s.id, s.key]));
  const bySeries = new Map<string, typeof observations>();
  for (const obs of observations) {
    const key = idToKey.get(obs.seriesId);
    if (!key) continue;
    const list = bySeries.get(key) ?? [];
    list.push(obs);
    bySeries.set(key, list);
  }

  const series: MacroSnapshotEntry[] = seriesRows.map((row) => {
    const def = SERIES_BY_KEY.get(row.key);
    const list = bySeries.get(row.key) ?? [];
    const latest = list.length > 0 ? list[list.length - 1] : null;
    const prev = list.length > 1 ? list[list.length - 2] : null;
    const staleThresholdMs =
      (def?.frequency === "quarterly" ? STALE_DAYS_QUARTERLY : STALE_DAYS_MONTHLY) * 86_400_000;
    const stale =
      latest != null && asOf.getTime() - latest.releaseAt.getTime() > staleThresholdMs;
    return {
      key: row.key,
      name: row.name,
      unit: row.unit,
      frequency: def?.frequency ?? row.frequency,
      value: latest?.value ?? null,
      prevValue: prev?.value ?? null,
      delta: latest != null && prev != null ? latest.value - prev.value : null,
      periodLabel: latest?.periodLabel ?? null,
      mode: latest?.mode ?? null,
      sourceUrl: latest?.sourceUrl ?? null,
      releaseAt: latest?.releaseAt.toISOString() ?? null,
      stale,
      nextRelease: nextReleaseEstimate(row.key, asOf),
    };
  });

  const missingKeys = series.filter((s) => s.value == null).map((s) => s.key);

  return {
    series,
    missingKeys,
    lastIngestAt: lastIngest?.toISOString() ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. PROMPT LINES — macroSeriesPromptLines (khối cho A20 main-agent wire)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dựng khối prompt chuỗi vĩ mô nội địa cho agent (A20 macro-economist —
 * main agent sẽ wire vào agent-context.ts, KHÔNG thuộc phạm vi module này).
 *
 * Series CÓ dữ liệu — đúng khuôn đặc tả F-02:
 *   "- CPI (CPI_YOY, %): 3,45% (2026-09, Δ −0,21đ vs kỳ trước, nguồn
 *    news-extract [URL])"
 * + hậu tố Q13 khi stale: " · CẦN CẬP NHẬT (>45 ngày không kỳ mới; kỳ công
 * bố kế ước tính 2026-10-29)". Series thiếu → 1 dòng khai báo thiếu (kỷ luật
 * không-bịa giống khối "CÒN THIẾU" hiện tại của buildMacroBlock).
 * TUÂN THỦ Q11: mọi con số format qua formatMacroValue/formatMacroDelta theo
 * MacroSeries.unit.
 */
export async function macroSeriesPromptLines(
  asOf: Date = new Date()
): Promise<string[]> {
  const snap = await macroSeriesSnapshot(asOf);

  const lines: string[] = [
    "VĨ MÔ NỘI ĐỊA VIỆT NAM (F-02 Pha A — trích xuất từ tin tức có trích dẫn, đơn vị theo khai báo chuỗi):",
  ];

  const withData = snap.series.filter((s) => s.value != null);
  for (const s of withData) {
    const def = SERIES_BY_KEY.get(s.key);
    const short = def?.shortName ?? s.key;
    let line = `- ${short} (${s.key}, ${s.unit}): ${formatMacroValue(s.value as number, s.unit)} (${s.periodLabel}`;
    if (s.delta != null) {
      line += `, Δ ${formatMacroDelta(s.delta, s.unit)} vs kỳ trước`;
    }
    if (s.sourceUrl) {
      line += `, nguồn ${s.mode} [${s.sourceUrl}]`;
    } else {
      line += `, nguồn ${s.mode ?? "—"}`;
    }
    line += ")";
    if (s.stale) {
      const nextIso = s.nextRelease.dateISO;
      line += ` · CẦN CẬP NHẬT (${Math.round((asOf.getTime() - Date.parse(s.releaseAt as string)) / 86_400_000)} ngày không kỳ mới${nextIso ? `; kỳ công bố kế ước tính ${nextIso}` : ""})`;
    }
    lines.push(line);
  }

  if (snap.missingKeys.length > 0) {
    const missingLabel = snap.missingKeys
      .map((key) => {
        const def = SERIES_BY_KEY.get(key);
        return def ? `${def.shortName} (${key})` : key;
      })
      .join(" · ");
    lines.push(
      `- Còn thiếu chuỗi (KHÔNG bịa số — dùng proxy lớp 1-3 đã khai báo): ${missingLabel}.`
    );
  }

  if (withData.length === 0) {
    // Chưa có gì sau ingest đầu — khai báo trung thực, không lặng thinh
    lines.push(
      "- (pipeline vĩ mô Pha A chưa trích được số nào — coi như CHƯA có dữ liệu, tuyệt đối không bịa CPI/GDP/lãi suất)"
    );
  }

  return lines;
}

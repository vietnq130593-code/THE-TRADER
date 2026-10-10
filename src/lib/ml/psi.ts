/**
 * src/lib/ml/psi.ts — A3 PSI DRIFT GIÁM SÁT ĐẶC TRƯNG (ML_OPS_BLUEPRINT §3 A3).
 *
 * Population Stability Index [DA — Monitoring/Drift]: so sánh phân phối đặc
 * trưng PHIÊN GẦN ĐÂY (p_new) với phân phối lúc TRAIN (p_train, histogram 10
 * bucket lưu MlModel.meta.featureHist do route train ghi — hợp đồng cốt
 * { edges: number[][], train: number[][] }). Model đóng băng giữa 2 lần train
 * → regime shift vô hình (T2 review #77); PSI là đồng hồ phát hiện sớm.
 *
 * Ngưỡng chuẩn [DA]: PSI < 0,1 "ổn" · 0,1–0,25 "cảnh-báo" · ≥ 0,25
 * "dịch-chuyển" (UI ml-panel badge Drift + cờ retrainRecommended trong
 * /api/ml/status). A3 KHÔNG tự retrain — chỉ cảnh báo (retrain lịch thuộc A4).
 *
 * File THUẦN (0 import · 0 DB) — mọi phép đo route ml/status gọi qua đây;
 * nghiệm thu bằng script seeded dịch phân bố (≥ 0,25 khi dịch).
 */

/** Ngưỡng PSI dưới — phân phối coi như ổn định so với lúc train. */
export const PSI_STABLE = 0.1;

/** Ngưỡng PSI trên — dịch chuyển lớn, đề xuất train lại (A4 mới retrain). */
export const PSI_WARN = 0.25;

/** Mức drift 3 bậc — label tiếng Việt dùng trực tiếp cho badge UI. */
export type PsiLevel = "ổn" | "cảnh-báo" | "dịch-chuyển";

/**
 * Phân bậc PSI: < 0,1 "ổn" · 0,1–0,25 "cảnh-báo" · ≥ 0,25 "dịch-chuyển".
 * NaN/Infinity → "dịch-chuyển" (fail-safe đỏ — không bao giờ xanh khi số
 * liệu hỏng, theo nguyên tắc "không bịa chất lượng" §1.4).
 */
export function psiLevel(v: number): PsiLevel {
  if (!Number.isFinite(v)) return "dịch-chuyển";
  if (v >= PSI_WARN) return "dịch-chuyển";
  if (v >= PSI_STABLE) return "cảnh-báo";
  return "ổn";
}

/** Guard epsilon: bucket rỗng (p = 0 hoặc p không finite) thay bằng 1e-6
 * trước khi log — ln(0) = −∞ sẽ nhiễm PSI toàn bộ chiều. 1e-6 đủ nhỏ để bucket
 * rỗng vẫn đóng góp phạt lớn (hội tụ về upper bound ln(1e-6) ≈ −13,8) nhưng
 * giữ mọi số hạng finite. */
const PSI_EPS = 1e-6;

function sanitizeP(p: number): number {
  return Number.isFinite(p) && p > 0 ? p : PSI_EPS;
}

/**
 * PSI = Σ (pNew_i − pTrain_i) · ln(pNew_i / pTrain_i) trên các bucket chung
 * (min length hai mảng — caller đảm bảo cùng số bucket từ cùng edges). Hai
 * phân phối đồng nhất → 0; dịch càng xa càng lớn (đối xứng Jensen, luôn ≥ 0).
 */
export function psi(pNew: number[], pTrain: number[]): number {
  const n = Math.min(pNew.length, pTrain.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const pn = sanitizeP(pNew[i]);
    const pt = sanitizeP(pTrain[i]);
    s += (pn - pt) * Math.log(pn / pt);
  }
  return s;
}

/**
 * Bin giá trị RAW theo điểm cắt tăng dần → tỷ lệ từng bucket (length =
 * edges.length + 1). Quy ước PHẢI-đóng — khớp CHÍNH XÁC vòng bin của route
 * train khi ghi featureHist (computeFeatureHist: `v <= cuts[k] → bucket k`):
 * v < edges[0] → bucket 0 · v == edges[k] → bucket k (bucket DƯỚI) ·
 * edges[k] < v ≤ edges[k+1] → bucket k+1 · v > edges[cuối] → bucket cuối.
 * Cùng quy ước 2 bên (train ghi / status đọc) để giá trị bằng điểm cắt —
 * thường gặp ở đặc trưng có điểm khối (logret1 = 0, macdHist = 0) — không
 * trôi mass sang bucket kề và phóng đại PSI giả.
 * Trả mảng toàn 0 khi values rỗng (caller tự gate số mẫu tối thiểu).
 */
export function bucketProportions(values: number[], edges: number[]): number[] {
  const k = edges.length + 1;
  const counts = new Array<number>(k).fill(0);
  let total = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let idx = edges.length; // mặc định bucket cuối (v vượt mọi điểm cắt)
    for (let j = 0; j < edges.length; j++) {
      if (v <= edges[j]) {
        idx = j;
        break;
      }
    }
    counts[idx]++;
    total++;
  }
  if (total === 0) return counts; // toàn 0 — caller gate n trước khi psi()
  return counts.map((c) => c / total);
}

/**
 * Tên 10 đặc trưng THEO ĐÚNG THỨ TỰ featureAt trong features.ts (đối chiếu
 * code dòng 347–358 — serving phụ thuộc thứ tự này). Chiều ngoài phạm vi
 * (tương lai B1 lag-16) hiển thị "f${d}" — code đọc theo edges.length,
 * không hardcode 10.
 */
export const FEATURE_NAMES: string[] = [
  "RSI14/100",        // x[0]  (rsi ?? 50) / 100
  "MACD-hist/giá",    // x[1]  macdHist / close
  "logret 5 phiên",   // x[2]
  "logret 10 phiên",  // x[3]
  "SMA20/SMA50−1",    // x[4]
  "giá/SMA20−1",      // x[5]
  "z-score KL 20",    // x[6]  volz20 clip ±8
  "độ lệch ret20",    // x[7]  std20 của logret1
  "giá/đỉnh60−1",     // x[8]  close / max60 − 1
  "logret 1 phiên",   // x[9]
];

/** Tên chiều theo index — an toàn mọi số chiều (10 hôm nay · 16 sau B1). */
export function featureName(d: number): string {
  return FEATURE_NAMES[d] ?? `f${d}`;
}

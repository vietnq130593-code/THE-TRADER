# AUDIT 137-b — Phân hệ ML/NN của THE TRADER

- **Ngày:** 2026-10-19 · **Agent:** audit subagent 137-b (read-only, chỉ nghiên cứu)
- **Phạm vi:** `src/lib/ml/*` (18 file) · `src/app/api/ml/*` (8 route) · `prisma/schema.prisma` (MlModel/SweepRun/AppSetting) · đối chiếu `worklog.md` F-18→F-22 (champion gate 4 điều kiện, serving swap v61, F-19 cap nTrain/15).
- **Phương pháp:** đọc toàn bộ từng file; với mọi nghi vấn toán, **tự tính tay + chạy numerical check** (gradient check MLP, gradient check GRU BPTT, gradient check multitask mag-head, enumeration 96-state RL) bằng script ad-hoc `/tmp/audit_*.ts` (không đụng file dự án).
- **Không sửa bất kỳ file dự án nào.** File duy nhất được ghi: `.audit-137-b.md` (file này).

## Tổng quan

Hệ thống tự viết ML thuần TS có chất lượng cao ở phần lõi: backprop MLP **đúng toán** (gradient check 9,6e-10), GRU BPTT **đúng toán** (gradient check 1,6e-7), Wilson CI đúng công thức, Murphy decomposition đúng đẳng thức, PIT macro/bandit-settle/news-coverage chuẩn, mutex race được xử lý nghiêm túc. Các finding thật tập trung vào: **(1) z-score chuẩn hoá toàn dãy trước khi chia train/val (data leakage — đúng dạng lỗi ưu tiên 1 của nhiệm vụ)**, **(2) công thức index 96 trạng thái Q-learning sai dấu ngoặc (chỉ 36/96 trạng thái thật)**, và một chuỗi **leakage chọn-mô hình (selection bias)** ở sweep/calibration/macro-edge do val bị dùng 3-4 lần (early-stop + chọn champion + cổng) mà không có heldout.

Kết quả numerical check chính (chạy thật trên code dự án, import trực tiếp):

| Check | Kết quả |
|---|---|
| MLP backprop (nn.ts) — finite-difference 12 trọng số 2 lớp | max rel err **9,6e-10 PASS** |
| GRU BPTT (gru.ts) — finite-difference 13 ma trận | max rel err **1,6e-7 PASS** |
| Softmax overflow (logit ±800) | ổn định, Σ=1 PASS |
| Bias-gradient có mặt sau fit | CÓ |
| RL 96-state (rl.ts:168) — enumeration 2×2×4×2×3 | **36/96 index duy nhất, 60 va chạm, max=35 FAIL** |
| Multitask mag-head (multitask.ts) — finite-difference bm[0] | numeric −2,09e-2 vs code −5,23e-2 **FAIL (thiếu hệ số 0,1)** |

---

## FINDINGS

### B1 — HIGH · Z-score chuẩn hoá trên TOÀN BỘ tập (gồm cả block val tương lai) trước khi `fit()` chia 80/20 — DATA LEAKAGE
- **File:dòng:** `src/lib/ml/train-mlp.ts:460` (nguồn rò); `src/lib/ml/features.ts:974-990` (`standardize`); `src/lib/ml/nn.ts:366-371` (split diễn ra BÊN TRONG `fit`, sau chuẩn hoá); tái phạm: `src/lib/ml/macro-forecast.ts:462`, `src/app/api/ml/train/route.ts:272` (dl-mtl).
- **Bằng chứng:**
```ts
// train-mlp.ts:459-461 + 491
const featureHist = computeFeatureHist(set.X, dims);
const { mean, std, Xstd } = standardize(set.X);        // ← TOÀN BỘ set.X (train + val)
...
const fit = mlp.fit(Xstd, set.y, { ... });              // fit tự cắt val = block CUỐI 20%

// nn.ts:366-371 — split NẰM TRONG fit, sau khi caller đã chuẩn hoá xong:
const nTrain = Math.floor(n * (1 - valFraction));
const trainIdx: number[] = [];
for (let i = 0; i < nTrain; i++) trainIdx.push(i);
const valIdx: number[] = [];
for (let i = nTrain; i < n; i++) valIdx.push(i);

// features.ts:970-974 — docstring nói ngược lại code:
/**
 * Chuẩn hoá z-score theo cột (fit trên tập train): mean/std từng đặc trưng,
```
- **Vì sao sai:** mean/std từng chiều được tính trên 100% mẫu (60k = 48k train + 12k val). Block val (20% ngày MỚI NHẤT) đóng góp 20% trọng lượng vào thống kê chuẩn hoá — thông tin phân phối tương lai rò vào (a) phép biến đổi của tập train, (b) val được chấm bằng bộ thống kê có chứa chính nó. Đây là đúng dạng "z-score toàn dãy trước chia train/val" trong checklist nhiệm vụ. Hệ quả: mọi `valAcc`/`valLoss`/Brier-val (kể cả valAcc 42,9% của champion C5 → serving v61) đều thiên lệch lạc quan một cách hệ thống; ảnh hưởng tương đối giữa champion-vs-serving (cùng leak cả hai) ít hơn ảnh hưởng tuyệt đối lên con số công bố. Đặc biệt: **chính route train làm đúng ở đường GRU ngay bên cạnh** — `api/ml/train/route.ts:143-168` tính mean/std chỉ trên `nTrain` mẫu đầu rồi mới áp cho cả chuỗi — chứng minh thiết kế dự định là train-only và đường MLP là sơ suất, không phải lựa chọn có chủ ý (không có ghi chú nào tuyên bố chủ ý ở đường MLP).
- **Gợi ý fix:** thêm tham số `fitRange` vào `standardize` (hoặc truyền `nTrain` vào `trainDlMlp`) — tính mean/std trên `set.X.slice(0, nTrain)` rồi transform toàn bộ; áp cùng sửa cho `macro-forecast.ts:462` và đường `dl-mtl`; đồng thời sửa docstring `features.ts:970` đang nói "fit trên tập train".
- **Tự tin: 92%.**

### B2 — HIGH · Q-learning 96 trạng thái: công thức index sai dấu ngoặc — chỉ 36/96 trạng thái thật, 60 va chạm, 60 hàng Q-table chết
- **File:dòng:** `src/lib/ml/rl.ts:168` (so với công thức đúng ở comment `rl.ts:147-149` và bản 48-state `rl.ts:166`).
- **Bằng chứng:**
```ts
// rl.ts:146-149 (comment mô tả ĐÚNG):
//   48-state (legacy): ((trend×4 + rsiBucket)×2 + mom)×3 + exposureBucket.
//   F-13 (#129) 96-state: thêm bit regime VNINDEX (SMA50 vs SMA200 —
//   BULL=1/BEAR=0) làm CHỐ ĐẦU: ((regime×2 + trend)×4 + rsiBucket)×2 + mom)×3
//   + exposureBucket — ...

// rl.ts:165-168 (code):
if (regimeBit == null) {
  return ((trend * 4 + rsiBucket) * 2 + mom) * 3 + expBucket;   // ✓ đúng, max 47
}
return (((regimeBit ? 2 : 0) + trend) * 4 + rsiBucket) * 2 + mom * 3 + expBucket; // ✗ SAI
```
- **Vì sao sai:** code 96-state viết `A*2 + mom*3 + expBucket` thay vì `(A*2 + mom)*3 + expBucket` (mất cặp ngoặc quanh `mom` trước `×3`). Tính tay + enumeration chạy thật: với 96 trạng thái logic (2 regime × 2 trend × 4 RSI × 2 mom × 3 exposure), công thức này chỉ sinh **36 giá trị duy nhất, max = 35, 60 cặp đụng độ** — ví dụ `g0t0r0m0e2` và `g0t0r1m0e0` cùng map vào index 2; `g0t0r0m1e0` và `g0t0r1m0e1` cùng map vào 3. Bảng `qTable` vẫn cấp phát 96 hàng (`rl.ts:194,196`) → **60 hàng (36..95) không bao giờ được cập nhật/đọc**, còn 36 hàng còn lại trộn lẫn các trạng thái thị trường khác nhau (RSI×mom×exposure). Train và `policyStance` dùng CÙNG hàm sai nên hệ thống không crash và "tự nhất quán", nhưng tuyên bố "96 trạng thái" (worklog F-13, UI, metrics `states:96` lưu MlModel) là **không đúng sự thật thống kê** — mô hình thực tế học một bảng Q 36-trạng-thái-biến-dạng, phân tách regime chỉ còn stride 8. Bản 48-state (serving v13 cũ) không dính lỗi.
- **Gợi ý fix:** sửa thành `((((regimeBit ? 2 : 0) + trend) * 4 + rsiBucket) * 2 + mom) * 3 + expBucket`; sau fix phải train lại rl-q (bảng 96 hiện tại là của không-gian sai) và có thể thêm 1 assert `s < states` trong `trainQTable`/`policyStance` để chặn tái diễn.
- **Tự tin: 97%** (đã chứng minh bằng enumeration).

### B3 — MEDIUM · F-11 PIT weekly basket dùng rổ của CHÍNH tuần lấy mẫu (được tính bằng dữ liệu đến CUỐI tuần đó) → lookahead ~4 phiên; comment tự nói ngược code
- **File:dòng:** `src/lib/ml/features.ts:1357-1385` (`weekOf` + `inBasket`), spec ở `features.ts:1300-1301`.
- **Bằng chứng:**
```ts
// features.ts:1300-1301 (spec): "Rổ top-N theo Σ giá trị GD 45 phiên KẾT THÚC
// TRƯỚC tuần lấy mẫu" — và comment 1371: "dùng rổ TRƯỚC (không nhìn tương lai)"

// features.ts:1369-1385 (code):
inBasket(dateStr: string, instrumentId: string): boolean {
  const wk = weekOf(dateStr);          // = thứ Hai của tuần chứa PHIÊN lấy mẫu
  ...
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (basketsByWeek[mid]!.week <= wk) {   // ← dùng luôn rổ CỦA CHÍNH tuần wk
      ans = mid; lo = mid + 1;
    } else { hi = mid - 1; }
  }
  ...
// (rổ tuần wk được xếp hạng từ bar CUỐI tuần wk — SQL rn=1 ORDER BY d DESC)
```
- **Vì sao sai:** rổ khóa `wk` chứa ranking ADTV45 tính tại **phiên cuối cùng của tuần wk** (thứ Sáu). Một mẫu lấy ở **thứ Hai/thứ Ba tuần wk** (`weekOf` trả về thứ Hai của chính tuần đó) sẽ được lọc theo rổ vừa tính bằng dữ liệu **3-4 phiên trong tương lai** của mẫu. Spec và comment đều nói "rổ TRƯỚC" nhưng binary-search `week <= wk` bao hàm chính tuần đang lấy mẫu — đúng nghĩa phải là tuần **nhỏ hơn** tuần lấy mẫu (hoặc dịch key rổ lên 1 tuần). Giảm nhẹ: ranking thanh khoản top-20 đổi chậm theo tuần nên magnitude bias nhỏ; và **hiện tại không call-site nào bật `pointInTime: true`** (grep toàn repo: `train-mlp.ts:436`, `sweep.ts:922`, `route.ts:265/403`, scripts — đều không truyền) → lỗi nằm ở nhánh dead-code, sẽ "sống" ngay khi F-11 được bật.
- **Gợi ý fix:** đổi điều kiện search thành `basketsByWeek[mid].week < wk` (hoặc so `weekOf(dateStr) − 7 ngày`), thêm 1 unit-test lấy mẫu thứ Hai so với rổ thứ Sáu cùng tuần.
- **Tự tin: 88%.**

### B4 — MEDIUM · Champion gate: valAcc champion được CHỌN trên val rồi BÁO lại chính val đó — không có heldout; điều kiện 1 còn so valAcc serving đo trên cửa sổ dữ liệu khác
- **File:dòng:** `src/lib/ml/sweep.ts:1032-1040` (Brier/score trên val), `sweep.ts:1157-1159` (chọn champion theo score), `sweep.ts:1174-1185` (cổng dùng chính val đó), `sweep.ts:968-976` (servingValAcc từ metrics CŨ của bản serving).
- **Bằng chứng:**
```ts
// sweep.ts:1157-1159 — champion = score cao nhất trong ứng viên:
const alive = evals.filter((e) => e.entry.error == null && e.model != null);
const championEval =
  alive.length > 0 ? alive.reduce((best, e) => (e.score > best.score ? e : best)) : null;

// sweep.ts:1174-1179 — cổng 4 điều kiện đo trên CÙNG val block đã (a) early-stop
// từng ứng viên trong fit(), (b) chọn champion:
const gate = championGateCheck({
  championValAcc: ce.entry.valAcc ?? 0,          // valAcc đo trên val vừa chọn champion
  servingValAcc,                                  // metrics CŨ của serving (cửa sổ train khác)
  ...
// nn.ts:484-491 — chính val này đã dùng early-stop từng ứng viên
```
- **Vì sao sai:** valAcc của champion là **kỳ vọng của max của ~16 biến ngẫu nhiên** (mỗi ứng viên early-stop theo val) — winner's curse làm con số 42,9% thiên lệch lên; nó lại được dùng làm cả tiêu chí chọn (score) lẫn tiêu chí cổng (điều kiện 1). Không tồn tại heldout/walk-forward ngoài val (task qui định: "nếu có ghi chú/heldout thì thôi" — ở đây có δ=0,01 và ΔBrier paired bootstrap CI95 < 0, hai hàng rào BỘ PHẬN nhưng không có ghi chú nào thừa nhận selection bias). Thêm nữa: `servingValAcc` đọc từ `metrics` lưu lúc serving train trên **cửa sổ dữ liệu cũ hơn** — so chéo cửa sổ với champion train trên cửa sổ hiện tại (chỉ công bằng nếu route train 04:00 hôm đó vừa retrain + promote serving cùng windowHash). Riêng ΔBrier CI (điều kiện 2) là paired cùng cửa sổ (reload serving weights chấm lại) — phần này sạch.
- **Gợi ý fix:** giữ val 20% cho early-stop + thêm walk-forward: chấm Brier/accuracy cổng trên block "post-val" (phiên sau val) hoặc dùng k-fold thời gian; hoặc tối thiểu ghi chú trong `SweepChampionInfo` rằng valAcc là con số post-selection. Điều kiện 1 nên so đồng cửa sổ (chấm lại serving trên val block hiện tại như Brier vẫn làm).
- **Tự tin: 80%.**

### B5 — MEDIUM · Cổng F-08 calibration: ECE "sau" đo trên CHÍNH tập đã fit isotonic — doc nói "holdout" nhưng không có holdout
- **File:dòng:** `src/lib/ml/calibration.ts:178-182` (fit + đo trên cùng `safeProbs`); `src/lib/ml/train-mlp.ts:547-549` (gate); claim "holdout" ở `calibration.ts:16`.
- **Bằng chứng:**
```ts
// calibration.ts:16 (header): "Gate nghiệm thu F-08: ECE giảm ≥ 20% tương đối
// trên holdout thì GIỮ — không thì whyRejected"
...
// calibration.ts:171-182 — curves fit TRÊN safeProbs, eceAfter cũng TRÊN safeProbs:
for (let c = 0; c < 3; c++) {
  const p = safeProbs.map((pr) => pr[c]!);
  const y = safeLabels.map((l) => (l === c ? 1 : 0));
  const curve = fitIsotonic(p, y);
  curves[c] = curve;
  ...
}
const eceBefore = eceOf(safeProbs, safeLabels);
const calibrated = safeProbs.map((pr) =>
  applyCalibration({ curves, fitted, ... }, pr));
const eceAfter = eceOf(calibrated, safeLabels);        // ← cùng tập vừa fit

// train-mlp.ts:548-549 — gate dùng eceAfter in-sample:
const improves = cal.eceBefore != null && cal.eceAfter != null && cal.eceAfter <= 0.8 * cal.eceBefore;
```
- **Vì sao sai:** isotonic regression fit trên tập X gần như luôn giảm ECE đo trên X (PAV chính là tối thiểu hoá sai lệch đơn điệu in-sample) → gate "giảm ≥ 20%" gần như tự động đạt khi đủ mẫu, không chứng minh gì về ngoài mẫu. Cùng val block này còn đã dùng early-stop MLP (B4) và nằm trong leak chuẩn hoá (B1) — xác suất serving sau calibration có thể tệ hơn ngoài mẫu mà gate vẫn "GIỮ". Lưu ý #130 đã verify gate từng từ chối (0,053→0,0622) — đó là lúc PAV chỉ có ít mốc, không phủ nhận tính chất in-sample của phép đo.
- **Gợi ý fix:** chia val làm 2 nửa theo thời gian (fit isotonic trên nửa đầu, chấm ECE giữ/tắt trên nửa sau); hoặc gate bằng Brier ngoài mẫu thay ECE in-sample; cập nhật docstring cho khớp thực tế.
- **Tự tin: 88%.**

### B6 — MEDIUM · macro-mlp: Brier60/`edge` (kể cả "US10Y 67,5%") đo trên block val của chính model — không phải out-of-sample
- **File:dòng:** `src/lib/ml/macro-forecast.ts:816-836` (cửa sổ Brier = 60 phiên cuối); `macro-forecast.ts:415-419` (tương quan vị trí với val block); `macro-forecast.ts:462` (standardize toàn tập — dính B1).
- **Bằng chứng:**
```ts
// macro-forecast.ts:816-831 — Brier60 trên 60 phiên CUỐI (đã realized):
const tLast = n - 1 - ML_HORIZON_DAYS;
const tStart = Math.max(ML_WARMUP_BARS - 1, tLast - MACRO_BRIER_WINDOW + 1);
...
for (let t = tStart; t <= tLast; t++) {
  const label = macroLabelOf(spec, bars.closes, t);
  ...
  const [pUp, pFlat, pDown] = mlp.predictProba(x14);
  brierSum += brierMultiClass(pUp, pFlat, pDown, label);
// gate: out.edge = out.brier60 < 2/3 − 0,01   (macro-forecast.ts:836)
```
- **Vì sao sai:** 60 phiên cuối trùng với block **val 20% cuối** đã dùng early-stop mô hình (và chuẩn hoá toàn-dãy của B1). "Cạnh biên" của 3/8 tài sản (US10Y Brier60 0,504, DXY 0,449) vì thế là số lạc quan một phần — nó không dùng gradient trên val nhưng đã dùng val để chọn epoch dừng. Bảng "DỰ BÁO 5 PHIÊN" vào prompt Chủ tịch hiện thị các con số này như track record.
- **Gợi ý fix:** đo Brier rolling trên các phiên **sau ngày train cuối + horizon** bằng cách giữ lại `holdout tail` (ví dụ 60 phiên cuối không đưa vào fit), hoặc khai báo rõ "Brier60 đo trên val của lần train cuối".
- **Tự tin: 85%.**

### B7 — MEDIUM · Multitask (dl-mtl) head mag/vol: output layer placeholder `(x >= 0 ? 1 : 1)`, gradient thiếu hệ số 0,1, ReLU gate soi nhầm tầng — numerical check FAIL
- **File:dòng:** `src/lib/ml/multitask.ts:136` (placeholder), `multitask.ts:137,150` (forward ×0,1), `multitask.ts:268-269` (backward thiếu ×0,1), `multitask.ts:282-285` (gate sai tầng).
- **Bằng chứng:**
```ts
// multitask.ts:135-137 — forward mag: KHÔNG có lớp ra 4→1, nhân hằng 0,1:
let s = 0;
for (let j = 0; j < acts.length; j++) s += acts[j]! * (this.bm[j]! >= 0 ? 1 : 1); // placeholder linear
mag = Math.tanh(s * 0.1);

// multitask.ts:268-269 — backward KHÔNG nhân 0,1 (chain tanh(0.1·s)):
const dMag = ((f.mag - l.mag) * MT_W_MAG * 2) / bs * (1 - f.mag * f.mag);
const dVol = ((f.vol - l.vol) * MT_W_VOL * 2) / bs * 0.5;

// multitask.ts:282-285 — ReLU gate kiểm trên h2 (tầng trước) thay vì pre-activation của head:
const act = f.h2; // đơn giản hoá: đạo hàm ReLU ~ theo h2 trực tiếp
...
dH2[k]! += this.Wm[off + k]! * (dMag / MT_ARCH.magHead) * (act[k]! > 0 ? 1 : 0);
```
- **Vì sao sai:** đã chạy finite-difference trên chính class: gradient thật của `bm[0]` là **−2,09e-2**, code tính **−5,23e-2** — lệch đúng hệ số 10 (thiếu đạo hàm của `×0.1`) và chia đều `dMag/4` cho mọi unit thay vì theo từng unit đang hoạt động; ReLU gate kiểm `h2 > 0` (tầng backbone) thay vì pre-activation `Wm·h2+bm > 0` của head. `(this.bm[j]! >= 0 ? 1 : 1)` hai nhánh giống hệt nhau là no-op — header file mô tả "h2 → 4 (ReLU) → 1 tanh" nhưng lớp ra 1 nơ-rôn không tồn tại. Head hướng (dir) + backbone backward thì đúng. Giảm nhẹ: `dl-mtl` là shadow (`promote:false`, chỉ train khi gọi tay `target:"dl-mtl"`, lên serving phải qua sweep gate MAE vol) — chưa bao giờ serving.
- **Gợi ý fix:** viết đúng head 4→1 (thêm Wout/bout), đạo hàm đủ chuỗi `×0.1` và `tanh/softplus`, gate theo pre-activation của head; hoặc tạm khoá route `dl-mtl` cho tới khi viết lại — hiện đường này không đáng tin về toán.
- **Tự tin: 95%** (đã chứng minh bằng numerical check).

### B8 — LOW/MEDIUM · Calibration + featureHist dùng cut cứng `TRAIN_FRACTION = 0,8` trong khi `fit()` dùng `valFraction` tuỳ chỉnh (0,1–0,4) → calibration có thể fit trên cả mẫu TRAIN khi trader đổi valFraction
- **File:dòng:** `src/lib/ml/train-mlp.ts:110` (hằng 0,8), `train-mlp.ts:537-540` (calibration cut cứng), `train-mlp.ts:207` (featureHist cut cứng), `nn.ts:356` (fit nhận `opts.valFraction`), `tuning.ts:182` (UI cho phép 0,1–0,4).
- **Bằng chứng:**
```ts
// train-mlp.ts:537-541 — calibration block luôn là "20% cuối" dù fit có thể
// đã dùng valFraction khác:
const nTotal = set.X.length;
const nTrainSplit = Math.floor(nTotal * TRAIN_FRACTION);   // = 0,8 cứng
const valIdx: number[] = [];
for (let i = nTrainSplit; i < nTotal; i++) valIdx.push(i);
if (valIdx.length >= CALIBRATION_MIN_PER_CLASS) { ... }
```
- **Vì sao sao lệch:** nếu trader đặt `valFraction = 0,1` (hợp lệ per `MLP_TUNING_FIELDS`), block "20% cuối" chứa 10% dữ liệu nằm trong TRAIN của `fit` → isotonic fit trên dữ liệu mô hình đã học → curve nhiễm train. Ngược lại `valFraction = 0,4` thì calibration chỉ thấy một phần val thật. featureHist (PSI baseline) cũng lệch biên tương tự. Sweep không dính (ứng viên luôn dùng default 0,2); chỉ đường train tay/engine với tuning chỉnh tay.
- **Gợi ý fix:** truyền `appliedTuning.valFraction` vào hai chỗ cut (calibration + computeFeatureHist) thay vì hằng; thêm assert `calibrationVal ⊆ fitVal`.
- **Tự tin: 88%.**

### B9 — LOW · Drift PSI mù với 8 chiều vĩ mô khi serving là v3-macro (24 chiều)
- **File:dòng:** `src/app/api/ml/status/route.ts:215` (đo bằng `featureAt(roll, t)` — 16 chiều, không macro) vs `route.ts:231` (`nDims = Math.min(hist.edges.length, perDim.length)` = min(24,16)).
- **Bằng chứng:**
```ts
// status/route.ts:213-221 — đo drift bằng featureAt KHÔNG macro:
for (let t = ML_WARMUP_BARS - 1; t < s.closes.length; t++) {
  if (!recentSet.has(s.bars[t].date.toISOString().slice(0, 10))) continue;
  const x = featureAt(roll, t);          // ← 16 chiều (không loadMacroContexts)
  ...
// route.ts:229-231 — silently cắt về 16 chiều đầu:
const nDims = Math.min(hist.edges.length, perDim.length);
```
- **Vì sao sai:** serving v61 là v3-macro với `featureHist` 24 chiều; phép đo PSI chỉ so 16 chiều giá → 8 chiều vĩ mô (dus10y20, slope, DXY, VND, cmdty, breadth, flow, sent7) không được giám sát drift, badge "Drift ổn" có thể xanh trong khi phân phối macro đã dịch. Không sai số học phần 16 chiều đo được — chỉ là khoảng mù giám sát.
- **Gợi ý fix:** khi `dlFeatureSet === "v3-macro"`, nạp `loadMacroContexts(recent)` và gọi `featureAt(roll, t, macro)`; hoặc hiển thị "8 chiều macro chưa giám sát".
- **Tự tin: 90%.**

### B10 — LOW · Bandit: Wilson CI tính trên `wins/pulls` với reward THẬP PHÂN (0,7/0,2) + vài chi tiết nhỏ sai nhãn
- **File:dòng:** `src/lib/ml/bandit.ts:512` (`wilson(wins/pulls, pulls)`), `bandit.ts:26` (comment "6 arm" nhưng mảng 7 phần tử), `bandit.ts:624-627` + `bandit.ts:641` (dates/closes filter lệch), `analytics.ts:243-246` (ghi chú xấp xỉ — trung thực).
- **Bằng chứng:**
```ts
// bandit.ts:510-518 — Wilson trên tỉ lệ wins/pulls (wins = Σ reward 0/0.2/0.7/1):
if (a.pulls > 0) {
  try {
    const ci = wilson(Math.max(0, Math.min(1, a.wins / a.pulls)), a.pulls);
    ...
// bandit.ts:624-627 — closes được filter close>0 nhưng dates KHÔNG:
const out = {
  dates: bars.map((b) => b.date),
  closes: bars.map((b) => b.close).filter((c) => c > 0),   // ← lệch độ dài nếu có bar rác
};
// bandit.ts:641: if (... vnindex.dates.length !== vnindex.closes.length) return null;
```
- **Vì sao sai:** (a) Wilson assumes kết quả nhị phân — `wins` là tổng reward thập phân → CI hẹp hơn/ sai phân phối thật (đã có ghi chú "xấp xỉ hợp lý" ở analytics.ts:243-246 nhưng bandit.ts:482-484 lại ghi "Wilson CI 95% của posteriorMean" — không phải posteriorMean, là wins/pulls). (b) Header "6 arm" vs 7 phần tử (risk-manager có thật trong BANDIT_ARM_CODES). (c) Nếu VNINDEX có bar `close ≤ 0`, `dates.length ≠ closes.length` → `regimeOf` trả null VĨNH VIỄN (fail-safe nhưng chết chức năng regime) và `currentMarketRegime` lấy `dates[last]` của bar đã bị lọc ra → nhãn `asOf` sai phiên. Tất cả đều nhỏ, không phá xác suất chính.
- **Gợi ý fix:** lọc `bars` TRƯỚC rồi map cả hai mảng từ cùng danh sách; đổi nhãn comment "Wilson của hit-rate (xấp xỉ vì reward thập phân)"; đếm lại arm trong doc.
- **Tự tin: 90%.**

### B11 — LOW · Permutation p-value = `ge/200` không có hiệu chỉnh `(ge+1)/(N+1)` — p = 0 tuyệt đối hoá ý nghĩa
- **File:dòng:** `src/lib/ml/xrel.ts:616-627`.
- **Bằng chứng:**
```ts
function intlPermTwoSidedP(xs: number[], ys: number[], rObs: number): number {
  ...
  let ge = 0;
  for (let i = 0; i < INTL_PERM_N; i++) {          // INTL_PERM_N = 200
    shuffleInPlace(shuffled, rand);
    const rp = correlation(shuffled, ys);
    if (rp != null && Math.abs(rp) >= absRObs) ge++;
  }
  return ge / INTL_PERM_N;                          // ← có thể = 0
}
```
- **Vì sao sai:** với 200 phép xáo trộn, p=0 nghĩa là "không lần nào đạt" — ước lượng p<1/200, không phải p=0; chuẩn bảo thủ là `(ge+1)/(N+1)` (Phipson-Smyth). Sau Bonferroni ×44, p=0 vẫn 0 → một quan hệ r mạnh ở dữ liệu ngắn dễ được tuyên bố ý nghĩa quá mức. Thực tế đo 17/10 kept=0/44 nên chưa gây hậu quả.
- **Gợi ý fix:** `return (ge + 1) / (INTL_PERM_N + 1);` — 1 dòng.
- **Tự tin: 90%.**

### B12 — LOW · `MlModel` không có unique `(kind, version)`; macro-forecast train dùng mutex RIÊNG (song song được với train/sweep)
- **File:dòng:** `prisma/schema.prisma:734-750` (chỉ `@@index([kind, status])`), `src/app/api/ml/macro-forecast/route.ts:37-38,114-126` (macroMutex riêng), `train-mlp.ts:86-90` (mutex dùng chung chỉ cho dl-mlp/sweep).
- **Bằng chứng:**
```prisma
model MlModel {
  id          String   @id @default(cuid())
  kind        String // "dl-mlp" | "rl-q"          ← comment stale (thực tế còn dl-gru|dl-mtl|macro-mlp)
  version     Int
  status      String   @default("serving")
  ...
  @@index([kind, status])                            // ← KHÔNG @@unique([kind, version])
}
```
- **Vì sao rủi ro:** bảo vệ trùng `(kind, version)` hoàn toàn dựa vào mutex in-process; `nextVersion` (max+1) + create là 2 await rời. `POST /api/ml/macro-forecast {train:true}` đi qua `macroMutex` riêng nên **có thể chạy song song** với `/api/ml/train`/sweep (khác kind → không trùng version, chỉ tranh CPU 8×fit — thiết kế có ghi chú "mutex chống ép CPU"); nhưng mọi đường tương lai quên gọi `tryAcquireTrainLock` (hoặc chạy đa instance Next) sẽ lại hồi sinh lỗi F-612R-06 từng được vá bằng transaction + mutex. Comment `kind` trong schema cũng đã stale.
- **Gợi ý fix:** thêm `@@unique([kind, version])` (hàng rào cuối cùng ở DB); cân nhắc cho macro-forecast dùng chung `tryAcquireTrainLock`.
- **Tự tin: 85%.**

### B13 — LOW · `resetBandit` reset alpha/beta/pulls/wins nhưng KHÔNG reset `regimeStats` — bảng regime mâu thuẫn bảng chung sau reset
- **File:dòng:** `src/app/api/ml/tuning/route.ts:195-201`.
- **Bằng chứng:**
```ts
if (body.resetBandit === true) {
  try {
    const res = await db.banditArm.updateMany({
      data: { alpha: 1, beta: 1, pulls: 0, wins: 0, lastRewardAt: null },  // ← thiếu regimeStats
    });
```
- **Vì sao sai:** sau reset, posterior bảng chung = prior Beta(1,1) nhưng `posteriorByCodeForCycle` vẫn ưu tiên `regimeStats` cũ (đủ ≥10 pulls) → phiếu bầu tiếp theo dùng track record "đã xoá" theo regime — mâu thuẫn ngữ nghĩa với thao tác "đặt lại vòng học".
- **Gợi ý fix:** thêm `regimeStats: null` (hoặc chuỗi `{}`) vào `data` của updateMany.
- **Tự tin: 95%.**

### B14 — LOW · ensemble-learn: gate so Brier của mô hình softmax đầy đủ nhưng thứ số TRIỂN KHAI là 2 scalar `wMlp/wLinreg` rút bằng heuristic |w| — artifact được kiểm định ≠ artifact được deploy
- **File:dòng:** `src/lib/ml/ensemble-learn.ts:237-253` (gate trên softmax model) vs `ensemble-learn.ts:255-265` (rút scalar weights); cộng `ensemble.ts:530-537` (khi GRU bật + learned → cộng cứng W_GRU=0,2 ngoài cặp learned).
- **Bằng chứng:**
```ts
// ensemble-learn.ts:237-242 — Brier của softmax(w·x) đầy đủ:
for (const v of val) {
  const x = voiceFeatures(v);
  const pl = softmax3([0, 1, 2].map((c) => w[c]!.reduce(...)));
  brierLearned += brier3(pl, v.realizedDir);
...
// ensemble-learn.ts:257-258 — nhưng deploy là 2 số vô hướng:
const mlpContribution = (Math.abs(w[2]![1]!) + Math.abs(w[0]![1]!)) / 2;
const linContribution = (Math.abs(w[2]![2]!) + Math.abs(w[0]![2]!)) / 2;
```
- **Vì sao rủi ro:** gate "learned thắng fixed" chứng minh cho softmax 3-lớp, không chứng minh cặp trọng số tuyến tính `wMlp/wLinreg` thật sự tốt hơn 0,7/0,3 trong công thức ensemble serving; heuristic |w| có thể chọn cặp trọng số tệ hơn dù gate pass. Hiện cold-start (0/60 phiếu) nên chưa từng "learned" — latent. Khi GRU bật + learned đồng thời, `score` còn cộng cứng `W_GRU*(...)` ngoài cặp learned đã chuẩn hoá Σ=1 (double-count cấu trúc).
- **Gợi ý fix:** khi_gate, đánh giá Brier của chính công thức deployed (score → pf mapping như baseline fixed) thay vì softmax; hoặc deploy luôn softmax probs vào phiếu.
- **Tự tin: 80%.**

---

## NỢ KỸ THUẬN (không phải bug ngày, nên xếp hàng sửa theo thứ tự)

1. **Chuẩn hoá train-only (B1)** — refactor `standardize` nhận `nTrain`; sửa 3 call-site (dl-mlp, macro-mlp, dl-mtl). Đây là nền của mọi con số valAcc đang công bố.
2. **Heldout/walk-forward cho cả chuỗi chọn-mô hình**: sweep champion (B4), calibration gate (B5), macro edge (B6) — cùng một thiếu hụt cấu trúc: val bị dùng nhiều lần.
3. **Viết lại đúng toán head mag/vol của multitask (B7)** hoặc đóng băng đường `dl-mtl` tới khi có numerical gradient check trong verify script.
4. **Sửa công thức 96-state (B2) + retrain rl-q** — kèm script verify enumeration (36 vs 96) để không tái diễn.
5. `@@unique([kind, version])` cho MlModel + macroMutex dùng khoá dùng chung (B12).
6. Drift mở rộng 24 chiều cho v3-macro (B9); PIT basket sửa `< wk` trước khi bật F-11 (B3).
7. Dọn vặt: `resetBandit` + regimeStats (B13); Wilson nhãn (B10); permutation +1 (B11); comment "6 arm"/"He-normal" (gru.ts:135)/schema kind stale; typo log `"l/sweep]"` (sweep.ts:773).
8. `sent7` đang gộp tin cả sau 15:45 của phiên t (weightedSentiment7 theo ngày lịch, không cutoff PIT 15:45 như news-coverage.ts) — hiện vô hại vì đặc trưng phiên t chỉ được tiêu thụ sau khi bar t đóng, nhưng đáng đưa về cùng chuẩn PIT khi dựng v3-news22.

## ĐÃ KIỂM TRA VÀ SẠCH (nghi đã loại trừ, kèm lý do)

- **Backprop MLP (nn.ts)** — numerical gradient check 12 trọng số (lớp ẩn + lớp ra): max rel err **9,6e-10**. Chiều ma trận W[to×from] row-major, gradient bias có mặt, Adam bias-correction chuẩn, L2 chỉ áp W (`isWeight = pi < L || pi === 2L` đúng theo bố cục blocks), khôi phục best-weights theo valLoss đúng.
- **GRU BPTT (gru.ts)** — numerical check 13 ma trận: max rel err **1,6e-7**; đủ 4 đường về `h_prev` (trực tiếp (1−z), qua r⊙h_prev, qua pre-sigmoid r, qua pre-sigmoid z); inverted dropout scale 1/(1−p) + backward dùng đúng x đã mask; serving không dropout; `paramCount` 3.179 khớp comment.
- **Softmax overflow** — trừ max trước exp (nn.ts:169-180, gru.ts:81-92, ensemble-learn softmax3); test logit ±800 → [1/3,1/3,1/3], Σ=1.
- **log(0)/chia 0** — mọi val loss dùng `-Math.log(Math.max(p, 1e-12))`; `standardize` std=0→1; `applyNorm` `(std[j] ?? 1) || 1`; linregSlope den>0; z-score linreg yêu cầu `projStd > 0`; PSI có `PSI_EPS` chống ln(0); calibration 5 tầng NaN guard (bản #130 đã vá và audit xác nhận).
- **Off-by-one lag/nhãn** — `featureAt` t≥59 đủ warmup cho mọi chuỗi con (t−5≥54); lag x[10..12] = ret1(t−1..t−3) thuần quá khứ; nhãn `close(t+5)/close(t)−1` với guard `future >= length → null`; GRU window `tStart = 59 + W − 1` (đã vá F-B811-02); macroLabelOf t+horizon cùng guard.
- **PIT macro (N4)** — `alignBefore` binary-search bar quốc tế `date < vnDate` (chặt, không dùng phiên cùng ngày US); breadth SQL window `20 PRECEDING AND 1 PRECEDING` (không tính bar hiện tại); flow20 cửa sổ 20 phiên kết thúc ở t (dữ liệu sau đóng cửa, hợp lệ cho dự báo close→close).
- **Bandit settle (đếm đúng/sai)** — castDate = phiên cuối ≤ createdAt; realizedDate = phiên giao dịch THỨ 5 sau cast (`after[SETTLE_SESSIONS−1]`); reward so direction vote với realizedDir rổ equal-weight ≥3 mã; idempotent qua `settledKeys` + chuỗi Promise in-process (F-801-04) + route settle mutex — không double-count.
- **Wilson CI (analytics.ts:56-72)** — công thức đúng chuẩn; kẹp [0,1] chỉ xoá nhiễu −2e-17 ở biên.
- **Murphy decomposition** — đẳng thức `BS = REL − RES + UNC` thoả đúng nhờ构造 brier lượng tử hoá theo bucket mean (đã kiểm bằng đại số: Σ w·ō(1−ō) = Ō(1−Ō) − Σ w(ō−Ō)²).
- **Brier multiclass** — `Σ_c (p_c − onehot_c)²` đúng ở sweep (perSampleBrier), ensemble (brierOf), ensemble-learn (brier3), macro-forecast (brierMultiClass); ánh xạ class [DOWN,FLAT,UP]↔[pUp,pFlat,pDown] nhất quán mọi nơi (đảo đúng 2 đầu).
- **Race 2 train cùng lúc** — engine (mini-services/market-engine:3003) gọi qua HTTP tới app Next (:3000) `POST /api/ml/{train,sweep,settle,ensemble-learn}` → mọi đường chạy trong CÙNG process Next → `tryAcquireTrainLock` + cooldown 429 có hiệu lực thật; `saveModel` dùng `$transaction` [archive, create] (vá F-612R-06) — không còn kẽ hở nào tìm thấy trong 1 process.
- **Seed/reproducible** — sweep seed 20261012 lưu `SweepRun.seed`, dãy ứng viên deterministic (không Math.random/Date.now trong sinh ứng viên — đã dò); MLP seed từ tuning truyền cả constructor lẫn fit (F-MLP-05); round-trip guard NAS sync so sâu từng số (p131 verify 15/15).
- **Đường GRU chuẩn hoá ĐÚNG train-only** (api/ml/train/route.ts:143-168) — bằng chứng nội tại cho thấy B1 là sơ suất đường MLP chứ không chủ ý hệ thống.
- **Dl-mtl/dl-gru không tự lên serving** (promote:false + cổng B2/B3); champion chỉ swap qua $transaction sau cổng 4 điều kiện; tuningSync fail-soft không rollback swap — đúng đặc tả F-18.
- **BMI/BM25/PSI** — IDF `ln(1+(N−df+0.5)/(df+0.5))` không âm; hybrid rank chặn doc bm25≤0; PSI quy ước bin PHẢI-đóng khớp chính xác `computeFeatureHist` (đã đối chiếu 2 vòng lặp `v <= cuts[k]`).
- **news-coverage PIT 15:45 ICT → phiên kế tiếp** — mapping chuẩn, không nhìn tương lai.
- **Skip-guard windowHash + featureSet** — hash trên chính chuỗi đã load (F-611-01), so cả serving lẫn latest, khớp DB qua `SweepRun.featureSet` — đối chiếu schema OK (SweepRun có đủ trường championJson/logJson/seed/status như code ghi).
- **Serving v1-lag10 đọc vector 16/24 chiều** — `predictProba` map norm theo index, forward chỉ đọc IN=10 chiều đầu (10 chiều đầu giữ nguyên công thức v1) — tương thích ngược không vỡ.

## Ghi chú meta

- Không tìm thấy chỗ nào JSON-serialize NaN ra DB mà thiếu guard ở tầng đọc (toàn bộ đường metrics đều `Number.isFinite`/`toFixed` trước lưu; `parseMetrics` route chặn thiếu trường số → null trung thực).
- Truyền thống "ghi chú trung thực trong comment" đúng ở đa số chỗ; các chỗ comment nói NGƯỢC code (B1 features.ts:970 "fit trên tập train", B3 features.ts:1371 "rổ TRƯỚC", B5 calibration.ts:16 "holdout", B2 rl.ts:147 mô tả công thức đúng nhưng code sai) chính là 4 phát hiện đáng giá nhất của đợt audit này — commenting culture của dự án khiến việc đối chiếu spec-vs-code hiệu quả bất thường.

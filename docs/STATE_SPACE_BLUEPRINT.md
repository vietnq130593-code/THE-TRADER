# STATE SPACE BLUEPRINT — Áp dụng "Time Series Analysis by State Space Methods" (Durbin & Koopman) vào THE TRADER

> Nguồn tri thức: **Durbin, J. & Koopman, S. J. (2012). Time Series Analysis by State Space Methods — 2nd edition.** Oxford University Press. (Bản 1: 2001; kèm SsfPack của Koopman–Shephard–Doornik.)
> Tài liệu này tổng hợp tri thức cuốn sách và chi tiết hoá **cách áp dụng vào THE TRADER** theo từng module, có file code, guard PIT, kế hoạch nghiệm thu và lộ trình.
> Bạn đọc đồng hành nên tra: Harvey (1989) *Forecasting, Structural Time Series Models and the Kalman Filter* (đối tác kết cấu cho phần structural/multivariate), Kim–Shephard–Chib (1998) cho stochastic volatility, Carter–Kohn (1994) cho simulation smoothing.
> Ngày soạn: 22/10/2026 · Người soạn: Z.ai Code · Trạng thái: **PHASE 1 ĐÃ TRIỂN KHAI (Task 176 — 23/10/2026): SS-1 holt-ss MLE + SS-2 predictive variance + SS-11 log-score + SS-7 CUSUM shadow — hermetic p176 36/36 PASS (Nile thật σ²ε=15 098,5 khớp sách 15 099 + đối chứng statsmodels), driver A15b chạy bóng 14 ngày, guard đọc-only**; **PHASE 2 ĐÃ TRIỂN KHAI (Task 178 — 23/10/2026): SS-3 skip-update nối đường thật (calendar.ts + null-tolerant cả 2 driver) + SS-8 auxiliary residuals → cờ SS_DATA_FLAG đọc-only + SS-5 β động TVP (tvp.ts vs VNINDEX) + SS-9 báo cáo seasonality `docs/SS_SEASONALITY_REPORT.md` (M1 thắng 12/12 chuỗi — KHÔNG đụng UI/featureset chưa, đúng kỷ luật 4 cổng) + SS-2 bullet 3 UI CI80 — hermetic p178 38/38 PASS, vá 6 findings F-177 của review Task 177**; v1.1 đã qua pass review kỹ sư AI/kiến trúc sư (22/10/2026; xem mục Lịch sử hiệu đính cuối file).

---

## Phần I — Tinh túy cuốn sách trong 12 điểm

1. **Mọi mô hình chuỗi thời gian tuyến tính-Gaussian đều viết được về một dạng duy nhất** — dạng không gian trạng thái (state space form):
   - Phương trình quan sát: `y_t = Z_t·α_t + ε_t`, `ε_t ~ N(0, H_t)`
   - Phương trình trạng thái: `α_{t+1} = T_t·α_t + R_t·η_t`, `η_t ~ N(0, Q_t)`
   ARIMA, Holt-Winters/ETS, structural (trend+seasonal+cycle), regression với hệ số đổi theo thời gian, dynamic factor… đều là **trường hợp đặc biệt** — cùng một cỗ máy ước lượng/luận suy xử lý hết.

2. **Bộ lọc Kalman (ch. 3)** là thuật toán đệ quy tối ưu: cho dữ liệu tới `t`, tính `E(α_t | y_1..t)` (gọi là **trạng thái lọc**, filtered state) và phương sai `P_{t|t}` — chỉ đi một chiều thời gian, O(1) mỗi bước, không cần nghịch ma trận lớn.

3. **Hàm khả năng = phân rã sai số dự báo (prediction error decomposition)**:
   `ℓ = −½ Σ_t [ log 2πF_t + v_t²/F_t ]` với `v_t` là innovation (sai số dự báo 1 bước) và `F_t` phương sai của nó. Đây là **cây cầu giữa "lọc" và "ước lượng MLE"** — tối ưu tham số chính là làm thông tin dự báo bớt ngạc nhiên.

4. **Local level model (ch. 2, dữ liệu sông Nile)** — mô hình mở đầu của sách và của mọi SSM: `y_t = μ_t + ε_t`, `μ_{t+1} = μ_t + η_t`. Thêm slope `ν_t` đi theo random walk → **local linear trend** — chính là "phiên bản có lý thuyết" của Holt trong THE TRADER hôm nay.

5. **Smoother (ch. 4)**: dùng TOÀN bộ dữ liệu `y_1..T` để suy lại trạng thái từng thời điểm quá khứ (`α_{t|T}`) — chính xác hơn lọc cho phân tích hồi cố (forensic), nhưng **KHÔNG được dùng làm feature quyết định tại `t`** (rò rỉ tương lai — xem quy tắc PIT ở Phần IV).

6. **Dữ liệu thiếu & tần số hỗn hợp (ch. 5)**: nếu `y_t` thiếu, đặt hàng quan sát về 0 và bỏ bước cập nhật — trạng thái trôi theo hệ thống động học, **phương sai phình lên một cách trung thực**. Hệ quả vàng: chuỗi công bố theo tháng (CPI…), phiên bị treo, nghỉ lễ Tết âm lịch — tất cả xử lý bằng chính một cơ chế, không cần forward-fill bịa số.

7. **Khởi tạo diffuse (ch. 6–7)**: đầu chuỗi khi chưa biết gì về trạng thái, dùng prior phương sai vô cùng lớn — likelihood "diffuse" xử lý đúng đắn (đoạn đầu không đóng góp thông tin). Thực dụng: với chuỗi hàng nghìn phiên, ảnh hưởng mờ mò vài chục điểm đầu; giai đoạn đầu dùng heuristic đơn giản là chấp nhận được, ghi rõ hạn chế.

8. **Hiệu ứng hồi quy & hệ số đổi theo thời gian (ch. 8)**: `y_t = x_t'β_t + ε_t` với `β_t` đi random walk — **hồi quy β động** (time-varying beta/loading) là vũ khí tự nhiên của cuốn sách cho quan hệ không ổn định (beta cổ phiếu so VNINDEX, độ nhạy vĩ mô…).

9. **Chẩn đoán mô hình (ch. 9)**: innovation chuẩn hoá `v_t/√F_t` phải ~N(0,1) nếu mô hình đúng; **phần dư phụ trợ (auxiliary residuals)** tách riêng cú sốc quan sát (outlier giá) khỏi cú sốc trạng thái (đổi level/trend) — công cụ phát hiện bất thường tinh hơn so với so ngưỡng thô; kèm CUSUM các loại để đo đổi cấu trúc.

10. **Mở rộng non-Gaussian / phi tuyến (ch. 10–11)**: biến thiên ngẫu nhiên (stochastic volatility), quan sát Poisson/nhị thức, ngưỡng… ước lượng bằng importance sampling và **particle filter**. Mạnh nhưng đắt và khó nghiệm chứng — chỉ đụng khi phần tuyến tính đã cứng.

11. **Bayesian (ch. 12)**: đặt prior cho tham số/trạng thái — với THE TRADER, ý nghĩa trực tiếp nhất là **shrink-to-base-rate chống cold-start** (meta-learner đang 36/60 tín hiệu đủ điều kiện).

12. **Simulation smoothing (ch. 4 + 12; thuật toán Carter–Kohn 1994)**: rút cả quỹ đạo trạng thái từ hậu nghiệm — sinh kịch bản đường giá/kịch bản vĩ mô cho đo rủi ro, không chỉ dự báo điểm.

---

## Phần II — Bản đồ: khái niệm sách → module THE TRADER

| # | Khái niệm (chương sách) | Module THE TRADER hiện tại | Đề xuất | Mã việc |
|---|---|---|---|---|
| 1 | Local linear trend + MLE (ch. 2–3) | `src/lib/quant/forecast.ts` — Holt heuristic α=0.5/β=0.25, dự báo điểm + band CI80 heuristic (Z80·σ√h từ residual 1 bước) | Viết lại dạng SS: MLE tham số + predictive variance từ covariance trạng thái → xác suất tăng/giảm có hiệu số tin cậy | SS-1 |
| 2 | Predictive variance (ch. 3) | `ml-forecast.holt-basket` có σ heuristic residual-based (không MLE, không propagate covariance trạng thái) — trọng số evidence hardcode 0,65 | Nâng σ lên predictive variance chuẩn + trọng số evidence theo z thay hardcode | SS-2 |
| 3 | Missing observations (ch. 5) | trả về `null` khi prev≤0 (features.ts) | Skip-update Kalman — trạng thái trôi, variance phình trung thực | SS-3 |
| 4 | Tần số hỗn hợp (ch. 5) | MacroContext 8 chiều theo ngày (`macroByDate`, v3-macro x[16..23]) | Latent macro state hằng ngày, cập nhật khi có công bố — nowcasting | SS-4 |
| 5 | TVP regression (ch. 8) | W1 rổ top-10 ADTV-45 — β chưa được mô hình hoá (reward rổ chung) | β động từng mã so VNINDEX; tách rủi ro thị trường/idiosyncratic | SS-5 |
| 6 | Multivariate / SUTSE, dynamic factor | 10 mã rổ dùng chung reward | Common VN factor (filtered, PIT) + cấu trúc lead-lag | SS-6 |
| 7 | Innovation chuẩn hoá + CUSUM (ch. 9) | W3 dùng PSI≥0.25 trên phân phối feature | Guard thứ hai: độ ngạc nhiên của model trung tâm ngoài N(0,1) | SS-7 |
| 8 | Auxiliary residuals (ch. 9) | `api/data-quality` hiện tại theo ngưỡng | Tách outlier quan sát vs đổi level → cờ chất lượng dữ liệu trước khi vào train | SS-8 |
| 9 | Seasonal structural (Harvey; ch. 5 nhịp không đều) | Không có seasonality rõ ràng | Day-of-week + hiệu ứng Tết (lịch âm rối) cho chiến lược & feature | SS-9 |
| 10 | Simulation smoother (ch. 4/12) | Không có sinh kịch bản | Sinh quỹ đạo hậu nghiệm → VaR kịch bản cho portfolio paper | SS-10 |
| 11 | Log predictive density (ch. 3) | W4 holdout chấm valAcc/valLoss (dl-mlp) · P&L chính sách vs 3 baseline (rl-q) — lớp forecast chưa có thước xác suất | Log-score xác suất cho các driver forecast — bổ sung cổng so sánh mô hình | SS-11 |
| 12 | Bayesian shrinkage (ch. 12) | meta-learner cold-start 36/60 | Prior co rút về base-rate 250 phiên (40,1/46,6/13,3) | SS-12 |

---

## Phần III — Chi tiết 12 ứng dụng

### SS-1 · Holt → Local linear trend trạng thái (điểm neo, ưu tiên CAO)

**Hiện trạng.** `src/lib/quant/forecast.ts` (`holtForecast`, `holtForecastPct`): pure function, α=0.5 β=0.25 cứng, dự báo điểm kèm band CI80 heuristic từ stdev residual 1 bước (Z80·σ·√h — không MLE, không propagate covariance trạng thái); `src/lib/bayes/evidence.ts` tiêu thụ làm driver `ml-forecast.holt-basket` (A15, trọng số hardcode 0,65) đút vào Bayes pUp/pDown.

**Sách dạy.** Holt linear trend ≡ local linear trend SSM:
- Trạng thái `α_t = [μ_t; b_t]` (level + slope), `T = [[1,1],[0,1]]`, `Z = [1, 0]`
- `Q = diag(σ²_ημ, σ²_ηb)`, `H = σ²_ε` — **3 tham số phương sai thay cho cặp α/β cố định**
- Ước lượng bằng MLE trên prediction error decomposition (Phần I.3) — **3 tham số nên dùng Nelder-Mead multi-start (≥5 mồi, gồm mồi từ α/β cũ qui ra signal-to-noise ratio) + clamp biên σ²≥0**: golden-section chỉ 1-D là không đủ; nghiệm biên σ²→0 là mô hình rút gọn hợp lệ (phải xử lý đúng, không phải lỗi hội tụ); likelihood có thể phẳng trên chuỗi ngắn khi 2 phương sai hoán đổi vai trò — multi-start chống kẹt
- Kalman cho ngay `Var(ŷ_{t+h|t})` bằng đệ quy `P_{t+h|t}` (không cần nhớ công thức đóng — dùng đệ quy là an toàn)

**Thiết kế.**
- File mới `src/lib/ml/ss/holt-ss.ts`: export `holtSsFit(closes, {maxIter})` → `{sigma2Eps, sigma2EtaMu, sigma2EtaB, logLik, innovations[]}` và `holtSsForecast(fit, closes, h)` → `{mean[], sd[], zByHorizon}`. Pure, không DB, deterministic (khởi tạo cố định theo khối KHỞI TẠO ở Phụ lục A, ngừng khi Δℓ<1e-8 — nhân bản được triết lý deterministic của train v17/v18).
- Driver Bayes: `ml-forecast.holt-ss` (đăng ký id riêng trong roster evidence, vd A15b — không đè A15 đang sống) — pUp từ z-score Gauss: `pUp = 1 − Φ((0 − meanPct)/sd)` ≡ `Φ(meanPct/sd)` (đổi ý nghĩa: thay "dự báo +%" bằng "xác suất tăng + mức tin"), evidence ghi kèm σ và logLik để audit.
- **PIT**: chỉ dùng closes ≤ castDate (giữ nguyên nguyên tắc đường holt hiện tại).

**Nghiệm thu hermetic (bắt buộc trước khi sống).**
1. **Tái hiện Nile** (dữ liệu sông Nile 1871–1970 trong sách ch. 2 — bảng số liệu công bố kèm SsfPack, cũng có trong R `datasets::Nile`): local level fit của em phải ra cùng thứ bậc tham số với sách (sai số nhỏ do khác numeric; dung sai xác định theo sơ đồ KHỞI TẠO + burn-in ở Phụ lục A).
2. Synthetic: sinh local linear trend bằng tham số cho trước → MLE phục hồi trong ±10% — **bắt buộc đủ 3 tham số** (Nile chỉ stress-test 2 tham số local level, không chạm bài toán biên/degenerate của cặp σ²ημ–σ²ηb).
3. Determinism: 2 lần chạy cùng input → cùng chuỗi byte kết quả (mirror tinh thần p167 digest test).
4. Đối chứng: driver cũ chạy song song 14 ngày, chấm bằng log-score (SS-11) trên holdout — chỉ thay evidence khi vượt.

**Effort**: S/M (1–2 ngày). **Rủi ro thấp** — module mới nguyên, không đụng đường train.

---

### SS-2 · Phương sai dự báo cho mọi forecast (CAO, đi kèm SS-1)

Nâng cấp σ từ heuristic residual (Z80·σ√h hiện tại) lên predictive variance chuẩn: mọi driver dự báo (holt-ss, macro nowcast SS-4, beta động SS-5) xuất chuẩn `sd` cùng `mean`. Nơi tiêu thụ:
- Bayes evidence: trọng số evidence theo z (|z| lớn → tin cao, có sàn/ceiling chống overconfident khi đuôi dày) thay trọng số hardcode 0,65 hiện tại;
- UI `Tổng quan`/`Tổng hợp`: hiển thị khoảng tin cậy 80% cho dự báo (hiện chỉ điểm);
- Guard an toàn: nếu sd phình quá ngưỡng (ví dụ > 3× sd cửa sổ 250 phiên cuộn cùng horizon) → tự giáng trọng số evidence về 0 (fail-soft trung thực — model tự nhận "tôi không biết").
**Effort**: S (nếu làm cùng SS-1).

---

### SS-3 · Phiên thiếu / mã treo: bỏ cập nhật thay vì bịa số (CAO)

**Hiện trạng.** `features.ts` trả `null` khi prev≤0; downstream xử lý null từng nơi (một số đường fill, một số bỏ dòng). Mã ngừng giao dịch, mã mới IPO giữa cửa sổ, nghỉ Tết — dữ liệu lởm chởm.

**Sách dạy (ch. 5).** Trong Kalman: quan sát thiếu ⇒ bỏ bước cập nhật, trạng thái tiến theo `T`, `P` phình đúng lượng bất định tích luỹ. KHÔNG cần bịa giá, KHÔNG cần bỏ dòng — mẫu vẫn giữ nhịp ngày.

**Thiết kế.** Cơ chế dùng ở 2 tầng:
- Tầng forecast/SS (SS-1/SS-4 dùng ngay miễn phí);
- Tầng feature dl-mlp: MacroContext dòng "absent" đã trung thực theo F-166b-3 — giữ nguyên triết lý: SS chỉ là **lựa chọn cho các đường dự báo**, không đổi featureset đang serving (đòi digest bump). Ghi rõ ranh giới này trong code comment.

**Nghiệm thu**: synthetic có lỗ tuần tự — so sánh "skip-update + variance phình" vs "drop dòng" vs "fill" về log-score; kỳ vọng skip thắng ở lỗ thưa (<20%).
**Effort**: S.

---

### SS-4 · Nowcasting vĩ mô tần số hỗn hợp cho MacroContext 8 chiều (TRUNG BÌNH — TOÀN CỤU NHẤT)

**Hiện trạng.** 8 chiều `dus10y20, slope10y5y, dxyMom20, vndMom20, cmdtyMom20, breadth20, flow20, sent7` — **toàn bộ là chuỗi NGÀY phái sinh thị trường** (không có chuỗi công bố tháng nào trong bộ hiện tại — CPI/tín dụng chỉ xuất hiện nếu mở rộng tương lai); ngày "absent" đang hash trung thực (macroRows 3306/62220 bars).

**Sách dạy.** SS xử lý tần số hỗn hợp & quan sát thưa một cách tự nhiên: trạng thái vĩ mô **hằng ngày** là latent; quan sát có mặt hôm nay cập nhật lại trạng thái, ngày absent trạng thái trôi + uncertainty phình (ch. 5). **Giá trị thật với 8 chiều hiện tại**: (a) điền ngày absent bằng latent state trung thực thay vì bỏ/bịa, (b) hợp nhất lead-lag giữa các chiều (DXY/US10Y thường dẫn trước VNDMom/breadth — Kalman đa biến đo được). Động cơ "mixed-frequency công bố tháng" chỉ áp cho mở rộng tương lai (CPI, PMI, tín dụng nếu thêm vào MacroContext).

**Thiết kế (phải đi qua 4 cổng).**
1. **PIT tuyệt đối**: tại ngày lấy mẫu `t` chỉ dùng `μ_{t|t}` (filtered) — dùng smoother là rò rỉ tương lai, cấm tuyệt đối trong đường train/evidence (smoother chỉ dành cho audit).
2. **windowHash**: feature mới từ SS ⇒ digestVersion bump (`bars+macro8-ss-v1`) theo đúng triết lý F-166b-3 — hash trên **giá trị chuẩn hoá model tiêu thụ**, tham số SS (σ² đã fit) thuộc meta + freeze theo cửa sổ (re-fit mỗi cửa sổ train như train các model khác, không cập nhật online trong quá khứ).
3. **Kill-switch + audit**: AppSetting `ml-ss-macro` tắt được, AuditLog `SS_MACRO_REFIT` ghi windowHash + tham số — nhân bản 5-guard W3.
4. **A/B chết/sống**: chỉ bật làm feature khi log-score holdout (SS-11) của dl-mlp với SS-feature ≥ không-SS (chạy sweep như v73→v83).

**Effort**: M/L (3–5 ngày). Làm SAU khi SS-1 đã đứng vững để dùng lại kalman.ts.

---

### SS-5 · β động cho rổ W1 (TRUNG BÌNH)

**Hiện trạng.** W1 (Task 163): rổ PIT top-10 ADTV-45 EOD tại castDate — reward chung rổ; beta so VNINDEX chưa được mô hình hoá động.

**Sách dạy (ch. 8).** `r_i,t = α_i,t + β_i,t·r_mkt,t + ε` với β_i,t random walk (hoặc decay về mean β̄). Kalman cho β_i,t|t mỗi ngày, kèm Var(β) — biết được "β đang trôi và mình chắc đến đâu".

**Ứng dụng trong THE TRADER:**
- Feature cho Portfolio Strategist (hedge ratio dự phòng cho thế giới live sau này);
- Risk route: tách biến động rổ thành thành phần thị trường vs idiosyncratic → cỡ lệnh từng mã (chưa làm sizing — ghi như future hook);
- Diagnostics: mã có Var(β) phình = quan hệ destabilising → cờ rủi ro vào data-quality/strategist context.

**PIT**: β_{t|t} từ dữ liệu ≤ t; cửa sổ fit rolling như train. **Effort**: M.

---

### SS-6 · Common VN factor + SUTSE cho rổ 10 mã (TRUNG BÌNH/THẤP)

Một factor thị trường chung (hoặc 2: thị trường + nhóm ngành NH/BĐS) rút từ 10 mã bằng Kalman filter đa biến — `filtered factor` (không smoothed!) là feature lớp cao cho meta-learner/rl-q (96-state có thể nâng lúc re-design lớn — KHÔNG đụng UI vội). Lead-lag giữa VCB/SSI… xem qua cross-correlation của innovation từng mã. **Effort**: M/L — chỉ làm khi SS-5 đã chạy ổn (dùng chung kalman.ts đa biến).

---

### SS-7 · Guard "độ ngạc nhiên" bên cạnh PSI (CAO — rẻ, ăn ngay infra W3)

**Hiện trạng.** W3 (Task 164): PSI ≥ 0.25 trên phân phối feature → auto-retrain 5-guard (kill-switch, cooldown 24h, mutex, windowHash, audit).

**Sách dạy (ch. 3 + 9).** Innovation chuẩn hoá `e_t = v_t/√F_t ~ N(0,1)` nếu model trung tâm còn khớp; kiểm định đơn giản: KS-test e_t với N(0,1) + CUSUM trên `e_t² − 1` (trung bình của e² phải = 1). Đây là **drift theo model-fit** — PSI đo drift phân phối đầu vào, e_t đo model có còn "sốc" với dữ liệu mới không — hai lớp bổ sung nhau.

**Thiết kế.** Chạy local level / local linear trend trên log-giá từng mã rổ (fit lại mỗi đêm theo cửa sổ, tham số freeze). **Nhà vận hành**: mở rộng due-check psi-retrain sẵn có của engine :3003 (nhịp 15' t2–t6 đã sống) thêm bước surprise, kill-switch `ml-ss-surprise` riêng — không sinh vòng lặp mới. Chu kỳ: 1 lần/ngày theo settle (không 15' — tránh multiplicity):
- **tin chính là CUSUM trên `e²−1`** (cửa sổ cuộn 60 phiên) — HOSE đuôi dày khiến KS vs N(0,1) reject mạn tính; KS hạ xuống tin phụ với ngưỡng Bonferroni (0,01/(số mã × số check/ngày)), |e|>4 giữ làm cờ đơn phát;
- ghi AuditLog `SS_SURPRISE` {symbol, e, cusum, p};
- tầng tổng: tỉ lệ mã "sốc" > 30% rổ → cùng tín hiệu với PSI (đi vào cơ chế auto-retrain có sẵn — tái dùng 5-guard, không sinh cơ chế mới).
**Effort**: S/M. **Trung thực**: guard bổ sung, không thay PSI; innovation tính bằng tham số fit trên chính cửa sổ chứa chúng (in-sample, hơi co lại — chấp nhận được cho guard); demo 4 tuần audit im lặng trước khi nối vào auto-retrain.

---

### SS-8 · Auxiliary residuals — cờ chất lượng dữ liệu trước cửa train (CAO)

**Sách dạy (ch. 9).** Smoothed observation-disturbance residual (ε) → **outlier giá** (sốc quan sát); smoothed state residual → **đổi level/trend thật** (tin tức cấu trúc). Phân biệt 2 loại này = biệt thoại giữa "dữ liệu bẩn" và "thị trường đổi chế" — hiện tại data-quality chỉ theo ngưỡng giá trị.

**Ứng dụng.** Mỗi đêm, chạy smoother (chỗ hợp pháp dùng smoother — cửa sổ đã đóng, mục đích audit) trên chuỗi giá 10 mã: |standardised aux obs residual| > 3.5 → cờ OUTLIER; |aux state residual| > 3.5 → cờ LEVEL_SHIFT kèm ngày. **Giai đoạn 1: cờ READ-ONLY** — chỉ vào bảng data-quality + ngữ cảnh strategist, KHÔNG đổi tuyển dòng train (nếu sau này cờ ảnh hưởng tuyển dòng thì windowHash phải hash cả quyết định tuyển dòng — triết lý F-166b-3 hash đúng thứ model tiêu thụ — nếu không A/B và skip-guard bị confound). Ghi AuditLog `SS_DATA_FLAG`. **Effort**: S/M.

---

### SS-9 · Seasonal cấu trúc: day-of-week + Tết (THẤP)

Structural seasonal (dummy hoặc trigonometric — Harvey ch. 2/6 dạng SS) cho chuỗi return/log-giá: 4 hệ số ngày trong tuần + 1 yếu tố Tết (cửa sổ ±5 phiên quanh lịch âm — đối xử như "seasonal không đều" bằng skip-update của ch. 5 vì ngày dương dịch năm nào cũng lệch). Đầu ra: seasonal factor hằng ngày cho strategist context ("đang trong cửa sổ Tết historically yếu") và làm feature so sánh qua sweep. **Chỉ làm khi có bằng chứng**: fit trước trên dữ liệu 62220 bars đang có, log-score holdout phải chứng minh seasonality có tín hiệu đáng kể trên HOSE trước khi đụng UI. **Effort**: M.

---

### SS-10 · Simulation smoothing → kịch bản VaR (THẤP — paper world)

Carter–Kohn (1994) backward sampling rút quỹ đạo trạng thái hậu nghiệm từ model SS-1/SS-9 → sinh N=2000 đường giá tương lai cho từng vị thế (hiện 3 vị thế TCB/VIC/VPB) → phân phối P&L 5 ngày → VaR 95% + expected shortfall cho khối "Hội đồng". Làm gọn: seed cố định theo windowHash (deterministic — nhân bản được cho audit). **Effort**: M. Giá trị: học định lượng rủi ro trên thế giới paper trước khi LIVE_TRADING.

---

### SS-11 · Log predictive density — cổng chấm model mới (CAO — công cụ nghiệm thu)

Mọi model dự báo xác suất/điểm (holt-ss, SS-4, SS-9, thậm chí pUp/pDown của Bayes) chấm trên holdout bằng **log-score**: `LS = Σ log p(y_actual | model)` — kéo dài prediction error decomposition ra ngoài mẫu. Đây là thước "calibration + sharpness" đúng chuẩn, khắc phục hạn chế valAcc post-selection mà review #162 (W5) từng nêu cho lớp forecast. Tích hợp vào sweep report (đã có hạ tầng sweep/holdout từ W4/W5). **Effort**: S.

---

### SS-12 · Bayesian shrink cho meta-learner cold-start (TRUNG BÌNH)

Meta-learner cần 60 tín hiệu/36 đạt — tín hiệu mới sinh chậm. Sách (ch. 12): prior N(β̄, τ²) với β̄ co về hệ số base-rate 250 phiên (40,1% tăng / 46,6% giảm / 13,3% ngang — đã có sẵn trong `/api/assessment` prior) và τ lớn; dữ liệu trickles in thì posterior tự rời prior. Triển khai dạng sạch nhất **không cần Kalman**: shrinkage conjugate Dirichlet/multinomial trên xác suất 3 lớp (kết quả WIN/LOSS là nhị thức/đa thức — Kalman tuyến-Gauss trên trọng số không exact; nếu muốn động theo thời gian thì logit-approx Kalman là phương án phụ). **Effort**: S/M — nhưng chỉ sau khi có SS-1 làm nền vận hành.

---

## Phần IV — Quy tắc kiến trúc triển khai (không thoả hiệp)

1. **Thư viện mới thuần TS, 0 dependency ngoài**: `src/lib/ml/ss/` gồm `kalman.ts` (filter + smoother đa biến tối thiểu, ~150 dòng, strict types, không DB), `holt-ss.ts`, `tvp.ts`, `diag.ts` (innovation/aux/KS/CUSUM), `simsmooth.ts`. Mọi hàm pure + deterministic (seed & khởi tạo ghi rõ trong meta).
2. **QUY TẮC SẮC ĐỎ PIT — LỌC, KHÔNG MƯỢT**: bất kỳ giá trị SS nào đi vào train-set/feature/evidence/decision tại thời điểm `t` **phải** là filtered `μ_{t|t}`/`P_{t|t}` (hoặc dự báo `t+h|t`). Smoothed quantities `μ_{t|T}` chỉ được dùng trong: audit forensic, data-quality hậu kiểm (SS-8), nghiên cứu ngoài đường sống. Vi phạm = rò rỉ tương lai, huỷ trắng kết quả như nguyên tắc PIT đã xử lý W1.
3. **Tham số phải "đóng băng" theo cửa sổ**: fit trong train window, giữ nguyên cho eval/holdout — không cập nhật online trong quá khứ. Mọi meta ghi đủ để tái tạo (như TrainingWindowMeta v83).
4. **windowHash theo triết lý F-166b-3**: bất kỳ feature nào sinh từ SS tham gia đường train dl-mlp ⇒ digestVersion bump và hash **trên giá trị đã chuẩn hoá model tiêu thụ** (kể cả phiên bản tham số SS trong meta, không hash chuỗi tham số thô gây nổ đổi hash vô nghĩa khi re-fit deterministic).
5. **Kill-switch + audit nhân bản W3**: mọi tầng SS có AppSetting (`ml-ss-*`) tắt được không restart, AuditLog `SS_*` cùng mô-típ `ML_PSI_RETRAIN` (kể cả lần skip im lặng khi cooldown — đã có bài học F-166c-1 về nuốt im lặng).
6. **A/B bằng SHADOW, không dual-live**: driver mới chạy 14 ngày ở chế độ BÓNG — ghi evidence + logScore vào AuditLog `SS_AB_LOG` {driver, horizon, mean, sd, realized, logScore} mỗi settle nhưng KHÔNG đút vào Bayes (2 driver cùng nguồn closes mà sống song song = đếm kép thông tin trend); hết 14 ngày so log-score (SS-11) — chỉ khi thắng mới hoán đổi evidence và tắt driver cũ. Không "đập cũ dựng mới" — đường holt heuristic giữ làm baseline đối chứng chi phí gần 0.
7. **Vị trí render UI**: mọi hiển thị mới (khoảng tin cậy, cờ SS-8, VaR) theo khối kiểm định 4 ô kiểu W3/W4 đã làm — minh bạch số trong mẫu vs ngoài mẫu.

---

## Phần V — Lộ trình 3 pha (đề xuất)

**Phase 1 — Nền móng & thắng lợi nhanh (1 tuần)**
- SS-1 (holt-ss + MLE) · SS-2 (σ cho mọi forecast) · SS-11 (log-score cổng nghiệm thu) · SS-7 (guard độ ngạc nhiên chạy audit im lặng 4 tuần song song PSI)
- Đầu ra: driver `ml-forecast.holt-ss` A/B, Nile + synthetic verify hermetic, guard mới ghi audit không hành động.

**Phase 2 — Chất lượng dữ liệu & cấu trúc rổ (2–3 tuần)**
- SS-3 (skip-update phiến thiếu) · SS-8 (auxiliary residuals → data-quality) · SS-5 (β động W1) · SS-9 (seasonal nếu chứng minh được tín hiệu)
- Đầu ra: cờ SS_DATA_FLAG sống, β động vào strategist context, seasonal report có/không kết luận dứt khoát.

**Phase 3 — Latent & kịch bản (sau khi Pha 1–2 ổn định ≥ 2 tuần)**
- SS-4 (nowcasting macro 8 chiều — đi đủ 4 cổng ở Phần III) · SS-6 (common factor) · SS-10 (VaR kịch bản) · SS-12 (Bayesian meta-learner)
- Đầu ra: feature macro8-ss-v1 qua sweep cổng holdout, khối VaR ở tab Hội đồng.

Mỗi pha kết thúc bằng: hermetic PASS toàn bộ → live verify 4 tầng (đường engine thật :3003 + FE + curl + audit) → browser desktop/mobile → lint → commit + worklog theo quy ước Task hiện hành.

---

## Phần VI — Những gì KHÔNG làm (định scope trung thực)

1. **Particle filter (ch. 11) — tạm không.** Đắt, khó nghiệm thu correctness, và chưa có bài toán nào của THE TRADER cần phi tuyến/non-Gaussian đến mức đó. Lớp SV đơn giản nếu cần thì dùng xấp xỉ Kim–Shephard–Chib (mixture 7 thành phần) chạy được bằng chính Kalman tuyến tính.
2. **Không viết lại dl-mlp thành SSM.** dl-mlp là bộ phân loại cross-sectional (24 feature → 3 lớp horizon 5 ngày) — việc khác với lọc chuỗi. SSM sống ở tầng driver/feature/risk, không cướp việc của MLP/GRU/Q-learning.
3. **Không đổi featureset đang serving trước khi có bằng chứng sweep.** Mọi feature SS phải thắng holdout như v83 đã từng thua v73 một cách trung thực (valAcc 40,56% < 42,88% → archived) — tiêu chuẩn không giảm.
4. **Khởi tạo diffuse chính xác (ch. 6–7) — hoãn.** Chuỗi 62220 bars khiến đoạn đầu vô nghĩa về thống kê; heuristic + ghi hạn chế là đủ ở quy mô này.
5. **Không đụng Q-table 96-state bằng SS ngay.** Việc nâng state space của rl-q là thiết kế lớn, phải chờ bằng chứng Phase 3 (common factor) đủ mạnh mới bàn.

---

## Phụ lục A — Toàn bộ toán lõi cần implement (tham chiếu nhanh)

```
KALMAN FILTER (mỗi t, đã biết a_{t|t-1}, P_{t|t-1}):
  v_t   = y_t − Z_t·a_{t|t-1}            (innovation)
  F_t   = Z_t·P_{t|t-1}·Z_t' + H_t        (phương sai innovation)
  K_t   = P_{t|t-1}·Z_t'·F_t^{-1}         (gain Kalman)
  a_{t|t}   = a_{t|t-1} + K_t·v_t
  P_{t|t}   = P_{t|t-1} − K_t·F_t·K_t'
  a_{t+1|t} = T_t·a_{t|t}
  P_{t+1|t} = T_t·P_{t|t}·T_t' + R_t·Q_t·R_t'

  y_t thiếu  ⇒ bỏ 4 dòng cập nhật (chỉ chạy 2 dòng dự báo), P phình tự nhiên.
  log-lik   : ℓ = −½ Σ [ ln(2πF_t) + v_t²/F_t ]

DỰ BÁO h BƯỚC: lặp a,P dự báo; Var(ŷ) = Z·P_{t+h|t}·Z' + H.  (dùng đệ quy, tránh công thức đóng)

SMOOTHER (chỉ cho audit/forensic — KHÔNG feature):
  lặp ngược từ T: r_{t-1} = Z_t'F_t^{-1}v_t + L_t'r_t ;  α̂_{t|T} = a_{t|t-1} + P_{t|t-1}r_{t-1}
  (L_t = T_t(I − K_tZ_t); auxiliary residuals lấy từ smoothed disturbances)

LOCAL LINEAR TREND: α=[μ;b]; T=[[1,1],[0,1]]; Z=[1,0]; Q=diag(σ²ημ, σ²ηb); H=σ²ε
TVP β ĐỘNG:        y = x'β_t + ε; β_{t+1}=β_t+η; Z_t = x_t'; Q=diag(τ²…)
LOG-SCORE HOLDOUT: LS = Σ_holdout ln N(y ; ŷ_{t|t-1}, F_t)

KHỞI TẠO (chuẩn hoá — áp cho mọi model SS):
  a₁ = [y₁ ; y₂−y₁] ;  P₁ = κ·I với κ = 10⁶·Var(y)  (xấp xỉ diffuse hữu hạn)
  burn-in: bỏ m = 5 điểm đầu khỏi likelihood ℓ (đoạn khởi tạo chưa ổn định)
  ⇒ mọi replication/synthetic test khai báo dung sai theo sơ đồ này
```

## Phụ lục B — Checklist nghiệm thu chuẩn (áp cho mọi việc SS)

- [ ] Hermetic: Nile replication (ch. 2) cho local level; synthetic recovery ±10%; determinism byte-đồng nhất 2 lần chạy
- [ ] PIT test kiểu p164: đổi toàn bộ holdout ⇒ feature/verdict tại đoạn train KHÔNG đổi (leakage = 0)
- [ ] windowHash: digestVersion bump đúng; macroRows/feature mới được hash; hash cũ ≡ hành vi cũ khi tắt kill-switch (kiểu T5/T6 của p167)
- [ ] Kill-switch tắt → hệ thống về đúng hành vi trước đó, audit ghi 1 dòng
- [ ] Live 4 tầng: đường engine :3003 thật + FE nút + curl + audit trail
- [ ] Log-score A/B 14 ngày: mới ≥ cũ mới được hoán đổi evidence
- [ ] Browser desktop 1440 + mobile 390: khối hiển thị mới render, 0 console error, footer flush
- [ ] Lint sạch; worklog + commit theo quy ước

## Tham chiếu chéo nội bộ THE TRADER

- W1–W5 + review #162: `worklog.md` Task 162–165 · 5-guard W3: Task 164 · holdout W4: Task 165
- F-166b-3 windowHash macro: Task 168 (`digestVersion bars+macro8-v2`, macroRows 3306)
- PIT bandit W1: Task 163 · auto-decision cổng đồng thuận: Task 91 (backup branch note)
- L2/NIM: Task 141–142 (nim-embed 2048 dim, p141 test, p142 bootstrap/verify) · key mới 22/10/2026
- D-LEDGER: Task 106 · meta v83 guard §1.5 giữ v73: Task 168

---
*Tài liệu đề xuất — Phase 1 đã viết code thật (Task 176, xem trên). Mọi con số hiện trạng trích từ DB/audit ngày 22/10/2026 (rl-q v22 · dlMlp v73 serving · v83 archived · L2 2372 chunk vector đầy đủ).*

## Lịch sử hiệu đính
- **v1.0** (22/10/2026): so thảo đầu — 12 ứng dụng SS-1..SS-12.
- **v1.1** (22/10/2026, pass review kỹ sư AI/kiến trúc sư — Task 172):
  - **F1 · lỗi dấu pUp (SS-1)**: `Φ((0−mean)/sd)` trả về pDown — sửa thành `1 − Φ((0−mean)/sd)` ≡ `Φ(mean/sd)`; công thức cũ nếu lọt vào implement sẽ đảo ngược evidence tăng/giảm
  - **F2 · sai thực trạng σ (Phần II hàng 2 + SS-1/SS-2)**: code thật đã có CI80 heuristic Z80·σ√h từ residual 1 bước + sigmaPct + trọng số hardcode 0,65 — sửa mô tả; lợi ích thật của SS-1/SS-2 là nâng cấp lên predictive variance + MLE, không phải "từ không có → có"
  - **F3 · động cơ SS-4 sai với 8 chiều hiện tại**: cả 8 đều chuỗi NGÀY phái sinh thị trường, không có chuỗi công bố tháng nào — viết lại giá trị thật (điền absent trung thực + hợp nhất lead-lag); động cơ mixed-frequency chỉ dành cho mở rộng tương lai
  - **F4 · tối ưu MLE 3 tham số**: golden-section 1-D không đủ → Nelder-Mead multi-start + clamp biên σ²≥0 + synthetic bắt buộc đủ 3 tham số (Nile chỉ chạm 2)
  - **F5 · A/B phải SHADOW không dual-live**: 2 driver cùng nguồn closes sống song song trong Bayes = đếm kép thông tin trend — định nghĩa chế độ bóng + sink AuditLog `SS_AB_LOG`
  - **F6 · SS-7 báo động giả**: HOSE đuôi dày → KS vs N(0,1) reject mạn tính — CUSUM-of-squares làm tin chính, KS hạ phụ + Bonferroni, 1 check/ngày theo settle
  - **F7 · SS-8 tương tác windowHash**: cờ dữ liệu READ-ONLY giai đoạn 1 — nếu sau này đổi tuyển dòng train thì digest phải hash cả quyết định tuyển
  - **F8 · SS-12 kết quả nhị thức**: Kalman tuyến-Gauss trên trọng số không exact → shrinkage conjugate Dirichlet/multinomial là đường sạch
  - **F9 · nhà vận hành SS-7/SS-8**: mở rộng due-check psi-retrain sẵn có của engine :3003 (không sinh vòng lặp mới)
  - P2: 4 lỗi gõ sót · driver mới đăng ký id riêng (A15b, không đè A15) · bổ sung khối KHỞI TẠO + burn-in vào Phụ lục A · Phần II hàng 5/11 viết lại chính xác (W1 chưa mô hình hoá β · W4 rl-q chấm P&L chính sách)

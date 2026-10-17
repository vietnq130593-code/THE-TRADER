# AI Engineer Review — Chuyển phân tích "Bộ não" thành Chức năng Kỹ thuật

**Ngày:** 17/10/2026 (v3) · **Vai trò:** Kỹ sư AI / chuyên gia lập trình (độc lập)
**Đối tượng:** The Trader — hệ thống giao dịch đa agent 24 thành phần (VNDIRECT paper)
**Phạm vi:** chuyển TOÀN BỘ kết quả phân tích kinh tế học về nguồn dữ liệu (khung top-down 3 lớp · 14 instrument vĩ mô #126 · findings P0/P1/P2 của review #125) thành **chức năng kỹ thuật cụ thể, khớp kiến trúc hiện có, không phá tầng nào**.

> **v3 — kết quả review độc lập lần 2** (theo yêu cầu chủ sở hữu): hiệu đính lỗi sự thật bằng đo trực tiếp DB/code (§1.5), bổ sung 2 chức năng bị bỏ sót (**F-00** vận hành hoá vòng tự học · **F-17** dự báo đa tài sản cho kỳ vọng "trái phiếu"), thêm §4 đối chiếu kỳ vọng chủ sở hữu và §5 đánh giá riêng kiến trúc Mạng thần kinh.

> **Chuỗi lý do của tài liệu:** phân tích kinh tế học nói *"bộ não cần nhìn biến kinh tế để phán đoán nền kinh tế"* → review #125 xác nhận *"não chưa từng nhìn biến kinh tế nào"* → đo trực tiếp DB 17/10 (**§1**): phục tùng thậm chí còn mỏng hơn — serving v8 chỉ đọc **10 chiều kỹ thuật giá** → tài liệu này trả lời: **xây cụ thể cái gì, ở file nào, chạy lúc mấy giờ, nghiệm thu thế nào**.

**Tài liệu liên kết:** [DATA_SOURCES.md](./DATA_SOURCES.md) (kho nguồn S1–S13) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [ML_OPS_BLUEPRINT.md](./ML_OPS_BLUEPRINT.md) · [ML_AUTOML_BLUEPRINT.md](./ML_AUTOML_BLUEPRINT.md) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md)

---

## 0. Nguyên tắc chuyển đổi (bất biến của tài liệu này)

Mọi chức năng dưới đây TUÂN THỦ 6 quy tắc — suy ra trực tiếp từ những gì hệ thống đang làm đúng:

| # | Nguyên tắc | Hệ quả kỹ thuật bắt buộc |
|---|---|---|
| **N1** | **Bám adapter pattern đã có** | Nguồn mới = 1 module `src/lib/<tên>.ts` + golden signature + retry/backoff + `markSource` — không phát minh luồng thứ 2 |
| **N2** | **No-fabrication tuyệt đối** | Chuỗi chưa có → khai báo trong khối "CÒN THIẾU"; số liệu trích từ tin phải kèm URL nguồn + mode `extracted`; không bao giờ điền proxy vào chỗ của số thật |
| **N3** | **Mọi thay đổi não phải qua sweep gate** | Đổi feature set / trọng số / kiến trúc MLP → ứng viên trong sweep Chủ nhật + paired-bootstrap Brier CI — **điều kiện tiên quyết: F-00 vận hành hoá vòng Chủ nhật (hiện `SweepRun` 0 dòng — gate chưa từng chạy đủ 1 vòng thật)** |
| **N4** | **Point-in-time khi đưa dữ liệu vào vòng học** | Feature tại phiên t chỉ được dùng dữ liệu có `releaseAt/asOf ≤ t` — chống look-ahead bias (nguy hiểm nhất với chuỗi vĩ mô chậm công bố) |
| **N5** | **1 nguồn sự thật mỗi loại đơn vị** | Dùng bảng `UNIT_SPECS` (market×type) sẵn có; chuỗi vĩ mô mới khai báo đơn vị ngay trong model, không heuristic rải rác |
| **N6** | **Trung thực số liệu phục vụ UI** | Mọi chuỗi mới lộ diện qua `DataSourceStatus` (mode + stale + lastError) — footer/matrix độ phủ tự hiển thị đúng |

---

## 1. Baseline kiến trúc — điểm neo gắn chức năng (đo trực tiếp DB 17/10/2026)

**Đường dữ liệu (đang hoạt động):**

- **225.644 bar** tổng kho: 90 instrument giá VN (HOSE/HNX/UPCOM × STOCK/ETF + 8 INDEX — dchart S7, 2013→nay, sync 15:45 ICT) + 22 mã US/HK + **14 instrument vĩ mô #126** (US5Y/US10Y/US30Y Treasury CSV · EURUSD/USDJPY/AUDUSD Frankfurter · VND=X er-api+Yahoo · DXY + GC/CL/BZ/SI/HG/NG Yahoo query2) — sync 06:15 ICT.
- 5 feed RSS VN — **908 tin** (crawler 15 phút). `FinancialFundamental` **0 dòng** (S10 pending-egress) · `CorporateEvent` **2 dòng** · `ForeignFlow` **768 dòng toàn mode=simulated**.
- `DecisionEvaluation` **48** · `AuditLog` ~1.000 · RAG ~700 docs.

**Bộ não (3 kênh học tách bạch) — đo từ `MlModel` registry:**

- **MLP serving v8: kiến trúc 10-16-8-3, đầu vào 10 chiều (feature set v1 — x[0..9]), valAcc 39,42% trên 60.000 mẫu/20 mã, train đến 2026-10-08, z-norm lưu trong `featureNorm`.** Feature contract mới nhất của code là `v2-lag16` (16 chiều) nhưng **chưa từng có champion nào thắng v8 để lên serving** (tổng 19 version dl-mlp, v9→v19 đều archived).
- Ensemble: trọng số **hardcoded** `ENSEMBLE_WEIGHTS = {mlp:0,7, linreg:0,3}` (src/lib/ml/ensemble.ts:53). **GRU: code + shadow + cổng Brier + kill-switch hoàn chỉnh nhưng `AppSetting "ml-gru"` chưa từng tồn tại → giọng thứ 3 chưa bao giờ được bật** (2 giọng đang dùng).
- Bandit Thompson: **8 hàng trong DB** (7 arm chính thức + 1 arm mồ côi `portfolio-strategist` pulls=0 — hygiene, xem F-15); pulls 27–28/arm; `ml-forecast` posterior **0,647** (dẫn đầu hội đồng); `macro-economist` **0 pulls** (cold-start Beta(1,1), #126); settle 16:15 quét 30 phiếu.
- Q-learning rl-q v13 (48 trạng thái × 3 hành động) · RAG BM25 (tokenizer Việt bỏ dấu) · XREL lead-lag trong nước only.

**Hội đồng:** 24 agents (A20 macro-economist — cử tri thứ 7) · cổng đồng thuận 80% · D-LEDGER chấm cả tín hiệu bị bác · tổng hợp Bayes 50 bằng chứng.

**Scheduler market-engine:** tick 10s · news 15' · eod-sync 15:45 · intl-sync 06:15 · settle 16:15 · k1-equity 16:30 · council-eval 16:45 · **ml-train SUN:04:00 · ml-sweep SUN:04:15 — hai slot này CHƯA NGHIỆM THU TỰ CHẠY (xem F-00)** · reprobe SUN:04:00 · agent-cycle (mặc định TẮT).

> **⚠️ Phát hiện vận hành quan trọng (đo 17/10):** bảng `SweepRun` **0 dòng** dù route sweep có persist đầy đủ (sweep.ts:709) → pipeline sweep chưa từng chạy đủ 1 vòng qua lối chính; toàn bộ 19 version MLP mang timestamp **thủ công** (v8 thứ Năm 00:07 ICT · cụm v14–v18 và v19 đêm CN lệch lịch 04:00/04:15). Kết luận: **vòng tự học Chủ nhật là cơ sở hạ tầng sẵn sàng nhưng chưa vận hành bền** — mọi thay đổi não "theo sweep gate" (F-01/F-07/F-09) phụ thuộc điều kiện tiên quyết F-00.

---

## 1.5. Nhật ký hiệu đính v2 → v3 (lỗi tìm thấy khi review lại)

| # | Lỗi/vấn đề trong v2 | Bằng chứng đo | Sửa trong v3 |
|---|---|---|---|
| E1 | §1 viết "MLP 10-16-8-3, feature set v2-lag16" | `MlModel v8 meta.featureCount = 10` — serving đọc 10 chiều v1; v2-lag16 chưa thắng cổng | §1 sửa + làm nổi: **não serving chỉ nhìn 10 chiều kỹ thuật giá** — P0-1 nặng hơn đã ghi trước đó |
| E2 | Ngụ ý sweep/train Chủ nhật chạy bền | `SweepRun` 0 dòng · 19 version timestamp thủ công · `AppSetting ml-sweep/ml-gru` chưa từng tồn tại | Thêm **F-00** (điều kiện tiên quyết P0) + cảnh báo §1 + N3 ghi chú |
| E3 | F-01 viết "MLP 10-24-8-3" | Notation sai (10 là chiều vào cũ) | Sửa "24-16-8-3 (hidden do sweep chọn)" |
| E4 | F-07 viết "persist vào BanditEvent.meta" như thể cột có sẵn | Schema `BanditEvent` chỉ có confidence — **không có meta** | F-07 ghi rõ: thêm cột `meta String @default("{}")` (db push migration nhỏ) |
| E5 | F-03 nêu endpoint finfo `/v4/foreigns` như xác thực | Sandbox chặn egress — endpoint **chưa từng được probe** | F-03 đổi: "endpoint dự kiến, phải xác thực khi có egress (như bài học `normalizePrice` heuristic S8)" |
| E6 | F-14 viết Monte Carlo như thiết kế lần đầu | `RiskQuantSnapshot` **đã có** `mcLoss5Pct`/`mcPDd` (MC bootstrap vô điều kiện, engine hiện có) | F-14 đổi vai trò: **mở rộng** MC có sẵn bằng factor-beta + kịch bản đặt tên — không build đúp |
| E7 | F-02 snippet schema thiếu `superseded`/`meta` dù text nhắc | Đối chiếu snippet ↔ text Pha A | Bổ sung 2 trường vào snippet |
| E8 | F-06 viết "kiểm tra CorporateEventKind" mơ hồ | Enum thực: SPLIT/BONUS/DIVIDEND/RESTATE | F-06 ghi rõ: **thêm enum value** EARNINGS/AGM/DIVIDEND_RECORD (db push) + dùng `status="scheduled"` |
| E9 | Số liệu cũ: ForeignFlow 754 · tin "830+" | Đo 17/10: **768** · **908** | §1 cập nhật |
| E10 | Bỏ sót kỳ vọng "trái phiếu" của chủ sở hữu | Kỳ vọng nguyên văn: "…cổ phiếu, trái phiếu" — không chức năng nào dự báo lợi suất trái phiếu | Thêm **F-17** + bảng đối chiếu §4 |
| E11 | §5 (v2) liệt kê GRU shadow như "đang đúng — giữ nguyên" | GRU chưa từng bật (ml-gru setting chưa tồn tại) | §7 giữ nguyên tắc "không nhận máy mù" nhưng ghi rõ: cần **kích hoạt shadow sớm** (0 rủi ro) |

---

## 2. Ma trận chuyển đổi: phát hiện → chức năng kỹ thuật

| # | Phát hiện (kinh tế học / review / review-v3) | Chức năng | Ưu tiên | Nhóm |
|---|---|---|---|---|
| 1 | Vòng tự học Chủ nhật chưa vận hành bền — mọi sweep gate là lý thuyết | **F-00** Vận hành hoá + giám sát vòng tự học | 🔴 P0-prereq | A |
| 2 | Não serving chỉ nhìn 10 chiều kỹ thuật giá; 14 instrument vĩ mô chưa vào vòng học | **F-01** Feature v3-macro 16→24 | 🔴 P0 | A |
| 3 | Lớp 2 (vĩ mô nội địa) thiếu toàn bộ chuỗi CPI/GDP/SBV/tín dụng/M2/PMI/TPCP | **F-02** MacroSeries VN + trích xuất LLM có trích dẫn | 🔴 P0 | A |
| 4 | ForeignFlow 768 dòng chỉ vào prompt (silo) | **F-03** Flow thật + đặc trưng | 🔴 P0 | A |
| 5 | Sentiment lexicon chỉ dùng XREL, không vào MLP | **F-04** Chuỗi sentiment hằng ngày | 🔴 P0 | A |
| 6 | FinancialFundamental 0 dòng | **F-05** Fundamentals → kênh chậm | 🟠 P1 | A |
| 7 | CorporateEvent 2 dòng — lịch gần trống | **F-06** Lịch sự kiện + blackout | 🟡 P2 | A |
| 8 | Trọng số ensemble hardcoded | **F-07** Meta-learner từ D-LEDGER | 🔴 P0 | B |
| 9 | Cạnh biên mỏng, chưa calibration/per-class | **F-08** Isotonic + báo cáo hiệu chuẩn | 🟠 P1 | B |
| 10 | 1 chân trời, chỉ hướng | **F-09** Đa nhiệm hướng+biên+vol | 🟠 P1 | B |
| 11 | XREL bỏ kênh US→VN | **F-10** XREL quốc tế căn giờ | 🟠 P1 | B |
| 12 | Bias sống sót rổ top-10 | **F-11** Universe point-in-time | 🟠 P1 | B |
| 13 | RAG BM25 thuần từ khoá | **F-12** Từ điển đồng nghĩa + hybrid (tuỳ chọn) | 🟡 P2 | B |
| 14 | **Kỳ vọng "trái phiếu" không có chức năng dự báo nào** (khoảng trống kỳ vọng — E10) | **F-17** Multi-asset forecast (bond/FX/hàng hoá) | 🟠 P1 | B |
| 15 | Q-table thô, bandit không ngữ cảnh | **F-13** Regime + contextual bandit | 🟡 P2 | C |
| 16 | Thiếu VaR kịch bản có tên | **F-14** Factor-beta MC + stress scenarios | 🟡 P2 | C |
| 17 | Bandit 28 pulls + `SETTLE_SCAN_LIMIT=30` + arm mồ côi | **F-15** Backlog settle + Wilson CI + dọn arm | 🟡 P2 | C |
| 18 | Chuỗi vĩ mô: chậm công bố/đa đơn vị/sửa hồi cứu | **F-16** Q10–Q13 + lịch công bố | 🟡 P2 | D |

---

## 3. Đặc tả chức năng kỹ thuật

Quy ước: **Nguồn gốc → Chức năng → Thiết kế → File → Prisma/API/Job → Gate nghiệm thu → Phụ thuộc**.

---

### NHÓM A — Đưa dữ liệu kinh tế vào não (đường dữ liệu · P0)

#### F-00 · Vận hành hoá + giám sát vòng tự học Chủ nhật (điều kiện tiên quyết)

**Nguồn gốc:** phát hiện E2 của review v3 — `SweepRun` 0 dòng · AppSetting `ml-sweep`/`ml-gru` chưa từng khởi tạo · 19 version MLP đều timestamp thủ công (v8: thứ Năm 00:07 ICT; v14–v19: đêm CN lệch lịch 04:00/04:15). Cơ sở hạ tầng sweep/championGate **có đầy đủ trong code nhưng chưa từng chạy đủ 1 vòng qua lối chính**. Không có F-00 thì mọi gate "theo sweep" của F-01/F-07/F-09 là lý thuyết.

**Chức năng:** biến 2 slot Chủ nhật (ml-train 04:00 · ml-sweep 04:15) thành vòng tự chạy **đo được, giám sát được, cảnh báo được khi bị bỏ lỡ**.

**Thiết kế:**

1. **Audit mỗi lần chạy:** route `/api/ml/train` + `/api/ml/sweep` khi được engine gọi ghi `AuditLog` action `ML_TRAIN_AUTO` / `ML_SWEEP_AUTO` (kèm outcome: trained/skipped-no-new-window/failed) — phân biệt với gọi tay (action hiện có `LLM_MODEL_SET` pattern). Train bị skip-guard chặn (windowHash không đổi) vẫn phải để lại 1 dòng audit "skipped" — im lặng là lỗi giám sát.
2. **Catch-up lúc boot:** engine đã có pattern "boot catch-up" cho eod-sync — áp cùng cho ml-train/ml-sweep: nếu slot Chủ nhật vừa trôi qua < 24h mà chưa có audit tương ứng → chạy bù 1 lần khi engine khởi động (không phát sinh 2 lần nhờ audit check).
3. **Cảnh báo bỏ lỡ:** job `GET /api/system/status` thêm check "ml-cycle-health": quá 8 ngày không có audit ML_TRAIN_AUTO → `RiskAlert` WARNING `ML_CYCLE_STALLED` (dedupe 7 ngày, cùng khuôn `DATA_SOURCE_STALE`).
4. **Khởi tạo setting:** lần chạy đầu tự `upsert` AppSetting `ml-sweep` (enabled) + `ml-gru` (enabled=false, shadow-only) — để UI tuning tab và kill-switch hoạt động đúng trạng thái thật thay vì default ngầm.
5. **Kích hoạt GRU shadow-only ngay** (0 rủi ro — chỉ log phiếu, không lên giọng): qua tuning route có sẵn `readGruSetting/writeGruSetting`. Shadow bắt đầu tích luỹ 60 phiên → cổng Brier có dữ liệu thật thay vì cơ chế chưa từng thử.

**File:** sửa `src/app/api/ml/train/route.ts` + `src/app/api/ml/sweep/route.ts` (audit) · `mini-services/market-engine/index.ts` (boot catch-up) · `src/lib/health.ts` (check ml-cycle-health).

**Gate nghiệm thu:** 2 Chủ nhật liên tiếp có audit `ML_TRAIN_AUTO` + dòng `SweepRun` mới (status done/failed đều tính — minh bạch); `GET /api/system/status` hiển thị sức khoẻ vòng ML; GRU shadow log có ≥ 1 phiếu pending.

**Phụ thuộc:** không phụ thuộc ai — **mọi chức năng nhóm B dùng sweep gate đều phụ thuộc F-00.**

---

#### F-01 · Feature set v3-macro — "cho não nhìn kinh tế" (16 → 24 chiều)

**Nguồn gốc:** P0-1 + E1: serving v8 chỉ đọc 10 chiều kỹ thuật giá; 14 instrument vĩ mô lớp 1 đã sync thật #126 nhưng mới vào prompt A20.

**Chức năng:** mở rộng vector đặc trưng MLP thêm **8 chiều vĩ mô/định lượng** dùng đúng dữ liệu đang nằm trong `Bar`:

```
x[16] dus10y_20   = (US10Y(t̄) − US10Y(t̄−20)) / 100        — Δ lợi suất 10Y 20 phiên (bar BOND_PCT×100 → cb)
x[17] slope_10y5y = (US10Y(t̄) − US5Y(t̄)) / 100            — độ dốc đường cong (nghịch = lo ngại tăng trưởng)
x[18] dxy_mom_20  = DXY(t̄)/DXY(t̄−20) − 1                  — động lượng đô la (ratio — đơn vị tự triệt tiêu)
x[19] vnd_mom_20  = VNDX(t̄)/VNDX(t̄−20) − 1               — sức ép tỷ giá (mất giá = dương)
x[20] cmdty_mom_20= trung bình MOM20 của GC=F, CL=F, BZ=F  — chu kỳ hàng hoá
x[21] breadth_20  = tỷ lệ mã HOSE có close > SMA20         — độ rộng thị trường nội địa
x[22] flow_20     = Σ ForeignFlow.netValue(20p) / Σ ADTV(20p)  — dòng khối ngoại chuẩn hoá (F-03)
x[23] sent_7      = điểm sentiment lexicon 7 ngày gần nhất (F-04)
```

**Quy tắc căn chỉnh point-in-time (N4 — quan trọng nhất):** với mẫu tại phiên VN `t`, mọi đại lượng vĩ mô quốc tế dùng **bar cuối có `date < Bar[t].date`** (hàm `alignMacroBefore(vnDate)` — bar US ngày d đóng 04:00 ICT trước mở cửa VN 09:00 ngày d+1 nên luôn "đã biết"). Breadth/flow/sentiment dùng chính ngày t. Thiếu chuỗi → chiều đó = 0 (trung tính) + đếm `macroDimsMissing` — không bỏ mẫu, không bịa. Scale khác nhau giữa các chiều không cần chuẩn hoá tay: MLP có z-norm trong `featureNorm` (tính lại khi train).

**Thiết kế:**

1. `src/lib/ml/features.ts`: `ML_FEATURE_SET = "v3-macro"` song song `v2-lag16`; `featureAt(r, t, macro?)` nhận `MacroContext` (8 giá trị căn chỉnh) — mặc định null → trả đúng vector cũ (tương thích ngược 100% cho serving v8).
2. Loader `loadMacroContexts(dates)`: 1 truy vấn cho 8 mã macro + breadth (tái dùng logic `buildMacroInner`) + ForeignFlow + sentiment daily (F-04) → `Map<dateString, MacroContext>`; cache theo FeatureCache hiện có.
3. `buildTrainingSet` nối MacroContext — cùng seed cố định; MLP mới **24-16-8-3** (hidden do sweep chọn trong grid arch có sẵn của SweepRun).
4. Sweep: thêm field `featureSet: "v2-lag16" | "v3-macro"` vào SweepHyper — bảng `SweepRun.featureSet` đã thiết kế sẵn cho việc này ("sẵn cho v3-news22 tương lai" — comment schema).

**Gate nghiệm thu:** v3-macro chỉ lên serving khi `ΔBrier CI 95%` hướng tốt so v2-lag16 qua ≥ 2 chu kỳ sweep **(F-00 phải đã vận hành)**; không thắng → giữ cũ + ghi `whyRejected` trong champion log (trung thực kiểu 39,42%).

**Phụ thuộc:** F-00 (gate thật) · F-03/F-04 cho x[22]/x[23] (có thể chạy 6/8 chiều trước, 2 chiều còn =0).

---

#### F-02 · Pipeline chuỗi vĩ mô nội địa VN — MacroSeries (lớp 2 của khung top-down)

**Nguồn gốc:** khối "CÒN THIẾU" trong prompt A20: *"kho dữ liệu CHƯA có chuỗi định lượng nội địa: CPI · GDP · lãi suất điều hành SBV · tín dụng · M2 · PMI · lợi suất TPCP VN · lãi liên ngân hàng · XNK · FDI"*.

**Chức năng:** đưa 10 chuỗi nội địa vào DB theo model riêng (chu kỳ tháng/quý ≠ nhịp phiên, cần metadata công bố), thay dần khối "CÒN THIẾU" bằng số liệu thật.

**Prisma (model mới):**

```prisma
model MacroSeries {
  id        String   @id @default(cuid())
  key       String   @unique          // CPI_YOY | GDP_YOY | SBV_REFI_RATE | CREDIT_YOY | M2_YOY |
                                          // PMI_MANU | VNGB_10Y | INTERBANK_OVN | TRADE_BAL | FDI_DISB
  name      String
  unit      String                    // "%" | "tỷ VND" | "lần" — nguồn sự thật đơn vị (N5)
  frequency String                    // monthly | quarterly | irregular
  source    String                    // gso | sbv | news-extract | manual-csv
  meta      String   @default("{}")   // JSON: releaseLagDays, note — lịch công bố Q13/F-16
  latestObservedAt DateTime?
}

model MacroObservation {
  id          String   @id @default(cuid())
  seriesId    String
  series      MacroSeries @relation(fields: [seriesId], references: [id], onDelete: Cascade)
  periodLabel String                   // "2026-09" | "Q3-2026" | "2026-10-24"
  periodStart DateTime
  value       Float
  releaseAt   DateTime                 // N4: feature/prompt chỉ dùng khi releaseAt ≤ asOf
  mode        String                   // real | extracted | manual
  superseded  Boolean  @default(false) // kỳ có bản real → bản extracted cũ chuyển true
  sourceUrl   String?                  // bắt buộc khi mode=extracted
  quoteVerbatim String?                // câu gốc chứa con số — chống bịa (N2)
  createdAt   DateTime @default(now())

  @@unique([seriesId, periodLabel])
  @@index([seriesId, periodStart])
}
```

**Thiết kế — 3 pha theo độ sẵn sàng nguồn:**

- **Pha A — Trích xuất có trích dẫn từ RSS (làm được NGAY):** job `extractMacroFromNews()` sau crawler news: 30 tin `category=macro` chưa xử lý → 1 lời gọi LLM (`src/lib/llm.ts`) hợp đồng JSON chặt: chỉ trích chuỗi + kỳ + con số **nguyên văn trong bài** + câu chứa số; từ chối nếu mơ hồ. Ghi `MacroObservation` mode=`extracted` + `sourceUrl` + `quoteVerbatim`. Dedupe `(seriesId, periodLabel)`; trùng kỳ khác số → bản real/manual thắng, extracted kia `superseded=true`. Guard N2: không suy ra, không nội suy, không quy đổi.
- **Pha B — Adapter nguồn chính thức (khi có egress, khuôn N1):** `src/lib/macro-vn.ts` — 3 adapter fail-soft: GSO/TCTK (CPI/PPI/XNK) · SBV (biểu lãi suất điều hành) · TPCP VN 10Y. Golden signature + throttle 500ms + retry 2 lần + `markSource` — clone kỷ luật `multi-market-sync.ts`.
- **Pha C — Nhập tay lịch sử:** route CSV 10 series (2–5 năm) — `periodStart/releaseAt` chuẩn hoá theo lag công bố khai trong `MacroSeries.meta`.

**API/Job:** `GET /api/macro/series` (bảng điều khiển + Δ kỳ trước + mode + stale + kỳ release kế) · `POST /api/macro/ingest` (cooldown 60s, audit `MACRO_INGESTED`) · scheduler slot **`MACRO_VN_AT` = 06:35 ICT** hằng ngày (sau intl-sync, trước open VN) Pha A; Chủ nhật Pha B · `DataSourceStatus` key `macro-vn` mode `real|extracted|pending`.

**Tiêu thụ:** `buildMacroBlock()` thay khối "CÒN THIẾU": series CÓ dữ liệu hiển thị `giá trị + Δ + kỳ + [nguồn]`; list series còn thiếu sinh động từ DB.

**Gate nghiệm thu:** (1) 1 kỳ CPI xuất hiện → prompt hiển thị đúng số + URL; (2) ép prompt trích sai → guard từ chối/`quoteVerbatim` rỗng → không ghi; (3) `releaseAt` không bao giờ ở tương lai so kỳ (N4).

---

#### F-03 · Dòng khối ngoại thật + đặc trưng flow (chống silo)

**Nguồn gốc:** P0-2 — ForeignFlow 768 dòng (toàn simulated) mới vào `flowsBlock` prompt; chưa thành feature hay bằng chứng Bayes.

**Chức năng:** (a) nguồn thật khi egress mở; (b) **quan trọng hơn**: chiều x[22] của MLP + evidence Bayes.

**Thiết kế:**

1. `src/lib/foreign-flow-live.ts` (Pha B — pending egress): **endpoint khối ngoại finfo chưa được xác thực từ sandbox** (bài học `normalizePrice` heuristic S8 — phải đối chiếu khi có egress thật); khuôn parse theo envelope `vndirect.ts`, throttle 500ms, fail-soft về simulator hiện tại (mode khai báo — không gián đoạn chu kỳ). Upsert `ForeignFlow @@unique([instrumentId, date])`, mode=`live`.
2. Scheduler `FLOW_SYNC_AT` = **16:05 ICT** (sau eod-sync 15:45 — khớp `Bar` cùng ngày).
3. Đặc trưng `flow_20` mỗi mã + bản tổng thị trường trong `loadMacroContexts`; clip ±3.
4. Bayes evidence `foreign-flow-trend` (3 mức theo z 20 phiên), weight 0,3 — cùng khuôn `bayes/evidence.ts`.
5. Giữ RiskAlert `FOREIGN_FLOW_OUTFLOW` (−300 tỷ, dedupe 24h).

**Gate nghiệm thu:** ngày có data live → ForeignFlow mode=`live` trùng ngày Bar cuối; x[22] ≠ 0; nguồn chết → mode fallback + chu kỳ agents sống sót.

**Phụ thuộc:** F-01 tiêu thụ; Pha A tính x[22] từ 768 dòng hiện có (mode khai báo simulated).

---

#### F-04 · Chuỗi sentiment hằng ngày → đặc trưng

**Nguồn gốc:** P0-2 (nửa sau) — lexicon sentiment chỉ phục vụ XREL/Bayes; phân tích kinh tế: cảm xúc tin tức là biến "nhanh" hiếm hoi của lớp 2 khi chuỗi chậm chưa có.

**Chức năng:** tổng hợp điểm sentiment lexicon mọi NewsItem 7 ngày → chuỗi `sent_7` (−1..+1) → x[23] + dashboard.

**Thiết kế:** job trong settle 16:15; `AppSetting` key `news-sentiment-daily` rolling 90 ngày `{date, score, n}`; trung bình trọng số tuyến tính theo độ tươi (hôm nay ×1,0 → 6 ngày ×0,4); n<5 → co về 0 (trung thực).

**File:** sửa `src/lib/quant/sentiment.ts` (thêm `dailySentimentSeries`) · tiêu thụ trong `loadMacroContexts`.

**Gate nghiệm thu:** sent_7 đổi dấu đúng ngày có cụm tin mạnh (kiểm chứng 1 sự kiện đã biết); ngày nghỉ n=0 → 0.

---

#### F-05 · Fundamentals → kênh đặc trưng chậm (post-egress)

**Nguồn gốc:** FinancialFundamental 0 dòng — adapter `fundamentals.ts` hoàn chỉnh, chỉ chờ egress (S10).

**Chức năng:** khi S10 sáng: thêm 3 chiều kênh chậm vào sweep kế tiếp (`v4-fundamental`): P/E z theo ngành · EPS yoy · ΔBVPS. **Không trộn vào v3-macro** — nguyên tắc đổi 1 nhóm biến / 1 chu kỳ sweep.

**Gate nghiệm thu:** đối chiếu T11.3 (P/E VCB ±5%) trước khi vào feature; sweep thắng mới lên serving.

**Phụ thuộc:** egress; F-01 đã chạy ≥ 1 tháng để tách ảnh hưởng.

---

#### F-06 · Lịch CorporateEvent → đặc trưng + quy tắc blackout

**Nguồn gốc:** CorporateEvent 2 dòng — gần trống; kỳ công bố kết quả/cổ tức là sự kiện định kỳ hàm thông tin cao.

**Chức năng:** (a) nạp lịch tương lai (cổ tức cuối sổ · ĐHĐCĐ · công bố kết quả) bằng RSS CafeF + trích xuất LLM có trích dẫn (dùng lại hợp đồng F-02 — chia sẻ module); (b) đặc trưng `days_to_event` (dummy ≤ 3 phiên); (c) exec: tín hiệu BUY mã có event ≤ 2 phiên tới → cờ `event_blackout` trong ô Chờ duyệt (UI hiện lý do — người phê duyệt quyết, không chặn cứng).

**Prisma:** enum `CorporateEventKind` hiện chỉ có `SPLIT/BONUS/DIVIDEND/RESTATE` → **thêm value** `EARNINGS/AGM/DIVIDEND_RECORD` (db push); lịch tương lai dùng `ratio=0`, `status="scheduled"`, `source="news-extract"`, `detail` JSON chứa title/URL.

**Gate nghiệm thu:** 1 mã có lịch cổ tức → ô tín hiệu hiện cờ blackout; event qua ngày → cờ tự hết.

---

### NHÓM B — Não mạnh hơn (chất lượng dự báo · P0/P1)

#### F-07 · Học trọng số ensemble — meta-learner từ D-LEDGER

**Nguồn gốc:** P0-3 — `ENSEMBLE_WEIGHTS` hardcoded 0,7/0,3 (0,5/0,3/0,2 GRU): Bandit học uy tín 7 cử tri nhưng tỉ lệ giọng nói trong `ml-forecast` không bao giờ được học.

**Chức năng:** thay trọng số cố định bằng **meta-learner tuyến tính học từ chính D-LEDGER**.

**Thiết kế:**

1. **Migration nhỏ:** `BanditEvent` hiện KHÔNG có cột meta → thêm `meta String @default("{}")` (db push) — từ giờ mỗi phiếu ml-forecast ghi kèm vector giọng nói `{pUp−pDown, tanh(z), gru?}` tại thời điểm cast.
2. Module `src/lib/ml/ensemble-learn.ts`: với mỗi phiếu đã settle, lấy vector giọng nói + nhãn hướng realized 5 phiên (settle logic có sẵn) → logistic softmax 3 lớp trên 2–3 giọng; ridge λ=0,5; walk-forward 70/30 theo thời gian; lưu `AppSetting "ml-ensemble-weights"` `{source:"learned", wMlp, wLinreg, wGru, nVotes, valBrier, trainedAt}`.
3. `mlForecastEnsemble()`: **chưa đủ 60 phiếu settle → dùng hardcode** (cold-start giữ nguyên); đủ → chỉ bật khi valBrier learned thắng fixed quá deadband 0,05·Brier; ngược lại giữ + `whyRejected`.
4. Train gắn vào job sweep Chủ nhật (sau sweep 5 phút) — **phụ thuộc F-00**.
5. Công khai: `/api/ml/architecture` thêm `weightsSource: "fixed"|"learned"` + bảng so sánh; tab Mạng thần kinh (`src/components/dashboard/ml/nn-tab.tsx`) hiển thị nguồn trọng số.

**Gate nghiệm thu:** ≥ 60 phiếu + valBrier learned < fixed − 0,005 → serving chuyển learned; kill-switch xoá AppSetting (fallback fixed tức thì); mỗi lần đổi ghi `AuditLog ML_WEIGHTS_SWITCHED` before/after.

**Phụ thuộc:** F-00 · migration BanditEvent · 4 tuần tích luỹ phiếu có meta.

---

#### F-08 · Calibration xác suất + báo cáo per-class

**Nguồn gốc:** P1-1 — valAcc 39,42% cạnh biên +6,4đ; điểm `pUp−pDown` có thể tự tin sai; chưa log per-class/Brier cho serving.

**Chức năng:** (a) `ml/analytics.ts` log per-class acc + Brier + reliability bin 10 mức (MLP/GRU/linreg) — hiển thị tab Dữ liệu ML; (b) lớp isotonic calibration trên xác suất MLP trước khi vào điểm ensemble.

**Thiết kế:** fit isotonic trên tập validation lần train cuối (≥ 60 điểm/class, không đủ → identity); persist `MlModel.meta.calibration` (registry versioned); áp trong `mlForecastEnsemble` sau forward. GRU Brier gate dùng xác suất ĐÃ calibration.

**Gate nghiệm thu:** reliability curve trước/sau hiển thị UI; ECE giảm ≥ 20% tương đối trên holdout thì giữ — không thì `whyRejected` + tắt.

---

#### F-09 · Đầu ra đa nhiệm: hướng + biên độ + biến động

**Nguồn gốc:** P1-2 — chỉ 1 chân trời 5 phiên, chỉ hướng; kỳ vọng "biến động tài chính" cần đo độ lớn.

**Chức năng:** backbone dùng chung, **3 đầu ra**: hướng 3 lớp · |ret| 5 phiên kỳ vọng (regression, tanh×scale) · realized vol 5 phiên tới. Loss = CE + 0,3·MSE_mag + 0,3·MSE_vol.

**Thiết kế:** `labelRichAt` (giữ `labelAt` cũ cho sweep v2); MLP backbone `in→h1→h2` rẽ 3 head (dir 8-3 · mag 4-1 · vol 4-1) — tham số `task: "direction"|"multitask"` trong SweepHyper; sweep quyết định lên serving. Tiêu thụ: σ̂ → sizing (`risk/sizing.ts` nhân 1/σ̂ — sizing theo biến động dự báo); biên độ → ngôn ngữ prompt A20.

**Gate nghiệm thu:** ≥ 2 chu kỳ sweep; MAE vol tốt hơn baseline "vol20 lịch sử" ≥ 10% mới bật kênh sizing.

---

#### F-10 · XREL quốc tế — kênh truyền US/HK → VN có chỉnh múi giờ

**Nguồn gốc:** P1-3 — `refreshRelations` chỉ trong nước dù 22 mã US/HK + 14 vĩ mô đã sync 06:15; kênh "đêm Mỹ → sáng VN" là đường truyền lân cận mạnh nhất.

**Chức năng:** tính lead-lag quốc tế → VN với quy tắc canh giờ tường minh; đưa vào prompt XREL + bảng truyền dẫn lớp 3 của A20.

**Thiết kế:**

1. `src/lib/ml/xrel.ts` mở rộng: cặp {(^GSPC, ^IXIC, DX-Y.NYB, GC=F, CL=F, ^HSI, 0700.HK) × (VNINDEX, VN30, top-3 ngành HOSE)}; lag 0, 1, 2.
2. **Căn giờ (N4):** US(d) đóng 04:00 ICT d+1 trước open VN 09:00 d+1 → US(d) ghép VN(d+1) là "lag 0 = đêm Mỹ tối qua → sáng VN nay"; HK đóng 17:00 ICT **sau** close VN 15:00 cùng ngày → HK chỉ dùng lag ≥ 1. Ngày lễ lệch → bỏ cặp, tối thiểu 120 cặp ngày chung mới tính (`overlapDays`).
3. Thống kê: Pearson r theo lag + permutation p (200 lần xáo) + Bonferroni theo số cặp×lag; giữ |r| ≥ 0,25 & p ≤ 0,05.
4. Tiêu thụ: `buildXrelPromptBlock()` mục "Kênh quốc tế" (3 dòng top + diễn giải chiều); `buildMacroInner` bảng truyền dẫn lớp 3.
5. Tính lại trong `maybeRefreshIfStale` (stale 24h hiện có) — thêm 30 phút sau intl-sync.

**Gate nghiệm thu:** ≥ 3 cặp đáng tin đúng chiều kinh tế (vd ^GSPC lag-1 → VNINDEX r>0); prompt A20 nhắc đúng chiều; thiếu mẫu → khai báo "chưa đủ dữ liệu quốc tế" (N2).

---

#### F-11 · Universe point-in-time — chống bias sống sót

**Nguồn gốc:** P1-6 — `loadTopSeries(10)` chọn rổ theo ADTV **hiện tại** cho toàn bộ train 2013→nay.

**Chức năng:** mọi phép tính lịch sử (train · Q-learning · backtest · sweep) chọn rổ theo thanh khoản **tại thời điểm lấy mẫu**.

**Thiết kế:**

1. `pointInTimeBasket(date, n)` trong `features.ts`: top-n theo `Σ Bar.value` cửa sổ 45 phiên **kết thúc trước date** — index `[instrumentId, date]` sẵn có.
2. `buildTrainingSet` duyệt theo ngày, tra basket mỗi ~20 phiên (cache theo tuần — ~700 → ~35 truy vấn/chu kỳ); sweep dùng cùng loader (1 đường tính).
3. `loadTopSeries` (rổ hiện tại) giữ cho **serving forward** — đúng ngữ cảnh hôm nay.
4. Metric sweep có thể giảm nhẹ sau sửa (số thật hơn) — ghi chú ML_OPS để không hiểu lầm là regression.

**Gate nghiệm thu:** script `scripts/pit-verify.ts`: basket 2015 chứa mã top thanh khoản thời đó (khác top hiện tại ≥ 2 mã); số mẫu giảm ≤ 15%.

---

#### F-12 · RAG từ điển đồng nghĩa vĩ mô + hybrid embedding (tuỳ chọn)

**Nguồn gốc:** P1-5 — BM25 tokenizer Việt bỏ dấu: "lạm phát" không trúng "CPI".

**Chức năng:** (a) **từ điển mở rộng truy vấn** (ngay, chi phí 0): lạm phát↔CPI↔inflation · lãi suất↔rate↔SBV · tín dụng↔credit · tăng trưởng↔GDP · tỷ giá↔FX↔VND=X · trái phiếu↔bond↔TPCP · thanh khoản↔liquidity… — expand query trước khi chấm BM25; (b) khung `EmbeddingProvider` tùy chọn (default OFF): điểm hybrid 0,5·BM25norm + 0,5·cosine, embedding cache trong bảng RAG doc hiện có.

**File:** sửa `src/lib/ml/rag.ts` (MACRO_SYNONYMS + query expansion + interface provider).

**Gate nghiệm thu:** truy vấn "lạm phát" trúng ≥ 1 doc chứa "CPI" (retrieval log UI có sẵn); retrieval@8 tăng trên 20 truy vấn chuẩn.

---

#### F-17 · Multi-asset forecast — đóng kỳ vọng "trái phiếu" (bổ sung v3 — E10)

**Nguồn gốc:** kỳ vọng nguyên văn của chủ sở hữu: *"…phán đoán nền kinh tế, biến động tài chính, cổ phiếu, **trái phiếu**"* — review v2 chỉ đưa lợi suất Treasury vào làm **đặc trưng đầu vào** (x[16]/x[17]) chứ không có chức năng **dự báo** cho chính tài sản trái phiếu/FX/hàng hoá. Khoảng trống duy nhất không được phủ bởi F-01→F-16.

**Chức năng:** mô hình dự báo thứ hai (family `dl-mlp` mới — `kind: "macro-mlp"`) cho 8 tài sản vĩ mô: **VNINDEX · VN30 · US10Y · US30Y · DXY · VND=X · GC=F · CL=F** — dự báo hướng 5 phiên cho TỪNG tài sản, trở thành giọng nói định lượng mới của hội đồng và khối "truyền dẫn lớp 3" của A20.

**Thiết kế:**

1. **Ngưỡng nhãn theo lớp tài sản** (khác cổ phiếu ±0,5%): INDEX VN ±0,7% · US10Y/US30Y ±12 cb (bar BOND_PCT×100 → ngưỡng theo đơn vị scaled 12) · DXY ±0,8% · VND=X ±0,3% · hàng hoá ±1,5% — khai báo trong bảng `ASSET_LABEL_SPEC` (N5: 1 nguồn sự thật, comment schema như UNIT_SPECS).
2. Đặc trưng mỗi tài sản: vệt giá riêng (RSI/SMAs/logret — tái dùng `featureAt` 10 chiều v1) + 4 chiều bối cảnh chung (ΔUS10Y_20 · DXY_mom · breadth · sent_7 — chia sẻ loader F-01). Chuỗi ≥ 2 năm có sẵn (Treasury 1.344 bar · Frankfurter 2.910 · Yahoo 5.486) — đủ train walk-forward.
3. Registry: `MlModel kind="macro-mlp"` versioned + windowHash PIT + sweep riêng (chạy sau sweep chính 10 phút Chủ nhật — phụ thuộc F-00).
4. Tiêu thụ: (a) evidence Bayes `cross-asset-forecast` (vote theo rổ tài sản, weight khởi điểm khiêm tốn 0,2 — bandit KHÔNG áp vì đây là 1 giọng định lượng, uy tín đo bằng Brier rolling hiển thị UI); (b) `buildMacroInner` thêm bảng "DỰ BÁO 5 PHIÊN" (8 dòng: tài sản · hướng · độ tin · Brier 60 phiên rolling); (c) risk: dự báo US10Y↑ + DXY↑ đồng thời → cảnh báo tighten điều kiện tài chính toàn cầu (RiskAlert INFO, cùng khuôn escalate).
5. API: `GET /api/ml/macro-forecast` (serving + metrics + Brier rolling) — hiển thị tab Mạng thần kinh khối riêng.

**Gate nghiệm thu:** mỗi tài sản chỉ kích hoạt khi Brier rolling 60 phiên tốt hơn baseline "đi ngang luôn" (uniform 0,667 cho 3 lớp) trên tập holdout — không đạt → dòng đó hiển thị "chưa đủ cạnh biên" (N6 trung thực); ≥ 2 tài sản đạt mới tính là chức năng sống.

**Phụ thuộc:** F-00 (sweep thật) · F-01 (loader đặc trưng dùng chung) — lịch sử dữ liệu ĐÃ ĐỦ ngay hôm nay.

---

### NHÓM C — Vòng phản hồi & kiểm soát rủi ro (P1/P2)

#### F-13 · Regime detector + contextual bandit + trạng thái Q giàu hơn

**Nguồn gốc:** P1-7 + phân tích kinh tế: chính sách 1 bộ cho mọi chế độ là sai về kinh tế học.

**Chức năng:** (a) nhãn chế độ hằng ngày từ `src/lib/quant/regime.ts` (chuẩn hoá 3 mức BULL/BEAR/CHOP theo VNINDEX MA50/MA200 + vol; persist AppSetting `market-regime` rolling); (b) **bandit theo ngữ cảnh**: posterior theo (arm × regime) — 3 khối Beta; rút thăm theo regime hiện tại; (c) Q-learning thêm bit regime vào state (48 → 96 trạng thái, giữ 3 hành động).

**Thiết kế:** Prisma: `BanditArm` thêm cột JSON `regimeStats` (null = dùng bảng chung — tương thích cũ); settle ghi cả khối chung và khối regime; UI bandit-block hiển thị posterior theo regime hiện tại + Wilson CI (F-15).

**Gate nghiệm thu:** ≥ 100 pulls/arm chung (điều kiện F-15) trước khi khối regime có trọng số; regime nào chưa đủ 10 pulls → fallback bảng chung (khai báo UI).

---

#### F-14 · Factor-beta Monte Carlo + kịch bản stress có tên (MỞ RỘNG MC có sẵn)

**Nguồn gốc:** P2 + phân tích kinh tế: hội đồng có thể đọc "US10Y +50cb thì sao?" nhưng không có công cụ định lượng. **Lưu ý (E6): `RiskQuantSnapshot` ĐÃ CÓ MC bootstrap vô điều kiện (`mcLoss5Pct`/`mcPDd`) + HS-VaR/CVaR — F-14 là mở rộng, không phải build từ đầu.**

**Chức năng:** `src/lib/risk/scenario.ts`: (a) ước lượng beta từng vị thế so với {VNINDEX, US10Y, DXY, GC=F} bằng hồi quy 250 phiên; (b) mô phỏng correlated 10.000 đường (Cholesky từ ma trận hiệp phương sai — tái dùng `quant/statistics.ts`) **cộng** 4 kịch bản stress đặt tên: US10Y +50cb · DXY +2% · VND −2% · hàng hoá ±10%; (c) VaR95/99 + ES + P&L từng kịch bản → ghi vào `RiskQuantSnapshot.detail` (JSON — không thêm cột trừ khi cần truy vấn) + khối prompt risk-manager + UI tab Danh mục.

**Gate nghiệm thu:** P&L kịch bản đúng dấu theo beta (mã beta dương VNINDEX lỗ khi VNINDEX −3%); < 2s cho ≤ 10 vị thế; mã mới niêm yết thiếu lịch sử → khai báo "chưa đủ dữ liệu beta".

---

#### F-15 · Sức mạnh thống kê Bandit: backlog settle + Wilson CI + dọn arm mồ côi

**Nguồn gốc:** P1-4 — 27–28 pulls/arm; `SETTLE_SCAN_LIMIT=30` quên phiếu cũ. **Cộng phát hiện v3: DB có 8 BanditArm — arm mồ côi `portfolio-strategist` (pulls=0) không nằm trong `BANDIT_ARM_CODES`, `ensureArms()` chỉ tạo không dọn.**

**Chức năng:** (a) settle quét theo **con trỏ ID** (`lastSettledEventId` persist AppSetting) thay vì `take 30` — không phiếu nào bị bỏ; (b) UI bandit-block + council hiển thị **Wilson CI 95%** cạnh posterior + mốc "≥100 pulls = tin khoảng cách"; (c) `ensureArms()` dọn arm không nằm trong `BANDIT_ARM_CODES` (soft-delete: chuyển cột `deprecated` hoặc xoá row — chọn xoá vì pulls=0 không mất gì); (d) log pulls/tháng vào ml/analytics.

**File:** sửa `src/lib/ml/bandit.ts` (con trỏ + `wilsonCi` ~10 dòng + dọn arm) · `src/components/dashboard/ml/bandit-block.tsx`.

**Gate nghiệm thu:** 2 ngày liên tiếp → 0 phiếu quá hạn 5 phiên chưa settle (script verify); UI hiển thị CI mọi arm; DB đúng 7 arm sau dọn.

---

### NHÓM D — Vận hành chất lượng dữ liệu vĩ mô (P2)

#### F-16 · Quy tắc chất lượng Q10–Q13 + lịch công bố chuỗi vĩ mô

**Nguồn gốc:** §5 DATA_SOURCES có Q1–Q9 cho dữ liệu giá; chuỗi vĩ mô có 4 tính chất riêng: **chậm công bố · đa dạng đơn vị · lịch release cố định · sửa số hồi cứu** (GSO revises).

**Chức năng — 4 quy tắc mới vào §5:**

| # | Quy tắc | Thực thi |
|---|---|---|
| Q10 | **Point-in-time release** | MacroObservation chỉ hợp lệ cho feature/prompt nếu `releaseAt ≤ asOf` — mọi loader bắt buộc kiểm (N4) |
| Q11 | **Đơn vị khai báo 1 chỗ** | `MacroSeries.unit` là nguồn duy nhất; format hiển thị theo unit; cấm heuristic tầng tiêu thụ |
| Q12 | **Dedupe kỳ + sửa số** | upsert `(seriesId, periodLabel)`; bản `real` đè `extracted`; số bị sửa → giữ `releaseAt` gốc bản mới + cờ `revised` (lịch sử feature KHÔNG viết lại — chống survivorship con số) |
| Q13 | **Stale theo tần suất** | monthly > 45 ngày không kỳ mới → DataSourceStatus `macro-vn` stale + cảnh báo (không đợi ngưỡng 4h của nguồn giá) |

Kèm **lịch công bố tĩnh** (`src/lib/macro-calendar.ts`, config JSON): GSO CPI ~29 hằng tháng · GDP quý ~T+20 ngày · SBV họp tối đa 4 lần/năm · PMI đầu tháng — UI hiển thị "kỳ release kế tiếp" để phân biệt "đang chờ" và "đang hỏng".

---

## 4. Đối chiếu kỳ vọng chủ sở hữu — đã đáp ứng chưa? (bổ sung v3)

Kỳ vọng nguyên văn (đầu tài liệu): *"bộ não cực mạnh trong phân tích dữ liệu thị trường — dùng dữ liệu cũ phán đoán nền kinh tế, biến động tài chính, cổ phiếu, trái phiếu"*.

| Kỳ vọng | Hiện trạng đo 17/10/2026 | Chức năng phủ | Verdict trung thực |
|---|---|---|---|
| "phân tích dữ liệu thị trường cực mạnh" | 225.644 bar thật 13,8 năm · 112 instrument (90 VN + 22 QT + 14 vĩ mô) · Q1–Q9 · stale marking · coverage matrix 3 màu | Nền tảng + F-16 | ✅ **Nền tảng đạt** — nền dữ liệu là điểm mạnh nhất của hệ thống; "cực mạnh" về vòng học còn phụ thuộc F-00–F-17 |
| "dùng dữ liệu cũ" | 2013→nay + windowHash PIT trong registry | F-11 đóng lỗ hổng survivorship | 🟡 Về cơ bản đạt; PIT chưa kín |
| "phán đoán nền kinh tế" | Serving chỉ 10 chiều kỹ thuật giá; chuỗi vĩ mô VN = 0; A20 đọc lớp 1 qua prompt | F-01 · F-02 · F-10 | ❌ **CHƯA** — GĐ1 (F-00→F-02) mới bắt đầu đáp ứng |
| "biến động tài chính" | Chỉ ĐO quá khứ (HS-VaR/CVaR/EWMA trong RiskQuantSnapshot); KHÔNG dự báo biến động | F-09 · F-08 · F-14 | ❌ Chưa — hiện tại hệ thống đo rủi ro, không dự báo rủi ro |
| "cổ phiếu" | valAcc 39,42% (cạnh biên +6,4đ) · 48 quyết định D-LEDGER · bandit ml-forecast 0,647 dẫn đầu hội đồng | F-01 · F-07 · F-08 · F-11 | 🟡 Kỷ luật đạt; cạnh biên mỏng — đúng như review #125 |
| "trái phiếu" | Có bar Treasury thật (đường cong 5Y/10Y/30Y 2 năm) nhưng **không chức năng nào DỰ BÁO lợi suất trái phiếu** — chỉ làm đặc trưng đầu vào | **F-17 (bổ sung v3)** | ❌ Khoảng trống — tài liệu v2 bỏ sót; v3 đóng bằng F-17 |

**Kết luận đối chiếu:** hiện tại hệ thống đáp ứng trọn vẹn 1/6 (nền tảng dữ liệu) + một nửa 2/6 (dữ liệu cũ, cổ phiếu về mặt kỷ luật). Sau GĐ1+GĐ2 của lộ trình (kèm F-00/F-17), **6/6 kỳ vọng có chức năng kỹ thuật cụ thể phủ** — chất lượng phủ đến đâu sẽ do sweep + Brier trả lời bằng số, theo đúng triết lý trung thực của hệ thống.

---

## 5. Đánh giá kiến trúc Mạng thần kinh — có cần thay đổi không? (bổ sung v3)

### 5.1 Hiện trạng đo trực tiếp (registry + code + DB 17/10)

| Thành phần | Trạng thái thật | Ghi chú |
|---|---|---|
| MLP backbone | serving v8: **10-16-8-3** (10 chiều vào, z-norm trong `featureNorm`) | 19 version tổng; v9→v19 archived — champion gate giữ v8 |
| GRU sequence | **Code + shadow + Brier gate + kill-switch hoàn chỉnh — chưa từng bật** (`ml-gru` setting chưa tồn tại) | Giọng thứ 3 nằm chờ |
| Linreg | Giọng 2 (tanh z) — chạy thật | — |
| Ensemble weights | Hardcoded 0,7/0,3 | F-07 |
| Sweep AutoML | Cơ sở hạ tầng đầy đủ (grid arch + championJson + paired-bootstrap) — **`SweepRun` 0 dòng** | F-00 |
| Calibration | Chưa có | F-08 |
| Multi-head / multi-asset | Chưa có | F-09 / F-17 |

### 5.2 Phán quyết

**Câu hỏi: có cần thay đổi kiến trúc Mạng thần kinh không?**

> **KHÔNG cần đổi paradigm — CẦN 6 cập nhật cụ thể bên trong paradigm, và 1 điều kiện tiên quyết về vận hành.**

**Lý do không đổi paradigm (MLP per-sample + ensemble nhỏ vẫn đúng):** regime dữ liệu hiện tại là **~60.000 mẫu, nhãn 3 lớp nhiễu, 20 mã, hàm lượng thông tin cực mỏng** (valAcc 39,42% khi mù 33%). Ở regime này **nút cổ là dữ liệu/đặc trưng, không phải dung lượng mô hình** — mạng to hơn (transformer sâu, attention cross-sectional) sẽ overfit và ăn mất cạnh biên +6,4đ đang có. Kết luận này nhất quán với thực nghiệm chính hệ thống: 11 version v9→v19 thay đổi arch/hyper mà không thắng v8 — bằng chứng sống rằng "đập đi xây lại mạng" không sinh cạnh biên.

**6 cập nhật cần làm (đã đặc tả đầy đủ ở §3):**

| # | Cập nhật | Chức năng | Vì sao đúng hướng |
|---|---|---|---|
| 1 | Vòng tự học phải chạy thật trước tiên | **F-00** | Gate là lời bảo vệ cuối cùng — gate chưa chạy thì mọi cập nhật không có trọng tài |
| 2 | Mở input 10 → 24 (vĩ mô + flow + sentiment) | **F-01** | Tăng thông tin đầu vào — cách duy nhất sinh cạnh biên ở regime dữ liệu nhỏ |
| 3 | Kích hoạt GRU shadow-only (0 rủi ro) | **F-00 (mục 5)** | Cơ chế "không nhận máy mù" đã xây xong 100% — để dormant là lãng phí; shadow bắt đầu tích luỹ 60 phiên cho cổng Brier |
| 4 | Multi-head 3 đầu ra (hướng+biên+vol) | **F-09** | Backbone dùng chung → thông tin chia sẻ, vol phục vụ sizing — đúng kỳ vọng "biến động tài chính" |
| 5 | Calibration + học trọng số ensemble | **F-08 · F-07** | Cùng triết lý Bandit: trọng số phải học từ bằng chứng, xác suất phải hiệu chuẩn |
| 6 | Mô hình thứ hai multi-asset (macro-mlp) | **F-17** | Đóng kỳ vọng "trái phiếu"; tái dùng toàn bộ hạ tầng registry/sweep — chi phí biên thấp |

**Không làm (trung thực về giới hạn):**

- ❌ Transformer/attention cross-sectional giữa các mã: cần ≥ 150k mẫu + ≥ 6 tháng D-LEDGER tích luỹ — để dành roadmap dài hạn (sector embedding là bước đón đầu rẻ nhất khi tới lúc).
- ❌ LLM end-to-end forecasting: vi phạm nguyên tắc tách kênh học (LLM là **cử tri**, không phải mô hình số) — kiến trúc đang đúng.
- ❌ Mô hình tick intraday sâu: IntradayBar ~5k mẫu — chưa đủ nuôi bất kỳ mạng nào nghiêm túc.
- ❌ Nối thẳng chuỗi RSS thô vào MLP: phải qua F-04 (sentiment chuẩn hoá) — text thô là nhiễu cho mạng nhỏ.

### 5.3 Kích thước/chi phí cập nhật (để chủ sở hữu ra quyết định)

F-00 + GRU shadow + F-12a ≈ **2–3 ngày** (thuần vận hành, 0 rủi ro serving) → F-04 + F-03a + F-01 ≈ **1,5 tuần** (v3-macro vào sweep đấu fair) → F-11 + F-02 Pha A ≈ **1,5 tuần**. F-07/F-08/F-17 ≈ **2 tuần** sau khi F-00 có ≥ 4 Chủ nhật audit + phiếu meta tích luỹ. Tổng GĐ1+GĐ2 ≈ **6–7 tuần** part-time của một kỹ sư.

---

## 6. Lộ trình tích hợp (thứ tự phụ thuộc — không phá kiến trúc)

```
GĐ0 · Tuần 0 (2-3 ngày)  "Vận hành hoá trọng tài + bật cơ chế ngủ đông"
 └─ F-00 audit + catch-up + ML_CYCLE_STALLED alert + GRU shadow-only + F-12a từ điển RAG
                              │
GĐ1 · Tuần 1–3   "Cho não nhìn kinh tế + mất bias"
 ├─ F-04 sentiment daily ─┐
 ├─ F-03a flow feature ────┼→ F-01 v3-macro 16→24 (đấu sweep — giờ là sweep THẬT)
 ├─ F-11 point-in-time universe (train v2 lẫn v3)
 └─ F-02 Pha A MacroSeries + trích xuất có trích dẫn
                              │
GĐ2 · Tuần 4–7   "Não mạnh hơn + học trọng số + trái phiếu"
 ├─ F-07 meta-learner trọng số (migration BanditEvent.meta + 4 tuần tích luỹ)
 ├─ F-08 calibration isotonic + per-class report
 ├─ F-10 XREL quốc tế (căn giờ d+1) — bảng truyền dẫn lớp 3 cho A20
 ├─ F-17 macro-mlp multi-asset (đóng kỳ vọng trái phiếu)
 ├─ F-09 multitask (vào sweep như ứng viên)
 └─ F-03b/F-05/F-02 Pha B — mở khi có egress
                              │
GĐ3 · Tuần 8+    "Vòng phản hồi chặt"
 ├─ F-15 backlog settle + Wilson CI + dọn arm (tiền điều kiện F-13)
 ├─ F-13 regime + contextual bandit (cần ≥100 pulls)
 ├─ F-14 factor-beta MC + stress scenarios (mở rộng MC có sẵn)
 └─ F-16 Q10–Q13 + lịch công bố → cập nhật DATA_SOURCES.md §5
```

**Điểm dừng an toàn:** hết GĐ0+F-01 hệ thống đã có trọng tài thật + não nhìn 8 chiều vĩ mô; hết GĐ1 đáp ứng "nền kinh tế"; hết GĐ2 đáp ứng "trái phiếu" + "biến động tài chính".

---

## 7. Những gì KHÔNG được đụng vào (kế thừa nguyên #125 — điều chỉnh lập luận theo đo mới)

1. **Tách 3 kênh học** (giá→MLP · uy tín→Bandit · ký ức→RAG) — mọi chức năng chỉ THÊM dữ liệu vào kênh, không trộn kênh.
2. **D-LEDGER chấm cả tín hiệu bị cổng bác** — F-07 học từ chính nguồn này; tuyệt đối không lọc bỏ phiếu bị bác.
3. **Cơ chế "không nhận máy mù" của GRU** (shadow 60 phiên + Brier + kill-switch) — giữ nguyên thiết kế; đo mới cho thấy nó chưa từng được bật → F-00 kích hoạt shadow là **hoàn thiện**, không phải thay đổi.
4. **Registry MlModel versioned + seed cố định + PSI drift + sweep champion gate** — mọi model mới (v3-macro · multitask · learned-weights · macro-mlp) đi qua đúng luồng; F-00 chỉ làm cho luồng thật sự chạy.
5. **Trung thực số liệu** — nếu v3-macro không thắng sweep: ghi `whyRejected`, giữ 39,42% và báo đúng. Kỷ luật này là điểm sáng nhất của hệ thống.

---

## 8. Chốt

Phân tích kinh tế học trả lời *"bộ não cần nhìn gì"*; review #125 trả lời *"thiếu gì"*; tài liệu này (v3, sau tự-review theo yêu cầu) trả lời *"gắn vào đâu cho đúng + đã đủ so với kỳ vọng chưa"*: **17 chức năng** (bổ sung F-00 điều kiện tiên quyết vận hành + F-17 đóng khoảng trống "trái phiếu"), 100% tái sử dụng adapter pattern – UnitSpec – DataSourceStatus – sweep gate – D-LEDGER – bandit, mỗi chức năng có gate nghiệm thu đo được và kill-switch. Về kiến trúc Mạng thần kinh: **không đổi paradigm** (MLP + ensemble nhỏ vẫn đúng regime 60k mẫu) — cập nhật 6 điểm cụ thể, đứng đầu là F-00: trọng tài sweep phải chạy thật trước khi bất kỳ nâng cấp não nào được tuyên là vô địch. Sau GĐ2, cả 6/6 kỳ vọng của chủ sở hữu đều có chức năng phủ; chất lượng phủ đến đâu sẽ do Brier + sweep trả lời bằng số — và hệ thống sẽ báo đúng con số đó, kể cả khi nó không đẹp.

---

## Change Log

| Ngày | Thay đổi |
|---|---|
| 17/10/2026 | **v3 — tự-review theo yêu cầu chủ sở hữu:** (1) **hiệu đính 11 lỗi E1–E11** bằng đo trực tiếp DB/code (§1.5) — quan trọng nhất: serving v8 thực tế đọc **10 chiều** (không phải v2-lag16) · SweepRun 0 dòng → vòng Chủ nhật chưa vận hành · BanditEvent không có cột meta · F-14 nêu đích MC có sẵn trong RiskQuantSnapshot; (2) bổ sung **F-00** (điều kiện tiên quyết P0: audit ML_TRAIN_AUTO/ML_SWEEP_AUTO + boot catch-up + alert ML_CYCLE_STALLED + kích hoạt GRU shadow) và **F-17** (macro-mlp multi-asset 8 tài sản — đóng kỳ vọng "trái phiếu" bị bỏ sót); (3) thêm **§4 đối chiếu 6 kỳ vọng chủ sở hữu** (verdict trung thực: hiện 1/6 trọn vẹn) và **§5 đánh giá kiến trúc Mạng thần kinh** (phán quyết: không đổi paradigm — 6 cập nhật cụ thể + danh mục "không làm" kèm lý do regime dữ liệu); (4) cập nhật baseline §1 bằng số đo trực tiếp 17/10 (225.644 bar · 908 tin · ForeignFlow 768 · 8 arm với 1 mồ côi · ml-forecast 0,647 · macro-economist 0 pulls); (5) ma trận §2 → 18 dòng; lộ trình thêm GĐ0 |
| 17/10/2026 | v2 — chuyển đổi full: đặc tả 16 chức năng F-01→F-16 theo 4 nhóm, ma trận chuyển đổi, lộ trình 3 giai đoạn, 6 nguyên tắc N1–N6 |
| 17/10/2026 | v1 — review kiến trúc & vận hành bộ não: phán quyết 5 khía cạnh, findings P0/P1/P2, lộ trình khái quát |

# AI Engineer Review — Chuyển phân tích "Bộ não" thành Chức năng Kỹ thuật

**Ngày:** 17/10/2026 · **Vai trò:** Kỹ sư AI / chuyên gia lập trình (độc lập)
**Đối tượng:** The Trader — hệ thống giao dịch đa agent 24 thành phần (VNDIRECT paper)
**Phạm vi:** chuyển TOÀN BỘ kết quả phân tích kinh tế học về nguồn dữ liệu (khung top-down 3 lớp · kiểm kê 14 instrument vĩ mô đã sync #126 · các phát hiện P0/P1/P2 của review #125) thành **chức năng kỹ thuật cụ thể, khớp kiến trúc hiện có, không phá tầng nào**.

> **Chuỗi lý do của tài liệu:** phân tích kinh tế học nói *"bộ não cần nhìn biến kinh tế để phán đoán nền kinh tế"* → review kỹ thuật #125 xác nhận *"não chưa từng nhìn biến kinh tế nào (featureAt 16/16 thuần kỹ thuật giá)"* → tài liệu NÀY trả lời câu hỏi còn lại: **xây cụ thể cái gì, ở file nào, chạy lúc mấy giờ, nghiệm thu thế nào**.

**Tài liệu liên kết:** [DATA_SOURCES.md](./DATA_SOURCES.md) (kho nguồn S1–S13) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [ML_OPS_BLUEPRINT.md](./ML_OPS_BLUEPRINT.md) · [ML_AUTOML_BLUEPRINT.md](./ML_AUTOML_BLUEPRINT.md) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md)

---

## 0. Nguyên tắc chuyển đổi (bất biến của tài liệu này)

Mọi chức năng dưới đây TUÂN THỦ 6 quy tắc — suy ra trực tiếp từ những gì hệ thống đang làm đúng:

| # | Nguyên tắc | Hệ quả kỹ thuật bắt buộc |
|---|---|---|
| **N1** | **Bám adapter pattern đã có** | Nguồn mới = 1 module `src/lib/<tên>.ts` + golden signature + retry/backoff + `markSource` — không phát minh luồng thứ 2 |
| **N2** | **No-fabrication tuyệt đối** | Chuỗi chưa có → khai báo trong khối "CÒN THIẾU"; số liệu trích từ tin phải kèm URL nguồn + mode `extracted`; không bao giờ điền proxy vào chỗ của số thật |
| **N3** | **Mọi thay đổi não phải qua sweep gate** | Đổi feature set / trọng số / kiến trúc MLP → ứng viên trong sweep Chủ nhật 04:15 + paired-bootstrap Brier CI — không thay mù (chuẩn `championGate` sẵn có) |
| **N4** | **Point-in-time khi đưa dữ liệu vào vòng học** | Feature tại phiên t chỉ được dùng dữ liệu có `releaseDate/asOf ≤ t` — chống look-ahead bias (đặc biệt nguy hiểm với chuỗi vĩ mô chậm công bố) |
| **N5** | **1 nguồn sự thật mỗi loại đơn vị** | Dùng bảng `UNIT_SPECS` (market×type) sẵn có; chuỗi vĩ mô mới khai báo đơn vị ngay trong model, không heuristic rải rác |
| **N6** | **Trung thực số liệu phục vụ UI** | Mọi chuỗi mới lộ diện qua `DataSourceStatus` (mode + stale + lastError) — footer/matrix độ phủ tự hiển thị đúng |

---

## 1. Baseline kiến trúc — điểm neo gắn chức năng (đo tại #126)

**Đường dữ liệu (đã hoạt động):**

- 90 instrument giá VN (HOSE/HNX/UPCOM × STOCK/ETF + 8 INDEX) — dchart S7, 215k bar thật 2013→nay, sync 15:45 ICT.
- 22 mã US/HK + **14 instrument vĩ mô #126**: US5Y/US10Y/US30Y (Treasury CSV · 1.344 bar) · EURUSD/USDJPY/AUDUSD (Frankfurter · 2.910 bar) · VND=X (er-api + Yahoo backfill) · DXY + GC/CL/BZ/SI/HG/NG (Yahoo query2 · 5.486 bar) — tổng kho 225.644 bar, sync 06:15 ICT.
- 5 feed RSS VN (CafeF/VnEconomy/VNExpress/Tuổi Trẻ/VietnamNet) — 830+ tin, crawler 15 phút.
- FinancialFundamental **0 dòng** (S10 pending-egress) · CorporateEvent **2 dòng** · ForeignFlow 754 dòng **mode=simulated**.

**Bộ não (3 kênh học tách bạch):**

- MLP 10-16-8-3, feature set `v2-lag16` (`featureAt` src/lib/ml/features.ts:365 — 16 chiều thuần kỹ thuật giá), serving v8 valAcc 39,4%, train Chủ nhật 04:00.
- Ensemble: trọng số **hardcoded** `ENSEMBLE_WEIGHTS = {mlp:0,7, linreg:0,3}` → GRU bật `{0,5/0,3/0,2}` (src/lib/ml/ensemble.ts:53) + GRU shadow 60 phiên + cổng Brier kill-switch.
- Bandit Thompson 7 arm (6 cử tri + macro-economist #126), ~28 pulls/arm, settle 16:15 hằng ngày quét 30 phiếu.
- Q-learning 48 trạng thái × 3 hành động · RAG BM25 (tokenizer Việt bỏ dấu) 700 docs · XREL lead-lag **trong nước only**.

**Hội đồng:** 24 agents (A20 macro-economist mới — cử tri thứ 7, arm cold-start) · cổng đồng thuận 80% · D-LEDGER chấm điểm cả tín hiệu bị bác · tổng hợp Bayes 50 bằng chứng.

**Scheduler market-engine (mini-services/market-engine/index.ts):** tick 10s · news 15' · eod-sync 15:45 · intl-sync 06:15 · settle 16:15 · k1-equity 16:30 · council-eval 16:45 · ml-train SUN:04:00 · ml-sweep SUN:04:15 · reprobe SUN:04:00 · agent-cycle (mặc định TẮT).

---

## 2. Ma trận chuyển đổi: phân tích kinh tế học → chức năng kỹ thuật

| # | Phát hiện từ phân tích (kinh tế học / review) | Chức năng kỹ thuật | Ưu tiên | Nhóm |
|---|---|---|---|---|
| 1 | Lớp 1 (thanh khoản toàn cầu) ĐÃ ĐỦ dữ liệu thật nhưng não MLP chưa từng tiêu thụ | **F-01** Feature set v3-macro 16→24 | 🔴 P0 | A |
| 2 | Lớp 2 (vĩ mô nội địa) THIẾU toàn bộ chuỗi CPI/GDP/SBV/tín dụng/M2/PMI/TPCP VN; RSS là nguồn số duy nhất | **F-02** MacroSeries VN + adapter + trích xuất LLM có trích dẫn | 🔴 P0 | A |
| 3 | ForeignFlow 754 dòng chỉ vào prompt, không vào feature (silo) | **F-03** Dòng khối ngoại thật + đặc trưng flow | 🔴 P0 | A |
| 4 | Sentiment lexicon tin tức chỉ dùng trong XREL event-study, không vào MLP | **F-04** Chuỗi sentiment hằng ngày → feature | 🔴 P0 | A |
| 5 | FinancialFundamental 0 dòng — bảng dựng sẵn không job populate | **F-05** Fundamentals → đặc trưng kênh chậm | 🟠 P1 | A |
| 6 | CorporateEvent 2 dòng — lịch cổ tức/kết quả gần trống | **F-06** Lịch sự kiện → đặc trưng + quy tắc blackout | 🟡 P2 | A |
| 7 | Trọng số ensemble hardcoded — mâu thuẫn triết lý "mọi trọng số phải học" | **F-07** Meta-learner trọng số từ D-LEDGER | 🔴 P0 | B |
| 8 | Cạnh biên mỏng (39,4%), chưa calibration, chưa log per-class | **F-08** Calibration isotonic + báo cáo hiệu chuẩn | 🟠 P1 | B |
| 9 | 1 chân trời duy nhất (5 phiên), chỉ phân loại hướng | **F-09** Đầu ra đa nhiệm hướng + biên độ + biến động | 🟠 P1 | B |
| 10 | XREL bỏ kênh truyền mạnh nhất: US đêm → VN sáng | **F-10** XREL quốc tế có chỉnh múi giờ | 🟠 P1 | B |
| 11 | Bias sống sót: rổ top-10 chọn theo thanh khoản HIỆN TẠI | **F-11** Universe point-in-time | 🟠 P1 | B |
| 12 | RAG BM25 thuần từ khoá: "lạm phát" không trúng "CPI" | **F-12** Từ điển đồng nghĩa vĩ mô + hybrid embedding (tuỳ chọn) | 🟡 P2 | B |
| 13 | Q-table 48×3 thô, bandit không ngữ cảnh chế độ thị trường | **F-13** Regime detector + contextual bandit | 🟡 P2 | C |
| 14 | Hội đồng rủi ro thiếu VaR kịch bản vĩ mô | **F-14** Monte Carlo VaR kịch bản shock | 🟡 P2 | C |
| 15 | Bandit 28 pulls/arm — sức mạnh thống kê thấp; SETTLE_SCAN_LIMIT=30 quên phiếu cũ | **F-15** Backlog settle + Wilson CI | 🟡 P2 | C |
| 16 | Chuỗi vĩ mô có tính chất riêng: chậm công bố, đơn vị đa dạng, lịch release | **F-16** Quy tắc chất lượng Q10–Q13 + lịch công bố | 🟡 P2 | D |

---

## 3. Đặc tả chức năng kỹ thuật

Quy ước mỗi đặc tả: **Nguồn gốc** (phát hiện nào của phân tích) → **Chức năng** → **Thiết kế** → **File mới/sửa** → **Prisma/API/Job** → **Gate nghiệm thu** → **Phụ thuộc**.

---

### NHÓM A — Đưa dữ liệu kinh tế vào não (đường dữ liệu · P0)

#### F-01 · Feature set v3-macro — "cho não nhìn kinh tế" (16 → 24 chiều)

**Nguồn gốc:** P0-1 (featureAt 16/16 thuần kỹ thuật giá) + phân tích kinh tế lớp 1 (Treasury/DXY/hàng hoá đã sync thật #126 nhưng chỉ vào prompt A20, chưa vào vòng học MLP).

**Chức năng:** mở rộng vector đặc trưng MLP thêm **8 chiều vĩ mô/định lượng** dùng đúng dữ liệu đang nằm trong `Bar` (14 instrument vĩ mô đã có):

```
x[16] dus10y_20   = (US10Y(t̄) − US10Y(t̄−20)) / 100        — biến động lợi suất 10Y 20 phiên (cb→thập phân)
x[17] slope_10y5y = (US10Y(t̄) − US5Y(t̄)) / 100            — độ dốc đường cong (nghịch = lo ngại tăng trưởng)
x[18] dxy_mom_20  = DXY(t̄)/DXY(t̄−20) − 1                  — động lượng đô la (gió ngược/thuận dòng vốn EM)
x[19] vnd_mom_20  = VNDX(t̄)/VNDX(t̄−20) − 1               — sức ép tỷ giá VND (mất giá = dương)
x[20] cmdty_mom_20= trung bình MOM20 của GC=F, CL=F, BZ=F  — chu kỳ hàng hoá
x[21] breadth_20  = tỷ lệ mã HOSE có close > SMA20         — độ rộng thị trường nội địa
x[22] flow_20     = Σ ForeignFlow.netValue(20p) / Σ ADTV(20p)  — dòng khối ngoại chuẩn hoá (F-03)
x[23] sent_7      = điểm sentiment lexicon 7 ngày gần nhất (F-04)
```

**Quy tắc căn chỉnh point-in-time (N4 — quan trọng nhất):** với mẫu tại phiên VN `t`, mọi đại lượng vĩ mô quốc tế dùng **bar cuối có `date < Bar[t].date`** (hàm `alignMacroBefore(vnDate)` — đêm Mỹ đóng 04:00 ICT trước mở cửa VN 09:00 nên bar US ngày d luôn "đã biết" trước phiên VN ngày d+1). VN-Index/breadth/flow/sentiment dùng chính ngày t. Thiếu chuỗi → chiều đó điền 0 (trung tính) + đếm `macroDimsMissing` — **không bỏ mẫu**, không bịa.

**Thiết kế:**

1. `src/lib/ml/features.ts`: thêm `ML_FEATURE_SET = "v3-macro"` (song song `v2-lag16` — tôn trọng FeatureContract: serving cũ đọc x[0..15] không đổi); `featureAt(r, t, macro?)` nhận thêm `MacroContext` (8 giá trị đã căn chỉnh) — mặc định null → trả đúng 16 chiều cũ (tương thích ngược 100%).
2. Loader mới `loadMacroContexts(dates: Date[])`: truy vấn 1 lần `Bar` của 8 mã macro (US10Y, US5Y, DX-Y.NYB, VND=X, GC=F, CL=F, BZ=F) + breadth (SQL `close > SMA20` — tái dùng logic `buildMacroInner`) + ForeignFlow + sentiment daily (F-04) → trả `Map<dateString, MacroContext>`; cache theo FeatureCache hiện có.
3. `buildTrainingSet` nối MacroContext vào từng mẫu — cùng seed cố định, cùng MLP 10-24-8-3 (cấu trúc lớp ẩn giữ 16→ nơ-ron vào = 24).
4. Sweep Chủ nhật: thêm ứng viên `featureSet: "v3-macro"` đấu với `v2-lag16` (đã có cơ chế championGate + paired-bootstrap Brier CI — dùng nguyên).

**File:** sửa `src/lib/ml/features.ts` (featureAt + loader) · `src/lib/ml/sweep.ts` (thêm field `featureSet` vào SweepHyper) · `src/lib/ml/nn.ts` (khởi tạo theo chiều vào động).

**Gate nghiệm thu:** v3-macro chỉ lên serving khi `ΔBrier CI 95%` hướng tốt so v2-lag16 qua ≥ 2 chu kỳ sweep; nếu không thắng → giữ v2 + ghi rõ trong `MlModel.meta.whyRejected` (trung thực kiểu 39,4%).

**Phụ thuộc:** F-03 (x[22]), F-04 (x[23]) — có thể triển khai trước với 6/8 chiều (x[22]=x[23]=0) rồi kích hoạt đủ sau.

---

#### F-02 · Pipeline chuỗi vĩ mô nội địa VN — MacroSeries (lớp 2 của khung top-down)

**Nguồn gốc:** phân tích kinh tế kết luận trực tiếp: *"kho dữ liệu CHƯA có chuỗi định lượng nội địa: CPI/lạm phát · GDP · lãi suất điều hành SBV · tăng trưởng tín dụng · M2 · PMI · lợi suất TPCP VN · lãi liên ngân hàng · XNK · FDI"* — hiện chỉ là khối khai báo "CÒN THIẾU" trong prompt A20.

**Chức năng:** đưa 10 chuỗi nội địa vào DB theo model riêng (không nhét vào `Bar` — vì chu kỳ tháng/quý ≠ nhịp phiên, và cần metadata công bố), rồi thay khối "CÒN THIẾU" bằng **bảng số liệu thật + phần còn thiếu thu hẹp dần**.

**Prisma (model mới):**

```prisma
model MacroSeries {
  id        String   @id @default(cuid())
  key       String   @unique          // CPI_YOY | GDP_YOY | SBV_REFI_RATE | CREDIT_YOY | M2_YOY |
                                          // PMI_MANU | VNGB_10Y | INTERBANK_OVN | TRADE_BAL | FDI_DISB
  name      String                    // "CPI tăng trưởng so cùng kỳ (%)"
  unit      String                    // "%" | "tỷ VND" | "lần" — khai báo 1 chỗ (N5)
  frequency String                    // monthly | quarterly | irregular (lãi suất đổi khi SBV họp)
  source    String                    // gso | sbv | news-extract | manual-csv
  latestObservedAt DateTime?          // kỳ dữ liệu mới nhất
}

model MacroObservation {
  id          String   @id @default(cuid())
  seriesId    String
  series      MacroSeries @relation(fields: [seriesId], references: [id], onDelete: Cascade)
  periodLabel String                   // "2026-09" (tháng) | "Q3-2026" (quý) | "2026-10-24" (irregular)
  periodStart DateTime                 // mốc kỳ (01-09-2026) — để join point-in-time
  value       Float
  releaseAt   DateTime                 // lúc số LIỆU CÔNG BỐ — N4: feature chỉ được dùng nếu releaseAt ≤ t
  mode        String                   // real | extracted | manual
  sourceUrl   String?                  // URL bài tin/endpoint — bắt buộc khi mode=extracted
  quoteVerbatim String?                // câu gốc chứa con số (kiểm tra chống bịa — N2)
  createdAt   DateTime @default(now())

  @@unique([seriesId, periodLabel])
  @@index([seriesId, periodStart])
}
```

**Thiết kế — 3 pha theo độ sẵn sàng nguồn (không phụ thuộc egress):**

- **Pha A — Trích xuất có trích dẫn từ RSS (làm được NGAY, không cần API ngoài):** job `extractMacroFromNews()` chạy sau crawler news: lấy 30 tin `category=macro` mới chưa xử lý → 1 lời gọi LLM (provider `src/lib/llm.ts` sẵn có) với hợp đồng JSON chặt: chỉ trích chuỗi + kỳ + con số **nguyên văn trong bài** + câu chứa số; từ chối nếu mơ hồ. Kết quả ghi `MacroObservation` mode=`extracted` kèm `sourceUrl` + `quoteVerbatim`. Dedupe theo `(seriesId, periodLabel)`; nếu trùng kỳ mà khác số → giữ bản `real`/`manual`, đánh dấu bản extracted `superseded=true`. **Guard N2:** không có tin nêu số → không ghi gì; prompt yêu cầu " KHÔNG suy ra, KHÔNG nội suy, KHÔNG quy đổi".
- **Pha B — Adapter nguồn chính thức (khi có egress, khuôn mẫu N1):** `src/lib/macro-vn.ts` với 3 adapter fail-soft: GSO/TCTK (CPI/PPI/XNK — portal công khai, parse HTML/JSON tĩnh), SBV (biểu lãi suất điều hành — trang thông cáo), TPCP VN 10Y (hội thị trường — tổng hợp công khai). Golden signature + throttle 500ms + retry 2 lần + `markSource` — clone kỷ luật `multi-market-sync.ts`.
- **Pha C — Nhập tay lịch sử (backfill):** route nhập CSV cho 10 series (2–5 năm) — chuẩn hoá `periodStart/releaseAt` (release = cuối kỳ + lag công bố ~20 ngày theo loại series, khai báo trong `MacroSeries.meta`).

**API/Job:**

- `GET /api/macro/series` — bảng điều khiển: mọi series + giá trị mới nhất + Δ kỳ trước + mode + stale + kỳ release kế (từ lịch công bố tĩnh F-16).
- `POST /api/macro/ingest` — trigger tay Pha A/B (cooldown 60s, audit `MACRO_INGESTED`).
- Scheduler market-engine: slot mới `MACRO_VN_AT` mặc định **06:35 ICT hằng ngày** (sau intl-sync 06:15, trước open VN 09:00) — Pha A; Chủ nhật chạy Pha B (nguồn phát hành theo tháng/quý nên kiểm tra daily, upsert khi có kỳ mới).
- `DataSourceStatus` key `macro-vn` — mode `real` (Pha B sống) | `extracted` (chỉ Pha A) | `pending` (chưa có gì).

**Tiêu thụ:** `buildMacroBlock()` (src/lib/agent-context.ts) — thay khối "CÒN THIẾU": mỗi series CÓ dữ liệu hiển thị 1 dòng `giá trị + Δ + kỳ + [nguồn]`; chuỗi vẫn thiếu giữ khai báo (list động từ `MacroSeries` chưa có observation). Prompt A20 đã có quy tắc "ưu tiên con số trong tin RSS" — giờ có số chuẩn hoá DB thay vì đọc lại từng bài.

**Gate nghiệm thu:** (1) 1 kỳ CPI xuất hiện trong MacroObservation → block prompt hiển thị đúng số + URL; (2) bịa số thử (test prompt ép trích sai) → guard từ chối hoặc đánh dấu `quoteVerbatim` rỗng → không ghi; (3) `releaseAt` của CPI tháng 9 phải ≥ 28/09 (không bao giờ có releaseAt trong tương lai so kỳ — N4).

**Phụ thuộc:** không chặn ai — F-01 mở rộng thêm chiều vĩ mô VN ở vòng sau (v4-macro-domestic) khi chuỗi đủ dài ≥ 24 kỳ.

---

#### F-03 · Dòng khối ngoại thật + đặc trưng flow (chống silo)

**Nguồn gốc:** P0-2 — ForeignFlow 754 dòng (mode=simulated) mới chỉ vào `flowsBlock` prompt; XREL event-study sentiment cũng silo. Phân tích kinh tế: dòng vốn ngoại là biến dẫn đường quan trọng bậc nhất của thị trường mới nổi.

**Chức năng:** (a) thay simulator bằng nguồn thật khi egress mở; (b) **quan trọng hơn**: biến flow thành chiều đặc trưng x[22] của MLP (chuẩn hoá theo ADTV — cùng đơn vị tỷ VND/tỷ VND) và bằng chứng Bayes định lượng.

**Thiết kế:**

1. `src/lib/foreign-flow-live.ts` (mới, Pha B — pending egress như S10): finfo `/v4/foreigns` HOSE+HNX EOD — envelope parse theo khuôn `vndirect.ts`, throttle 500ms, fail-soft về `simulated` (giữ nguyên simulator hiện tại làm fallback có khai báo — không gián đoạn). Upsert `ForeignFlow @@unique([instrumentId, date])`, mode=`live`.
2. Scheduler slot `FLOW_SYNC_AT` = **16:05 ICT** (sau đóng cửa 15:00, sau eod-sync 15:45 — khi đó tổng khối lượng phiên đã chốt, khớp `Bar` cùng ngày).
3. Đặc trưng: `flow_20 = Σ netValue(20 phiên) / Σ ADTV(20 phiên)` mỗi mã + bản tổng thị trường — tính trong `loadMacroContexts` (F-01); clip ±3 (tránh outlier ngày stat).
4. Bayes: thêm evidence `foreign-flow-trend` (3 mức: vào ròng / cân bằng / ra ròng theo z-score 20 phiên) — cùng khuôn evidence.ts, weight khiêm tốn 0,3.
5. Giữ nguyên RiskAlert `FOREIGN_FLOW_OUTFLOW` (−300 tỷ, dedupe 24h) — nguồn live chỉ đổi `mode`.

**Gate nghiệm thu:** 1 ngày có data live → ForeignFlow có dòng mode=`live` trùng ngày Bar cuối; feature x[22] ≠ 0 cho mọi mẫu sau ngày đó; khi nguồn chết → mode về `simulated` + DataSourceStatus `foreign-flows` mode=fallback (không crash chu kỳ agents).

**Phụ thuộc:** F-01 tiêu thụ; egress cho Pha B (Pha A: tính x[22] từ dòng simulated hiện có — vẫn đúng "dữ liệu có trong DB", mode khai báo).

---

#### F-04 · Chuỗi sentiment hằng ngày → đặc trưng

**Nguồn gốc:** P0-2 (nửa sau) — lexicon sentiment của `src/lib/quant/sentiment.ts` + `ml/news-coverage.ts` chỉ phục vụ XREL/Bayes, chưa vào MLP. Phân tích kinh tế: cảm xúc tin tức là biến "nhanh" hiếm hoi của lớp 2 khi chuỗi chậm chưa có.

**Chức năng:** tổng hợp điểm sentiment lexicon của mọi `NewsItem` trong 7 ngày → chuỗi hằng ngày `sent_7` (điểm −1..+1 chuẩn hoá theo số tin) → chiều x[23] của v3-macro + dashboard.

**Thiết kế:** job tính trong settle 16:15 (đã quét tin cùng lúc): bảng `AppSetting` key `news-sentiment-daily` — mảng `{date, score, n}` rolling 90 ngày (JSON, đủ nhẹ); loader của F-01 đọc trực tiếp. Công thức: trung bình có trọng số tuyến tính theo độ tươi (tin hôm nay ×1,0 → 6 ngày ×0,4), chia sqrt(n) nếu n<5 (chưa đủ tin → co về 0 — trung thực).

**File:** sửa `src/lib/quant/sentiment.ts` (thêm `dailySentimentSeries(days)` persist vào AppSetting) · gọi từ settle job engine · tiêu thụ trong `loadMacroContexts`.

**Gate nghiệm thu:** sent_7 đổi dấu đúng ngày có cụm tin mạnh (kiểm chứng với 1 sự kiện đã biết trong NewsItem); n=0 ngày nghỉ → 0.

---

#### F-05 · Fundamentals → kênh đặc trưng chậm (post-egress)

**Nguồn gốc:** FinancialFundamental 0 dòng — bảng + adapter `src/lib/fundamentals.ts` hoàn chỉnh, chỉ chờ egress (S10). Phân tích kinh tế: P/E tương đối ngành + động lượng lợi nhuận là biến giá trị dài hạn.

**Chức năng:** khi S10 sáng (tự động, job Chủ nhật đã cài trong `runDataCollector`): thêm 3 chiều kênh chậm vào vòng sweep kế tiếp (`v4-fundamental`): P/E z theo ngành · EPS yoy · biến động BVPS. **Không thêm vào v3-macro ngay** — tránh đổi 2 nhóm biến cùng 1 chu kỳ sweep (nguyên tắc biến đổi 1 lần 1 thứ).

**Gate nghiệm thu:** đối chiếu T11.3 (P/E VCB ±5% nguồn ngoài) trước khi vào feature; sweep thắng mới lên serving.

**Phụ thuộc:** egress máy chủ; F-01 đã chạy ≥ 1 tháng để tách ảnh hưởng.

---

#### F-06 · Lịch CorporateEvent → đặc trưng + quy tắc blackout thực thi

**Nguồn gốc:** CorporateEvent 2 dòng — gần trống; phân tích kinh tế: kỳ công bố kết quả/cổ tức là sự kiện định kỳ hàm thông tin cao; exec nên tránh mở vị thế mới ngay trước kỳ.

**Chức năng:** (a) nạp lịch sự kiện tương lai (cổ tức cuối sổ · họp ĐHĐCĐ · công bố kết quả quý) bằng 2 nguồn: RSS CafeF category sự kiện + trích xuất LLM có trích dẫn (dùng lại hợp đồng F-02 — chia sẻ module); (b) đặc trưng `days_to_event` (dummy ≤ 3 phiên); (c) quy tắc exec: tín hiệu BUY mã có event trong 2 phiên tới → cờ `event_blackout` vào ô Chờ duyệt (UI hiển thị lý do — không chặn cứng, người phê duyệt quyết định).

**Prisma:** tái dùng `CorporateEvent` (thêm `kind` EARNINGS/AGM/DIVIDEND_RECORD đã có enum — kiểm tra `CorporateEventKind`) + cột `status="scheduled"` cho lịch tương lai (hiện model thiên về adjust lịch sử).

**Gate nghiệm thu:** 1 mã có lịch cổ tức trong DB → ô tín hiệu hiện cờ blackout; event qua ngày → cờ tự hết.

---

### NHÓM B — Não mạnh hơn (chất lượng dự báo · P0/P1)

#### F-07 · Học trọng số ensemble — meta-learner từ D-LEDGER

**Nguồn gốc:** P0-3 — `ENSEMBLE_WEIGHTS` hardcoded 0,7/0,3 (0,5/0,3/0,2 khi GRU bật): Bandit học uy tín 7 cử tri nhưng tỉ lệ giọng nói bên trong `ml-forecast` không bao giờ được học. Nghịch lý với triết lý thiết kế.

**Chức năng:** thay trọng số cố định bằng **meta-learner tuyến tính nhỏ học từ chính D-LEDGER** (DecisionEvaluation/BanditEvent lịch sử — dữ liệu đã có 48+ quyết định và tăng 6 phiếu/chu kỳ).

**Thiết kế:**

1. Module mới `src/lib/ml/ensemble-learn.ts`:
   - Dữ liệu: với mỗi phiếu bầu `ml-forecast` đã settle, lấy **vector giọng nói tại thời điểm đó** (pUp−pDown của MLP, tanh(z) linreg, xác suất GRU nếu bật — các giá trị này phải persist vào `BanditEvent.meta` từ giờ, thêm 1 trường khi ghi phiếu) + nhãn kết quả hướng 5 phiên thật (đã có settle logic).
   - Mô hình: hồi quy logistic 3 lớp (softmax) trên 2–3 giọng → trọng số tối ưu hoá Brier walk-forward: train trên 70% phiếu cũ theo thứ tự thời gian, validate 30% cuối; ridge λ=0,5 (chuẩn hoá chống weight vọt khi ít mẫu).
   - Lưu `AppSetting` key `ml-ensemble-weights`: `{source: "learned", wMlp, wLinreg, wGru, nVotes, valBrier, trainedAt, version}`.
2. `mlForecastEnsemble()` đọc trọng số: **chưa đủ 60 phiếu settle → dùng hardcode hiện tại** (cold-start giữ nguyên — N3); đủ → so valBrier learned vs fixed trên cùng cửa sổ, chỉ bật khi **kém hơn nhiều hơn deadband 0,05·Brier** mới thắng; ngược lại giữ fixed + ghi `whyRejected`.
3. Train nhịp: gắn vào job `ML_SWEEP_AT` Chủ nhật 04:15 (chạy sau sweep 5 phút) — cùng nhịp học lại toàn hệ.
4. Công khai: `/api/ml/architecture` trả thêm `weightsSource: "fixed" | "learned"` + bảng so sánh; tab Mạng thần kinh hiển thị nguồn trọng số (UI sửa `ml/nn-tab.tsx` 1 khối nhỏ).

**Gate nghiệm thu:** ≥ 60 phiếu + valBrier learned < fixed − 0,005 (có ý nghĩa thực) → serving chuyển `weightsSource="learned"`; kill-switch thủ công qua xoá AppSetting (fallback fixed ngay lập tức); mọi lần đổi ghi `AuditLog ML_WEIGHTS_SWITCHED` kèm before/after.

**Phụ thuộc:** cần persist giọng nói vào BanditEvent.meta (sửa nhỏ `bayes/evidence.ts` khi ghi phiếu ml-forecast) — làm trước 4 tuần để tích luỹ mẫu.

---

#### F-08 · Calibration xác suất + báo cáo per-class

**Nguồn gốc:** P1-1 — valAcc 39,4% cạnh biên +6,4đ; điểm ensemble `pUp−pDown` có thể tự tin sai; chưa log per-class acc/Brier cho MLP serving.

**Chức năng:** (a) log đầy đủ per-class accuracy + Brier + reliability bin 10 mức cho MLP/GRU/linreg vào `ml/analytics.ts` (hiển thị tab Dữ liệu ML); (b) lớp isotonic calibration trên xác suất MLP trước khi vào điểm ensemble.

**Thiết kế:** fit isotonic trên tập validation của lần train cuối (ngưỡng 60 điểm mỗi class — không đủ thì trả identity); persist hệ số vào `MlModel.meta.calibration` (registry versioned như mọi artifact); áp trong `mlForecastEnsemble` ngay sau forward. GRU Brier gate dùng xác suất ĐÃ calibration (cộng hưởng đúng với F-07).

**Gate nghiệm thu:** reliability curve trước/sau hiển thị ở UI; ECE giảm ≥ 20% tương đối trên tập holdout thì giữ calibration — không thì ghi `whyRejected` và tắt.

---

#### F-09 · Đầu ra đa nhiệm: hướng + biên độ + biến động

**Nguồn gốc:** P1-2 — chỉ 1 chân trời 5 phiên, chỉ phân loại hướng; không đo độ lớn/đerived vol — trong khi phân tích kinh tế cần "biến động tài chính" (trái phiếu/rủi ro), không chỉ hướng.

**Chức năng:** MLP backbone dùng chung, **3 đầu ra**: (1) hướng 3 lớp (như hiện tại); (2) |ret| 5 phiên kỳ vọng (regression 1 node, tanh×scale); (3) realized vol 5 phiên tới (regression 1 node). Loss tổng = CE + 0,3·MSE_biên + 0,3·MSE_vol.

**Thiết kế:** `labelAt` mở rộng trả `{dir, mag, vol}` (tách hàm `labelRichAt` — giữ `labelAt` cũ cho sweep v2); `nn.ts` MLP cấu trúc 10-24-16→(8-3 dir | 4-1 mag | 4-1 vol) — tham số trong SweepHyper mới `task: "direction" | "multitask"`; sweep quyết định có lên serving không. Tiêu thụ phiếu: vol kỳ vọng → quy đổi sizing (risk/sizing.ts nhân hệ số 1/σ̂ —-sizing theo biến động dự báo); biên độ → ngôn ngữ prompt A20 ("dự báo biên độ trung bình 1,2%/5 phiên").

**Gate nghiệm thu:** ứng viên multitask vào sweep ≥ 2 chu kỳ; metric phụ MAE vol so baseline "vol20 lịch sử" phải tốt hơn 10% mới được bật kênh sizing.

---

#### F-10 · XREL quốc tế — kênh truyền US/HK → VN có chỉnh múi giờ

**Nguồn gốc:** P1-3 — `refreshRelations` chỉ tính quan hệ trong nước (VN30/VN100 + 10 ngành HOSE) dù data US 10 mã + HK 4 mã + 14 macro instrument đã sync 06:15. Phân tích kinh tế: kênh "đêm Mỹ → sáng VN" là đường truyền lân cận mạnh nhất.

**Chức năng:** tính lead-lag **quốc tế → VN** với quy tắc canh giờ tường minh, đưa vào prompt XREL + bảng truyền dẫn lớp 3 của A20.

**Thiết kế:**

1. `src/lib/ml/xrel.ts` mở rộng: cặp tính = {(^GSPC, ^IXIC, DX-Y.NYB, GC=F, CL=F, ^HSI, 0700.HK) × (VNINDEX, VN30, top-3 ngành HOSE)}; lag 0, 1, 2 phiên.
2. **Căn giờ (N4):** bar US ngày d (đóng 04:00 ICT d+1) ghép với bar VN ngày **d+1** — lag 0 nghĩa là "US tối qua → VN sáng nay"; HK tương tự (đóng 17:00 ICT → cùng khung giờ VN nhưng phải loại trừ trùng phiên: chỉ dùng lag ≥ 1 cho HK). Kỳ nghỉ lệch (US holiday) → bỏ cặp ngày đó, ghi `overlapDays` — tối thiểu 120 cặp ngày chung mới tính.
3. Thống kê: Pearson r theo lag + permutation p-value (200 lần xáo) — Bonferroni theo số cặp×lag; chỉ giữ |r| ≥ 0,25 & p ≤ 0,05 vào bảng "quan hệ đáng tin".
4. Tiêu thụ: `buildXrelPromptBlock()` thêm mục "Kênh quốc tế" (3 dòng top lead-lag + diễn giải chiều); `buildMacroInner` thêm bảng truyền dẫn lớp 3 (biến lớp 1 → phản ứng VN trung bình theo r lịch sử).
5. Scheduler: tính lại trong `maybeRefreshIfStale` (đã có stale 24h) — thêm 30 phút sau intl-sync 06:15 thì stale tự hết.

**Gate nghiệm thu:** bảng quan hệ có ≥ 3 cặp đáng tin với r dương đúng chiều kinh tế (VD ^GSPC lag-1 → VNINDEX r>0); prompt A20 nhắc đúng "đêm Mỹ giảm thì sáng VN áp lực"; không có cặp đủ mẫu → prompt khai báo "chưa đủ dữ liệu quốc tế" (N2).

---

#### F-11 · Universe point-in-time — chống bias sống sót

**Nguồn gốc:** P1-6 — rổ top-10 thanh khoản của `loadTopSeries(10)` chọn theo ADTV **hiện tại** cho toàn bộ tập train 2013→nay: mã hot hôm nay được "nhìn lại quá khứ" bằng lọc nhìn-lùi → backtest đẹp hơn thực tế.

**Chức năng:** mọi phép tính lịch sử (train MLP · Q-learning · backtest · sweep) chọn rổ theo thanh khoản **tại từng thời điểm lấy mẫu**.

**Thiết kế:**

1. Hàm mới `pointInTimeBasket(date, n)` trong `features.ts`: top-n theo `Σ Bar.value` cửa sổ 45 phiên **kết thúc trước date** — SQL `groupBy instrumentId` có `where date < :date` + index `[instrumentId, date]` sẵn có.
2. `buildTrainingSet` đổi cách duyệt: duyệt theo ngày (t đã có sẵn trong vòng) → với mỗi ~20 phiên lại tra basket 1 lần (cache basket theo tuần — 700 truy vấn → ~35 truy vấn chu kỳ train); sweep dùng cùng loader (1 đường tính — FeatureContract).
3. Giữ `loadTopSeries` (rổ hiện tại) cho **serving forward** — đúng ngữ cảnh dự báo hôm nay.
4. Hiệu chuẩn kỳ vọng: metric sweep có thể **giảm nhẹ** sau sửa (đó là số thật hơn) — ghi chú vào `ML_OPS_BLUEPRINT` để không bị tưởng là regression.

**Gate nghiệm thu:** script verify `scripts/pit-verify.ts`: năm 2015 basket phải chứa mã từng thuộc top thanh khoản thời đó (so sánh với top hiện tại có khác biệt ≥ 2 mã); số mẫu train giảm không quá 15% (vùng viền không đủ 60 phiên warmup bị bỏ hợp lệ).

---

#### F-12 · RAG từ điển đồng nghĩa vĩ mô + hybrid embedding (tuỳ chọn)

**Nguồn gốc:** P1-5 — BM25 tokenizer Việt bỏ dấu: truy vấn "lạm phát" không trúng tài liệu nói "CPI"; bỏ ngữ nghĩa.

**Chức năng:** (a) **từ điển mở rộng truy vấn** vĩ mô-tài chính (làm ngay, chi phí 0): lạm phát↔CPI↔inflation, lãi suất↔rate↔SBV, tín dụng↔credit, tăng trưởng↔GDP, tỷ giá↔FX↔VND=X, trái phiếu↔bond↔TPCP, thanh khoản↔liquidity… — expand query trước khi chấm BM25; (b) khung `EmbeddingProvider` tùy chọn (default OFF): khi có provider (API embedding tương thích), điểm hybrid = 0,5·BM25norm + 0,5·cosine, embedding cache trong bảng RAG doc hiện có.

**File:** sửa `src/lib/ml/rag.ts` (MACRO_SYNONYMS + query expansion + interface provider) · `docs/DATA_SOURCES.md` ghi rõ provider tùy chọn.

**Gate nghiệm thu:** truy vấn "lạm phát" trúng ≥ 1 doc chứa "CPI" (chạy tay qua API log truy hồi — có sẵn retrieval log UI); retrieval@8 tăng khi đo trên 20 truy vấn chuẩn.

---

### NHÓM C — Vòng phản hồi & kiểm soát rủi ro (P1/P2)

#### F-13 · Regime detector + contextual bandit + trạng thái Q giàu hơn

**Nguồn gốc:** P1-7 (Q-table 48×3 thô) + phân tích kinh tế: chính sách 1 bộ cho mọi chế độ thị trường là sai về kinh tế học (hành vi tăng/giảm/ngang khác nhau căn bản).

**Chức năng:** (a) nhãn chế độ hằng ngày từ `src/lib/quant/regime.ts` (đã có — chuẩn hoá đầu ra 3 mức BULL/BEAR/CHOP theo VNINDEX MA50/MA200 + vol; persist AppSetting `market-regime` rolling); (b) **bandit theo ngữ cảnh**: BanditArm mở posterior theo (arm × regime) — 3 khối Beta; rút thăm theo regime hiện tại; (c) Q-learning: thêm bit regime vào state (48 → 96 trạng thái, giữ 3 hành động — tăng vừa đủ, không nổ không gian).

**Thiết kế:** Prisma: `BanditArm` thêm cột JSON `regimeStats {BULL:{a,b}, BEAR:{a,b}, CHOP:{a,b}}` (mặc định null = dùng bảng chung — tương thích dữ liệu cũ); settle ghi vào cả khối chung và khối regime; UI bandit-block hiển thị posterior theo regime hiện tại + Wilson CI (F-15).

**Gate nghiệm thu:** ≥ 100 pulls/arm chung (điều kiện F-15) trước khi arm regime có trọng số quyết định; nếu 1 regime chưa đủ 10 pulls → khối regime fallback bảng chung (khai bảo trong UI).

---

#### F-14 · Monte Carlo VaR kịch bản vĩ mô cho hội đồng rủi ro

**Nguồn gốc:** review P2 + phân tích kinh tế: hội đồng có thể đọc "US10Y +50cb thì sao?" nhưng không có công cụ định lượng kịch bản.

**Chức năng:** module `src/lib/risk/scenario.ts` (mới, 0 LLM): (a) ước lượng hệ số tải (beta) từng vị thế hiện có so với {VNINDEX, US10Y, DXY, GC=F} bằng hồi quy 250 phiên; (b) mô phỏng Monte Carlo 10.000 đường (Cholesky từ ma trận hiệp phương sai yếu tố — đã có `quant/statistics.ts`) + **kịch bản stress tĩnh**: US10Y +50cb · DXY +2% · VND −2% · hàng hoá ±10%; (c) báo cáo VaR95/99 + expected shortfall + P&L từng kịch bản → khối prompt risk-manager + UI tab Danh mục.

**Gate nghiệm thu:** kịch bản stress cho ra P&L đúng dấu theo beta (mã beta dương với VNINDEX lỗ khi VNINDEX −3%); chạy < 2s cho ≤ 10 vị thế; không đủ dữ liệu beta → khai báo "chưa đủ lịch sử" cho mã mới niêm yết.

---

#### F-15 · Sức mạnh thống kê Bandit: backlog settle + Wilson CI

**Nguồn gốc:** P1-4 — 28 pulls/arm; `SETTLE_SCAN_LIMIT = 30` quét 30 phiếu gần nhất: phiếu cũ hơn 5 phiên chưa settle bị "quên" → mất reward → posterior thiếu mẫu.

**Chức năng:** (a) settle quét theo **con trỏ ID** (persist `lastSettledEventId` trong AppSetting) thay vì `take 30` — không phiếu nào bị bỏ; (b) UI bandit-block + council hiển thị **khoảng tin cậy Wilson 95%** cạnh mỗi posterior + mốc "≥100 pulls = tin khoảng cách"; (c) log pulls/tháng vào ml/analytics để theo dõi tốc độ tích luỹ mẫu.

**File:** sửa `src/lib/ml/bandit.ts` (con trỏ + `wilsonCi(mean, n)` ~10 dòng) · `src/components/dashboard/ml/bandit-block.tsx` (cột CI).

**Gate nghiệm thu:** chạy settle 2 ngày liên tiếp → 0 phiếu quá hạn 5 phiên chưa settle (script verify quét BanditEvent so AgentRun thời gian); UI hiển thị CI mọi arm.

---

### NHÓM D — Vận hành chất lượng dữ liệu vĩ mô (P2)

#### F-16 · Quy tắc chất lượng Q10–Q13 + lịch công bố chuỗi vĩ mô

**Nguồn gốc:** §5 DATA_SOURCES có Q1–Q9 cho dữ liệu giá; chuỗi vĩ mô có 4 tính chất mới phải hoá quy tắc: **chậm công bố · đa dạng đơn vị · lịch release cố định · sửa số hồi cứu** (GSO revises).

**Chức năng — 4 quy tắc mới vào §5:**

| # | Quy tắc | Thực thi |
|---|---|---|
| Q10 | **Point-in-time release** | MacroObservation chỉ hợp lệ cho feature/prompt nếu `releaseAt ≤ asOf` — mọi loader bắt buộc kiểm tra (N4) |
| Q11 | **Đơn vị khai báo 1 chỗ** | `MacroSeries.unit` là nguồn duy nhất; hiển thị format theo unit; cấm heuristic ở tầng tiêu thụ |
| Q12 | **Dedupe kỳ + sửa số** | upsert theo `(seriesId, periodLabel)`; bản `real` đè `extracted`; số bị sửa → giữ `releaseAt` gốc của bản mới + cờ `revised` (lịch sử feature KHÔNG viết lại — chống survivorship con số) |
| Q13 | **Stale theo tần suất** | monthly > 45 ngày không có kỳ mới → DataSourceStatus `macro-vn` stale + cảnh báo (không đợi 4h như nguồn giá) |

Kèm **lịch công bố tĩnh** (config JSON `src/lib/macro-calendar.ts`): GSO CPI ~29 hằng tháng · GDP quý ~T+20 ngày · SBV họp tối đa 4 lần/năm · PMI đầu tháng — UI hiển thị "kỳ release kế tiếp" để trader biết thiếu là đang chờ hay đang hỏng.

---

## 4. Lộ trình tích hợp (thứ tự phụ thuộc — không phá kiến trúc)

```
GĐ1 · Tuần 1–3   "Cho não nhìn kinh tế + mất bias"
 ├─ F-12a từ điển đồng nghĩa RAG (1 ngày, đứng độc lập)
 ├─ F-04 sentiment daily (2 ngày) ─┐
 ├─ F-03a flow feature từ DB hiện có (2 ngày) ├→ F-01 v3-macro 16→24 (1 tuần, sweep gate)
 ├─ F-11 point-in-time universe (3 ngày — dùng cho cả train v2 lẫn v3)
 └─ F-02 Pha A MacroSeries + trích xuất có trích dẫn (1 tuần)
                              │
GĐ2 · Tuần 4–7   "Não mạnh hơn + học trọng số"
 ├─ F-07 meta-learner trọng số (persist giọng nói từ tuần 1 — tích luỹ mẫu)
 ├─ F-08 calibration isotonic + per-class report
 ├─ F-10 XREL quốc tế (căn giờ d+1) — bảng truyền dẫn lớp 3 cho A20
 ├─ F-09 multitask (vào sweep như ứng viên, không vội serving)
 └─ F-03b/F-05/F-02 Pha B — mở khi có egress (pipeline đã sẵn)
                              │
GĐ3 · Tuần 8+    "Vòng phản hồi chặt"
 ├─ F-15 backlog settle + Wilson CI (tiền điều kiện F-13)
 ├─ F-13 regime + contextual bandit (cần ≥100 pulls)
 ├─ F-14 Monte Carlo VaR kịch bản
 └─ F-16 hoàn thiện Q10–Q13 + lịch công bố → cập nhật DATA_SOURCES.md §5
```

**Điểm dừng an toàn:** hết GĐ1 hệ thống đã "nhìn" kinh tế (8 chiều vĩ mô + sentiment + flow + không bias sống sót) — dù GĐ2/GĐ3 hoãn vô thời hạn, mục tiêu phân tích đã nâng một bậc.

---

## 5. Những gì KHÔNG được đụng vào (kế thừa nguyên từ review #125)

1. **Tách 3 kênh học** (giá→MLP · uy tín→Bandit · ký ức→RAG) — mọi chức năng trên chỉ THÊM dữ liệu vào kênh, không trộn kênh.
2. **D-LEDGER chấm cả tín hiệu bị cổng bác** — F-07 học từ chính nguồn này; tuyệt đối không lọc bỏ phiếu bị bác.
3. **GRU shadow 60 phiên + cổng Brier + kill-switch 5 phiên** — cơ chế "không nhận máy mù"; F-07/F-08 chỉ làm nó sắc hơn.
4. **Registry MlModel versioned + seed cố định + PSI drift + sweep Chủ nhật** — mọi model mới (v3-macro, multitask, learned-weights) đi qua đúng luồng này.
5. **Trung thực số liệu** — nếu v3-macro không thắng sweep: ghi `whyRejected`, giữ 39,4% và báo đúng. Kỷ luật này là điểm sáng nhất của hệ thống.

---

## 6. Chốt

Phân tích kinh tế học trả lời *"bộ não cần nhìn gì"* (3 lớp top-down); tài liệu này trả lời *"gắn vào đâu cho đúng"*: **16 chức năng, 100% tái sử dụng adapter pattern – UnitSpec – DataSourceStatus – sweep gate – D-LEDGER – bandit**, mỗi chức năng có gate nghiệm thu đo được và kill-switch. Không chức năng nào đòi hỏi viết lại tầng — chỉ thêm vào các điểm neo đã verify. Sau GĐ1, não đã nhìn đủ 3 lớp dữ liệu; chất lượng dự báo tăng hay không sẽ do sweep trả lời bằng số — và hệ thống sẽ báo đúng con số đó, kể cả khi nó không tăng.

---

## Change Log

| Ngày | Thay đổi |
|---|---|
| 17/10/2026 | **v2 — chuyển đổi full:** tài liệu từ "review findings" (#125) chuyển thành **đặc tả 16 chức năng kỹ thuật F-01→F-16** theo 4 nhóm (A đường dữ liệu · B chất lượng não · C phản hồi/rủi ro · D vận hành DQ), mỗi chức năng có thiết kế/file/Prisma/API-Job/gate nghiệm thu/phụ thuộc; thêm ma trận chuyển đổi phát hiện→chức năng (§2), lộ trình phụ thuộc 3 giai đoạn (§4), 6 nguyên tắc chuyển đổi N1–N6 (§0), baseline đo tại #126 (§1); giữ nguyên danh mục "không đụng" (§5) |
| 17/10/2026 | v1 — review kiến trúc & vận hành bộ não: phán quyết 5 khía cạnh, findings P0-1→P0-3, P1-1→P1-7, P2, lộ trình 3 giai đoạn khái quát |

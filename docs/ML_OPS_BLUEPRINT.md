# ML OPS BLUEPRINT — NHÓM HỌC MÁY: ĐÁNH THỨC VÒNG PHẢN HỒI, ĐẶC TRƯNG CHUỖI & CỔNG BẰNG CHỨNG GRU

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/ML_OPS_BLUEPRINT.md` · **Version:** 1.0 · **Created:** 2026-10-10 (phiên #78 — gộp **Giai đoạn A + B thành MỘT blueprint** theo chỉ đạo của trader: "Gộp cả A và B vào trong 1 blueprint đi")
> **Status:** **BẢN NHÁP — CHỜ TRADER DUYỆT** (triển khai theo giao thức §7: soạn → chốt → triển khai → fixbug)
> **Nguồn kế thừa:** review `77-ML-TEMPORAL-REVIEW` (khung temporal 5 lớp + câu hỏi LSTM) · kiểm kê `76-ML-ARCH-1a` (7 agents + 8 runners + bằng chứng file:dòng) · ánh xạ `76-ML-DOC-MAP` (4 tài liệu 79 trang theo thấu kính ML) · hấp thụ **L1–L5 đã duyệt** từ [ML_LEARNING_BLUEPRINT.md](./ML_LEARNING_BLUEPRINT.md) v1.0.1 (phiên #51)
> **Nguồn tri thức (4 tài liệu user tải lên, `upload/` gitignored):** `Machine Learning.pdf` 20 trang **[ML]** · `MATH.pdf` 14 trang **[MATH]** · `Data Analytics.pdf` 29 trang **[DA]** · `DEEP LEARNING.pdf` 16 trang **[DL]** — mọi hạng mục gắn nhãn nguồn kèm cụm nội dung.
> **Cross-refs:** [EXECUTION_OPS_BLUEPRINT.md](./EXECUTION_OPS_BLUEPRINT.md) (pattern triển khai P0→P1 + giao thức fixbug 3 vòng đối kháng) · [DATA_PLATFORM_BLUEPRINT.md](./DATA_PLATFORM_BLUEPRINT.md) (FeatureContract P0-3 · PIT P1-2 · rổ topByAdtv P0-2) · [MARKET_EXPANSION_BLUEPRINT.md](./MARKET_EXPANSION_BLUEPRINT.md) (B7 ensemble · B8 scorecard/Brier · B9 cổng đồng thuận) · [CONTROL_RISK_QUANT_BLUEPRINT.md](./CONTROL_RISK_QUANT_BLUEPRINT.md) (CRB-1 σ regime) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [Fixbug.md](../Fixbug.md)
> **Người soạn:** Kỹ sư AI / Kiến trúc sư hệ thống (phiên #78)

---

## §0. Chẩn đoán trung thực hiện trạng (đo trực tiếp 2026-10-10)

### 0.1 Nhóm Học máy hôm nay (từ 76-ML-ARCH-1a, kiểm chứng chéo #77)

7 agents (roster `agent-roster.ts` nhóm `ml` — Phòng Học máy): learning-rag A13 · backtest A14 · rl-gym S3 · rl-policy A16 · dl-trainer A17 · rl-trainer A18 · model-registry A19 — chạy Đợt B song song trong chu kỳ 23 agents. Thành phần ML thật:

| Thành phần | Vị trí | Hiện trạng đo |
|---|---|---|
| Ensemble dự báo | `ml/ensemble.ts` | 0,7×MLP + 0,3×tanh(z-linreg) · deadband ±0,05 · ml-forecast là cử tri thứ 6 của Bayes (B7) |
| MLP | `ml/nn.ts` | 10→16→8→3 = **339 tham số** · Adam viết tay · cut 80/20 THEO THỜI GIAN · seed 42 deterministic · serving v8 valAcc **39,42%** (baseline 33%) · 60k mẫu |
| Đặc trưng | `ml/features.ts` | 10 đặc trưng cửa sổ cố định (1/5/10/14/20/26/50/60 phiên) · PIT windowHash SHA-256 · rổ topByAdtv HOSE-STOCK |
| Q-learning | `ml/rl.ts` | 48 state (trend2×RSI4×mom2×exposure3) × 3 action · γ 0,95 · serving v5 stance "giảm" |
| Bandit | `ml/bandit.ts` | Thompson Beta-Bernoulli 6 arm · settle 5 phiên ±0,5% rổ top-10 |
| Kiểm định | A14 backtest | 1 chiến lược equal-weight 90 phiên |

### 0.2 Vòng học bandit — chẩn đoán SỬA CHÍNH so với #77 (đo mới 2026-10-10)

Phát biểu #77 "bandit DORMANT" cần tinh chỉnh — **cơ chế KHÔNG hỏng, nó chưa kịp đóng**:

1. `BanditEvent = 0` trên 35 assessment, 6 arm toàn Beta(1,1) pulls=0 — ĐÚNG.
2. Nguyên nhân đo được: assessment **cũ nhất = 2026-10-06T18:25Z** (trùng ngày migrate Supabase). Settle cần **5 phiên giao dịch TƯƠNG LAI** sau createdAt (`bandit.ts:250-252`) → assessment 10-06 chỉ mới có 3 phiên (10-07/08/09). **Chốt đầu tiên sẽ tự rơi vào 10-13 (thứ Ba)** nếu có settle chạy.
3. Nhưng `settlePendingRewards` chỉ được gọi từ (a) chu kỳ agent Đợt B (`agent-service-runs.ts:1138`) và (b) nút train thủ công (`api/ml/train/route.ts:235`) — **không có lịch riêng**. Scheduler chu kỳ agent đang **TẮT** (`AGENT_CYCLE_MINUTES=0` mặc định, không override trong .env). → Không ai bảo đảm vòng học được đóng đúng hạn.
4. Phiếu bầu tồn tại thật: `detail.agentVotes` đủ 6 cử tri kèm confidence (đo mẫu hôm nay) — dữ liệu vào hoàn chỉnh.

→ **Giai đoạn A1 là việc cấp thiết số 1 của blueprint này: cấp lịch cho settle, tách khỏi chu kỳ agent (đắt, LLM) và nút bấm (phụ thuộc con người).**

### 0.3 Kiến trúc temporal 5 lớp — chỗ thiếu (từ review #77)

| Lớp nhớ | Hiện trạng | Hành động |
|---|---|---|
| Lớp 4 — phản hồi (kết quả thật) | 🔴 vòng bandit chưa từng đóng · retrain thủ công | **Giai đoạn A** |
| Lớp 1 — đặc trưng (lag/đạo hàm) | 🟡 chỉ 1 timestep nén qua cửa sổ cố định | **Giai đoạn B** |
| Lớp 3 — chính sách (regime-conditioned RL) | 🟡 blueprint L4 đã duyệt, chờ cổng ≥250 phiên/regime | giữ cổng §6 |
| Lớp 2 — mô hình (GRU/LSTM chuỗi) | 🔴 không có — **chỉ mở khi cổng bằng chứng B2 bật** | **Giai đoạn B (gated)** |
| Lớp 5 — tri thức (RAG/lesson) | 🟡 L1-L5 đã duyệt #51, 0 dòng code | giữ cổng §6 |

### 0.4 Nhịp dữ liệu vào Supabase (đo trực tiếp 2026-10-10 — trả lời câu hỏi của trader)

| Luồng | Nhịp | Bảng ghi | Đo hôm nay (T7 10-10, 20:36 ICT) |
|---|---|---|---|
| EOD dchart VNDIRECT | **15:45 ICT hằng ngày** (engine `EOD_SYNC_AT`) | `Bar` 75 mã thật, cột PIT `firstSeenAt/lastSyncedAt` | ✅ engine-state `eodSyncDate=2026-10-10` · `lastEodSyncAt` 18:42 ICT · dữ liệu tới phiên **10-09 đủ 75 mã** |
| Tick bảng giá | **10 giây** (`TICK_MS`, strict-session T2-T6 09:00-15:00 ICT) | `Quote` — **UPSERT latest-only 76 dòng** (không phải chuỗi lịch sử!) | ✅ tick 200 liên tục · tradedAt mới nhất 18:27 ICT |
| News RSS 5 nguồn VN | 15 phút (`NEWS_MS`) | `NewsItem` | ✅ lastSuccessAt hôm nay |
| Intl Yahoo (B12) | 06:15 ICT hằng ngày | Bar quốc tế | ⚠️ **failStreak 3** hôm nay — theo dõi, không chặn A/B |
| Chu kỳ agent 23 | **TẮT** (scheduler mặc định 0 — chỉ chạy khi bấm/E2E) | `MarketAssessment` + `AgentMessage` | assessment mới nhất 15:21 ICT (E2E #74) |
| Settle bandit | **KHÔNG có lịch riêng** (chỉ theo chu kỳ agent / nút train) | `BanditEvent` + `BanditArm` | 🔴 0 event — A1 vá |
| Retrain ML | thủ công (nút bấm) | `MlModel` | serving dl-mlp v8 + rl-q v5 (10-08) |

**Kết luận trung thực cho trader:** dữ liệu **hàng ngày** CÓ tự động vào Supabase (15:45 ICT, hôm nay đã chạy, kèm dấu PIT mỗi lần sync). Dữ liệu **"hàng giờ"**: bảng giá được cập nhật mỗi 10 giây trong phiên NHƯNG **chỉ lưu trạng thái cuối của từng mã** — không lưu chuỗi lịch sử phút/giờ. Độ phân giải thời gian duy nhất của chuỗi giá để AI học hiện là **NGÀY** (Bar EOD). Đây chính là rào chắn thật của lớp mô hình chuỗi (§4 B4 + cổng §6: dữ liệu intraday 5-phút từ MARKET_EXPANSION là chìa khoá mở).

## §1. Nguyên tắc bất biến (kế thừa + bổ sung)

1. **PIT tuyệt đối** (DATA_PLATFORM v1.3 §5): windowHash SHA-256 · `firstSeenAt` không bao giờ đổi · mọi train kèm biên `trainDateFrom/To`.
2. **Time-split 80/20** — val là block ngày mới nhất; shuffle chỉ trong train split (giữ nguyên `nn.ts:142-147`).
3. **Deterministic** — seed cố định mọi nơi (mulberry32); 2 lần train cùng windowHash phải ra cùng metrics.
4. **Không bịa chất lượng** — mọi chỉ số kèm n và CI (Wilson cho tỉ lệ — L2); n < 30 hiển thị "chưa đủ mẫu".
5. **Serving chỉ khi thắng baseline** trên cùng windowHash (văn hoá CRB: mô hình dưới ngưỡng không lên serving).
6. **Fail-soft + kill-switch** — mọi thành phần mới có AppSetting tắt được; lỗi ML không bao giờ làm hỏng chu kỳ agent (fail-soft §6.6 EXECUTION_OPS).
7. **Viết tay TypeScript thuần** — 0 dependency ngoài stack TS/Bun/Prisma (kế thừa ML_LEARNING_BLUEPRINT §1.1).
8. **Cổng bằng chứng đo được** — không thêm mô hình mới vì "hay để có"; GRU chỉ mở khi B2 xác quyết bằng số liệu trên chính dữ liệu hệ thống.

## §2. Kho tri thức 4 tài liệu → hạng mục dùng (từ bản đồ 76-ML-DOC-MAP, gắn nhãn nguồn)

| Cụm tri thức | Nguồn | Dùng ở hạng mục |
|---|---|---|
| Drift PSI (Population Stability Index, ngưỡng 0,1/0,25) + giám sát mô hình | [DA] mục Monitoring/Drift | **A3** |
| Wilson 95% CI cho tỉ lệ nhị phân · CLT áp đúng chỗ | [DA] Statistics/Confidence | **A2** |
| Brier score + Murphy decomposition (reliability/resolution/uncertainty) · calibration bucket | [ML] Evaluation Metrics + [DA] | **A2** |
| Kiểm định giả thuyết (bootstrap, paired test) | [MATH] Hypothesis Testing + [DA] A/B Testing | **B2 cổng bằng chứng** |
| Rank correlation (Spearman) cho IC đặc trưng | [MATH] + [DA] | **B2** |
| Đặc trưng lag / rolling / multimodal feature engineering | [ML] Feature Engineering | **B1** |
| RNN gating (LSTM 3 cổng · GRU 2 cổng gọn hơn, chống vanishing gradient, vùng dữ liệu nhỏ thường GRU ≥ LSTM) | [DL] RNN/LSTM chương sequence | **B3** |
| Dropout/regularisation cho mạng nhỏ + overfit guards | [ML] + [DL] | **B3** |
| AUC-PR / macro-F1 cho lớp mất cân bằng | [ML] Evaluation | **nghiệm thu B** (đo thêm, không thay Brier làm chỉ số chính) |
| Holt/curve-fit dự báo chuỗi thời gian | [MATH] | ngoài phạm vi — linreg ensemble hiện có đủ |
| GPT-4-as-judge cho bài học L5 | [ML] | giữ ở L5 (ML_LEARNING_BLUEPRINT) |
| PCA/K-Means phân cụm regime | [DA]/[ML] | ngoài phạm vi — regime.ts rule-based đã chạy, L4 sẽ đối chiếu |

## §3. GIAI ĐOẠN A (P0) — ĐÁNH THỨC VÒNG PHẢN HỒI *(điều kiện sống của mọi học sau này)*

### A1 — Lịch settle bandit hàng ngày (tách khỏi chu kỳ agent)

**Vấn đề:** settle đúng cơ chế nhưng không có chủ định lịch — phụ thuộc chu kỳ agent (đắt, đang TẮT) hoặc nút train (thủ công).

**Thiết kế:**
1. Route mới `POST /api/ml/settle` — wrapper mỏng gọi `settlePendingRewards()` (đã có, idempotent qua `settledKeys`), trả `{settled, votes, details}` + `AuditLog` kind `ML_SETTLE` (ghi n phiếu chốt, realized direction, window) — pattern audit giống exec-verify I3 (chỉ ghi, không xoá).
2. Engine (`mini-services/market-engine`) thêm lịch `SETTLE_AT` mặc định **"16:15 ICT"** (sau eod-sync 15:45 + biên độ chạy 48s): scheduler 60s hiện hành kiểm "đã qua 16:15 ICT · `eodSyncDate == hôm nay` · chưa settle ngày này" → `POST /api/ml/settle` (timeout 60s, lỗi chỉ log + retry phút sau, không dồn cục — pattern `eodSyncDate` hiện có).
3. State `lastSettleDate` lưu vào engine-state (P0-5 pattern — restart không mất lịch).
4. Settle là **thuật toán thuần** (quyét Bar + Vote — 0 LLM, ~1-2s) → chạy hằng ngày $0.

**Nghiệm thu A1:** (1) sau 5 phiên giao dịch từ bất kỳ assessment nào, `BanditEvent` xuất hiện đúng hạn không phụ thuộc chu kỳ agent; (2) restart engine giữa chừng không double-settle (idempotent); (3) `AuditLog` ghi đủ truy vết; (4) ngày lễ/T7/CN không chạy (theo `isTradingDay` + eodSyncDate gate).

### A2 — Wilson CI + Brier decomposition + calibration vào scorecard B8 *(hấp thụ L2 đã duyệt #51)*

Từ dữ liệu `BanditEvent` bắt đầu đọng sau A1 — **không thu thập thêm gì, thuần truy vấn**:

1. **Hit-rate kèm Wilson 95% CI** từng arm: `wilson(p̂, n, z=1,96)` — hiển thị "market-analyst: 62% [CI 48–74%] · n=54"; n < 30 → "chưa đủ mẫu".
2. **Brier Murphy decomposition** (reliability − resolution + uncertainty, viết tay ~30 dòng) + **calibration bucket** 5 mức confidence (≤0,4 / 0,4-0,55 / 0,55-0,7 / 0,7-0,85 / >0,85) — đường calibration khai báo vs thực tế.
3. **Posterior Beta trajectory** từng arm theo thời gian settle — thấy "agent từng tốt rồi sa sút".
4. **Bảng agent × regime** (hit-rate từng arm trong BULL/BEAR/SIDEWAYS/VOLATILE — `quant/regime.ts` tính hồi mốc settle).
5. UI: mở rộng scorecard B8 tab "Hiệu năng & calibration" (đã có chỗ trong agents-workspace).

**Nghiệm thu A2:** (1) mọi con số kèm n + CI; (2) Wilson tái lập trên 1.000 (p̂, n) giả lập so thư viện tham chiếu; (3) phân rã Brier thoả bất đẳng thức tổng = reliability − resolution + uncertainty; (4) 0 model DB mới.

### A3 — Drift PSI giám sát đặc trưng

**Vấn đề:** model đóng băng giữa 2 lần train — regime shift vô hình (T2 review #77).

**Thiết kế:**
1. Lúc train (route `/api/ml/train` hiện có): lưu **histogram 10 bucket/dimension** của 10 đặc trưng train vào `MlModel.meta` (`featureHist`) — cùng transaction hiện có, ~2KB.
2. Job đo (gộp vào `GET /api/ml/status`, TTL cache như hiện tại): lấy 30 phiên mới nhất → tính lại đặc trưng qua `rollingFeatures` (FeatureContract P0-3 — không đường tính thứ 2) → PSI = Σ (p_new − p_old)·ln(p_new/p_old) mỗi dimension.
3. Ngưỡng chuẩn [DA]: PSI < 0,1 ổn · 0,1-0,25 CANH BÁO · > 0,25 DỊCH CHUYỂN LỚN → UI badge "Drift" trên ml-panel + cờ `retrainRecommended` trong status payload.
4. Không tự retrain trong A3 (chỉ cảnh báo — retrain lịch ở A4).

**Nghiệm thu A3:** (1) PSI tính đúng trên dữ liệu seeded dịch phân bố (test ≥ 0,25 khi dịch); (2) status API không chậm thêm > 100ms (cache TTL); (3) 0 ghi DB mới ngoài meta lúc train.

### A4 — Retrain định kỳ Chủ nhật 04:00 ICT

1. Engine thêm lịch `ML_TRAIN_AT` mặc định **"SUN:04:00"** (chung cửa sổ reprobe B14 — không thêm cửa sổ vận hành mới) → `POST /api/ml/train` (route hiện có: cooldown 60s + mutex in-flight + settle-trước-train + $transaction archive/create — **đã sẵn đủ an toàn**, A4 chỉ cấp lịch).
2. Guard skip thông minh: nếu windowHash của tập train == meta windowHash bản serving (không có bar mới) → skip, log "không có dữ liệu mới". 
3. Retrain là thuật toán thuần (MLP < 30s + RL ~10s, 0 LLM) → $0. LLM (chu kỳ agent) **không** nằm trong lịch này.

**Nghiệm thu A4:** (1) Chủ nhật chạy đúng 04:00 ICT,次日 engine-state có `lastMlTrainDate`; (2) bản mới chỉ lên serving khi metrics ≥ bản cũ trên cùng windowHash (nguyên tắc §1.5 — route hiện có đã archiving, bổ sung so sánh trước swap `status:"serving"`); (3) skip khi không dữ liệu mới.

## §4. GIAI ĐOẠN B (P1) — ĐẶC TRƯNG CHUỖI v2 + CỔNG BẰNG CHỨNG GRU

### B1 — Đặc trưng lag v2: 10 → 16 chiều *(lớp 1 khung temporal)*

Thêm 6 đặc trưng прошло hoàn toàn từ chuỗi EOD hiện có (PIT-an toàn — chỉ dùng quá khứ):

```
x[11] r_lag1 = logret1(t−1)      x[12] r_lag2 = logret1(t−2)     x[13] r_lag3 = logret1(t−3)
x[14] ΔRSI5  = rsi14(t) − rsi14(t−5)        (quật đảo động lượng RSI)
x[15] Δvolz5 = volz20(t) − volz20(t−5)      (thay đổi tương đối khối lượng)
x[16] sma20slope = sma20(t)/sma20(t−5) − 1  (độ dáng đường trung bình — "hình dạng" tối thiểu)
```

- `ML_FEATURE_COUNT` 10→16 · `featureAt` mở rộng (thứ tự cố định ghi doc-string như hiện tại — serving phụ thuộc thứ tự).
- MLP v2 kiến trúc IN 16 → H1 24 → H2 12 → OUT 3 (**~715 tham số** — vẫn 84 mẫu/tham số danh nghĩa, vùng an toàn so GRU §B3); `nn.ts` tham số hoá IN/H1/H2 (không hardcode) + `fromJSON` arch check "16-24-12-3".
- Versioning: `MlModel.kind` giữ "dl-mlp" — version v9, meta ghi `featureSet: "v2-lag16"`; serving **vẫn là v8** cho tới khi cổng B2 xử quyết (nguyên tắc §1.5).
- Ensemble/Bayes/evidence **không đổi** — chỉ đổi nguồn `predictProba` khi swap serving.

**Nghiệm thu B1:** (1) buildTrainingSet cho 60k mẫu + 16 đặc trưng < 60s; (2) windowHash NHỚNG v1 (hash trên bar — không phụ thuộc đặc trưng) → so trình bày được "cùng dữ liệu, khác bộ đặc trưng"; (3) train v9 deterministic (2 lần cùng hash = cùng metrics); (4) UI ml-panel hiển thị bộ 16 đặc trưng + featureSet nhãn.

### B2 — Cổng bằng chứng (EVIDENCE GATE) — quyết định GRU bằng số liệu, không cảm tính

Script `scripts/ml-evidence-gate.ts` (chạy tay khi cần + có thể gọi từ ml/status "gate" field) — **3 phép đo trên chính dữ liệu hệ thống**:

1. **Autocorrelation lag 1-5** của logret rổ top-20 (bar EOD thật) + CI 95% qua bootstrap 1.000× — trả lời "còn tín hiệu tuần tự không dùng tới ở tần suất ngày?".
2. **Rank-IC (Spearman)** của TỪNG đặc trưng (cả 10 cũ + 6 mới) vs nhãn hướng 5 phiên tới, kèm bootstrap CI — trả lời "đặc trưng mới có mang thông tin không?".
3. **ΔBrier paired bootstrap** (1.000× resample val block): MLP v9-lag16 vs v8-lag10 trên **cùng windowHash** — trả lời "thêm quá khứexplicit có cải thiện xác suất không?".

**Quy tắc xử quyết (ghi cứng vào AppSetting `ml-gate` + meta v9):**
- **PASS → mở B3 (GRU)** khi: CI95 ΔBrier hoàn toàn < 0 (v9 thắng có ý nghĩa) **HOẶC** ≥ 3/6 đặc trưng mới có |rank-IC| ≥ 0,02 với CI loại trừ 0.
- **FAIL → khoá B3**, ghi verdict kèm số liệu vào meta + hiển thị trên ml-panel ("Cổng chuỗi: CHƯA mở — ΔBrier CI [x,y]"); **lịch re-đo mỗi quý** hoặc ngay khi có dữ liệu intraday (§6).
- Trung gian (CI chạm 0) → mặc định an toàn: FAIL.

**Nghiệm thu B2:** (1) script deterministic + in báo cáo JSON đầy đủ (lag, IC, CI, verdict); (2) bootstrap paired đúng cú pháp (resample theo MẪU ghép cặp, không resample độc lập); (3) verdict lưu AppSetting + meta — re-run không thay đổi kết quả trên cùng windowHash.

### B3 — GRU-24 giọng thứ ba, GATED + kill-switch *(chỉ triển khai khi B2 PASS)*

**Chọn GRU trước LSTM** [DL]: 2 cổng (update z, reset r) thay 3 cổng → ít tham số ~25%, trên dữ liệu nhỏ thường bằng hoặc tốt hơn LSTM; đủ chống vanishing gradient cho window 20.

```
Kiến trúc: input 16 đặc trưng × window 20 phiên → GRU cell 24 unit (xét theo từng bước
           thời gian t−19..t, output h_t cuối cùng) → dense 8 ReLU → softmax 3 class
Tham số:  ~2.6k (GRU 3 ma trận × [16+24]×24 + bias + dense) — ghi rõ khi train
Train:    Adam như nn.ts (β1 0,9 β2 0,999 ε 1e-8, LR 0,005 — thấp hơn MLP vì BPTT
          nhiễu hơn) · batch 32 · ≤60 epoch · patience 12 · dropout input 0,2 ·
          class-weight 1/freq · cut 80/20 THEO THỜI GIAN · seed 43 (khác MLP)
File:     src/lib/ml/gru.ts mới (~450 dòng viết tay — cùng phong cách nn.ts,
          Float64Array phẳng, 0 dependency)
Lưu:      MlModel kind "dl-gru" · meta {window:20, featureSet:"v2-lag16", gateVerdict}
```

**Vào ensemble qua 3 lớp bảo vệ:**
1. **Shadow 60 phiên** — GRU predictProba mỗi chu kỳ nhưng KHÔNG vào score; ghi Brier rolling 60 phiên so MLP cùng chu kỳ (model-registry A19 hiển thị).
2. Sau 60 phiên: chỉ khi Brier-shadow ≤ Brier-MLP → lên giọng thứ 3: `W_MLP 0,5 · W_LINREG 0,3 · W_GRU 0,2` (điều chỉnh một lần khi swap, ghi changelog meta).
3. **Kill-switch 2 tầng**: AppSetting `ml-gru` (off mặc định) + A19 tự hạ (archive) khi Brier serving GRU tệ hơn MLP 5 phiên liên tiếp.

**Nghiệm thu B3:** (1) BPTT gradient check trên văn cảnh giả lập (đạo hàm số học khớp解析 4 chữ số); (2) train 60k × window 20 < 20 phút CPU Bun; (3) deterministic seed; (4) MLP/linreg KHÔNG đổi khi GRU off (bit-flip test: tắt AppSetting → ensemble ra đúng kết quả cũ); (5) kill-switch hạGRU trong 1 chu kỳ.

### B4 — Đường khi cổng KHÔNG mở (kỷ luật "không phải bây giờ ≠ không bao giờ")

- Verdict FAIL hiển thị trung thực trên UI + ghi trong docs này (changelog) — không giấu.
- Chỉ số re-đo: mỗi quý HOẶC ngay khi MARKET_EXPANSION bật lưu chuỗi intraday 5-phút (`QuoteHistory/IntradayBar`) — đó là lúc lớp chuỗi gần như chắc chắn mở (SNR tần suất phút >> ngày, sequence length thật sự dài).
- Kỷ luật: không "thử GRU cho biết" ngoài cổng — mọi mô hình mới qua cùng format cổng (nguyên tắc §1.8).

## §5. Kiến trúc dữ liệu & nhịp (đo 2026-10-10 — nền cho A/B)

Xem bảng đo §0.4. Ba hệ quả kiến trúc:

1. **EOD là độ phân giải chuỗi giá duy nhất** → mọi huấn luyện (MLP/RL/GRU) và PIT windowHash đều trên Bar ngày — ổn định, deterministic, đủ cho horizon 5 phiên của hệ thống.
2. **Quote latest-only** → tick 10s nuôi WS/serving/paper-matching nhưng KHÔNG nuôi ML — đúng thiết kế hiện tại (không phí); khi cần intraday cho lớp chuỗi → MARKET_EXPANSION mở bảng mới (ngoài phạm vi blueprint này, tham chiếu cổng §6).
3. **Intl Yahoo failStreak 3** — không chặn A/B (rổ ML khoá HOSE-STOCK), nhưng cần theo dõi B12; nếu kéo dài > 7 ngày → cảnh báo `DataSourceStatus` route riêng (đã có cơ chế markSource).

**Schema thay đổi (additive, tối thiểu):** KHÔNG model mới. Chỉ: `MlModel.meta` thêm trường JSON (`featureHist` A3 · `featureSet`/`gateVerdict` B) + `AppSetting` keys mới (`ml-gate`, `ml-gru`, `ml-settle-schedule`) + `AuditLog` kind `ML_SETTLE` (enum thêm giá trị — additive). BanditArm/BanditEvent **KHÔNG đổi** (confidence đã có từ B8).

## §6. Cổng kích hoạt tổng hợp (dữ liệu thật quyết định — gộp cổng L1-L5 đã duyệt #51 + cổng mới)

| Bước | Cổng mở khi | Dữ liệu đo |
|---|---|---|
| Giai đoạn A (A1-A4) | **Trader duyệt blueprint này** | — |
| B1 (đặc trưng v2) | A hoàn tất (A1 chạy thật ≥ 1 settle) | AuditLog ML_SETTLE |
| B2 (cổng bằng chứng) | B1 train xong v9 | windowHash khớp v8 |
| **B3 (GRU)** | **B2 PASS** (ΔBrier CI < 0 hoặc ≥3/6 đặc trưng mới |IC| ≥ 0,02) | gate verdict AppSetting |
| GRU lên ensemble | Shadow 60 phiên Brier ≤ MLP | A19 rolling Brier |
| L1 BM25 RAG | Trader duyệt (đã có #51) | — |
| L2 analytics | Sau A2 ≥ 1 chu kỳ (đã nằm trong A2) | Wilson hiển thị đúng |
| L3 pgvector | RetrievalLog ≥ 30 ngày & RAG dùng ≥ 10% chu kỳ | truy vấn RetrievalLog |
| L4 RL regime 192-state | ≥ 250 phiên/regime | quét Bar theo nhãn regime |
| L5 AgentLesson | ≥ 3 tháng BanditEvent settle + ≥ 200 phiếu confidence | count BanditEvent |
| Lớp chuỗi đầy đủ (intraday) | MARKET_EXPANSION có bảng intraday 5-phút | số bar intraday |

## §7. Giao thức triển khai & fixbug (kế thừa nguyên vẹn EXECUTION_OPS §v1.2.1)

1. **Soạn** (bản này) → **chốt** (trader duyệt + trả lời §8) → **triển khai A** (P0) → **fixbug A** (3 vòng đối kháng: rà độc lập → vá → xác nhận sạch, hermetic, không đụng prod) → **triển khai B** (P1) → **fixbug B** (cùng giao thức).
2. Mọi hạng mục có script nghiệm thu tự chạy (pattern `exec-verify.ts` 91/91 · `p2-verify.ts` 72/72): A có `ml-ops-verify.ts` (plant dữ liệu seeded → settle → assert BanditEvent + Wilson đúng thư viện tham chiếu + PSI dịch → cảnh báo + retrain skip khi hash trùng); B có `ml-gate-verify.ts` (seeded ΔBrier biết trước → verdict đúng).
3. E2E qua gateway :81 desktop + mobile (0 console error) trước khi commit; commit + push theo PAT store.
4. Bất biến toàn văn §1 + bất biến EXECUTION_OPS §6 (chu kỳ không tự đặt lệnh · plan chỉ sau APPROVE · claim atomic · fail-soft).

## §8. Câu hỏi mở cho trader (trả lời trước khi chốt triển khai A)

1. **A1 lịch settle 16:15 ICT hằng ngày** — duyệt nhịp này? (muộn hơn nếu eod-sync chưa xong thì engine tự chờ — đã thiết kế)
2. **A4 retrain Chủ nhật 04:00 ICT tự động** — duyệt? (thuần thuật toán $0, có skip-guard; trader vẫn có nút train thủ công như cũ)
3. **Chu kỳ agent 23 agents**: giữ TẮT scheduler (thủ công/E2E như hiện tại — kiểm soát chi phí LLM) hay bật `AGENT_CYCLE_MINUTES` (ví dụ 240 phút trong phiên = ~1 chu kỳ/ngày)? *Đề xuất: giữ TẮT — settle A1 đã tách khỏi chu kỳ nên vòng học không phụ thuộc nữa.*
4. **B1 nâng 10→16 đặc trưng** tạo MLP v9 (arch mới, v8 giữ serving cho tới B2 xử quyết) — duyệt cách versioning này?
5. **GRU chỉ mở khi cổng PASS** (B2) + shadow 60 phiên + kill-switch — duyệt级别的 thận trọng này? (Đây là trả lời kiến trúc cho câu hỏi LSTM #77: đúng vị trí, đúng cổng, đúng thứ tự.)

## §9. Changelog

| Version | Ngày | Nội dung |
|---|---|---|
| 1.0 | 2026-10-10 (phiên #78) | Soạn bản đầu — gộp Giai đoạn A (đánh thức vòng phản hồi: A1 settle lịch · A2 Wilson/Brier/calibration · A3 PSI drift · A4 retrain Chủ nhật) + Giai đoạn B (B1 lag16 · B2 cổng bằng chứng bootstrap · B3 GRU-24 gated shadow kill-switch · B4 đường khi cổng đóng) + đo nhịp dữ liệu Supabase §0.4 + hấp thụ L1-L5 cổng từ ML_LEARNING_BLUEPRINT v1.0.1. Chờ trader duyệt §8. |

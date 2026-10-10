# ML OPS BLUEPRINT — NHÓM HỌC MÁY: ĐÁNH THỨC VÒNG PHẢN HỒI, ĐẶC TRƯNG CHUỖI & CỔNG BẰNG CHỨNG GRU

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/ML_OPS_BLUEPRINT.md` · **Version:** 1.3 · **Created:** 2026-10-10 (phiên #78 — gộp **Giai đoạn A + B thành MỘT blueprint** theo chỉ đạo của trader: "Gộp cả A và B vào trong 1 blueprint đi") · **v1.1:** 2026-10-10 (phiên #79 — trader tiết lộ 4 kế hoạch tương lai K1-K4 + uỷ quyền chọn §8 → 5/5 DUYỆT, triển khai Giai đoạn A) · **v1.2:** 2026-10-10 (phiên #81 — triển khai Giai đoạn B: B1 v2-lag16 · B2 cổng đo thật **verdict FAIL** · B3 GRU gated khoá · B4 đường cổng đóng) · **v1.3:** 2026-10-10 (phiên #83 — user hiệu lệnh: triển khai **L1 BM25 RAG** (ML_LEARNING_BLUEPRINT) + **bảng IntradayBar 5-phút** mở đường cổng "Lớp chuỗi đầy đủ")
> **Status:** **GIAI ĐOẠN A ✅ + FIXBUG #80 TRIỆT ĐỂ · GIAI ĐOẠN B ✅ (#81) — CỔNG B2 VERDICT FAIL: GRU KHOÁ THEO B4 · L1 BM25 RAG ✅ TRIỂN KHAI + BẢNG IntradayBar 5-phút ✅ (#83 — thu thập bắt đầu phiên giao dịch kế tiếp, đủ dữ liệu sẽ re-đo cổng B2)**
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

**Nghiệm thu B3:** (1) BPTT gradient check trên văn cảnh giả lập (đạo hàm số học khớp GIẢI TÍCH 4 chữ số — đo thật #81: rel ≤ 2,1e-6 trên 60 vị trí × 13 khối); (2) train 60k × window 20 < 20 phút CPU Bun; (3) deterministic seed; (4) MLP/linreg KHÔNG đổi khi GRU off (bit-flip test: tắt AppSetting → ensemble ra đúng kết quả cũ); (5) kill-switch hạGRU trong 1 chu kỳ.

### B4 — Đường khi cổng KHÔNG mở (kỷ luật "không phải bây giờ ≠ không bao giờ")

- Verdict FAIL hiển thị trung thực trên UI + ghi trong docs này (changelog) — không giấu.
- **KẾT QUẢ ĐO THẬT #81 (2026-10-10, windowHash 30f2d982fa29…, 60k mẫu, val 12k):** ΔBrier = Brier(v2-lag16) − Brier(v1-lag10 cùng cửa sổ) = **+0,0062, CI 95% [+0,0046; +0,0079]** — hoàn toàn >0: bộ 16 đặc trưng THUA về chất lượng xác suất trên cùng dữ liệu. Rank-IC: **0/6** đặc trưng mới đạt |IC| ≥ 0,02 với CI loại trừ 0 (lag1 −0,012 · ΔRSI5 −0,018 — đều dưới ngưỡng). Autocorr lag-1 0,009 CI [−0,017; +0,037] vắt qua 0 — **không còn tín hiệu tuần tự đáng kể ở tần suất ngày**, đúng chẩn đoán §0.4. → **VERDICT: FAIL — GRU khoá, serving giữ v8-lag10 (valAcc 0,3942), UI ml-panel hiển thị "Cổng chuỗi: CHƯA mở" + ΔBrier CI thật.**
- Chỉ số re-đo: mỗi quý HOẶC ngay khi MARKET_EXPANSION bật lưu chuỗi intraday 5-phút (`QuoteHistory/IntradayBar`) — đó là lúc lớp chuỗi gần như chắc chắn mở (SNR tần suất phút >> ngày, sequence length thật sự dài).
- Kỷ luật: không "thử GRU cho biết" ngoài cổng — mọi mô hình mới qua cùng format cổng (nguyên tắc §1.8). `POST /api/ml/train {target:"dl-gru"}` trả 400 kèm lý do khi cổng chưa mở.

## §5. Kiến trúc dữ liệu & nhịp (đo 2026-10-10 — nền cho A/B)

Xem bảng đo §0.4. Ba hệ quả kiến trúc:

1. **EOD là độ phân giải chuỗi giá duy nhất** → mọi huấn luyện (MLP/RL/GRU) và PIT windowHash đều trên Bar ngày — ổn định, deterministic, đủ cho horizon 5 phiên của hệ thống.
2. **Quote latest-only** → tick 10s nuôi WS/serving/paper-matching nhưng KHÔNG nuôi ML — đúng thiết kế hiện tại (không phí); khi cần intraday cho lớp chuỗi → MARKET_EXPANSION mở bảng mới (ngoài phạm vi blueprint này, tham chiếu cổng §6).
3. **Intl Yahoo failStreak 3** — không chặn A/B (rổ ML khoá HOSE-STOCK), nhưng cần theo dõi B12; nếu kéo dài > 7 ngày → cảnh báo `DataSourceStatus` route riêng (đã có cơ chế markSource).

**Schema thay đổi (additive, tối thiểu):** KHÔNG model mới. Chỉ: `MlModel.meta` thêm trường JSON (`featureHist` A3 · `featureSet`/`gateVerdict` B) + `AppSetting` keys mới (`ml-gate`, `ml-gru`, `ml-settle-schedule`) + `AuditLog` action `ML_SETTLE` (cột String sẵn có — không cần migrate). BanditArm/BanditEvent **KHÔNG đổi** (confidence đã có từ B8).

## §6. Cổng kích hoạt tổng hợp (dữ liệu thật quyết định — gộp cổng L1-L5 đã duyệt #51 + cổng mới)

| Bước | Cổng mở khi | Dữ liệu đo |
|---|---|---|
| Giai đoạn A (A1-A4) | **ĐÃ DUYỆT (phiên #79) + ĐÃ TRIỂN KHAI + FIXBUG #80 TRIỆT ĐỂ** | — |
| B1 (đặc trưng v2) | **ĐÃ TRIỂN KHAI #81** (A1 chạy thật ≥ 1 settle) | AuditLog ML_SETTLE · bản v13+ v2-lag16 đã train |
| B2 (cổng bằng chứng) | **ĐÃ ĐO #81 — verdict FAIL** (train xong v2-lag16, windowHash khớp) | AppSetting `ml-gate` — ΔBrier CI [+0,0046; +0,0079] · 0/6 đặc trưng mới có ý nghĩa |
| **B3 (GRU)** | **KHOÁ (B2 FAIL)** — code gru.ts sẵn sàng gated, chỉ train khi verdict PASS | `POST /api/ml/train {target:"dl-gru"}` chặn 400 trung thực |
| GRU lên ensemble | Shadow 60 phiên Brier ≤ MLP (chỉ khi B3 mở) | A19 rolling Brier |
| L1 BM25 RAG | Trader duyệt (đã có #51) | ✅ **ĐÃ TRIỂN KHAI #83** — rag.ts · RetrievalLog · tiêm 6 prompt LLM |
| L2 analytics | Sau A2 ≥ 1 chu kỳ (đã nằm trong A2) | Wilson hiển thị đúng |
| L3 pgvector | RetrievalLog ≥ 30 ngày & RAG dùng ≥ 10% chu kỳ | truy vấn RetrievalLog |
| L4 RL regime 192-state | ≥ 250 phiên/regime | quét Bar theo nhãn regime |
| L5 AgentLesson | ≥ 3 tháng BanditEvent settle + ≥ 200 phiếu confidence | count BanditEvent |
| Lớp chuỗi đầy đủ (intraday) | MARKET_EXPANSION có bảng intraday 5-phút | ✅ **BẢNG ĐÃ CÓ (#83 — IntradayBar)** — tick 10s gom bucket 5-phút tự động trong phiên; thu thập bắt đầu phiên giao dịch kế tiếp; số bar đo ở ml/status field `intraday`; đủ dữ liệu → re-đo cổng B2 |

## §7. Giao thức triển khai & fixbug (kế thừa nguyên vẹn EXECUTION_OPS §v1.2.1)

1. **Soạn** (bản này) → **chốt** (trader duyệt + trả lời §8) → **triển khai A** (P0) → **fixbug A** (3 vòng đối kháng: rà độc lập → vá → xác nhận sạch, hermetic, không đụng prod) → **triển khai B** (P1) → **fixbug B** (cùng giao thức).
2. Mọi hạng mục có script nghiệm thu tự chạy (pattern `exec-verify.ts` 91/91 · `p2-verify.ts` 72/72): A có `ml-ops-verify.ts` (plant dữ liệu seeded → settle → assert BanditEvent + Wilson đúng thư viện tham chiếu + PSI dịch → cảnh báo + retrain skip khi hash trùng); B có `ml-gate-verify.ts` (seeded ΔBrier biết trước → verdict đúng).
3. E2E qua gateway :81 desktop + mobile (0 console error) trước khi commit; commit + push theo PAT store.
4. Bất biến toàn văn §1 + bất biến EXECUTION_OPS §6 (chu kỳ không tự đặt lệnh · plan chỉ sau APPROVE · claim atomic · fail-soft).

## §8. Câu hỏi mở — ĐÃ TRẢ LỜI (phiên #79: trader uỷ quyền chọn theo 4 kế hoạch tương lai)

> **Trader tiết lộ 4 kế hoạch tương lai (2026-10-10) và uỷ quyền kỹ sư tự chọn phương án tối ưu cho chúng:**
> - **(K1) Cơ chế thử nghiệm** — module Cài đặt: nhập số tiền ảo → bấm kích hoạt → tiền mặc định cấp cho hệ agents thực hiện các giao dịch thử nghiệm; sự tăng/giảm của số tiền theo thời gian chính là quá trình học phân tích thị trường & đầu tư của agents.
> - **(K2) Nút "Chạy agent" = chế độ liên tục** — một khi bấm, các agent/nhóm tự động bắt đầu công việc; chỉ ngừng khi trader tự tay bấm tắt.
> - **(K3) Nhiệm vụ (module Đội agents)** — phần nhiệm vụ từng agent sẽ là nơi thiết lập công việc hàng ngày/hàng tuần cho agents.
> - **(K4) Ban Điều hành & Thực thi** — sau này được xây khả năng thiết lập Nhiệm vụ cho agents thuộc các nhóm khác.

| # | Câu hỏi | QUYẾT ĐỊNH | Lý do gắn 4 kế hoạch |
|---|---|---|---|
| 1 | A1 — lịch settle 16:15 ICT hằng ngày | ✅ **DUYỆT** | K1: settle là vòng "chấm bài" phiếu bầu — tiền ảo tăng/giảm chỉ thành bài học khi phiếu được đối chiếu realised đều đặn hằng ngày; A1 đã tách khỏi chu kỳ agent nên độc lập với K2 |
| 2 | A4 — retrain Chủ nhật 04:00 ICT tự động | ✅ **DUYỆT** | K1: agents học liên tục qua giao dịch thử nghiệm → mô hình không được đóng băng giữa 2 lần bấm nút; skip-guard windowHash giữ an toàn; $0 thuần thuật toán |
| 3 | Chu kỳ agent 23 agents | ✅ **BẬT `AGENT_CYCLE_MINUTES=240`** (cầu nối cho K2) | K2 muốn agents tự chạy liên tục — bật nhịp 4h ngay làm nền vận hành: sinh phiếu bầu dày cho bandit (A2 có số sớm hơn) + hệ thống làm quen chu kỳ tự động trước khi K1/K2 xây UI toggle; $0 (Zen free tier). Khi K1/K2 hoàn tất, quyền kiểm soát chuyển về AppSetting + nút UI (env thành mặc định hậu phương) |
| 4 | B1 — versioning v9 train / v8 serving tới cổng | ✅ **DUYỆT** | K1: mô hình tương lai sẽ hoán đổi thường xuyên theo P&L sandbox — pattern train→shadow→gate→swap→kill trở thành chuẩn dùng lại cho mọi lần swap |
| 5 | B3 — GRU gated + shadow 60 phiên + kill-switch | ✅ **DUYỆT** | K1 chính là "thử nghiệm có kiểm soát" — GRU gated cùng triết lý. **Điểm tích hợp tương lai:** khi K1 hoạt động, hiệu suất giọng GRU trong sandbox (P&L/đóng góp) trở thành tín hiệu bổ sung cho kill-switch/thăng giọng bên cạnh Brier |

> **Ghi chú kiến trúc cho 4 kế hoạch (ghi lại đây để các phiên tương lai đối chiếu):** K2/K3/K4 đều cần một "chủ lịch" chung — engine scheduler (mini-service :3003) là ứng viên tự nhiên (đã có pattern kiểm 60s + state P0-5 + fail-soft, sẽ được mở rộng qua A1/A4); model `AgentTask` có sẵn trong schema là nền cho K3/K4; cơ chế tiền ảo K1 nên dùng `BrokerAccount` loại sandbox + AuditLog faucet để tách bạch khỏi paper account hiện tại.

## §9. Changelog

| Version | Ngày | Nội dung |
|---|---|---|
| 1.3 | 2026-10-10 (phiên #83) | **User hiệu lệnh triển khai L1 + bảng intraday 5-phút.** (1) **L1 BM25 RAG** (ML_LEARNING_BLUEPRINT §2): `src/lib/ml/rag.ts` (~460d — tokenizer VN không stemming · corpus 500 AgentMessage broadcast + 200 NewsItem · BM25 k₁ 1,5/b 0,75 + 0,3·recency nửa đời 72h · chỉ hit có BM25>0 vào top — chống top-8 thuần recency) · model **RetrievalLog** (query Json · results Json · usedInPrompt) · tiêm khối ≤1.200 token (cap 3.000 ký tự) vào prompt **5 agent nghiên cứu + Chủ tịch** cả chu kỳ (api/agents/run — 1 retrieval/chu kỳ sau snapshot) lẫn single-run (buildSingleRunPrompt) · nhãn "TRI THỨC TRUY HỒI (RAG…)" + ghi chú vô hại hoá (ngữ cảnh quá khứ, không phải bằng chứng — chống đếm kép T7.5) · **A13 learning-rag nâng cấp** từ "chỉ đếm" thành báo cáo corpus + 30 ngày RetrievalLog · ml/status field `rag` (additive) + UI ml-panel khối "Tri thức truy hồi (L1)" · Nghiệm thu: rank 700 docs **3ms ≤ 50ms** · query VCB trả đúng tin nhắn nhắc VCB · E2E single-run market-analyst 4.551 tokens input (trước ~3.154 — khối RAG ~1.200 token vào prompt thật) · E2E chu kỳ 23 agents 43,3s: [rag] log 8/700 docs · block 2.662 ký tự · A13 báo "3 lần truy hồi — 100% tiêm prompt". (2) **Bảng IntradayBar 5-phút**: model mới (instrumentId · startTime neo floor UTC 5-phút · OHLCV delta · source simulated/realtime-finfo · tickCount độ phủ · firstSeenAt PIT · unique [instrumentId, startTime]) · `src/lib/intraday.ts` (recordIntradayTick thuần cache 0 DB · flush chunk 10: bucket đóng ở biên + safety-flush 120s · flushAll ngoài phiên đóng sổ) · tick route pha 3 + payload `intradayBarsWritten` · **API GET /api/market/intraday** (symbol/days/day + coverage bucket kín tickCount ≥ 25) · ml/status field `intraday` + UI khối "Chuỗi intraday 5-phút" · script `scripts/intraday-verify.ts` hermetic **13/13 PASS** (bắt + vá bug identity: flush bucket đóng xoá nhầm bucket mới trong map — giờ chỉ xoá khi map giữ đúng object) · tự dọn TEST-IB cascade. Restart dev-server để nạp Prisma Client mới (db:push + generate). Chairman chu kỳ E2E gặp Zen 429 rate-limit (môi trường — fail-soft, 20/21 agents + assessment OK). |
| 1.2 | 2026-10-10 (phiên #81) | **TRIỂN KHAI GIAI ĐOẠN B** — B1: `features.ts` v2-lag16 (10→16 chiều, 6 lag/đạo hàm PIT-safe, 10 chiều đầu giữ nguyên — v8 serving đọc x[0..9] tương thích ngược) · `nn.ts` tham số hoá arch (16→24→12→3 = 747 tham số, fromJSON nạp cả "10-16-8-3" cũ) · train route meta.featureSet + promotion guard featureSet-aware (khác bộ đặc trưng chỉ lên serving khi cổng PASS) + skip-guard so hash VÀ featureSet · status route thêm field `dlMlp.featureSet` + `gate` + `gru` (additive) · UI badge featureSet + khối "Cổng bằng chứng chuỗi". B2: `scripts/ml-evidence-gate.ts` (autocorr lag 1-5 + rank-IC 16 đặc trưng + ΔBrier paired bootstrap 1.000× — deterministic seed 20261011, chạy 2 lần cùng số liệu) → **VERDICT FAIL** (ΔBrier CI [+0,0046; +0,0079] > 0 · 0/6 đặc trưng mới có ý nghĩa) → AppSetting `ml-gate` + meta.gateVerdict · serving giữ v8 (không swap). B3: `gru.ts` GRU-24 viết tay BPTT đầy đủ (3.179 tham số, gradient check numeric khớp giải tích rel ≤ 2,1e-6) + ensemble giọng thứ ba GATED (shadow 60 phiên + kill-switch 2 tầng AppSetting `ml-gru` off mặc định + bit-flip verify không model → ensemble ra kết quả cũ) + train target dl-gru chặn 400 khi cổng FAIL. B4: hiển thị trung thực trên UI + ghi §4 B4 kết quả đo. Nghiệm thu: train 2 lần deterministic (valAcc 0,395 · epochs 24 khớp tuyệt đối) · windowHash không đổi giữa v13-lag16 và v12-lag10 (cùng dữ liệu khác đặc trưng) · skip-guard skip khi hash+featureSet trùng · GRU 400 kèm verdict · E2E desktop+mobile 0 console error. Fixbug-B Vòng 1: F-B811-01 toast promoted=false nói đúng lý do (thêm promotionReason — trước hiện "39,5% < 39,4%" sai sự thật khi lý do là cổng featureSet) · F-B811-02 buildTrainingSequences khởi đầu t warmup+W−1 (19 phiên đầu mỗi mã từng bị bỏ âm thầm). |
| 1.1 | 2026-10-10 (phiên #79) | Trader tiết lộ 4 kế hoạch tương lai (K1 cơ chế thử nghiệm tiền ảo · K2 nút Chạy agent = chế độ liên tục · K3 Nhiệm vụ = công việc ngày/tuần · K4 Ban Điều hành giao nhiệm vụ) + uỷ quyền chọn §8 → 5/5 DUYỆT (Q3: bật `AGENT_CYCLE_MINUTES=240` làm cầu nối K2) — bắt đầu triển khai Giai đoạn A. Sửa chi tiết §5: AuditLog.action là String (0 migrate). |
| 1.0 | 2026-10-10 (phiên #78) | Soạn bản đầu — gộp Giai đoạn A (đánh thức vòng phản hồi: A1 settle lịch · A2 Wilson/Brier/calibration · A3 PSI drift · A4 retrain Chủ nhật) + Giai đoạn B (B1 lag16 · B2 cổng bằng chứng bootstrap · B3 GRU-24 gated shadow kill-switch · B4 đường khi cổng đóng) + đo nhịp dữ liệu Supabase §0.4 + hấp thụ L1-L5 cổng từ ML_LEARNING_BLUEPRINT v1.0.1. Chờ trader duyệt §8. |

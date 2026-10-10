# EXECUTION & OPERATIONS BLUEPRINT — NHÓM ĐIỀU HÀNH & THỰC THI: CHỦ TỊCH TỔNG HỢP, PHÊ DUYỆT LỆNH, BÙ TRỪ SỔ SÁCH & DÒNG TIỀN

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/EXECUTION_OPS_BLUEPRINT.md` · **Version:** 1.2.1 · **Created:** 2026-10-09 (phiên #66 — kế thừa trực tiếp bản phân tích ánh xạ tài liệu EXEC-DOC-MAP-1 cùng phiên) · **v1.1:** 2026-10-09 (phiên #70) · **v1.1.1:** 2026-10-10 (phiên #71 — fixbug P0) · **v1.2:** 2026-10-10 (phiên #72 — P1) · **v1.2.1:** 2026-10-10 (phiên #73 — fixbug P1)
> **Status:** **P0 HOÀN TẤT + fixbug sạch (v1.1.1) · P1 HOÀN TẤT + fixbug sạch (v1.2.1) — 2 câu hỏi kiến trúc P1 (§7.4/§7.5) đã được trader duyệt theo đề xuất gốc** (review v1.0 chấm 8.6/10 · APPROVE WITH AMENDMENTS, commit `9f20ae5`)
> **Nguồn tri thức (bắt buộc đọc trước khi triển khai):** 4 tài liệu user tải lên, lưu tại `upload/` (gitignored — không hiện trong cây thư mục git, đã đọc trọn **79 trang**):
> - `upload/Machine Learning.pdf` — 20 trang (viết tắt **[ML]**)
> - `upload/MATH.pdf` — 14 trang (**[MATH]**)
> - `upload/Data Analytics.pdf` — 29 trang (**[DA]**)
> - `upload/DEEP LEARNING.pdf` — 16 trang (**[DL]**)
>
> Mọi hạng mục trong §4 đều gắn nhãn nguồn `[ML §x]` `[MATH §x]` `[DA §x]` `[DL §x]` kèm số trang — không có hạng mục nào "không rõ gốc".
> **Cross-refs:** [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) §5.1–5.2 (đội 23 agents · chu kỳ 6 đợt A→F) · [RESEARCH_COUNCIL_PLAN.md](./RESEARCH_COUNCIL_PLAN.md) §3.1 (Đợt E Chủ tịch · Đợt F Ban Điều hành) · [PHASE3_BLUEPRINT.md](./PHASE3_BLUEPRINT.md) §4.1/§4.5/§4.9 (vòng đời tín hiệu · phê duyệt của trader — **luật bất khả xâm phạm**) · [CONTROL_RISK_QUANT_BLUEPRINT.md](./CONTROL_RISK_QUANT_BLUEPRINT.md) (VETO · Kelly ¼ CRB-9) · [MARKET_EXPANSION_BLUEPRINT.md](./MARKET_EXPANSION_BLUEPRINT.md) §3.5 (cổng đồng thuận 80% B9) · [DATA_PLATFORM_BLUEPRINT.md](./DATA_PLATFORM_BLUEPRINT.md) (verdict A9 · đặc trưng S2 — P0-P2 đã hoàn tất) · [ML_LEARNING_BLUEPRINT.md](./ML_LEARNING_BLUEPRINT.md) §13 (worker Python) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [Fixbug.md](../Fixbug.md)
> **Người soạn:** Kỹ sư AI / Kiến trúc sư hệ thống (phiên #66)

---

## §0. Chẩn đoán trung thực hiện trạng (đo trực tiếp mã nguồn ngày 2026-10-09)

### 0.1 Bốn agents — "roster nói" vs "code làm"

| Agent | Roster nói (`agent-roster.ts`) | Code thật (đo tại) | Khoảng cách |
|---|---|---|---|
| **A1 Portfolio Strategist — Chủ tịch** (LLM) | "Tổng hợp tín hiệu từ toàn bộ Hội đồng Nghiên cứu & Ủy ban Kiểm soát, **phân bổ danh mục** theo phong cách cân bằng rủi ro-lợi nhuận" · config `{targetPositions: 8, rebalanceThresholdPct: 5, style: "balanced", council: "23-agent"}` | Prompt Đợt E **dày và đúng**: 5 context block (market/news/flows/valuation/liquidity) + TÍN HIỆU ĐANG MỞ + cờ DQ A9 (P0-4) + khối Bayes posterior + khối QUANT Kelly ¼ (CRB-9) + digest 23 agents + vetoNotice (`agents/run/route.ts:838-854`) → JSON contract 1 tín hiệu `{symbol, direction, score 0-100, rationale, targetPrice, stopLoss, takeProfit}` clamp + round100. **NHƯNG**: 3/4 khóa config (`targetPositions`, `rebalanceThresholdPct`, `style`) **0 consumer** (rg toàn src) — A1 là "người ra 1 tín hiệu", không phải "chiến lược gia danh mục 8 vị thế" như danh xưng | 🟢 **Nền tảng chat thật, tổng hợp thật** — nhưng chữ "phân bổ danh mục" hữu danh vô thực |
| **A10 Execution Manager** (service) | "Ghi nhận tín hiệu chờ phê duyệt, thực thi lệnh qua API VNDIRECT khi được duyệt: **tách lệnh (TWAP/VWAP)**, **theo dõi khớp** và **báo cáo sau giao dịch**" · config `{sliceCount: 3, maxSlippagePct: 0.5, orderType: "LIMIT"}` | Đợt F **chỉ ghi nhận** tín hiệu — đúng an toàn §4.5/§4.9 (chu kỳ KHÔNG tự tạo Order; `agents/run/route.ts:1019-1119`). Phần "thực thi" thật nằm **ngoài nhóm**: `signal-execution.ts` tạo **1 lệnh LIMIT nguyên khối** (sizing nav5pct/budget50m), fill engine trong `market/tick` khớp claim-atomic, cancel ở `orders/[id]/cancel`. **Tách lệnh TWAP/VWAP: KHÔNG TỒN TẠI. Theo dõi khớp: không có chủ. Báo cáo sau giao dịch: không có nơi.** Config `sliceCount/maxSlippagePct/orderType` **0 consumer** (rg toàn src chỉ thấy định nghĩa trong roster) | 🔴 **Hữu danh vô thực ở đúng lĩnh vực "thực thi"** — phần ghi nhận thì trung thực |
| **A11 Settlement Officer** (service) | "**Đối chiếu** khớp lệnh, phí môi giới & thuế TNCN 0,1% trên giao dịch bán — báo cáo sau mỗi chu kỳ" · config `{taxSellPct: 0.1, feePct: 0.15}` | `runSettlement` (`agent-service-runs.ts:712-729`): reduce `Trade` trong cửa sổ 24h → 4 con số (count/totalValue/totalFee/totalTax) + 1 câu. **0 phép đối chiếu nào**: không Order↔Trade (lệnh đọng PENDING/cancel/partial vô hình), không tính lại fee theo `FEE_RATE=0.0015` (hardcode `tick/route.ts:60`) để bắt lệch, không thuế bán `TAX_RATE=0.001` (tick route:61), không đối chiếu delta cash. **Cửa sổ 24h trượt theo run** → cùng 1 Trade bị đếm ở nhiều chu kỳ (không idempotent theo giao dịch). Config `taxSellPct/feePct` **0 consumer** — biểu phí sống ở 2 hằng số hardcode khác file | 🔴 **"Bù trừ" chưa có phép đối chiếu nào** — báo cáo suông |
| **A12 Cash Manager** (service) | "Theo dõi số dư tiền mặt, biên margin và sức mua ước tính — **đề xuất hạn mức cho lệnh tiếp theo**" · config `{marginRoomMinVnd: 500.000.000, buyingPowerFactor: 0.5}` | `runCashManagement` (`agent-service-runs.ts:732-751`): 1 công thức `buyingPower = cash + GTTH×factor − marginUsed` (AUD-CODE #15b đã vá — không đếm kép cash) + flag `tight < marginMin`. **0 dự báo**: không nhìn tín hiệu ACTIVE (cam kết chi tiêu tiềm năng), không chuỗi tiền ra/vào tương lai, không đề xuất hạn mức theo lệnh cụ thể. Config **được đọc đúng** (duy nhất trong nhóm) | 🟡 **Nông nhưng trung thực** — đúng 1 phép đo |

### 0.2 Dòng chảy thật: Tín hiệu → Lệnh → Khớp → Bù trừ (truy vết từ mã nguồn)

```
Đợt D  Bộ tổng hợp Bayes (0 LLM) ── posterior + consensusGate 80% (B9)
          │
Đợt E    A1 Chủ tịch (LLM) ◄─ 5 context block + DQ + Bayes + Quant-Kelly + 23 digest + vetoNotice
          │  JSON signal → guard: VETO hard-enforce AUD-CODE #6 (vi phạm → hạ HOLD)
          │  consensusGate snapshot bind theo assessment sinh tín hiệu (B9)
          ▼
        Signal {ACTIVE, expiresAt +3 ngày, audit SIGNAL_CREATED}
          │
Đợt F    A10 "ghi nhận" (0 hành động thực thi)
          │
Đợt E-service (route:1180 — chạy SAU Chairman & Đợt F): A11 reduce 24h · A12 buyingPower
          │
Trader   POST /api/signals/[id]/decision APPROVE → createPaperOrderFromSignal(nav5pct)
         hoặc POST /convert (budget50m) — claim atomic AUD-CODE #2 · LIMIT PENDING
          │
Tick 10s fill engine (tick/route.ts) — claim PENDING→FILLED · fee 0,15% · thuế 0,1% BÁN
          · cash delta · position upsert · audit ORDER_FILLED (F-206/F-302)
          │
Chu kỳ sau: A11 lại reduce 24h — KHÔNG đụng đến phép đối chiếu nào
```

**Điểm nghẽn trách nhiệm:** "thực thi" thật phân tán ở 3 nơi ngoài nhóm (signal-execution.ts / fill engine tick / trader tự bấm). A10 đúng vai "người ghi biên bản an toàn" nhưng **sai phạm vi chức trách roster** (tách lệnh + theo dõi khớp + báo cáo). *(Hiệu chỉnh v1.1 — REV-5 review #69: đo lại route:1180, WAVE_E_SERVICE_CODES chạy **SAU** Chủ tịch & Đợt F — bản v1.0 ghi "A11 chạy trước Chủ tịch" là sai; hệ quả đúng: A11 "báo cáo sau giao dịch" về mặt thời điểm là đúng nghĩa, nhưng cửa sổ 24h trượt làm cùng 1 Trade nhảy số giữa các chu kỳ — giữ nguyên khoảng trống G6).*

### 0.3 Những gì ĐÃ TỐT — giữ nguyên, không làm lại

1. **An toàn phê duyệt** — chu kỳ KHÔNG tự tạo lệnh (PHASE3 §4.5/§4.9); trader duyệt từng tín hiệu. ExecutionPlan trong §4 sẽ chỉ sinh **SAU** APPROVE — không phá luật này.
2. **Vòng đời tín hiệu 4 trạng thái** ACTIVE|ACTED|REJECTED|EXPIRED + sweep `expireDueSignals` (AUD-CODE #1) gọi 3 điểm.
3. **VETO hard-enforce** (AUD-CODE #6) — tín hiệu vi phạm bị hạ về HOLD kèm lý do trong rationale.
4. **Cổng đồng thuận 80%** bind snapshot lúc sinh tín hiệu (B9) — convert ở chu kỳ sau không bị đánh giá lại.
5. **Claim atomic** tín hiệu→lệnh trong 1 transaction (AUD-CODE #2 — chống TOCTOU/2 lệnh/2 lần trừ tiền).
6. **Gate LIVE 3 lớp**: paper / `live-unconfigured` → 503 + audit `LIVE_TRADING_BLOCKED` / live chưa gateway → 501 + audit `LIVE_ORDER_GATEWAY_UNAVAILABLE` (S3).
7. **Dải trần/sàn ±7% + bội 100 ₫ + lot 100** (F-202) · **phí 0,15% notional** (F-201) · SELL cần vị thế (chặn sớm).
8. **Audit trail dày**: `SIGNAL_CREATED/APPROVED/REJECTED` · `ORDER_CREATED/FILLED/CANCELLED` — đủ truy溯源 mọi bước.
9. **buyingPower không đếm kép cash** (AUD-CODE #15b).
10. **Prompt Chủ tịch có điểm neo định lượng** (posterior Bayes + Kelly ¼ CRB-9 tham mưu + cờ DQ A9) — không tổng hợp mù.

### 0.4 Khoảng trống lớn (xếp theo mức thiệt hại)

| # | Khoảng trống | Thiệt hại / rủi ro đã thấy |
|---|---|---|
| G1 | **A10 không có Execution Plan** — không tách lệnh, không ngân sách trượt giá, không deadline, không theo dõi khớp | Lệnh 5% NAV nguyên khối vào mã thanh khoản thấp → tác động giá tự gây ra (đúng rủi ro A5 Liquidity cảnh báo nhưng không ai tiêu thụ để đổi cách đặt lệnh); lệnh PENDING sống vô hạn nếu giá không chạm |
| G2 | **A11 không có phép đối chiếu nào** + biểu phí sống ở 2 nơi (roster config chết + hardcode tick route) | Sai số sổ sách không bao giờ bị phát hiện; đổi biểu phí phải sửa 2 chỗ — lớp bug "1 sự thật 2 nguồn" (cùng họ G2/G3 DATA_PLATFORM_BLUEPRINT) |
| G3 | **A12 không cộng cam kết tiềm năng** — tín hiệu ACTIVE là "chi tiêu có điều kiện" nhưng sức mua không biết | Trader phê duyệt 3 tín hiệu liên tiếp có thể vượt sức mua thực — chỉ phát hiện khi lệnh bị fill engine từ chối |
| G4 | **Chất lượng Chủ tịch không đo được** — score 0-100 không hiệu chuẩn; không có precision của tín hiệu BUY; target/stop không đối chiếu với thực tế 5 phiên sau | Không có vòng phản hồi để prompt Chủ tịch tiến bộ; scorecard B8 hiện chỉ chấm 6 cử tri research |
| G5 | **A1 "phân bổ danh mục" 0 consumer** (targetPositions/rebalanceThresholdPct/style) | Danh xưng "Portfolio Strategist" ≠ thực tế "Signal Generator" |
| G6 | **Cửa sổ 24h lăn chu kỳ của A11** — số đếm lặp giữa các chu kỳ, không idempotent theo giao dịch | "Báo cáo sau mỗi chu kỳ" không comparable; cùng 1 Trade nhảy số nhiều lần |
| G7 | **KPI vận hành nhóm không tồn tại** — không biết conversion tín hiệu→duyệt→khớp, tỷ lệ tín hiệu chết (EXPIRED), giá trị lệnh TB | Không đo được nhóm Điều hành có đang làm việc hiệu quả không |

---

## §1. Nhiệm vụ chung & nhiệm vụ riêng — xác định lại

### 1.1 Nhiệm vụ chung của nhóm (bản "hợp đồng sứ mệnh" 5 điều)

Nhóm Điều hành & Thực thi là **bộ môn duy nhất bảo đảm cho mọi đồng VND đi ra khỏi hệ thống**:

1. **Quyết định truy được nguồn**: mọi tín hiệu/từ chối truy về được 23 báo cáo + posterior Bayes + VETO + cổng đồng thuận + quyết định của trader (audit chain khép kín).
2. **Phê duyệt thuộc về con người**: chu kỳ không tự đặt lệnh — mọi lệnh chỉ sinh sau APPROVE của trader (giữ PHASE3 §4.5 — bất khả xâm phạm, nhắc lại ở §6).
3. **Thực thi có kế hoạch**: lệnh được duyệt luôn đi kèm **ExecutionPlan** (cách tách, ngân sách trượt giá, hạn chờ) — kể cả khi engine chỉ có 1 con đường LIMIT đơn lệnh.
4. **Sổ sách khép kín về 0**: Order ↔ Trade ↔ Cash ↔ Position đối chiếu được mỗi chu kỳ bằng **kỳ vọng kiểm tra (expectations)**[DA tr13 · Great Expectations] — lệch là MISMATCH trung thực, không "tự lành".
5. **Tiền có trước lệnh**: sức mua luôn tính **kể cả cam kết tiềm năng** từ tín hiệu đang mở — không để trader duyệt lệnh rồi mới biết thiếu tiền.

**Nguyên tắc phân vai:** A1 **QUYẾT** (tham mưu + trình duyệt) → trader **DUYỆT** → A10 **THỰC THI THEO KẾ HOẠCH** → A12 **GIỮ TIỀN TRƯỚC giao dịch** → A11 **KIỂM SÁ SỔ SAU giao dịch**. Engine market giữ vai người bấm đồng hồ — nhóm không giữ scheduler riêng (tránh 2 đồng hồ, nguyên tắc DATA_PLATFORM_BLUEPRINT §1.1).

**Khung nhận thức 4 trụ cột / 5 cấp độ phân tích [DA tr8-9]** — ánh xạ thẳng vào phân vai nhóm:
| Cấp độ [DA] | Câu hỏi | Ai sở hữu |
|---|---|---|
| Descriptive | Đã xảy ra gì? | A11 (sổ 24h → kỳ vọng đối chiếu) |
| Diagnostic | Tại sao lệch? | A11 (expectation fail → nguyên nhân) |
| Predictive | Sắp xảy ra gì? | A12 (dòng tiền / sức mua kịch bản) |
| Prescriptive | Nên làm gì? | A1 (tín hiệu + đề xuất phân bổ) + A10 (cách đặt lệnh) |
| Cognitive (cấp 5) | Học & tự động hoá gì? | đích xa — A1 sau khi có scorecard phản hồi (P2) |

### 1.2 Nhiệm vụ riêng từng agent — hiện tại → đích

| Agent | Hiện tại (tóm §0.1) | **Nhiệm vụ đích** (sau nâng cấp) |
|---|---|---|
| **A1** | 1 tín hiệu JSON/tuần kỳ, config phân bổ chết | **Chủ tịch trình 2 lớp**: (a) giữ tín hiệu JSON hiện tại (đúng khung [ML §Agent frameworks] PydanticAI-style structured output), (b) thêm khối **đề xuất phân bổ danh mục** theo `targetPositions=8` + ngưỡng tái cân bằng 5% [MATH §Regularization — phạt L2 mềm] — narrative + bảng tỷ trọng, **chỉ tham mưu**, không sinh nhiều tín hiệu tự động. Khối calibration: confidence LOW/MEDIUM/HIGH được hiệu chuẩn bằng scorecard (E-P1-4) |
| **A10** | Ghi nhận suông | **Người lập kế hoạch thực thi**: khi trader APPROVE → sinh `ExecutionPlan` (đường tách theo `sliceCount`, ngân sách trượt giá `maxSlippagePct`, deadline chờ) — P0 là metadata + guard; P1 tách TWAP thật cho lệnh lớn theo ADTV; P2 formalism RL [DL §RL] cho execution policy. **Vẫn không tự đặt lệnh ngoài lệnh do trader phê duyệt** |
| **A11** | 4 con số cửa sổ 24h trượt | **Kiểm soát viên sổ sách**: `ReconciliationReport` — 5 phép đối chiếu kỳ vọng (order coverage · fee recompute · tax recompute · cash delta · position delta) idempotent theo checkpoint `executedAt > lastReconciledAt` [DA tr13 Great Expectations · tr18-20 hypothesis testing 6 bước · tr23-25 ACID/window functions]; bất thường giao dịch bằng IQR/z-score [DA §EDA · §Z-distribution] |
| **A12** | 1 công thức + flag | **Người giữ dòng tiền**: giữ buyingPower chuẩn + thêm **committed view** (cộng cam kết tiềm năng từ tín hiệu ACTIVE theo sizing nav5pct) P0; **dự báo dòng tiền** (GRU trước, LSTM sau [DL tr12-14 rule of thumb]) P1; CI 95% kèm định nghĩa "đây là ước tính nội bộ, không phải hạn mức thật VNDIRECT" (giữ câuclaimer hiện tại) |

---

## §2. KHO TRI THỨC 4 TÀI LIỆU → NỘI DUNG DÙNG CHO NHÓM ĐIỀU HÀNH & THỰC THI *(trọng tâm của bản blueprint)*

> Quy ước trích dẫn: `[ML trN §Chủ đề]` = Machine Learning.pdf trang N; tương tự `[MATH trN]`, `[DA trN]`, `[DL trN]`. Mỗi dòng bảng ghi rõ **ai dùng** và **áp vào hạng mục nào của §4**.

### 2.1 Machine Learning.pdf (20 trang) — 14 cụm nội dung, lấy gì cho nhóm

| # | Mục (trang) | Nội dung gốc trong tài liệu | Ai dùng | Áp vào đâu (§4) |
|---|---|---|---|---|
| M1 | Classification Metrics (tr1-3) | Confusion Matrix TP/TN/FP/FN · Accuracy · **Precision** (tránh cảnh báo giả) · **Recall** (tránh bỏ sót) · **F1** (dữ liệu lệch) · ROC/AUC · **AUC-PR (dữ liệu cực lệch)** · Specificity · Balanced Accuracy · Log Loss · Macro/Micro/Weighted · bảng chọn metric theo loại bài toán | A1 + kiểm định | **E-P1-4 Chairman Scorecard**: tín hiệu BUY/SELL = bài toán phân loại trên "nhãn" kết quả 5 phiên sau → Precision = tín hiệu BUY có tới target không; F1 vì tín hiệu BUY hiếm hơn HOLD (đúng cảnh báo imbalanced của tài liệu); AUC-PR khi lệch mạnh; Macro-F1 cho 3 lớp. Log Loss cho confidence hiệu chuẩn |
| M2 | Regression Metrics (tr1) | **MAE** (kháng outlier) · **MSE/RMSE** (phạt nặng sai số lớn — "phù hợp quản trị rủi ro") · R² | A1 · A12 | E-P1-4: RMSE sai số `targetPrice/stopLoss/takeProfit` vs giá thực 5/10 phiên sau (RMSE phạt nặng sai lớn — đúng tinh thần quản trị rủi ro [nguyên văn tài liệu]); E-P1-3: dự báo dòng tiền đo bằng MAE |
| M3 | Model Comparison (tr3) | **AIC/BIC** (phạt độ phức tạp) · Adjusted R² | A12 · thiết kế | E-P1-3: nguyên tắc "mô hình đơn giản nhất giữ hiệu năng" khi chọn GRU (ít tham số) vs LSTM (nhiều tham số) — cùng rule of thumb [DL tr13] |
| M4 | Calculus for ML (tr4) | Đạo hàm · đạo hàm riêng · chain rule · gradient · Jacobian · Hessian · Taylor · Gradient Descent | A1 (hiểu) | Nền hiểu: GD là cơ chế fine-tuning LLM Chairman (hiểu để đọc AgentRun cost); KHÔNG implement — ghi nhận loại có chủ đích |
| M5 | Self-Attention (tr5-6) | Token/embedding · Q/K/V · scale √dk · softmax · multi-head · causal masking | A1 (hiểu) | Giải thích vì sao Chủ tịch nhận **23 digest nén** thay vì full report (context window + attention giữa các báo cáo); thiết kế khối ngữ cảnh ngắn gọn E-P2-1 |
| M6 | LLM Evaluation (tr6-7) | Perplexity · **Exact Match** · F1 · ROUGE-N/L · BLEU · METEOR · BERTScore · **GPT-4-as-a-Judge** · **Human Evaluation** ("bước kiểm định cuối cùng mang tính quyết định") | A1 + kiểm định | E-P1-4/E-P2-2 khung 3 lớp chấm Chairman: (a) **EM** cho JSON contract (parse đúng = match tuyệt đối — đúng bản chất contract [ML §PydanticAI]), (b) kiểm số trong summary vs DB (thay BERTScore ngữ nghĩa bằng kiểm tra số định lượng — hệ thống có DB thật), (c) **Human eval = trader duyệt** — tài liệu gọi là bước quyết định, PHASE3 đã dựng sẵn cơ chế này ở Đợt F. ROUGE/BLEU/METEOR **loại** (không có văn bản tham chiếu) |
| M7 | Thuật toán ML (tr8-9) | Linear/Logistic · Decision Tree · **Random Forest — "kết hợp nhiều cây + bỏ phiếu đa số/trung bình, giảm overfitting"** · SVM · KNN · K-Means · PCA | Toàn nhóm (ngôn ngữ tư duy) | Random Forest = **hình mẫu lý thuyết của cổng đồng thuận 80% B9** (23 phiếu → gate — ensemble voting đã chạy thật từ #38); KNN-trung-bình-láng-gềng = tư duy dự báo sức mua theo ngày tương tự lịch sử (E-P1-3 baseline) |
| M8 | EDA quy trình (tr9-11) | Dataset Overview → Shape → Data Types → Missing → **Duplicates** → Summary → Distribution → **Outlier** → Correlation → Feature Relationships → Class Distribution → **Insights & Next Steps** | A11 | E-P0-3/E-P1-5: quy trình "EDA sổ giao dịch" — value_counts theo trạng thái lệnh, outlier fee/slippage, class distribution theo hướng tín hiệu |
| M9 | LLMs (tr11-13) | Transformer · tokenization BPE/WordPiece · inference Greedy/Beam/Top-k/Top-p · fine-tuning · **RLHF** · **hallucinations** · chi phí tính toán · learning path | A1 vận hành | Hallucination = rủi ro số 1 của Chủ tịch → đã có guard "chỉ chọn mã trong bảng chỉ báo" + clamp số; E-P2-1 theo dõi tỷ lệ parse-fail/JSON rác như **drift monitor** [M14]; chi phí = AgentRun token/cost đã track |
| M10 | Agent Frameworks (tr13-14) | **LangGraph** — stateful graph + **human-in-the-loop** + multi-actor · CrewAI · AutoGen · OpenAI Agents SDK (tracing/guardrails) · **PydanticAI — structured outputs cho xử lý tài chính** · Semantic Kernel | Kiến trúc | **Bản đồ kiến trúc hiện tại của chính hệ thống**: chu kỳ 6 đợt A→F = directed graph + state snapshot 1 lần/chu kỳ (đúng State/Nodes/Edges [DA tr27-28]) + **human-in-the-loop ở Đợt F = trader duyệt** (đúng tính chất LangGraph đề cao — giữ nguyên); PydanticAI structured outputs = lý do tồn tại của JSON contract `parseJsonBlock`; guardrails = VETO + consensus + compliance. Chỉ CrewAI/AutoGen/AgentsSDK/SemanticKernel **loại** (không thêm framework — quyết định phiên #35 giữ nguyên) |
| M11 | MLOps (tr14-16) | Workflow khép kín · **Experiment tracking** · **Versioning** · **Model registry** · CI · Deployment · **Monitoring + drift** · **Retraining khi sụt giảm** | A1 vận hành | E-P2-1 "LLM ops khép kín cho Chairman": AgentRun = experiment tracking (đã có); `p*-verify` = CI (đã có); provider/model/reasoning_effort = model registry (llm.ts); drift = parse-fail + veto-rate + calibration; retraining ≡ điều chỉnh prompt khi drift vượt ngưỡng |
| M12 | Encoders (tr16-17) | Autoencoder · VAE · Transformer/CNN/RNN encoder — **anomaly detection** | A11 (P2 xa) | E-P2-4: autoencoder phát hiện giao dịch bất thường — **chỉ khi IQR/z-score [DA] không đủ** (IQR rẻ hơn nhiều, ưu tiên P1) |
| M13 | LangChain (tr17-18) | Agent = LLM + tools + memory · vòng **Nhận → Hiểu & lập kế hoạch → Chọn công cụ → Hành động → Quan sát → lặp** | A10 (mẫu vòng) | Vòng vận hành A10 ExecutionPlan: nhận tín hiệu duyệt → lập kế hoạch tách → đặt lát → **quan sát khớp mỗi tick** → báo cáo → lặp (đúng vòng agent của tài liệu, không cần thư viện LangChain) |
| M14 | MCP (tr18-20) | Chuẩn hoá công cụ qua JSON-RPC · **5 best practices: server tin cậy · quyền tối thiểu · kiểm dữ liệu vào/ra · graceful error handling · giám sát log** | A10 · gateway S3 | 5 best practices áp thẳng cho **gateway VNDIRECT mini-service tương lai** (S3 live) và worker A10: mọi Route/plan validate input/output, lỗi nuốt-ghi-log không sập chu kỳ, quyền chỉ đọc-trừ khi duyệt. MCP server đầy đủ **loại** trong P0-P2 (single-app chưa cần) |

### 2.2 MATH.pdf (14 trang) — 8 cụm nội dung, lấy gì cho nhóm

| # | Mục (trang) | Nội dung gốc | Ai dùng | Áp vào đâu (§4) |
|---|---|---|---|---|
| H1 | Regression Formulas (tr1) | Linear · MSE loss · GD · Normal Equation · **Ridge L2 / Lasso L1** · MAE/RMSE/R² · Multiple · Polynomial · Logistic sigmoid | A1 | E-P1-1: **phạt L2 mềm cho độ lệch danh mục** (tỷ trọng hiện tại vs mục tiêu `targetPositions=8` — phạt bình phương độ lệch, kéo về từ từ, không bán tái cấu trúc đột ngột); L1 để thưa hoá (loại vị thế dưới ngưỡng nhỏ) |
| H2 | Xác suất (tr2-3) | Conditional · **Bayes** · PMF/PDF · Binomial/**Normal**/Poisson · **E[X] · Var(X)** — "ứng dụng cốt lõi trong quản trị rủi ro tài chính, đánh giá danh mục" · Joint/Marginal · **LLN** | A1 · A12 | A1 đọc posterior Bayes Đợt D bằng đúng ngôn ngữ E[X]/Var (hệ thống đã có — ghi nhận ánh xạ); E-P0-4/E-P1-3: A12 tính **kỳ vọng dòng tiền** theo kịch bản phê duyệt (E[cash] = Σ p_i × cash_i); Binomial cho chuỗi thắng của tín hiệu (đo độ tin cậy k-thắng-trong-n) |
| H3 | Linear Algebra (tr3-4) | Vectors · Matrices · Transpose · Determinant · Inverse · Eigen (nền PCA) · **Norms L1/L2/L∞/Frobenius** · SVD | A1 · A10 | Norm L1/L2 là chuẩn toán của H1 (phạt tuyến tính tuyệt đối vs bình phương); E-P0-2 ngân sách trượt giá theo chuẩn **L2** (phạt bình phương sai lệch — nhẵn, dùng cho slippage budget) và **L∞** cho ràng buộc cứng (không lát nào vượt trần trượt giá tuyệt đối) |
| H4 | Thống kê suy luận (tr5-6) | Sampling distribution · **Confidence Interval** · **Hypothesis Testing** (H0/H1/α) · **Two-sample t-test** · Chi-Square · ANOVA · Correlation · **p-value** ("tiêu chuẩn vàng… so với α = 0.05") | A11 · A12 · A1 | **E-P0-3 reconciliation theo đúng 6 bước HT** [DA tr18-20 trùng bản mô tả]: H0 "chênh lệch sổ = 0" → α=0.05 → chọn phép → tính p → kết luận → diễn giải theo ngữ cảnh; E-P1-3: CI 95% cho dự báo sức mua; E-P2-2: paired t-test trước/sau đổi prompt Chairman (A/B prompt) |
| H5 | Đo đánh giá (tr6-8) | Bảng tham chiếu thuật toán ↔ metric | kiểm định | Tra cứu chọn độ đo (phụ trợ M1/M2) |
| H6 | Logistic Regression (tr8-11) | Sigmoid · **decision boundary ngưỡng 0.5** · **Odds Ratio e^β** · assumptions · limitations | A1 | Odds ratio = ngôn ngữ tự nhiên của posterior log-odds (LR = 1+0.8×conf **chính là nhân odds** — hệ thống đang dùng, ghi nhận ánh xạ); E-P1-4: decision boundary rõ cho score → thay "ngưỡng trong đầu LLM" bằng ngưỡng khai báo |
| H7 | Hồi quy phổ biến (tr9-10) | Linear · **Stochastic Regression — "cập nhật theo mẫu ngẫu nhiên, dữ liệu lớn theo thời gian thực (real-time data streams)"** · Decision Tree/RF ensemble · k-NN · NN · XGBoost · **SVR — ε-insensitive zone (không phạt sai lệch trong ε)** | A10 · A12 | E-P1-3: stochastic/online update cho dự báo dòng tiền mỗi chu kỳ (không train lại toàn bộ); **SVR ε-insensitive = khung tư duy slippage tolerance của A10** — chấp nhận sai lệch trong ε=0.5% không "phạt", vượt mới tính là trượt giá (đúng tinh thần `maxSlippagePct` roster) |
| H8 | SciPy (tr12-14) | **optimize** (tìm cực tiểu) · integrate · interpolate · linalg · signal · **stats** · spatial · **curve_fit** | A10 · A11 · A12 | E-P1-2: `scipy.optimize.minimize` cho bài toán phân bổ lát cắt (min kỳ vọng tác động giá với ràng buộc số lát/thời gian — khi công thức tham Loch đenton đơn giản không đủ); E-P0-3/E-P1: `scipy.stats` (t-test/CI) — chạy trong worker Python §13 ML_LEARNING_BLUEPRINT; TypeScript thuần đủ cho P0 (xem §2.7) |

### 2.3 Data Analytics.pdf (29 trang) — 15 cụm nội dung, lấy gì cho nhóm

| # | Mục (trang) | Nội dung gốc | Ai dùng | Áp vào đâu (§4) |
|---|---|---|---|---|
| D1 | Analytics Cheat Sheet (tr1) | 6 bước Define→Collect→Clean→Explore→Analyze→Communicate · **KPIs: Conversion Rate · Churn Rate · AOV** | Toàn nhóm | **E-P0-5 KPI vận hành nhóm**: Conversion = tín hiệu→lệnh→khớp (funnel phê duyệt); "Churn" ≡ tín hiệu EXPIRED chưa duyệt (bỏ rơi); AOV ≡ giá trị lệnh trung bình — đúng 3 KPI khung của tài liệu |
| D2 | Pandas tabular (tr2-3) | describe · **quantile 25/50/75** · std/var · cov/corr · **cumsum/cumprod** · fillna | A11 · A12 | E-P0-3: **cumsum cho P&L lũy kế** theo checkpoint (thay cửa sổ 24h trượt — giải G6); E-P1-3: quantile dòng tiền |
| D3 | Data Science Steps 2026 (tr3-5) | 9 bước Problem→…→**Deployment**→**Communication** ("trình bày câu chuyện dựa trên dữ liệu") | A1 | Ghi nhận: narrative summary 2-4 câu của A1 chính là bước Communication — đã đúng; Deployment ≡ serving JSON contract |
| D4 | NumPy EDA (tr5-6) | Descriptive stats · histogram/box/scatter/heatmap · **IQR Method outlier** · constant columns | A11 | E-P1-5: **IQR** phát hiện giao dịch bất thường (fee/slippage ngoài tứ phân vị) — chọn IQR làm P1 vì rẻ và giải thích được (tài liệu dùng đúng ngữ cảnh này) |
| D5 | 12 dạng biểu đồ (tr6-8) | Line · Bar · Histogram · Scatter · **Box** · Pie · **Heatmap** · **Area** · Violin · Pair · Bubble · **Donut** | UI nhóm | E-P0-5: line cho equity/buyingPower theo chu kỳ · bar cho lệnh theo trạng thái · **box cho phân bố slippage** · donut cho trạng thái tín hiệu · area cho dòng tiền lũy kế |
| D6 | 4 trụ cột + 5 cấp độ (tr8-9) | Descriptive → Diagnostic → Predictive → **Prescriptive** ("đề xuất phương án hành động tối ưu — tối ưu hóa, mô phỏng, AI") → Cognitive | Phân vai nhóm | **Khung xương sống đã ánh xạ ở §1.1** — từng agent ownership một cấp; Prescriptive = đúng định nghĩa nhiệm vụ A1+A10; Cognitive = đích P2 sau khi có scorecard |
| D7 | CLT (tr14-16) | n≥30 · **SE = σ/√n** · hội tụ về chuẩn · **hạn chế: "dữ liệu tài chính đuôi nặng → tăng n"** | A1 · kiểm định | Nền thống kê cho **điểm đồng thuận 23 phiếu** (trung bình trọng số ≈ trung bình mẫu — CLT cho phép CI cho consensus ratio); cảnh báo đuôi nặng áp cho P&L: không dùng CI chuẩn cho tổn thất trước khi kiểm chuẩn — dùng median/IQR [D4] |
| D8 | Z-distribution (tr16-18) | **z-score** · **Empirical rule 68-95-99.7** · ±2 = "rõ rệt" · Z-table | A10 · A11 | E-P1-5: z-score giá fill vs mid khi khớp (>2σ = fill bất thường — đúng mốc "rõ rệt" của tài liệu); tái dùng cùng ngôn ngữ z-score với dải định giá A3 (context Chairman) — 1 ngôn ngữ thống kê toàn hệ thống |
| D9 | Hypothesis Testing (tr18-20) | **6 bước chuẩn** · Z/t/Chi²/ANOVA/F · tips: **kiểm giả định trước · phân biệt ý nghĩa thống kê vs thực tiễn** | A11 | E-P0-3: 6 bước chuẩn cho reconciliation; tips "thống kê vs thực tiễn" = đúng tinh thần RiskAlert severity (chênh 12 ₫ về mặt thống kê có ý nghĩa nhưng vô nghĩa thực tiễn → không escalate) |
| D10 | 20 EDA techniques (tr20-23) | info/describe/isnull/fillna/duplicated/dtypes/unique/**value_counts**/corr/**filter/sort/groupby**/hist/scatter/countplot/pairplot/heatmap/save | A11 | E-P0-5: quy trình "EDA sổ lệnh" — value_counts trạng thái · groupBy theo symbol/tuần · sort top giá trị |
| D11 | 12 khái niệm DB (tr23-25) | Tables/PK/FK/**Joins**/Indexes/Normalization/SQL/Relationships/**Transactions Begin-Commit-Rollback** · **ACID (Atomicity, Consistency, Isolation, Durability)** · **Window Functions ("tính trượt/xếp hạng không gộp nhóm")** · Partitioning | A10 · A11 | **Xương sống kỹ thuật nhóm**: ACID = lý do transcript đã dùng `$transaction` claim (AUD-CODE #2 — ánh xạ trỏ vào code thật); **Window Function = cách tính P&L lũy kế + xếp hạng giao dịch theo symbol KHÔNG gộp nhóm** cho E-P0-3 (Prisma chưa có → compute JS hermetic, raw query chỉ khi tối ưu); Indexes = kiểm tra index `Trade.executedAt` trước khi thêm query đối chiếu; Partitioning = tư duy P2 xa khi Bar/Trade phình |
| D12 | Ngôn ngữ R (tr25-26) | dplyr/tidyr/ggplot2/readr/psych | — | **LOẠI** — stack Python/TypeScript đã chọn (ML_LEARNING_BLUEPRINT §13); ghi nhận loại có chủ đích |
| D13 | Preprocessing (tr26-27) | missing mean/median · min-max · z-score · **robust IQR** · **log transform ("lệch phải — thu nhập/giá trị tài sản")** · one-hot · label · **binning** · feature engineering | A12 | E-P1-3: binning ngày theo loại phiên A/m/B/C (vn-calendar) · **log transform cho notional** (lệch phải đúng ứng dụng tài liệu) · robust scaling cho giá (nhiều outlier) |
| D14 | LangGraph (tr27-29) | **State (TypedDict) · Nodes · Edges · Entry/END** · **conditional edges** · compile · invoke · use case **Multi-Agent Systems** | Kiến trúc | Bản mô tả chi tiết nhất về đúng cấu trúc `agents/run/route.ts` hiện tại: Đợt E rẽ nhánh có điều kiện (`strategist.signal && validInstrumentId`) → Đợt F — ghi nhận hệ thống **đã là LangGraph-style graph không cần thư viện**; E-P0-2 ExecutionPlan mô hình hoá như node graph có điều kiện (sau APPROVE → chờ khớp → báo cáo) |
| D15 | CV (tr13-14) + Hệ thống phân tích hiện đại (tr11-13) | Computer Vision · Kafka/NiFi/Snowflake/Spark/dbt/Airflow · **tầng 8: Data Quality, Orchestration & Monitoring — Great Expectations** | A11 (tư duy) | CV **loại** (không dữ liệu ảnh); big-data stack **loại** (single-app + Supabase); **chỉ mượn tư duy tầng 8**: A11 = lớp **"kỳ vọng dữ liệu" (expectations)** của sổ giao dịch — reconciliation chính là Great-Expectations-style cho tài chính, không cài thêm công cụ nào (RiskAlert + p-verify đã là monitoring) |

### 2.4 DEEP LEARNING.pdf (16 trang) — 7 cụm nội dung, lấy gì cho nhóm

| # | Mục (trang) | Nội dung gốc | Ai dùng | Áp vào đâu (§4) |
|---|---|---|---|---|
| L1 | Backpropagation (tr1-2) | Forward · activation · loss · **chain rule** · δ error term · update · luồng tổng thể | A1 (hiểu) | Nền hiểu khi Chairman đọc evidence `mlp-forecast` (nhóm ML) — KHÔNG implement trong nhóm executive |
| L2 | Kiến trúc NN (tr2-3) + Core (tr6-8) | Perceptron · MLP · CNN · RNN · **LSTM ("dự báo chuỗi thời gian tài chính phức tạp")** · **GRU ("dự báo chuỗi thời gian tốc độ cao")** · Autoencoder · Transformer · **lời khuyên: "chọn theo loại dữ liệu · bắt đầu đơn giản rồi tăng · dùng pre-trained khi có thể"** | A12 | E-P1-3: **đường tiến hoá dự báo dòng tiền** — (1) hồi quy tuyến tính (đơn giản nhất) → (2) **GRU trước** (ít tham số, chuỗi cash 60-90 điểm ngắn) → (3) LSTM chỉ khi GRU chưa đạt (phụ thuộc dài hạn chuỗi tuần) — đúng thứ tự khuyến nghị tài liệu [DL tr13 rule of thumb] + [ML M3 AIC/BIC] |
| L3 | Activation functions (tr5-6) | Linear · Sigmoid · Tanh · ReLU · Leaky ReLU · ELU · **Softmax** | A12 · A1 | Softmax = ngôn ngữ "phân phối xác suất 3 lớp BUY/SELL/HOLD" cho hiệu chuẩn confidence A1 (E-P1-4); kiến trúc mạng A12 worker nếu vượt P1 |
| L4 | ANN (tr8-9) | Training loop · applications: **Fraud Detection · Risk Prediction · Demand Forecasting** | A11 · A12 | Fraud detection = ứng viên P2 anomaly (cùng M12 — sau IQR); "Demand Forecasting" ≡ **cash demand** của A12 — đúng ứng dụng tài liệu liệt kê |
| L5 | Keras (tr9-11) + multi-backend (tr14-16) | Sequential/Dense · compile adam/binary_crossentropy · fit epochs/batch/**validation_split** · evaluate/predict · **Callbacks: EarlyStopping + ModelCheckpoint** · save `.keras` · common layers · **utilities set_random_seed/to_categorical** | A12 (worker P1/P2) | Stack triển khai worker A12: **EarlyStopping** chống overfit dự báo dòng tiền · **ModelCheckpoint** giữ bản tốt nhất · **set_random_seed** cho tái lập (đúng văn hoá reproducibility của DATA_PLATFORM_BLUEPRINT §1.1 điều 4) · validation_split để đo generalisation |
| L6 | RL (tr11-12) | **Framework S_t → A_t → R_{t+1} → S_{t+1}** · Q-Table · **stochastic policy** · **exploration vs exploitation** · Q-Learning/SARSA/DQN/Policy Gradient/Actor-Critic/PPO | A10 (formalism) | **Ngôn ngữ tư duy execution policy**: action = {tách 3 lát · 1 lệnh · hoãn · đề nghị huỷ}, state = {chênh giá vs LIMIT, ADTV, phần dư, tick còn lại}, reward = −tác động giá − chi phí chờ; E-P2-3: A10 tiêu thụ **stance rl-policy (A16, nhóm ML)** làm advisory; exploration/exploitation cũng là ngôn ngữ Thompson sampling bandit (đã chạy) — ghi nhận ánh xạ |
| L7 | RNN so sánh (tr12-14) | RNN yếu chuỗi dài (vanishing/exploding gradient) · LSTM 3 cổng + cell state · **GRU 2 cổng, "ít tham số hơn, train nhanh hơn"** · bảng so sánh · **"thử GRU trước; chưa đạt chuyển LSTM; RNN chỉ tác vụ vỡ lòng"** | A12 | Quyết định kiến trúc E-P1-3 — trích nguyên tắc áp thẳng; cú pháp PyTorch `nn.GRU/nn.LSTM` tham khảo nhưng **chọn Keras** [L5 — multi-backend thân thiện worker] |

### 2.5 Ma trận tổng hợp — nội dung dùng × 4 agents

| Nội dung lấy từ 4 tài liệu | Nguồn | A1 Chủ tịch | A10 Thực thi | A11 Bù trừ | A12 Dòng tiền | Hạng mục §4 |
|---|---|---|---|---|---|---|
| Precision/Recall/F1/AUC-PR (phân loại) | ML tr1-3 | ● chấm tín hiệu | — | — | — | E-P1-4 |
| RMSE/MAE (hồi quy) | ML tr1 · MATH tr1 | ● target/stop | — | — | ● dự báo | E-P1-3/4 |
| Ensemble voting đa số (Random Forest) | ML tr8 | ● cổng 80% (đã có — ánh xạ) | — | — | — | (ghi nhận) |
| Bayes · E[X] · odds | MATH tr2-3 · tr10 | ● posterior (đã có) | — | — | ● E[cash] kịch bản | E-P0-4 |
| Ridge L2 / Lasso L1 | MATH tr1 | ● tái cân bằng | — | — | — | E-P1-1 |
| Norm L2/L∞ | MATH tr4 | — | ● slippage budget | — | — | E-P0-2 |
| SVR ε-insensitive | MATH tr10 | — | ● tolerance 0.5% | — | — | E-P0-2 |
| SciPy optimize/stats | MATH tr12-14 | — | ● optim lát cắt | ● t-test | ● CI | E-P1-2/3 |
| 6 bước HT · t-test · CI · p-value | MATH tr5-6 · DA tr18-20 | ● A/B prompt (P2) | — | ● reconciliation | ● CI sức mua | E-P0-3 |
| CLT · SE=σ/√n · đuôi nặng | DA tr14-16 | ● consensus 23 phiếu | — | — | — | (ghi nhận) |
| z-score · 68-95-99.7 | DA tr16-18 | ● ngôn ngữ A3 | ● fill anomaly | ● outlier | — | E-P1-5 |
| IQR outlier | DA tr5-6 · tr26 | — | — | ● chính | — | E-P1-5 |
| 4 trụ cột / 5 cấp độ | DA tr8-9 | ● Prescriptive | ● Prescriptive | ● Desc+Diag | ● Predictive | §1.1 |
| KPI Conversion/Churn/AOV · funnel | DA tr1 | ● | ● | ● | ● | E-P0-5 |
| ACID · Transactions · Window Functions | DA tr23-25 | — | ● claim (đã có) | ● P&L lũy kế | — | E-P0-3 |
| Cumsum · quantile · groupby | DA tr2-3 · tr20-23 | — | — | ● thay cửa sổ 24h | ● phân vị | E-P0-3 |
| Great Expectations (tư duy) | DA tr13 | — | — | ● expectations | — | E-P0-3 |
| Binning · log transform · robust scaling | DA tr26-27 | — | — | — | ● feature | E-P1-3 |
| LangGraph state/conditional/human-in-loop | ML tr13 · DA tr27-29 | ● cấu trúc chu kỳ | ● node plan | — | — | (ghi nhận) |
| PydanticAI structured output | ML tr14 | ● JSON contract | ● ExecutionPlan | ● ReconciliationReport | ● CashflowForecast | E-P0-2/3/4 |
| MLOps: tracking/registry/drift/retraining | ML tr14-16 | ● LLM ops | — | — | — | E-P2-1 |
| Hallucination guard · tri thức cutoff | ML tr12-13 | ● guard mã + clamp | — | — | — | (đã có — ghi nhận) |
| Vòng agent Nhận→Kế hoạch→Hành động→Quan sát | ML tr17-18 | — | ● vòng ExecutionPlan | — | — | E-P0-2 |
| MCP 5 best practices | ML tr18-20 | — | ● gateway S3 | — | — | (nguyên tắc §6) |
| LSTM/GRU + rule of thumb | DL tr2-3 · tr12-14 | — | — | — | ● kiến trúc | E-P1-3 |
| Keras callbacks (EarlyStopping/Checkpoint/seed) | DL tr14-16 | — | — | — | ● worker | E-P1-3 |
| Softmax (phân phối 3 lớp) | DL tr5-6 | ● calibration | — | — | — | E-P1-4 |
| RL formalism S/A/R + exploration | DL tr11-12 | — | ● policy (P2) | — | — | E-P2-3 |
| Autoencoder anomaly | ML tr16-17 · DL tr7 | — | — | ● P2 xa | — | E-P2-4 |

**(đã có — ghi nhận)** = nội dung tài liệu mô tả đúng thứ hệ thống đang chạy — blueprint ghi nhận ánh xạ để minh bạch nguồn gốc thiết kế, không làm lại. ● = nội dung sẽ được đưa vào §4.

### 2.6 Danh mục KHÔNG dùng — loại có chủ đích (và lý do)

| Nội dung | Nguồn | Lý do loại |
|---|---|---|
| Computer Vision / CNN / Object Detection / Segmentation | DA tr13-14 · DL tr3-5 | Không có dữ liệu ảnh nào trong hệ thống |
| Ngôn ngữ R (dplyr/ggplot2/readr/psych) | DA tr25-26 | Stack Python/TypeScript đã chốt (ML_LEARNING_BLUEPRINT §13) |
| Power BI / Tableau / Looker / Superset | DA tr1 · tr12 | Dashboard Next.js + shadcn/ui đã có, realtime WS |
| Kafka / NiFi / Airbyte / Fivetran / Snowflake / Spark / dbt / Databricks | DA tr12 | Single-app + Supabase postgres; volume 215k bar không cần |
| CrewAI / AutoGen / OpenAI Agents SDK / Semantic Kernel | ML tr13-14 | Chu kỳ graph tự viết đã ổn định 23 agents; quyết định phiên #35 "không dùng LangChain/LlamaIndex" giữ nguyên — không thêm dependency framework |
| ROUGE / BLEU / METEOR / BERTScore / Perplexity | ML tr6-7 | Không có văn bản tham chiếu để so; perplexity không đo được qua API provider hiện tại |
| MCP server đầy đủ | ML tr18-20 | Single-app; chỉ mượn 5 best practices cho gateway S3 tương lai |
| Autoencoder / VAE | ML tr16-17 · DL tr7 | P2 xa — IQR + z-score rẻ hơn, giải thích được |
| DQN / PPO / Actor-Critic (train riêng) | DL tr12 | A10 chỉ mượn formalism + tiêu thụ rl-policy A16 có sẵn; không train execution-RL riêng trong P0-P2 |
| Taylor / Hessian / Jacobian | ML tr4 | Hiểu lý thuyết — không có điểm áp dụng tính toán thật trong nhóm |
| Great Expectations / Airflow / Prometheus / Grafana (công cụ) | DA tr13 | Mượn TƯ DUY expectations; monitoring thật = RiskAlert + dev.log + p-verify + AgentRun (đã có) |
| Grid World / game RL | DL tr11 | Ví dụ dạy học — không áp dụng |

### 2.7 Stack công nghệ kết luận (từng giai đoạn)

| Giai đoạn | Stack | Lý do (nguồn tài liệu) |
|---|---|---|
| **P0** (E-P0-1→5) | **TypeScript thuần + Prisma — 0 dependency mới** | Reconciliation/KPI/committed-view đều là reduce + so sánh số — không cần thư viện; hermetic verify dễ (pattern p2-verify 73/73) |
| **P1** (E-P1-1→5) | TypeScript là chính; **tách TWAP là số học thuần** (không cần scipy — chỉ khi ràng buộc phức tạp mới cân nhắc worker) | [MATH H7] tolerance + [ML M13] vòng quan sát đủ triển khai bằng tính toán bật-tắt |
| **P1-3 / P2** (dự báo dòng tiền, nếu vượt ngưỎ TypeScript) | **Worker Python mini-service** (pattern market-engine): NumPy · Pandas · SciPy (stats/optimize) · scikit-learn (metrics) · Keras (GRU→LSTM) | Đúng 5 thư viện 4 tài liệu nhắc tới nhiều nhất [MATH H8 · ML M1 · DA D2 · DL L5]; chạy port riêng + `XTransformPort` qua gateway; callbacks Keras cho tái lập [DL L5] |

---

## §3. Kiến trúc phối hợp lại (ai sở hữu hợp đồng nào)

### 3.1 Sơ đồ đích

```
Đợt D  Bayes posterior + consensus 80% (B9)
          ▼
Đợt E    A1 CHỦ TỊCH (LLM) ── JSON signal (giữ nguyên contract)
         │   + khối ĐỀ XUẤT PHÂN BỔ (targetPositions 8 · L2 soft) [E-P1-1]
         │   + calibration từ ChairmanScorecard [E-P1-4]
         ├── E-service: A12 committed buyingPower [E-P0-4] · A11 reconciliation chu kỳ trước [E-P0-3]
         ▼
        Signal ACTIVE (expiresAt 3 ngày, gate VETO + đồng thuận đã gắn)
         ▼
Trader   APPROVE/REJECT (luật §4.5 — bất khả xâm phạm)
         ▼ APPROVE
A10      sinh ExecutionPlan {slices, slippageBudgetPct, deadlineTicks} [E-P0-2]
         ├── 1 lệnh LIMIT như hiện tại (P0: plan = metadata + guard deadline)
         └── P1: tách TWAP 3 lát khi qty > ngưỡng % ADTV
         ▼
Fill engine (tick 10s — giữ nguyên claim atomic) ── z-score fill [E-P1-5]
         ▼
A11      ReconciliationReport 5 phép (idempotent checkpoint) ── RiskAlert khi MISMATCH
         ▼
A12      CashflowForecast (kịch bản phê duyệt) ── đầu vào: plan + reconciliation [E-P1-3]
         ▼
S1/KPI   Bảng KPI vận hành nhóm (funnel + conversion + churn + AOV) [E-P0-5]
```

### 3.2 Bốn hợp đồng dữ liệu mới (tên sẽ thành code — pattern PydanticAI structured output [ML M10])

| Hợp đồng | Định nghĩa rút gọn | Chủ sở hữu | Hạng mục |
|---|---|---|---|
| **`ExecutionPlan`** | `{orderId, style: "SINGLE"\|"TWAP", slices: [{seq, quantity, price, afterTick}], slippageBudgetPct, deadlineTicks, rationale}` — sinh SAU APPROVE, lưu `Order.note` JSON (P0) hoặc bảng riêng (P1 nếu tách thật) | A10 | E-P0-2 |
| **`ReconciliationReport`** | `{window: {fromCheckpoint, toNow}, expectations: [{name, expected, actual, diff, ok}], verdict: "BALANCED"\|"MISMATCH"\|"DEGRADED", severity}` — **6 phép** (v1.1 thêm phép 6 theo REV-8 review #69): order-coverage · fee-recompute · tax-recompute · cash-delta · position-delta · **order-fee-ledger (Order.fee == Σ Trade.fee của cùng order — fill engine ghi 2 sổ phí tick:257 Order + tick:262 Trade)** | A11 | E-P0-3 |
| **`CommittedCashView`** | `{cash, buyingPower, committedNotional, committedBuyingPower, activeSignals: n, pendingOrders: n, tight: bool}` — committed = **Σ sizing nav5pct của tín hiệu ACTIVE (ước tính) + Σ notional còn lại của Order PENDING/PARTIALLY_FILLED ((quantity − filledQuantity) × price — cam kết THẬT)** *(v1.1 — REV-1 review #69: phải cộng PENDING orders; tín hiệu APPROVE rời tập ACTIVE đúng lúc lệnh PENDING sinh — không cộng PENDING thì mù đúng chỗ cam kết thật; đọc từ chính Order nên tự nhiên phủ cả 2 đường sizing nav5pct/budget50m)* | A12 | E-P0-4 |
| **`ChairmanScorecard`** | `{window, signals, precision, recall, f1, aucPr, calibration: {LOW/MEDIUM/HIGH → winrate}, targetRmse}` — nhãn = kết quả 5 phiên sau (đối chiếu Bar) | kiểm định (API route) | E-P1-4 |

### 3.3 Đơn vị hoá cấu hình (giải G2 "1 sự thật 2 nguồn" — hiệu chỉnh v1.1: **3 nguồn**, không phải 2)

- **Thực đo review #69 (REV-2): biểu phí sống ở 3 nơi với 2 đơn vị khác nhau** — `tick/route.ts:60-61` (FEE_RATE=0.0015/TAX_RATE=0.001 — **fraction**) · `signal-execution.ts:391` (literal `0.0015` — fraction) · roster config A11 `{feePct: 0.15, taxSellPct: 0.1}` (**percent** — khác đơn vị 100×!). Module mới `src/lib/exec/constants.ts` chuyển percent→fraction đúng MỘT chỗ kèm **guard biên** `0 < rate ≤ 0.01` — ai đó sửa nhầm đơn vị sẽ nổ ngay lúc import, không chạy im lặng lệch 100× (E-P0-1).
- `FEE_RATE`/`TAX_RATE` chuyển về **1 nguồn duy nhất** đọc từ config roster A11 (`feePct`/`taxSellPct`) — fill engine + reconciliation + signal-execution cùng import (E-P0-1).
- `sliceCount`/`maxSlippagePct`/`orderType` của A10 **có consumer** trong ExecutionPlan builder (E-P0-1/E-P0-2).
- `targetPositions`/`rebalanceThresholdPct`/`style` của A1 **có consumer** trong khối đề xuất phân bổ (E-P1-1).

---

## §4. Kế hoạch triển khai (P0 → P1 → P2, mỗi hạng mục gắn nguồn tài liệu)

### P0 — Sự thật & an toàn (không đổi hành vi giao dịch, chỉ thêm lớp kiểm chứng)

| # | Hạng mục | Nguồn tài liệu | Files chạm (dự kiến) | Thử nghiệm nghiệm thu |
|---|---|---|---|---|
| **E-P0-1** | **Đơn vị hoá biểu phí + config có consumer**: `FEE_RATE=0.0015`/`TAX_RATE=0.001` từ 1 module (đọc roster config A11) — tick route + signal-execution + reconciliation cùng nguồn; đổi biểu phí sửa 1 chỗ. **Hiệu chỉnh v1.1 (REV-2): đếm đủ 3 nguồn phí** (tick:60-61 fraction · signal-execution:391 literal · roster:227 percent) + **guard đơn vị percent↔fraction**: module chuyển percent→fraction đúng 1 chỗ, assert biên `0 < rate ≤ 0.01` — sửa nhầm đơn vị lệch 100× sẽ nổ lúc import chứ không chạy im lặng | [DA tr23-25 ACID — "đảm bảo giao dịch luôn đáng tin cậy"] · [ML M14 — kiểm dữ liệu vào/ra] | `agent-roster.ts` (export hằng số từ config) · `market/tick/route.ts` · `signal-execution.ts` (dòng 391) · module mới `src/lib/exec/constants.ts` | exec-verify EX-A1: 3 nơi import cùng 1 hằng số (rg không còn hardcode 0.0015/0.001 rải rác); EX-A3: guard đơn vị — feePct 0.15 → 0.0015 fraction, giá trị ngoài biên → throw; fill thật 1 lệnh test → fee khớp |
| **E-P0-2** | **`ExecutionPlan` sinh khi APPROVE** (P0: `style=SINGLE` 1 lát đúng hiện trạng + `slippageBudgetPct` từ config + `deadlineTicks` mặc định 1440 tick ≈ 4h phiên liên tục); guard deadline: tick expirer hoãn-huỷ lệnh PENDING quá hạn (audit `ORDER_EXPIRED_BY_PLAN`) — kế hoạch đi kèm lệnh chứ KHÔNG tự đặt thêm. **Hiệu chỉnh v1.1 (REV-7): `deadlineTicks` chỉ đếm tick TRONG phiên liên tục** (09:15–11:30 + 13:00–14:45, bỏ nghỉ trưa + ngày nghỉ lễ/T7-CN theo vn-calendar — 1440 tick @10s ≈ đúng 1 phiên giao dịch); lệnh không có plan (tạo trước P0 / thủ công) không bị ép hạn mới | [ML M13 vòng agent] · [MATH H3 norm L∞/H7 ε-tolerance] · [DL L6 state/action formalism] · [DA D14 conditional edges] | `signal-execution.ts` (sinh plan vào `Order.note`) · `market/tick/route.ts` (guard deadline) · module mới `src/lib/exec/plan.ts` · API trả plan cho UI | EX-A2: APPROVE 1 tín hiệu → Order.note có plan JSON parse được; lệnh PENDING sống > deadline → EXPIRED + audit; E2E UI hiện plan ở tab Lệnh |
| **E-P0-3** | **A11 → `ReconciliationReport` 6 phép idempotent**: checkpoint `lastReconciledAt` (AppSetting) — window `[checkpoint, now]` không trùng lặp (giải G6); 6 phép: (1) mọi Order kết thúc đều có Trade đủ khối lượng (partial = PARTIALLY_FILLED hợp lệ), (2) fee mỗi Trade = feePct×notional (recompute), (3) tax bán = taxSellPct×notional, (4) delta cash = Σ(±notional ∓ fee ∓ tax), (5) delta position = Σ khối lượng theo hướng, **(6) Order.fee == Σ Trade.fee của cùng order (REV-8 v1.1)**. MISMATCH → RiskAlert (không "tự lành"). **Hiệu chỉnh v1.1 (REV-12): whitelist semantics phép cash-delta** — mọi write cash ngoài fill-engine (seed/script/manual) sẽ gây MISMATCH CÓ CHỦ ĐÍCH: khai báo rõ "reset checkpoint sau seed/manual write", phép đối chiếu đo đúng ranh giới này | [DA tr13 Great Expectations] · [DA tr18-20 + MATH H4 — HT 6 bước H0 "sổ khớp 0 lệch"] · [DA D11 ACID/window] · [DA D2 cumsum] | `agent-service-runs.ts` (runSettlement viết lại) · module mới `src/lib/exec/reconciliation.ts` · `riskAlert` · `prisma/schema.prisma` (thêm `@@index([executedAt])` cho Trade — REV-9 v1.1: window query không dùng được composite [instrumentId, executedAt]) | EX-B1-B6: cài dữ liệu test tự tạo (trade fee sai 1 dòng) → expectation fail đúng 1 phép + verdict MISMATCH; chạy 2 lần liên tiếp → window 2 lần giao không đếm trùng (idempotent); MISMATCH → RiskAlert |
| **E-P0-4** | **A12 `CommittedCashView`**: giữ buyingPower chuẩn + thêm committed = Σ sizing nav5pct của tín hiệu ACTIVE (ước tính, giá hiện tại) **+ Σ notional còn lại của Order PENDING/PARTIALLY_FILLED** (REV-1 v1.1: lệnh đã duyệt là cam kết THẬT — đọc (quantity − filledQuantity) × price từ chính Order, tự nhiên phủ cả 2 đường sizing nav5pct lẫn budget50m) → `committedBuyingPower` hiển thị (KHÔNG chặn — chỉ tham mưu + nhãn "ước tính nội bộ") | [MATH H2 E[X] kỳ vọng] · [DA tr1 KPI] | `agent-service-runs.ts` (runCashManagement mở rộng) · module mới `src/lib/exec/committed.ts` | EX-C1: tạo 2 tín hiệu ACTIVE → committed tăng đúng 2 × nav5pct; tín hiệu EXPIRED → committed giảm lại; **APPROVE 1 tín hiệu → lệnh PENDING thay tín hiệu trong tập cam kết — committed KHÔNG tụt mù (REV-1); lệnh FILLED → committed giảm đúng phần đã khớp** |
| **E-P0-5** | **KPI vận hành nhóm (funnel)**: API + UI khối KPI — tín hiệu sinh (30 ngày) → % duyệt → % lệnh → % khớp · tỷ lệ EXPIRED-chưa-duyệt ("churn") · AOV lệnh · phân bố slippage thực (box plot [DA D5]) | [DA tr1 Conversion/Churn/AOV] · [DA D10 value_counts/groupby] | API route mới `/api/exec/kpi` (hoặc gộp `/api/agents` payload) · UI `agents-workspace` khối nhóm executive | EX-D1: dữ liệu test 10 tín hiệu (5 duyệt, 3 expired, 2 chờ) → KPI tính đúng bằng tay; E2E bảng hiển thị |

### P1 — Nâng năng lực (vẫn 0 tự động hoá vượt phê duyệt)

| # | Hạng mục | Nguồn tài liệu | Ghi chú thêm |
|---|---|---|---|
| **E-P1-1** | **A1 khối "đề xuất phân bổ"**: prompt Chủ tịch thêm yêu cầu bảng tỷ trọng `{symbol, currentPct, targetPct, action}` theo `targetPositions=8` + ngưỡng `rebalanceThresholdPct=5%` — phạt mềm L2 (không lệnh tự sinh; chỉ narrative + bảng) | [MATH H1 Ridge L2 — "giữ trọng số nhỏ / kéo về"] · [MATH H2 E[X] danh mục] | Parse an toàn: bảng sai format → bỏ qua + ghi parse-fail (drift metric E-P2-1) |
| **E-P1-2** | **TWAP tách lát thật**: khi khối lượng lệnh > 1% ADTV-20 phiên [tư duy A5] → `sliceCount` lát LIMIT rải `afterTick` (mỗi lát lot 100); fill engine từng lát như lệnh riêng (claim per-lát); đo slippage thực vs ngân sách | [MATH H7 ε-tolerance] · [ML M13 vòng quan sát] · [DL L6 state/action] · [MATH H8 scipy.optimize nếu cần tối ưu] (P1 dùng số học thuần) | Rủi ro cao nhất kế hoạch — tách nhỏ E-P1-2a (sinh nhiều Order con khi APPROVE, mỗi Order 1 plan con) trước E-P1-2b (fill theo lịch afterTick) |
| **E-P1-3** | **A12 dự báo dòng tiền**: baseline hồi quy tuyến tính + quantile [DA D2] (TS thuần) → nếu vượt ngưỡng lỗi → worker Python GRU [DL L2/L7 rule of thumb] với EarlyStopping + set_random_seed [DL L5]; đầu vào: binning loại phiên [DA D13] + log notional; đầu ra `CashflowForecast` kịch bản {allApprove, half, none} + CI 95% [MATH H4] | [DL tr12-14] · [DA tr26-27] · [ML M3 AIC/BIC] | "half" scenario = kịch bản minh bạch (không phải xác suất thật) — khai báo trong contract |
| **E-P1-4** | **ChairmanScorecard** (giải G4): nhãn tín hiệu 5 phiên sau (BUY thắng nếu high ≥ target trước khi low ≤ stop — hoặc đơn giản hoá phiên 1: so close-5-phiên vs giá sinh); precision/recall/F1/AUC-PR [ML M1] + RMSE target [ML M2] + calibration LOW/MEDIUM/HIGH → winrate [DL L3 softmax ngôn ngữ] + odds [MATH H6]; API + UI như B8 scorecard research | [ML tr1-3 · tr6-7 EM+Human-eval] · [DA tr14-16 CLT — CI cho winrate, cẩn trọng đuôi nặng] | đủData=false khi n<30 [DA D7 n≥30] — trung thực như B8 |
| **E-P1-5** | **A11/A10 bất thường giao dịch**: IQR fee/slippage [DA D4] + z-score fill vs mid [DA D8 ±2σ] → RiskAlert mức nhẹ (không ack-bắt-buộc) | [DA tr5-6 · tr16-18] | Ngưỡng ±2σ đúng mốc "rõ rệt" của tài liệu |

### P2 — Tự tiến hoá (sau khi P0-P1 ổn định ≥ 2 tuần)

| # | Hạng mục | Nguồn tài liệu |
|---|---|---|
| **E-P2-1** | **LLM ops Chairman khép kín** [ML M11]: drift monitor (tỷ lệ parse-fail + veto-rate + calibration shift) — vượt ngưỡng → cảnh báo "cân nhắc hiệu chỉnh prompt"; prompt A/B bằng paired t-test trước/sau [MATH H4]; versioning prompt trong `agent-context.ts` kèm hash vào AgentRun | ML tr14-16 · MATH tr5-6 |
| **E-P2-2** | **GPT-4-as-judge tự chấm summary Chủ tịch** (đối chiếu số vs DB) — chỉ khi provider mạnh có sẵn; human eval vẫn tối thượng [ML M6] | ML tr7 |
| **E-P2-3** | **A10 advisory từ rl-policy stance (A16)**: khi stance "thận trọng" → ExecutionPlan khuyến nghị tăng sliceCount/giảm tốc độ [DL L6 formalism] | DL tr11-12 |
| **E-P2-4** | **Autoencoder anomaly cho chuỗi giao dịch** — chỉ khi IQR/z-score thiếu [ML M12 · DL L4 fraud detection] | ML tr16-17 · DL tr8-9 |
| **E-P2-5** | **Reconciliation cross-entity đầy đủ**: position-vs-trade khối lượng tích luỹ + cash ledger; cân nhắc Window Function raw query [DA D11] + partition tư duy nếu DB phình | DA tr23-25 |

---

## §5. Kiểm định (pattern p2-verify — hermetic, tự dọn)

**`scripts/exec-verify.ts`** (mới — không đụng 73/73 hiện có):

| Nhóm | Check |
|---|---|
| EX-A (hợp đồng) | A1 ExecutionPlan parse/validate · A2 deadline guard · A3 đơn vị hoá fee (rg không hardcode rải rác) |
| EX-B (reconciliation) | B1 fee-recompute bắt lệch cài sẵn · B2 tax-recompute · B3 order-coverage · B4 cash-delta · B5 idempotent 2 lần chạy · B6 verdict MISMATCH → RiskAlert |
| EX-C (committed) | C1 committed = Σ nav5pct tín hiệu ACTIVE · C2 hết hạn giảm |
| EX-D (KPI) | D1 funnel đúng bằng tay · D2 không KPI âm |
| EX-E (an toàn) | E1 chu kỳ vẫn KHÔNG tự tạo lệnh · E2 plan chỉ sinh sau APPROVE · E3 đổi biểu phí 1 chỗ đổi mọi nơi |

Kèm: `bunx tsc --noEmit` · `bun run lint` · E2E agent-browser **qua gateway :81** (chuẩn mới từ #65: console 0 error + desktop 1440 + mobile 390) · `pm2 restart ecosystem.config.js --update-env`.

---

## §6. Nguyên tắc bất khả xâm phạm (kế thừa + bổ sung)

1. **Chu kỳ KHÔNG BAO GIỜ tự tạo lệnh** — ExecutionPlan chỉ sinh SAU APPROVE của trader (PHASE3 §4.5/§4.9; nhắc lại ở §1.1 điều 2).
2. **Biểu phí đơn nguồn** — đổi biểu phí sửa 1 chỗ (E-P0-1); reconciliation là lớp phát hiện, không phải lớp sửa.
3. **MISMATCH không "tự lành"** — mọi phép đối chiếu fail ghi RiskAlert trung thực (văn hoá "không bịa dữ liệu" DATA_PLATFORM_BLUEPRINT §0.4).
4. **Dự báo dòng tiền KHÔNG dùng làm hạn mức chặn** — chỉ hiển thị + khuyến nghị; câuclaimer "không phải hạn mức thật VNDIRECT" giữ nguyên.
5. **KPI không vanity** — conversion thấp không đồng nghĩa xấu (trader có thể đúng khi từ chối) — KPI mô tả, không phán xét [DA tr18-20 tips: "phân biệt ý nghĩa thống kê và ý nghĩa thực tiễn"].
6. **Graceful error handling** — mọi expect/plan fail-soft: reconciliation lỗi query → báo DEGRADED không sập chu kỳ [ML M14 best practice 4].
7. **Minh bạch mô phỏng/ước tính** — committed view, kịch bản dự báo, calibration đều gắn nhãn "ước tính nội bộ" (văn hoá DataSourceStatus).

---

## §7. Câu hỏi mở cho trader (trả lời trước khi chốt P0)

> **Ghi nhận v1.1 (phiên #70):** trader duyệt review #69 và chỉ thị bắt đầu P0 → 5 câu lấy **mặc định theo đề xuất gốc của từng câu** (đổi sau không phá hợp đồng — đều là tham số/config, không phải thay đổi schema): (1) `Order.note` JSON ở P0 · (2) deadline 1440 tick phiên liên tục ≈ 1 phiên · (3) committedBuyingPower âm → badge cảnh báo, không ack-bắt-buộc · (4) E-P1-1 chỉ narrative + bảng · (5) E-P1-3 TypeScript thuần baseline trước. Trader muốn đổi câu nào — nói trong chat, cập nhật constants + changelog.
>
> **Ghi nhận v1.2 (phiên #72):** trader duyệt 2 câu hỏi kiến trúc P1 (trình bày trong báo cáo fixbug #71) **theo đề xuất gốc**: câu (4) E-P1-1 chỉ narrative + bảng tỷ trọng trong output Chủ tịch — KHÔNG push vào prompt các chu kỳ sau; câu (5) E-P1-3 TypeScript thuần baseline tuyến tính + quantile — worker Python GRU chỉ mở khi baseline vượt ngưỡng lỗi (chưa mở trong P1). P2 (E-P2-1→5) là phase kế tiếp theo §4 — khởi động sau khi P0-P1 ổn định ≥ 2 tuần (điều kiện §4 P2).

1. **E-P0-2 — nơi lưu ExecutionPlan**: `Order.note` JSON (P0 gọn, không migration) hay bảng `ExecutionPlan` riêng (sạch hơn cho P1 tách thật)? *(đề xuất: note JSON ở P0 — migration chỉ khi làm E-P1-2)* ✅ mặc định: note JSON
2. **E-P0-2 — deadline mặc định**: 1440 tick (≈4h phiên liên tục) có hợp lý, hay muốn tính theo `expiresAt` tín hiệu (3 ngày)? ✅ mặc định: 1440 tick (chỉ đếm tick trong phiên — REV-7)
3. **E-P0-4 — committedBuyingPower âm**: chỉ badge cảnh báo, hay cần RiskAlert ack-bắt-buộc? ✅ mặc định: badge (P0 không chặn — không tạo áp lực ack rào)
4. **E-P1-1 — phạm vi đề xuất phân bổ**: chỉ narrative + bảng tỷ trọng trong output Chủ tịch (đề xuất), hay muốn push vào prompt các chu kỳ sau như ngữ cảnh? ✅ mặc định: narrative + bảng (P1)
5. **E-P1-3 — ngôn ngữ dự báo dòng tiền**: TypeScript thuần (baseline tuyến tính + quantile) đủ cho P1, hay mở worker Python GRU ngay từ đầu? ✅ mặc định: TypeScript thuần trước (P1)

---

## §8. Đánh giá độ sẵn sàng dữ liệu (cho các hợp đồng mới)

| Hợp đồng | Dữ liệu cần | Hiện trạng | Sẵn sàng? |
|---|---|---|---|
| ExecutionPlan | Order + Quote giá hiện tại + ADTV (đã có topByAdtv) | 🟢 đủ ngay |
| ReconciliationReport | Order · Trade · BrokerAccount.cashBalance · Position (mỗi Trade có fee/tax BigInt) | 🟢 đủ — cần checkpoint AppSetting |
| CommittedCashView | Signal ACTIVE + Quote last (sizing nav5pct tái tính) | 🟢 đủ |
| ChairmanScorecard | Signal + Bar 5 phiên sau nhãn | 🟢 đủ (Bar 215k dòng, mọi mã có bar; nhãn trễ 5 phiên tự nhiên) |
| CashflowForecast | chu kỳ lịch sử cash (AppSetting/BrokerAccount snapshot?) | 🟡 **chưa có chuỗi cash theo thời gian** — cần snapshot cash mỗi chu kỳ (thêm vào P1-3 precondition) |

---

## Changelog

### v1.0 — 2026-10-09 (phiên #66)
- Soạn bản thiết kế đầy đủ cho **nhóm Điều hành & Thực thi** (executive — 4 agents A1/A10/A11/A12) theo chỉ thị user "viết Blueprint với đầy đủ tất cả những gì lấy từ 4 tài liệu cho nhóm này".
- **§2 là trọng tâm**: ánh xạ chi tiết **44 cụm nội dung** từ 4 tài liệu upload (ML 14 · MATH 8 · DA 15 · DL 7) — mỗi cụm ghi rõ trang gốc, ai dùng, áp vào hạng mục nào; ma trận tổng 2.5; danh mục loại có chủ đích 2.6; stack kết luận 2.7.
- §0 chẩn đoán trung thực đo từ mã nguồn: 4 bảng roster-vs-code + dòng chảy tín hiệu→lệnh→khớp→bù trừ + 7 khoảng trống (G1-G7); xác nhận bằng rg: config `sliceCount/maxSlippagePct/orderType/taxSellPct/feePct` **0 consumer** — biểu phí thật hardcode 2 hằng số ở `tick/route.ts:60-61`.
- 10 điểm ĐÃ TỐT giữ nguyên (§0.3) — không làm lại an toàn phê duyệt/claim atomic/VETO/gate LIVE.
- Kế hoạch 5 P0 + 5 P1 + 5 P2 — **mọi hạng mục gắn nhãn nguồn tài liệu** (không hạng mục "không rõ gốc"); 5 câu hỏi mở §7 cho trader; 7 nguyên tắc bất khả xâm phạm §6 bổ sung vào 5 điều sứ mệnh §1.1. *(Hiệu chỉnh v1.1 — REV-6: bản ghi "5 nguyên tắc" ở đây sai — §6 có **7** nguyên tắc.)*
- Trạng thái: **BẢN THIẾT KẾ — chưa triển khai code nào** (chỉ document). Chờ trader duyệt khung P0 + trả lời 5 câu hỏi §7 trước khi lên code (quy trình soạn→chốt→triển khai→fixbug như DATA_PLATFORM_BLUEPRINT #54→#55→#57).

### v1.1 — 2026-10-09 (phiên #70)
- **Trader duyệt review #69** (chấm 8.6/10 · APPROVE WITH AMENDMENTS, commit `9f20ae5`) — chỉ thị "đưa 3 điều kiện bắt buộc vào blueprint và bắt đầu triển khai phase 0". 3 điều kiện bắt buộc hoà nhập:
  1. **E-P0-4 (REV-1)**: CommittedCashView **cộng PENDING/PARTIALLY_FILLED orders** (notional còn lại từ chính Order — phủ cả 2 đường sizing nav5pct/budget50m) + EX-C1 thêm ca APPROVE không tụt mù.
  2. **E-P0-1 (REV-2)**: **guard đơn vị percent↔fraction** (assert biên, sai 100× nổ lúc import) + đếm đủ **3 nguồn phí** (tick:60-61 · signal-execution:391 · roster:227) + EX-A3 kiểm guard.
  3. **Docs (REV-5/REV-6)**: §0.2 sửa thứ tự chạy (WAVE_E_SERVICE_CODES chạy SAU Chairman & Đợt F — route:1180) + changelog v1.0 ghi đúng "7 nguyên tắc §6".
- Kèm 4 hiệu chỉnh khuyến nghị của review: REV-7 (deadlineTicks chỉ đếm tick trong phiên liên tục) · REV-8 (phép đối chiếu thứ 6: Order.fee == Σ Trade.fee) · REV-9 (Trade `@@index([executedAt])`) · REV-12 (whitelist semantics phép cash-delta — MISMATCH khi seed/manual write là CÓ CHỦ ĐÍCH, reset checkpoint sau seed).
- §7: 5 câu hỏi lấy mặc định theo đề xuất từng câu (đổi được sau — tham số, không phá hợp đồng).
- Trạng thái: **P0 TRIỂN KHAI** (E-P0-1→5 + exec-verify §5 — phiên #70).

### v1.1.1 — 2026-10-10 (phiên #71 — fixbug Phase 0)
- **Giao thức Fixbug chạy trên toàn bộ code Phase 0** (4 lớp rà soát: tĩnh-code · tĩnh-dữ liệu · runtime · browser) — 4 findings, tất cả đã vá + kiểm định:
  1. **F-701-01 (P1) — POSITION_SIZE_PCT còn 2 nguồn**: `signal-execution.ts` giữ bản địa `0.05` trong khi `exec/constants.ts` xuất bản thứ hai cho CommittedCashView (E-P0-4) → nếu đổi 1 chỗ, ước tính cam kết lệch im lặng so với lệnh thật. **Vá**: xoá bản địa, sizing thật + committed view cùng import nguồn đơn `exec/constants.ts` (đúng tinh thần E-P0-1 mở rộng cho tham số sizing).
  2. **F-701-02 (P1) — funnel KPI trộn 2 cohorts**: bước 1-2 đếm theo `signal.createdAt∈window` nhưng bước 3-4 đếm MỌI lệnh theo `order.createdAt∈window` → dữ liệu thật hiển thị "Trader duyệt 2 → Lệnh tạo 9" (lệnh thủ công/seed/đường cũ vào nhầm phễu). **Vá**: neo funnel về **một cohort phê duyệt** (đúng nguyên văn §2 D1 "funnel phê duyệt") — lệnh chỉ vào funnel khi gắn tín hiệu actionable ACTED của window; lệnh còn lại đếm riêng `ordersOutOfFunnel` + UI chip "Ngoài phễu N" minh bạch (không biến mất). AOV/slippage cũng neo theo cohort để mọi con số card cùng một câu chuyện. exec-verify D1a/D2 đồng bộ semantics mới.
  3. **F-701-03 (P2) — position-delta `actual: NaN`**: khi có lệch, `actual` ghi NaN → `JSON.stringify` hoá null, mất con số trong AgentRun.output. **Vá**: actual = tổng delta thật theo mã (expected/actual/diff đều con số thật).
  4. **F-701-04 (P2) — `PLAN_ORDER_TYPE` ternary đồng vị**: `x === "LIMIT" ? "LIMIT" : "LIMIT"` đọc config A10 mà không tiêu thụ. **Vá**: hằng số thẳng `= "LIMIT"` + comment ghi rõ config `orderType` sẽ được tiêu thụ thật khi E-P1-2 (TWAP/MARKET).
- Không đổi thiết kế nào đã chốt (§8.2 Fixbug.md): F-701-02 là đưa code VỀ đúng spec "funnel phê duyệt" vốn có của E-P0-5, không phải thiết kế mới.
- Kiểm định sau vá: exec-verify **41/41 PASS** (D1a mở rộng assert cohort + ngoài phễu: 13/4/3/3/8 đúng bằng tay) · p2-verify 72/72 không hồi quy · E2E browser qua gateway: funnel đơn điệu + chip "Ngoài phễu" · A11 6/6 BALANCED · 0 console error desktop + mobile 390.

### v1.2 — 2026-10-10 (phiên #72 — triển khai Phase 1)
- **Trader duyệt 2 câu hỏi kiến trúc P1 theo đề xuất gốc** (trả lời trực tiếp trong báo cáo fixbug #71): §7.4 E-P1-1 chỉ narrative + bảng tỷ trọng trong output Chủ tịch (không push prompt chu kỳ sau) · §7.5 E-P1-3 TypeScript thuần baseline trước (worker Python GRU chỉ khi baseline vượt ngưỡng lỗi — chưa mở trong P1).
- **E-P1-1 (A1 khối đề xuất phân bổ)**: `src/lib/exec/allocation.ts` — config roster A1 `targetPositions=8`/`rebalanceThresholdPct=5`/`style` lần đầu có consumer (đóng G5); system prompt Chủ tịch thêm hợp đồng `allocation` {narrative, rows[{symbol, currentPct, targetPct, action}]} theo luật phạt mềm L2 (chỉ MUA/BÁN khi lệch vượt ngưỡng 5%); block `buildPortfolioWeightsBlock()` (%NAV mỗi vị thế + tiền mặt) cho vào user prompt để currentPct không bịa; parse an toàn (sai format → null + counter AppSetting `exec.chairman.allocationParseFail` làm drift metric E-P2-1); message Chủ tịch đính kèm narrative + bảng (§7.4 mặc định). E2E chu kỳ thật: Chủ tịch trả allocation 8 dòng đúng luật (TCB 12,3% → 10,0% GIỮ...) hiển thị tab Phát thanh.
- **E-P1-2 (TWAP tách lát thật — 2a+2b một lượt)**: `src/lib/exec/twap.ts` (ADTV-20 phiên từ Bar.value · `shouldTwap` notional > 1% ADTV · `draftTwapSlices` chia đều bội lot 100, phần dư dồn lát đầu, afterTick rải `floor(deadline/sliceCount)`); `buildTwapChildPlan` trong plan.ts — style "TWAP" + meta {totalSlices, signalId, notionalPctAdtv, adtvVnd}; `createPaperOrderFromSignal` sinh N Order con trong CÙNG claim transaction (AUD-CODE #2 giữ nguyên — atomic toàn phần), mỗi con 1 plan con, audit ORDER_CREATED ghi children + twap meta; fill engine guard `planSliceEligible` (E-P1-2b): chỉ khớp Order con tới lượt lát (afterTick đếm tick phiên REV-7) + đếm `twapWaiting`; decision/convert route trả `orders[]` + `twap` (giữ shape cũ `order` = lát đầu); KPI funnel thêm `approvedWithOrders`/`signalsFullyFilled` (bước 3/4 neo theo TÍN HIỆU — giữ đơn điệu khi 1 duyệt sinh N lệnh, hint hiển thị số lát thật). F-701-04 note chốt: config `orderType` vẫn tiêu thụ khi mở MARKET (P2+).
- **E-P1-3 (A12 CashflowForecast)**: model `CashSnapshot` mới (điều kiện tiên quyết §8 — chuỗi cash theo thời gian); `src/lib/exec/forecast.ts` — OLS slope VND/ngày + CI 95% từ quantile phần dư (phi tham số — kháng đuôi nặng [DA D7]); kịch bản {none, half, allApprove} từ CommittedCashView (half = kịch bản MINH BẠCH khai báo trong contract, không phải xác suất); A12 ghi snapshot mỗi chu kỳ + prune 90 ngày; /api/exec/kpi gộp `forecast` (fail-soft); UI ExecutiveKpi có dải dự báo 3 kịch bản + nhãn "ước tính nội bộ" (§6.4 không chặn lệnh).
- **E-P1-4 (ChairmanScorecard — giải G4)**: `src/lib/exec/chairman-scorecard.ts` + API `/api/exec/chairman-scorecard` + UI card dưới section nhóm executive (pattern B8). Nhãn 5 phiên sau: BUY thắng nếu high chạm target TRƯỚC khi low chạm stop (walk từng bar), fallback close-5-phiên vs giá sinh khi thiếu target/stop; SELL đối xứng; thiếu 5 bar → `pendingLabels` (không bịa). Metrics [ML M1/M2]: confusion (predicted-up=BUY · actual-up=giá tăng) → precision/recall/F1; AUC-PR = Average Precision gộp nhóm đồng điểm; RMSE target/stop (BUY có số); calibration LOW/MEDIUM/HIGH → winrate + odds p/(1−p) [MATH H6 — odds null khi 0%/100% minh bạch]; enoughData=false khi nhãn < 30 [DA D7].
- **E-P1-5 (A11/A10 bất thường giao dịch)**: `src/lib/exec/anomaly.ts` — z-score fill vs mean20/σ20 Bar close (|z| > 2 [DA D8] — σ=0 bỏ qua trung thực) + IQR slippage [DA D4] (fence 1,5×IQR, cần ≥ 4 mẫu); A11 quét trên CHÍNH window reconciliation vừa đóng + RiskAlert `EXEC_TRADE_ANOMALY` severity INFO (nhẹ — không ack-bắt-buộc, dedupe 24h); fail-soft riêng không làm hỏng reconciliation.
- **Kiểm định (§5 mở rộng)**: exec-verify **87/87 PASS** (P0 41 giữ nguyên + P1 46 mới: F=17 TWAP · G=7 forecast · H=10 scorecard · I=4 anomaly · J=8 allocation — E2E hermetic cài/dọn qua instrument test EVT1/EVS2/EVS2B/EVA3 + tài khoản soft-delete) · p2-verify **72/72** không hồi quy · tsc 0 lỗi src/ · lint src sạch (2 lỗi cũ examples/websocket ngoài phạm vi) · E2E browser qua gateway :81: desktop 1440 + mobile 390 0 console error/page error, KPI card + Bảng điểm Chủ tịch + dải dự báo + tab Phát thanh allocation đều render, footer sticky đúng, chu kỳ 23 agents thật 86s: A1 allocation 8 dòng + A11 BALANCED + anomaly scan 0 (trung thực) + A12 forecast n=2 snapshot · tick 200 chảy liên tục.
- **Ghi nhận trung thực phạm vi E2E**: TWAP verify ở mức hàm + DB thật (F3: APPROVE lệnh lớn trên instrument ADTV nhỏ → 3 Order con + plan + audit + fee), KHÔNG để lại lệnh TWAP sống trong sổ prod (danh mục thực nhỏ hơn ngưỡng 1% ADTV của mã thật — TWAP chưa tự nhiên kích hoạt; cơ chế đã chứng minh hermetic).

### v1.2.1 — 2026-10-10 (phiên #73 — fixbug Phase 1)
- **Giao thức fixbug P1 (3 vòng rà + 2 vòng vá)**: Vòng 1 rà đối kháng SONG SONG (2 review agent độc lập, probe runtime + DB read-only) → **28 findings** (0 P0 · 1 P1 · 9 P2 · 18 P3) · Vòng fix 28/28 (3 fix agent song song theo cụm file không giao nhau + harness) · Vòng 2 rà lại đối kháng: **28/28 fix CONFIRM + 6 finding mới** (1 P2 + 5 P3 — bug do fix/harness引入) → vá hết · Vòng 3 xác nhận sạch độc lập (4/4 kiểm định tự chạy khớp) + 3 finding nhỏ P3/P4 → vá nốt. **Tổng 37 findings · 37/37 vá**.
- **P1/P2 đáng kể (logic tính năng + an toàn dữ liệu)**: F-73A-01 (P1) `triggerPct: 1` literal → import hằng `TWAP_ADTV_TRIGGER_PCT` đơn nguồn §3.3 (cùng họ F-701-01) · F-73A-02 (P2) plan + note TWAP ghi NGAY trong cùng `$transaction` — bản cũ ghi ngoài tx nên (a) cửa sổ race vài trăm ms: tick engine có thể khớp lát sau TRƯỚC khi guard afterTick tồn tại trong note (b) update fail giữa chừng → con còn lại mất guard vĩnh viễn · F-73B-01 (P2) forecast `orderBy asc + take 500` lấy 500 snapshot CŨ NHẤT → trend/CI đóng băng vĩnh viễn khi chuỗi > 500 (đổi desc + reverse, kèm regression check G5) · F-73B-02 (P2) anomaly IQR lệch chỉ số orders↔slippageSamples khi có lệnh FILLED price=0 — gán nhầm anomaly cho lệnh khác + bỏ sót outlier thật (mô phỏng chứng minh) → zip cặp {order, slip} + query `price > 0` · F-73B-05 (P2) fit OLS trên chuỗi trải vài phút → slope 720tr ₫/ngày vô nghĩa → guard `MIN_SPAN_DAYS = 1` (trend/CI null trung thực) · F-73A-04 (P2) exec-verify F3 plant TWAP trên tài khoản prod — fill engine nền khớp được lát giữa create→dọn, cleanup cũ KHÔNG hoàn cash (snapshot cash/equity + hoàn có điều kiện kèm phát hiện fill prod đồng thời + dọn audit đầy đủ kể cả throw giữa chừng) · F-73A-05 (P2) race APPROVE/REJECT decision route: REJECT `update` vô điều kiện đè được ACTED trong khi N lệnh con đang sống → REJECT `updateMany where status=ACTIVE` + 409; APPROVE bỏ ghi đè (re-read — claim atomic đã đúng) · F-73A-03 (P2) single-run Chủ tịch: system prompt đòi đối chiếu block tỷ trọng nhưng user prompt không có dữ liệu (LLM bịa currentPct — đúng cái E-P1-1 diệt) + allocation output bị nuốt im lặng → cấp block + parse + đếm parse-fail · F-73B-03 (P2) anomaly IQR `symbol: "N cp"` → mã cổ phiếu thật · F-73B-04 (P2) /api/exec/kpi hardcode `buyingPowerFactor 0.5`/`marginRoomMinVnd 0` khác roster A12 → đơn nguồn hoá + equity fallback `avgPrice` F-102 như portfolioSnapshot.
- **P3 đáng chú ý**: F-73A-06 draftTwapSlices tự bảo vệ hợp đồng lot-100 (nuốt phần dư → null) · F-73A-07 adtv20For < 20 bar → adtv=0 (không tách mù trên ADTV-k) · F-73A-13 rationale plan SINGLE nói đúng nhánh thật (singleReason 3 giá trị) · F-73B-08 scorecard thiếu agent row → contract RỖNG trung thực (bỏ fallback-all — DB thật có tín hiệu từ 4 agentId) · F-73B-06/07 ruleCounts {targetStop, close5, pending} minh bạch semantics fallback + "RMSE tính trên tập BUY" · F-73A-08 + F-73R2-03 + F-73R3-02: **5 chỗ `position.findMany` neo về tài khoản sống** (buildMarketBlock · kpi route · portfolioSnapshot · loadCurrentLedger — không trộn vị thế tài khoản khác/soft-delete vào NAV/ledger) · F-73A-09 message Chủ tịch `whitespace-pre-line` (khối allocation giữ cấu trúc narrative + bảng) · F-73A-10 SignalDecisionResponse thêm orders/twap + toast "TWAP N lát · tổng X cp" · F-73A-11 counter parse-fail không đóng băng khi value hỏng · F-73B-11 window anomaly khớp mép reconciliation (`report.window.toNow`) · F-73B-12 z-score cần đủ 20 bar + detail nêu baseline trước window · F-73B-13 FunnelBar value=0 vẽ thanh 0 · F-73B-09/10 note forecast khai báo horizon 1h cố định + CI thang ngày bảo thủ + allApprove bỏ inflow SELL ACTIVE (bảo thủ một chiều) · F-73R2-01/R3-01 harness I3 không false-fail + không xoá nhầm alert prod (pre-existing 24h window) · F-73R2-02 hoàn cash chỉ khi không có fill prod trong window test.
- **Không đổi thiết kế đã chốt** (§8.2 Fixbug.md): mọi fix đưa code VỀ đúng hợp đồng P1 (đơn nguồn §3.3 · hermetic §5 · atomic AUD-CODE #2 · trung thực §6) — không thay đổi hành vi giao dịch.
- **Kiểm định sau vá**: exec-verify **87→91 checks** (+G5/G5b regression >500 snapshot · H5 fallthrough + ruleCounts · I2 refId đúng lệnh 22.000 + I2b symbol thật) **91/91 PASS ×2 liên tiếp** · p2-verify **72/72** không hồi quy · tsc 0 lỗi src/+scripts/ · lint src sạch · E2E browser qua gateway :81: desktop 1440 + mobile 390 **0 console error/page error** — KPI funnel đơn điệu 9→2→2→2 + chip "Ngoài phễu 7" · dải dự báo "2 snapshot · linear-quantile" + trend null trung thực (span < 1 ngày — F-73B-05 hoạt động thật) · Bảng điểm Chủ tịch đủ badge "Chưa đủ 30 nhãn" + dòng "Chấm theo target/stop: 0 · close-5: 0" · dev.log toàn 200 · dọn hermetic sạch sau verify (0 instrument/alert/audit/snapshot test sót).

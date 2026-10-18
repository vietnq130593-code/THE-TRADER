# AUDIT 137 — RÀ SOÁT TOÀN DIỆN CODE VẬN HÀNH THE TRADER

- **Ngày:** 2026-10-18 · **Task ID:** 137 · **Phương thức:** 4 subagent audit song song (A: đội agent & council · B: pipeline ML/NN · C: thực thi & rủi ro · D: frontend & data layer) + 1 lượt đối chứng cá nhân toàn bộ findings CRITICAL/HIGH trực tiếp trong code trước khi công bố.
- **Đối chứng thêm:** DB sống Supabase (RiskQuantSnapshot, RiskAlert, AgentRun settlement, AuditLog, MlModel, BrokerAccount/Position/Order/Trade) · dev.log · lint (0 lỗi) · tsc (chỉ lỗi có sẵn scripts/skills).
- **Tổng:** **40 findings** — 1 CRITICAL · 3 HIGH · ~15 MEDIUM · ~21 LOW · + 4 danh mục nợ kỹ thuật · + danh sách đã-kiểm-tra-và-sẠCH (≈50 mục).
- **Phụ lục thô:** `docs/audit/137-{a,b,c,d}-raw.md` (bản đầy đủ từng phân hệ của 4 subagent).

## 0. KẾT LUẬN CHUNG

> Lõi giao dịch (state machine Order, claim atomic chống double-execution, TWAP, timezone phiên VN, toán phí/thuế, backprop MLP/GRU) **được bảo vệ tốt và kiểm chứng bằng mô phỏng tay + numerical gradient-check**. Ba nhóm vấn đề thật sự:
> 1. **"Hai thế giới tiền" (paper vs sandbox K1) chưa xuyên suốt** — risk engine, reconciliation, committed-cash, KPI, anomaly vẫn trộn sandbox vào paper → đã tạo alert giả thật + nhiễm hạn mức VETO động (C1 CRITICAL).
> 2. **Vệ sinh ML thiếu heldout** — chuẩn hoá toàn dãy trước khi chia train/val (B1), chọn champion rồi chấm trên chính val đó (B4), calibration/macro-edge đo in-sample (B5/B6) → mọi valAcc công bố (42,9%) mang thiên lệch lạc quan hệ thống.
> 3. **Vài lỗi logic rời rạc có thật**: Q-learning "96 trạng thái" thực tế chỉ 36 (B2), đếm kép episodes (A1), broadcast khai sai kiến trúc serving (A5), VETO fail-open khi control-agent crash (A3).

## 1. CRITICAL (vá ngay)

### C1 — Risk engine + Scenario engine đo NHẦM THẾ GIỚI: NAV/VaR/HHI/ngưỡng VETO động của paper chạy trên danh mục sandbox
- **File:** `src/lib/risk/engine.ts:389-409` · `src/lib/risk/scenario.ts:708-728`
- **Cơ chế:** `position.findMany({ where: { status: "OPEN" } })` — không lọc tài khoản (gộp vị thế sandbox); `brokerAccount.findFirst({ where: { deletedAt: null } })` — không lọc accountType, không orderBy.
- **Bằng chứng DB sống:** paper đang trống (cash=0, 0 vị thế) nhưng 5 RiskQuantSnapshot gần nhất đều `nav=29.720.000, proxy=false` = đúng bằng 3 vị thế sandbox (TCB+VIC+VPB) + cash paper 0. Hệ quả dây chuyền ĐÃ XẢY RA: `topPosPct 72,34% > dynMax 28,43%` → breach mỗi chu kỳ → CRB-7 Beta learning ghi `risk-quant-limits {position α:10 β:128}` → hạn mức VETO A7 của paper bị siết một chiều theo dữ liệu sandbox; RiskAlert CRITICAL (QUANT_MC_DD/CVAR/HHI) sống trên số liệu sai; `quant-tail` evidence DOWN nhiễm posterior đồng thuận → kéo tín hiệu paper.
- **Tự tin 95%** — đã đối chứng code cá nhân + khớp tuyệt đối DB; cùng họ code, `portfolioSnapshot`/`reconciliation ledger`/`kpi route` đều lọc đúng — riêng 2 file này (viết trước K1 #87) bỏ sót.
- **Fix:** world-context "paper" cho cả 2 engine (fetch account `accountType: { not: "sandbox" }` + orderBy cố định, positions theo account.id) → **reset `risk-quant-limits` về prior** vì Beta đã nhiễm → thêm regression "paper trống + sandbox có vị thế ⇒ proxy-mode".

## 2. HIGH

### B1 — LOOKAHEAD chuẩn hoá: mean/std tính trên 100% mẫu trước khi fit chia 80/20
- **File:** `src/lib/ml/train-mlp.ts:460` (tái phạm `macro-forecast.ts:462`, `api/ml/train/route.ts:272`)
- `standardize(set.X)` chạy trên toàn bộ chuỗi; `fit()` (nn.ts:366-371) mới cắt val = block cuối 20%. Block tương lai đóng góp vào thống kê z-score → **valAcc 42,9% của serving v73 thiên lệch lạc quan hệ thống**. Bằng chứng tính chủ ý: đường GRU cùng route tính mean/std **đúng chỉ trên train split** — MLP path là sơ suất.
- **Fix:** truyền `nTrain` vào standardize (hoặc chuẩn hoá sau khi cắt) — 3 call-site.

### B2 — Q-learning "96 trạng thái" thực ra chỉ có 36 trạng thái hiệu dụng
- **File:** `src/lib/ml/rl.ts:168`
- `(((regime?2:0)+trend)*4+rsi)*2 + mom*3 + exp` — thiếu cặp ngoặt quanh `…+mom` trước `×3` (uutu tiên phép nhân), khác công thức legacy 48-state đúng ở dòng 166. Enumeration chạy thật: 96 trạng thái logic → **36 index duy nhất, max 35, 60 va chạm** (vd `r0m0e2 ≡ r1m0e0` cùng index 2); 60 hàng Q-table chết. Train và policyStance dùng cùng hàm sai nên không crash — nhưng dồn trạng thái khác nhau vào cùng Q-value; mọi tuyên bố "96 trạng thái" (docs #129, UI) sai. Bản 48-state cũ sạch.
- **Fix:** `((((regime?2:0)+trend)*4+rsi)*2+mom)*3+exp` + retrain rl-q + đồng bộ nhãn.

### C2 — Reconciliation: Trade sandbox rơi vào window nhưng ledger chỉ đo paper → MISMATCH GIẢ đã nổ 2 lần thật
- **File:** `src/lib/exec/reconciliation.ts:194-207` vs `:99-122`
- `trade.findMany({ executedAt ∈ window })` không lọc thế giới; `loadCurrentLedger()` paper-only. **DB:** 2 RiskAlert EXEC_RECONCILE_MISMATCH + 2 AgentRun settlement MISMATCH (14-10: trades=2 TCB+VIC expected −25.788.625 vs actual 0 · 16-10: trades=1 VPB) khớp đúng timestamp fill sandbox. Còn 1 lệnh PENDING sandbox → sẽ nổ tiếp, gây alarm-fatigue che mismatch THẬT.
- **Fix:** join Trade→Order lọc accountType theo thế giới ledger (hoặc 2 chu kỳ reconciliation riêng paper/sandbox).

## 3. MEDIUM (chọn lọc — đầy đủ trong phụ lục)

| Mã | File | Vấn đề | Tác động |
|---|---|---|---|
| A1 | `agent-service-runs.ts:1087-91` | So **object identity** (`m !== metrics`) thay vì `v.id !== model.id` — `parseModelMetrics` luôn trả object mới → episodes bản serving cộng 2 lần | Số liệu broadcast A16 + AgentRun sai (thổi ~+2.000 episode) |
| A2 | `ml/bandit.ts:333-336` + `eod-sync.ts:350-353` | Bar ngày D lưu `15:00 UTC` nhưng chốt thật 08:00 UTC → phiếu bầu sau 15:45 ICT bị tính `castDate=D-1`, đo `[D-1→D+4]` — 1/5 phiên reward là thông tin đã biết lúc bầu | Posterior Beta → trọng số cử tri → Kelly CRB-9 tuyệt đối bị thổi, ~1/6 chu kỳ |
| A3 | `api/agents/run/route.ts:835-850` | Control agent A7/A8 crash → `result=null` → `verdict.startsWith("VETO")` không match → **fail-open**: tín hiệu MUA đi thẳng, agent lỗi còn biến mất khỏi digest | Ngược nguyên tắc VETO-cứng fail-safe |
| A4 | `agent-ratelimit.ts:15,35-37` + `run/route.ts:412-450` | Watchdog dọn RUNNING >5' nhưng chu kỳ LLM xấu nhất ≈ >5' (45s×4 retry×8 agent tuần tự) → agent xếp hàng bị reset IDLE giữa chừng → **2 chu kỳ chồng** (double LLM, double AgentRun, 2 tín hiệu Chairman) | Rủi ro vận hành hiếm nhưng thật |
| B3 | `ml/features.ts:1369-1385` | PIT weekly basket binary-search `week <= wk` dùng rổ của chính tuần — rổ rank từ bar cuối tuần → nhìn tương lai ~4 phiên (comment tự nói ngược code). **Latent** — chưa call-site nào bật `pointInTime:true` | Mìn chờ F-11 kích hoạt |
| B4 | `ml/sweep.ts:1157-1185` | Champion CHỌN theo score trên val rồi valAcc CÙNG val đó làm điều kiện cổng 1 — winner's curse ~16 ứng viên, không heldout/walk-forward; ΔBrier paired CI sạch riêng | valAcc champion lạc quan |
| B5 | `ml/calibration.ts:178-182` | `eceAfter` tính trên chính `safeProbs` vừa fit isotonic (in-sample) trong khi header hứa "ECE giảm ≥20% trên **holdout**" | Gate calibration tự pass |
| B6 | `ml/macro-forecast.ts:816-836` | Brier60/edge đo trên val block của chính model (đã early-stop + dính B1) → "US10Y 67,5%" hiển thị vào prompt Chủ tịch như track record | Lac quan một phần |
| B7 | `ml/multitask.ts:136,268-285` | Head mag/vol sai toán đã **numerical-check FAIL** (placeholder `>= 0 ? 1 : 1`, thiếu hệ số ×0,1, ReLU gate sai tầng). Giảm nhẹ: dl-mtl là shadow, chưa từng serving | Ngủ — khoá hoặc viết lại |
| C3 | `exec/committed.ts:79-102` | Lệnh PENDING không lọc thế giới → 1 lệnh sandbox TCB làm `committedBuyingPower` paper = **−3.385.070₫** sai | Badge cảnh báo sai cho paper trống trơn |
| C4 | `signal-execution.ts:490-491` | `Math.max(100, floor(rawQty/100)*100)` ép min-lot khi ngân sách 5% NAV < 1 lot → **lệnh thật VIC 100cp @224.200 = 22,6% NAV (4,5× sizing ý định)**; đường budget50m cùng ca lại từ chối — hai đường trái dấu | Vượt hạn sizing; không guard đủ tiền |
| C5 | `paper-world.ts:96-114` | resetPaperWorld không gọi `resetReconcileCheckpoint()` dù REV-12 (chính module reconciliation:19-23) bắt buộc → MISMATCH giả "0 giao dịch" sau mỗi reset | Alert giả sau reset |
| C6 | `market/tick/route.ts:365-377` | Fill BUY trừ cash không guard → cash âm dồn; `marginUsed` không có writer nào → veto margin A8 đo hằng số 0 | Đòn bẩy thật không đo được |
| D1 | `use-realtime.ts:33-39` + `footer.tsx:130` + `quotes-table.tsx:104` | Tooltip hứa "đang dùng polling TanStack Query" khi WS chết nhưng query `["quotes"]` **0 refetchInterval** → bảng giá + biểu đồ đóng băng; 760 dòng socket.io 404 trong dev.log chứng minh WS rơi thật | Điểm hỏng đơn của UX realtime |
| D3 | `src/app/` (toàn thư mục) | **0 error.tsx / global-error.tsx** — một exception render thổi bay cả 8 workspace về màn lỗi mặc định Next, mất trạng thái | Blast radius 100%, xác suất thấp |

## 4. LOW (tóm tắt — chi tiết phụ lục)

- **A5** `agent-service-runs.ts:1075,1096,1181` — broadcast hardcode "48 trạng thái", "MLP 10→16→8→3", "5 arm" — đều sai thực trạng (rl-q v15, serving 24-48-24-12-3, 7 arm) → Hội đồng đọc mô tả sai kiến trúc đang dự báo.
- **A6** `agent-service-runs.ts:183-185` — hết tài khoản paper thì Exposure/Compliance đo NAV trên CẢ vị thế sandbox (mất kiểm dịch K1).
- **A7** `consensus.ts:143-158` — wouldBlockRate sai mẫu (tử ≤200, mẫu vô hạn, gộp cả assessment manual).
- **A8** `run/route.ts:417-476` — khe TOCTOU findMany→updateRunning ~50-300ms cho single-run claim → 1 agent chạy kép.
- **B8** `train-mlp.ts:110,537-540` — cut 0,8 cứng cho calibration + featureHist trong khi `valFraction` nhận 0,1-0,4 → đổi valFraction làm calibration fit lẫn mẫu train.
- **B9** `api/ml/status/route.ts:215,231` — PSI drift so 16 chiều vs featureHist 24 chiều → 8 chiều vĩ mô không được giám sát drift.
- **B10** `bandit.ts` — Wilson trên reward thập phân (xấp xỉ, nhãn sai "posteriorMean"); `dates` không filter close>0 → bar rắc chết `regimeOf` vĩnh viễn.
- **B11** `xrel.ts:616-627` — permutation p = ge/200 thay vì (ge+1)/(N+1) → p=0 tuyệt đối hoá.
- **B12** schema thiếu `@@unique([kind, version])` MlModel; macro-forecast train mutex riêng song song được với train/sweep.
- **B13** `api/ml/tuning/route.ts:195-201` — resetBandit bỏ `regimeStats` → ưu tiên track record regime "đã xoá".
- **B14** `ensemble-learn.ts:237-265` — gate kiểm định softmax đầy đủ nhưng deploy 2 scalar heuristic |w|; GRU bật còn cộng cứng W_GRU=0,2.
- **C7** `exec/forecast.ts:47-51` — prune 90 ngày A12 xoá luôn chuỗi snapshot sandbox 365 ngày (telemetry học K1).
- **C8** `tick/route.ts:288-307` — Order.fee toàn khối lượng vs Trade.fee theo phần khớp → lệch nếu có PARTIALLY_FILLED (trạng thái chết hiện tại — bug ngủ).
- **C9** `tick/route.ts:313-363` — position read-then-write không row-lock (an toàn nhờ đơn-process; mất an toàn khi scale).
- **C10** `exec/kpi.ts:96-176` + `anomaly.ts` — KPI/anomaly trộn 2 thế giới; `slice(-100)` sau sort lấy 100 giá trị LỚN NHẤT (comment nói "gần nhất").
- **C11** `signal-execution.ts:261-274` vs `:1010-1013` — tín hiệu `consensusGate=null`: auto-decision TỪ CHỐI fail-safe nhưng convert TAY được tạo lệnh — hai đường trái dấu.
- **D2** `serialize.ts:17-20` — `seen.add` không bao giờ remove → DAG shared-reference bị thay "[Circular]" (mìn cho route tự build payload).
- **D4** `use-realtime.ts:104-110` — engine phát 14 sự kiện WS, client nghe 5 → `settle`/`ml-train`/`council-eval`... không invalidate query tương ứng.
- **D5** `page.tsx:64-66` — cold-load double-fetch + flash ~200ms do hydrate dateRange sau khi query con mount "all".
- **D6** engine `index.ts:320-322` — CORS `origin:"*"` không auth (chấp nhận sandbox; phải khóa trước khi public).
- **D7** engine `index.ts:82-88` — `bun --hot` đăng ký scheduler TRÙNG, chỉ console.error nhắc restart tay.

## 5. ĐÃ KIỂM TRA VÀ SẠCH (điểm tin cậy — trích nổi bật, ~50 mục đầy đủ trong phụ lục)

- **Toán lõi ML:** backprop MLP & GRU BPTT đúng (numerical gradient-check 9,6e-10 / 1,6e-7 PASS); softmax trừ max; lag/off-by-one sạch (nhãn t+5, lag t-1..t-3, GRU window); PIT macro `alignBefore` chặt `date < vnDate`; Wilson CI đúng; Murphy decomposition đúng đẳng thức; Brier multiclass đúng 4 nơi; bandit settle idempotent; seed sweep deterministic + round-trip NAS guard.
- **Giao dịch:** state machine Order 4 chuyển đều claim atomic; double-convert tín hiệu mô phỏng 2 request đồng thời chỉ 1 thắng; VETO hard-enforce (A7/A8 hạ HOLD trước khi lưu); TWAP mô phỏng 1000cp/3 lát = 400+300+300 Σ chính xác, không timer → không leak; timezone phiên VN (UTC+7, T2-T6, 09:15-11:30/13:00-14:45, lễ 2026-27) đúng; biểu phí 1 nguồn, fill ≡ recompute từng dòng; ¼-Kelly/EWMA/VaR/CVaR/CUSUM đúng công thức.
- **Frontend:** 12 hook + 15 component mọi interval/socket/listener có cleanup; TanStack v5 dedupe + key tách cache; Zustand selector nguyên tử 100%; ICT +7h nhất quán trục UTC; BigInt/Date serialize an toàn; res.ok 100% client fetch; XTransformPort truyền đúng mọi request engine.io.

## 6. LỘ TRÌNH KHUYẾN NGHỊ (hàng đợi F-23)

| Ưu tiên | Gói | Nội dung | Lý do |
|---|---|---|---|
| **P0** | World-context risk/exec | C1 + C2 + C3 (+C5, C10) một cơ chế `world` chung cho mọi hàm đọc Order/Trade/Position; reset `risk-quant-limits`; regression "paper trống + sandbox có vị thế ⇒ proxy-mode" | Đang tạo alert giả + nhiễm ngưỡng VETO động mỗi chu kỳ |
| **P1** | Vệ sinh ML đánh giá | B1 (standardize train-only, 3 call-site) + B2 (96-state + retrain rl-q) + A1/A5 (số liệu broadcast đúng thực trạng) | Mọi valAcc/episodes/trạng-thái công bố đang sai ý nghĩa |
| **P2** | Fail-safe vận hành | A3 (control-agent null ⇒ HOLD) + A4 (nâng watchdog ≥ worst-case) + D3 (error.tsx + global-error.tsx) + C4 (min-lot ⇒ từ chối khi <1 lot trong hạn) | Đóng 4 điểm hỏng đơn |
| **P3** | Realtime UX | D1 (refetchInterval khi !connected + sửa tooltip) + D4 (5 handler invalidate) + D7 (guard boot scheduler) | UX đóng băng khi WS rơi |
| **P4** | Dọn dẹp | A2 (mốc giờ-chốt bandit) + B4/B5/B6 (heldout/walk-forward) + B3 (PIT `< wk` trước khi bật F-11) + B7 (khoá dl-mtl) + LOW còn lại | Nợ trung hạn, cần thiết trước khi mở rộng |

## 7. GHI CHÚ TRUNG THỰC

- B4/B5/B6 cùng một thiếu hụt cấu trúc (val dùng nhiều lần) — không làm mô hình "hỏng", chỉ làm **số công bố lạc quan**; δ=0,01 + ΔBrier paired CI vẫn là hàng rào bộ phận có thật.
- Một số findings ranh giới "bug vs chủ ý paper-trading" (C4 min-lot, C6 no-cash-guard) — đã ghi rõ cả hai phía trong phụ lục để chủ sở hữu quyết định chính sách.
- Cả 4 subagent đều xác nhận truyền thống fail-soft/try-catch và ghi chú trung thực của codebase là nhất quán — phần lớn các nghi vấn ban đầu đã bị loại trừ là false positive sau khi truy call-site.

---
*Audit read-only: 0 file sản phẩm bị sửa trong quá trình rà soát. Báo cáo này + 4 phụ lục là sản phẩm của Task 137.*

## 8. TRIỂN KHAI LỘ TRÌNH (Task 138 — F-23, cùng ngày)

**P0 — World-context risk/exec (138-a) — XONG:**
- C1 engine.ts + scenario.ts: account paper nạp trước (`accountType != sandbox` + orderBy) → positions theo account; hết paper → 0 vị thế → proxy mode. **Reset `risk-quant-limits` về prior Beta(1,99) (đã nhiễm α:10 β:128) + ack 3 alert EXEC_RECONCILE_MISMATCH giả** (scripts/p137-reset-risk-prior.ts — AuditLog RISK_QUANT_LIMITS_RESET).
- C2 reconciliation lọc Trade theo `order.brokerAccount.accountType` · C3 committed lọc lệnh PENDING · C5 resetPaperWorld gọi resetReconcileCheckpoint (REV-12) · C7 prune CashSnapshot theo brokerAccountId · C10 KPI/anomaly world filter + slippage giữ 100 mẫu GẦN NHẤT theo thời gian.
- **Verify script PASS toàn bộ (scripts/p137-verify-world.ts):** runRiskQuantEngine → nav=0 ≠ 29.720.000, proxy=true, topPosPct null · runReconciliation → BALANCED, tradesCount=0 · committedBuyingPower=0 ≠ −3.385.070.
- A6 fallback positions `[]` · A1 đếm episodes theo `v.id` · A5 broadcast derive arch thật (24-48-24-12-3) + states 96 + 7 arm từ BANDIT_ARM_CODES.length.

**P1 — ML hygiene (138-b) — XONG:**
- B1 `standardize(X, {nTrain})` — mean/std chỉ trên train split, 3 call-site (dl-mlp · macro-mlp · dl-mtl) khớp công thức cut nn.ts; tự kiểm ví dụ nhỏ PASS. **valAcc từ train kế tiếp sẽ nhạt hơn số cũ (trung thực, không phải sa sút).**
- B2 rl.ts thiếu ngoặc vá + **retrain rl-q v16 serving: Q-table 96×3, 66/96 hàng được cập nhật (trước vá tối đa 36)** — scripts/p137-verify-rl-states.ts chặn tái diễn.
- B3 PIT basket `< wk` · B5 calibration gate holdout nửa-đầu/nửa-sau (PAV hết tự pass) · B6 macro reserve 60 phiên cuối + cờ brier60Holdout · B8 một biên nTrainSplit thay cut 0,8 cứng · B9 PSI giám sát đủ 24 chiều v3-macro (phát hiện sống: max PSI 27,6 ΔUS10Y) · A2 cửa sổ reward bandit theo mốc giờ-chốt ICT (mô phỏng PASS 2 nhánh) · B10/B11/B13 dọn vặt · B7 khoá dl-mtl (400 + banner) · B4 docs selection bias §4.4.1.

**P2+P3 — Fail-safe + Realtime (138-c) — XONG:**
- A3 VETO fail-closed: control agent lỗi → hạ GIỮ + Chủ tịch/digest/Bayes thấy nhãn "chưa kiểm định" · A4 heartbeat 7 điểm sau mỗi wave (watchdog 5' chỉ dọn chu kỳ chết im) · A8 claim chu kỳ điều kiện `status != RUNNING` + count → 409.
- C4 min-lot: rawQty < 100 → 400 "nhỏ hơn 1 lot" (hết lệnh 22,6% NAV) · C11 gate null chặn cả 2 đường (đồng bộ fail-safe) · A7 wouldBlockRate tử/mẫu cùng cửa sổ + lọc source cycle.
- D3 error.tsx + global-error.tsx (trước đó 0 boundary) · D1 polling fallback 30s cho ["quotes"] khi WS chết + tooltip trung thực · D4 wiring 8 sự kiện WS → invalidate queryKey tồn tại · D7 guard scheduler trùng bun --hot · D2 serialize path-based (DAG hết "[Circular]" giả — verify 7 ca).
- Còn: D5 (cold-load flash), D6 (engine CORS) — LOW, giữ nguyên có chủ ý (sandbox); xem phụ lục D.

**P4 — Hoàn tất DEFER + vận hành trung thực hoá (Task 139) — XONG:**
- **B4 walk-forward sweep (triển khai thật):** cắt H = 5% cửa sổ kẹp [120;1500] (hiện 1.500 mẫu ≈ 24-06 → 09-10) khỏi vũ trụ chọn-lựa — ứng viên train/early-stop/score trên m = n−H mẫu đầu; block holdout cuối CHỈ đo điều kiện 1+2 cổng (champion vs serving ĐỒNG cửa sổ, post-selection). `SweepChampionInfo` + championJson + audit ML_SWEEP_SWAP + UI tab Tự động tìm kiếm thêm khối `holdout` + `selectionNote`. Nghiệm thu mini-sweep sống (budget 3): champion C3 selection-valAcc 42,4% nhưng holdout 34,3% < serving 37,0% → cổng TỪ CHỐI swap đúng — winner's curse hiện hình đúng như chẩn đoán. Học thêm 1 bug trong lần chạy đầu (setTrain thiếu cắt symbols/dates → TypeError ở topSymbols — fail-soft giữ 0 hàng MlModel, vá ngay + cắt đồng bộ mọi mảng).
- **B12:** `@@unique([kind, version])` MlModel đã push DB (unique index `MlModel_kind_version_key` — DB kiểm 0 trùng trước đó) + comment kind chuẩn hoá + macro-forecast POST train giờ dùng `tryAcquireTrainLock` DÙNG CHUNG train/sweep (bận → 429) — macroMutex chỉ còn chống 2 POST macro đè nhau.
- **B14:** gate ensemble-learn giờ chấm Brier của CHÍNH công thức deploy (cặp scalar wMlp/wLinreg → score → pf mapping) so fixed 0,7/0,3 cùng công thức — softmax đầy đủ chỉ còn số chẩn đoán (`valBrierDeployed` vào AppSetting + whyRejected nói rõ) · ensemble.ts: learned chỉ áp trong thế giới 2 giọng được kiểm định — GRU bật → cặp fixed V3 (hết double-count W_GRU ngoài cặp Σ=1). Cold-start 0/30 phiếu voice → đường sống tự kích hoạt khi đủ 60.
- **C8:** Order.fee lúc claim FILLED = phí LŨY KẾ (Σ Trade.fee đã có + phí phần khớp lần này) — full-fill hôm nay 2 số bằng nhau (0 hành vi đổi), partial tương lai giữ bất biến sổ. Verify: 3 lệnh FILLED có Trade → 0 lệch.
- **C9:** fillOrder tx mở row-lock `SELECT … FOR UPDATE` trên BrokerAccount NGAY đầu tx — mọi fill cùng tài khoản hoá tuần tự ở DB (position + cash đều read-then-write); mọi tx fill lấy đúng 1 khoá này trước tiên → không đảo chiều chờ → không deadlock (các update đơn lẻ của k-sandbox auto-commit không tạo chu trình). Verify sống: connection 2 bị từ chối FOR UPDATE NOWAIT khi tx1 giữ khoá, khoá lại được sau rollback.
- **Vận hành (khuyến nghị §8 đã chạy):** purge 7 RiskQuantSnapshot nav=29.720.000₫ (17-18/10, dấu vân tay sandbox-nhiễm) + AuditLog RISK_QUANT_SNAPSHOT_PURGE — Beta dd hết học trên chuỗi giả (engine đã viết snapshot sạch mới) · retrain macro-mlp 8 tài sản hậu-B1 → **Brier60 giờ đo holdout (`brier60Holdout: true`)**: VNINDEX 0,638 edge thật · VN30 0,662 trung thực KHÔNG edge · US10Y 0,514 · US30Y 0,424 · retrain dl-mlp → **v77 valAcc 40,82% (trung thực, archived)** so 42,88% công bố cũ của v73 (đo trên chuẩn hoá rò rỉ) — serving-swap guard giữ v73 đúng chủ ý bảo thủ; sweep mini cũng xác nhận serving v73 trên holdout gần nhất ≈ 37,0%/Brier 0,618 — đây là bộ số trung thực để đọc thay cho 42,9%.
- Nghiệm thu: lint 0 lỗi · tsc src/ sạch (3 lỗi cũ scripts/skills không đụng) · mini-sweep E2E + macro retrain + dl-mlp retrain trên dev server sống · agent-browser desktop + mobile 390px: tab Tự động tìm kiếm hiển thị "Cổng walk-forward · 1.500 mẫu holdout…", 0 console error, không tràn ngang, footer flush · scripts/p139-verify-c8-c9.ts PASS · scripts/p139-purge-risk-snapshots.ts idempotent PASS.

**DEFER còn lại (sau Task 139):** B7 viết lại head dl-mtl (khi cần dl-mtl) · D5 (cold-load flash), D6 (engine CORS `*` — sandbox) · B14 đường sống chờ ≥60 phiếu voice (0/30 hiện tại). Ghi chú hiển thị: tile serving v73 trên tab Mạng thần kinh vẫn in valAcc metrics cũ 42,9% của chính bản đó (số của row, không phải số cổng) — sẽ tự trung thực hoá khi serving đổi qua cổng holdout; mọi số CỔNG từ nay đo walk-forward.

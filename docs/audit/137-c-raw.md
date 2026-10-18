# AUDIT 137-c — EXECUTION & RISK (Signal → VETO → Orders/TWAP → Portfolio → Reconciliation)

- **Ngày audit:** 2026-10-18 · **Agent:** audit 137-c (read-only, không sửa bất kỳ file dự án nào ngoài file này)
- **Phạm vi đã đọc TOÀN BỘ:** `src/lib/exec/` (11 file), `src/lib/risk/` (7 file), `src/lib/signal-execution.ts`, `src/app/api/orders/` (+cancel), `src/app/api/signals/` (route, decision, convert), `src/app/api/portfolio/` (route, reset-paper), `src/app/api/market/tick/route.ts`, `src/lib/paper-world.ts`, `src/lib/intraday.ts`, `src/lib/market-quotes.ts`, `src/lib/market-session.ts`, `src/lib/serialize.ts`, `prisma/schema.prisma` (Order/Position/Signal/Trade/BrokerAccount/RiskAlert/AppSetting/CashSnapshot).
- **Phương pháp chống false-positive:** mỗi nghi vấn được (1) đọc ≥30 dòng ngữ cảnh + grep call-site, (2) mô phỏng tay 1 ca cụ thể qua code, (3) **đối chiếu DB sống Supabase** (2 tài khoản: paper `margin` cash=0/0 vị thế — sandbox cash 69.263.965/3 vị thế/4 lệnh/3 trade; AppSetting k-sandbox enabled, consensus enforce=true; RiskQuantSnapshot, RiskAlert, AgentRun settlement, AuditLog). Không model VetoLog/Portfolio tồn tại trong schema (VETO sống trong AgentRun.output verdict + hạ hướng tín hiệu — xem "SẠCH" mục 3).
- **Số finding:** 11 (C1 CRITICAL · C2 HIGH · C3–C6 MEDIUM · C7–C11 LOW).

---

## C1 — CRITICAL — Risk engine + Scenario engine đo NHẦM THẾ GIỚI: positions của mọi tài khoản + cash của 1 tài khoản tuỳ ý → toàn bộ NAV/VaR/HHI/breach-learning/Bayes-evidence/ngưỡng VETO bị nhiễm dữ liệu sandbox

- **File:dòng:** `src/lib/risk/engine.ts:389-409` (đặc biệt 390-406 và 407-409); cùng lỗi `src/lib/risk/scenario.ts:708-728`.
- **Bằng chứng (engine.ts:389-409):**
```ts
const [positionRows, account, snapshotRows, limitsBefore, banditArms] = await Promise.all([
  db.position
    .findMany({
      where: { status: "OPEN" },          // ← KHÔNG lọc brokerAccountId — gộp paper + sandbox
      select: { quantity: true, avgPrice: true, instrumentId: true, instrument: {...} },
    })
    .catch(() => []),
  db.brokerAccount
    .findFirst({ where: { deletedAt: null }, select: { cashBalance: true, marginUsed: true } })
    .catch(() => null),                    // ← KHÔNG lọc accountType, KHÔNG orderBy — tuỳ ý DB
  ...
```
`scenario.ts:708-727` lặp y hệt pattern (`position.findMany({ where: { status: "OPEN" } })` + `findFirst({ where: { deletedAt: null } })`).
- **Vì sao sai — ca mô phỏng ĐÃ XẢY RA trong DB sống:** thế giới paper đang TRỐNG (cash=0, 0 vị thế mở), sandbox có 3 vị thế (TCB 100 cp, VIC 100 cp @224.200, VPB 200 cp). Chạy `runRiskQuantEngine()`:
  - `positionRows` = 3 vị thế **sandbox** (MV ≈ 29.720.000 ₫); `account` = `findFirst` → trả **paper** (cash=0, đã verify bằng query đúng thứ tự DB).
  - `nav = 0 + 29.720.000` → **RiskQuantSnapshot.nav = 29.720.000, proxyMode=false** — khớp 100% DB (5 snapshot gần nhất đều nav=29.720.000). Engine tin "danh mục thật" = danh mục sandbox gắn cash paper.
  - Hệ quả dây chuyền ĐÃ CHỨNG MINH bằng DB: `topPositionPct = 72,34%` (snapshot detail mới nhất) > `dynMaxPositionPct 28,43%` → `breaches.position=true` **mỗi chu kỳ** → CRB-7 Beta learning ghi `risk-quant-limits = {position:{α:10,β:128}, sector:{α:10,β:128}, dd:{α:21,β:117}}` (α đã tăng ~9-20 lần chỉ trong vài ngày) → hạn mức VETO A7 của **thế giới paper** bị siết một chiều theo dữ liệu sandbox (đã thấy dynPos tụt 28,75 → 28,43 trong 1,5 ngày).
  - RiskAlert CRITICAL sống trên số liệu sai: `QUANT_MC_DD` (P=100%), `QUANT_CVAR` (12,3% NAV), `QUANT_HHI` (HHI vị thế 0,563) — toàn bộ là đặc tính danh mục 3 mã của sandbox, hiển thị là rủi ro của trader.
  - Nhiễm lan vào VÒNG QUYẾT ĐỊNH: `riskQuant.evidence` (quant-tail:hs-cvar / quant-tail:hhi — direction DOWN) được tiêm vào `buildEvidenceBundle` (run route:886-889) → kéo posterior pUp xuống → ảnh hưởng `consensusGate` → tín hiệu/duyệt lệnh thế giới paper. Vi phạm P0 quarantine §5.1 mà chính portfolioSnapshot (agent-service-runs.ts:160-185), reconciliation (reconciliation.ts:104-107), kpi route (exec/kpi/route.ts:56-63), orders/portfolio route đều triển khai đúng — riêng engine.ts/scenario.ts (viết trước K1 #87) bỏ sót.
- **Gợi ý fix:** thêm tham số `world: "paper"` cho `runRiskQuantEngine`/`runScenarioAnalysis`: fetch account trước (`accountType: { not: "sandbox" }`, kèm `orderBy` cố định) rồi `position.findMany({ where: { brokerAccountId: account.id, status: "OPEN" } })`; reset `risk-quant-limits` về prior sau khi vá vì Beta đã nhiễm. (Muốn đo sandbox thì chạy engine lần 2 với world sandbox.)
- **Tự tin:** **95%** (bằng chứng code + DB sản xuất khớp tuyệt đối; khả năng "chủ ý" đã loại trừ vì chính module đợt C của cùng chu kỳ dùng portfolioSnapshot paper-only).

---

## C2 — HIGH — Reconciliation: Trade của THẾ GIỚI SANDBOX rơi vào window nhưng ledger chỉ đo tài khoản paper → MISMATCH GIẢ đã nổ 2 lần trong sản xuất

- **File:dòng:** `src/lib/exec/reconciliation.ts:194-207` (query Trade không lọc thế giới) đối lập `reconciliation.ts:99-122` (`loadCurrentLedger` paper-only).
- **Bằng chứng:**
```ts
const trades = await db.trade.findMany({
  where: { executedAt: { gte: from, lt: now } },   // ← MỌI tài khoản, kể cả sandbox
  ...
// nhưng:
db.brokerAccount.findFirst({
  where: { deletedAt: null, accountType: { not: "sandbox" } },  // ledger = paper only
```
Phép 4 cash-delta (dòng 313-333) & phép 5 position-delta (336-371) so `expectedDelta` tính từ **toàn bộ Trade** với `actualDelta` chỉ từ **cash/positions paper**.
- **Vì sao sai — ca ĐÃ XẢY RA (DB):** 02:15 UTC 14-10, fill engine khớp 2 lệnh sandbox (TCB 3.330.000+4.995 và VIC 22.420.000+33.630) → window [23:01 13-10 → 03:02 14-10) chứa 2 Trade này → `expectedDelta = −25.788.625 ₫`, `actualDelta = 0 − 0 = 0` → **verdict MISMATCH, trades=2** (AgentRun settlement 2026-10-14T03:02:30.692Z — đọc trực tiếp từ DB) + RiskAlert `EXEC_RECONCILE_MISMATCH` 2026-10-14T03:02:29.510Z. Lặp lại 2026-10-16T04:12:56 (trades=1, VPB). K1 sandbox đang bật + còn 1 lệnh PENDING sandbox (TCB BUY 100 @33.800) → **mọi fill sandbox tiếp theo lại tạo alert giả**, gây alarm fatigue che mất mismatch THẬT — đúng điều §6.3 sợ nhất ("MISMATCH không tự lành").
- **Gợi ý fix:** join Trade→Order và lọc `order.brokerAccount.accountType` theo thế giới ledger (hoặc tách 2 chu kỳ reconciliation song song paper/sandbox, mỗi bên checkpoint riêng `exec.reconcile` / `exec.reconcile.sandbox`).
- **Tự tin:** **93%** (2 bản ghi MISMATCH + 2 alert trong DB khớp đúng timestamp các fill sandbox; comment header module tự nói "không đối chiếu chéo 2 thế giới tiền" nhưng code Trade lại chéo).

---

## C3 — MEDIUM — CommittedCashView đếm lệnh PENDING của SANDBOX vào cam kết sức mua của PAPER

- **File:dòng:** `src/lib/exec/committed.ts:79-102`.
- **Bằng chứng:**
```ts
const pendingOrders = await db.order.findMany({
  where: {
    status: { in: ["PENDING", "PARTIALLY_FILLED"] },
    price: { not: null },
    brokerAccountId: { not: null },        // ← không lọc accountType
  },
  ...
const notional = remaining * o.price;
if (o.side === "BUY") { orderCommittedBuy += notional * (1 + FEE_RATE); }
```
Caller (agent-service-runs.ts:845-851 `runCashManagement`; exec/kpi/route.ts:80-86) truyền snapshot **paper-only** (cash/equity của tài khoản không-sandbox).
- **Vì sao sai — ca hiện tại (DB):** 1 lệnh PENDING sandbox TCB BUY 100 @33.800 → `orderCommittedBuy = 3.380.000 × 1.0015 = 3.385.070 ₫`; paper cash=0 → `committedBuyingPower = 0 − 3.385.070 = −3.385.070` → badge "sức mua sau cam kết dưới hạn mức nội bộ — cân nhắc trước khi duyệt tiếp tín hiệu MUA" bắn cho thế giới paper **đang trống trơn**. Lệnh sandbox đã thuộc thế giới tiền khác (quarantine §5.1) nhưng vẫn chiếm ngân sách rò rỉ qua bên này (double-count với chính sizing 5% NAV sandbox đã định).
- **Gợi ý fix:** query kèm `brokerAccount: { accountType: { not: "sandbox" } }` (hoặc nhận `brokerAccountId` từ caller như portfolioSnapshot đã làm).
- **Tự tin:** **90%**.

---

## C4 — MEDIUM — Sizing nav5pct/sandbox ép min-lot 100 khi ngân sách không đủ 1 lot → lệnh vượt mức sizing hàng chục % (đã có lệnh thật 22,6% NAV thay vì 5%)

- **File:dòng:** `src/lib/signal-execution.ts:490-491`; đối lập đường budget50m `431-436` (từ chối đúng).
- **Bằng chứng:**
```ts
const rawQty = Math.floor((equity * sizeFraction) / lastPrice);
quantity = Math.max(100, Math.floor(rawQty / 100) * 100);   // ← ép 100 cp khi rawQty < 100
```
- **Vì sao sai — ca ĐÃ XẢY RA (DB):** sandbox equity lúc đặt ≈ 96,7tr × 5% = 4,83tr; giá VIC 224.200 → `rawQty = floor(21) = 21` → `floor(21/100)*100 = 0` → `max(100, 0) = 100` → lệnh **22.420.000 ₫ = 22,6% NAV sandbox (≈4,5× mức sizing ý định)** — đúng lệnh VIC BUY 100 @224.200 trong DB (nó cũng là gốc của HHI 0,563 và breach 72% ở C1). Đường budget50m cùng tình huống trả 400 "Khối lượng tính toán nhỏ hơn 1 lot" — hai đường sizing xử lý trái ngược nhau. Hệ quả: sandbox bandit học trên position khống cỡ sai; nếu paper có vị thế mà không đủ tiền mặt 5%, cùng cơ chế tạo lệnh khớp xong đẩy cash âm (không guard mua — xem C6). Note: comment hàm có ghi "lot 100 min 100 (hành vi run route)" nên hành vi min-lot có phần chủ ý — nhưng KHÔNG ai xử lý hệ quả vượt hạn; thiếu both "từ chối khi không đủ 1 lot trong hạn mức" lẫn guard đủ tiền.
- **Gợi ý fix:** khi `rawQty < 100` thì từ chối tạo lệnh (400, cùng thông điệp budget50m) hoặc giảm `sizeFraction`天花板… đơn giản nhất: `if (rawQty < 100) return 400 "Ngân sách 5% NAV không đủ 1 lot cho mã này"`. Thêm guard notional ≤ cash khả dụng cho BUY nếu muốn giữ min-lot.
- **Tự tin:** **80%** (lệch "bug vs chủ ý min-lot" — nhưng ca thật 4,5× vượt sizing là bằng chứng hệ quả không chủ ý).

---

## C5 — MEDIUM — resetPaperWorld xoá Trade/Order/Position + zero cash nhưng KHÔNG reset checkpoint `exec.reconcile` → MISMATCH giả ngay chu kỳ settlement kế tiếp sau mỗi lần reset

- **File:dòng:** `src/lib/paper-world.ts:96-114`; quy trình bắt buộc mà nó vi phạm: `reconciliation.ts:19-23` (REV-12) + helper có sẵn `reconciliation.ts:90-92` (`resetReconcileCheckpoint`) không được gọi.
- **Bằng chứng (paper-world.ts:96-114):**
```ts
const delTrades = await db.trade.deleteMany({ where: { order: { brokerAccountId: { in: accountIds } } } });
const delOrders = await db.order.deleteMany({ where: { brokerAccountId: { in: accountIds } } });
const delPositions = await db.position.deleteMany({ where: { brokerAccountId: { in: accountIds } } });
...
await db.brokerAccount.updateMany({ ... data: { cashBalance: BigInt(0), equity: BigInt(0), marginUsed: BigInt(0) } });
// ← KHÔNG có resetReconcileCheckpoint() / xoá AppSetting exec.reconcile
```
- **Vì sao sai — mô phỏng:** checkpoint đang lưu `{cash: C, positions: {...}}` của thời điểm trước reset; reset đưa paper cash về 0 và xoá positions. Chu kỳ settlement sau: window chứa 0 trade nhưng `actualDelta = 0 − C` và position-delta = −(từng mã) → MISMATCH "0 giao dịch" (đúng hình dạng alert 2026-10-11T11:23 trong DB: MISMATCH cash-delta+position-delta, 0 trades — sau các đợt write ngoài fill-engine cùng ngày). Module tự khai báoREV-12: "quy trình: reset checkpoint sau khi seed" nhưng đường reset chính thức của hệ thống không tuân thủ quy trình của chính nó.
- **Gợi ý fix:** gọi `await resetReconcileCheckpoint().catch(...)` trong `resetPaperWorld()` ngay sau bước zero cash (fail-soft như audit log).
- **Tự tin:** **85%**.

---

## C6 — MEDIUM — Fill engine BUY không kiểm tra sức mua: cash âm được phép, `marginUsed` không bao giờ được cập nhật bởi fill → veto margin A8 gần như vô nghĩa

- **File:dòng:** `src/app/api/market/tick/route.ts:365-377` (trừ tiền không có guard); `src/lib/agent-service-runs.ts:727-736` (A8 marginRoom); grep toàn src: `marginUsed` chỉ được ghi `BigInt(0)` lúc tạo/reset tài khoản (k-sandbox.ts:300,446,589; paper-world.ts:113) — không increment ở fill nào.
- **Bằng chứng (fillOrder):**
```ts
const notional = BigInt(price * qty);
const cashDelta = snapshot.side === "BUY" ? -(notional + fee) : notional - fee - tax;
await tx.brokerAccount.update({
  where: { id: brokerAccountId },
  data: { cashBalance: account.cashBalance + cashDelta },   // ← không floor, không so cash
});
```
- **Vì sao sai — mô phỏng:** paper cash=0 nhưng có vị thế (equity>0 qua mv) → tín hiệu MUA 5% NAV vẫn tạo lệnh (chỉ guard equity≤0 tại signal-execution.ts:483-489) → fill → cash = −5% NAV… lặp qua nhiều tín hiệu ACTIVE → cash âm dồn lớn, không ai chặn ở điểm fill; A8 chỉ veto khi `equity − marginUsed < 0` (marginUsed=0 mãi mãi) tức chỉ khi equity tổng âm. Brake duy nhất là "khi equity đã âm thì không tạo lệnh mới" — muộn. Có thể xem là chủ ý margin của paper (tài khoản type "margin") nhưng marginUsed không phản ánh nợ → mọi chỉ số "biên margin/sức mua" đều không đo được đòn bẩy thật.
- **Gợi ý fix:** trong `fillOrder` BUY: nếu `account.cashBalance + cashDelta < −someLimit` (hoặc < 0 nếu muốn no-margin) → claim REJECT `INSUFFICIENT_CASH` 1 lần (pattern F-303); hoặc tăng `marginUsed` khi cash âm để A8/committed nhìn thấy nợ.
- **Tự tin:** **75%** (ranh giới chủ-ý-paper vs bug; hệ quả đo lường là thật).

---

## C7 — LOW — Prune CashSnapshot 90 ngày của A12 xoá LUÔN chuỗi snapshot sandbox `k1-daily` (thiết kế K1 giữ 365 ngày)

- **File:dòng:** `src/lib/exec/forecast.ts:47-51` vs `src/lib/k-sandbox.ts:56, 989-993`.
- **Bằng chứng:**
```ts
// forecast.ts (recordCashSnapshot — chạy mỗi chu kỳ A12)
await db.cashSnapshot.deleteMany({
  where: { createdAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } },  // ← mọi account
}).catch(() => undefined);
// k-sandbox.ts
const K1_SNAPSHOT_PRUNE_DAYS = 365;   // §5.4 "đường cong học dài hạn"
...deleteMany({ where: { brokerAccountId: account.id, createdAt: { lt: pruneBefore } } })
```
- **Vì sao sai:** snapshot 91-365 ngày tuổi của sandbox bị chu kỳ paper A12 xoá trước khi prune 365 ngày của K1 chạy tới → "đường cong học dài hạn §5.4" của sandbox bị cắt âm thầm còn 90 ngày (k1-daily 1 dòng/ngày). Không phải tiền, là telemetry học.
- **Gợi ý fix:** thêm `brokerAccountId: input.brokerAccountId` vào where của prune (hoặc `source: "cycle"`).
- **Tự tin:** **85%**.

---

## C8 — LOW — `Order.fee` lúc fill ghi trên TOÀN khối lượng lệnh; Trade.fee ghi trên phần khớp — lệch sổ order-fee-ledger nếu tồn tại lệnh PARTIALLY_FILLED

- **File:dòng:** `src/app/api/market/tick/route.ts:288-304` (claim ghi `fee: BigInt(round(FEE_RATE × price × snapshot.quantity))`) vs `:307` (`fee = BigInt(round(FEE_RATE × price × qty))` với `qty = quantity − filledQuantity`).
- **Vì sao sai — mô phỏng:** lệnh 1000 cp đã PARTIAL 400 (avgFillPrice P1) → fill nốt 600 ở P2: Trade.fee = fee(600×P2) nhưng Order.fee bị đè = fee(1000×P2) ≠ Σ Trade.fee (400 phần ở P1) → phép 6 order-fee-ledger MISMATCH + Order.fee phóng đại. Hiện tại engine chỉ full-fill một shot (qty==quantity, hai giá trị bằng nhau) và không có đường nào sinh PARTIALLY_FILLED — nên là **bug ngủ**: chỉ bộc lộ khi bổ sung partial fill (đường PARTIAL đã được filter ở mọi where — trạng thái chết nhưng kế toán phí thì chưa tương thích).
- **Gợi ý fix:** khi claim FILLED ghi `fee = accumulated` (đọc Σ Trade.fee hiện có + fee fill này) hoặc `fee trên qty` + giữ cột phí-lũy-kế riêng.
- **Tự tin:** **70%** (bug ngủ, chưa bộc lộ với dữ liệu hiện tại).

---

## C9 — LOW — Position update dạng read-then-write không row-lock: an toàn nhờ mutex đơn-process + fill tuần tự, mất an toàn ngay khi đa process

- **File:dòng:** `src/app/api/market/tick/route.ts:313-363` (`findUnique` position → `update`/`upsert` tính `newQty/newAvg` trong tx Read-Committed).
- **Vì sao sao:** 2 process (scale ngang / một `next dev` lạc cùng DB) cùng tick: claim Order A và Order B (2 lệnh KHÁC nhau — claim DB đều thắng) → cùng đọc position VCB qty=0 → mỗi tx ghi qty=100 → **mất 100 cp** trong khi cash trừ 2 lần. Hiện tại triển khai pm2 đơn instance + mutex in-process (tick route:99-100) nên không tái hiện; Order-claim có bảo vệ DB nhưng Position thì không.
- **Gợi ý fix:** `SELECT ... FOR UPDATE` (Prisma `$queryRaw` hoặc `updateMany` tính bằng SQL `quantity + qty` cộng conditional `avgPrice` bằng biểu thức SQL), hoặc giữ nguyên nhưng ghi ràng buộc triển khai 1-process duy nhất vào runbook.
- **Tự tin:** **70%** (tùy triển khai; code hiện tại đơn process nên "chưa sai hôm nay").

---

## C10 — LOW — KPI funnel/AOV/slippage + anomaly scan trộn 2 thế giới; `valuesPct: slice(-100)` lấy 100 giá trị LỚN NHẤT sau sort (comment nói "gần nhất")

- **File:dòng:** `src/lib/exec/kpi.ts:96-106` (orders mọi account), `:161-176` (`slipSamples.sort(...); valuesPct: slipSamples.slice(-100)`); `src/lib/exec/anomaly.ts:62-88` (trades mọi account).
- **Vì sao sai:** (a) KPI "Điều hành" là thế giới paper (route exec/kpi lọc account paper cho forecast) nhưng funnel/AOV/slippage gộp lệnh/trade sandbox → `ordersOutOfFunnel` +4, AOV/slippage lệch theo giao dịch sandbox; (b) sau `sort((a,b)=>a-b)`, `slice(-100)` là **đuôi LỚN nhất** chứ không phải "100 mẫu gần nhất" như comment/ý định — box-plot/strip UI vẽ trên mẫu lệch (chỉ nửa trên phân phối). Không tiền, chỉ độ trung thực hiển thị.
- **Gợi ý fix:** truyền `brokerAccountId`/world vào computeExecKpi + detectTradeAnomalies; giữ 100 mẫu gần nhất bằng cách slice TRƯỚC khi sort theo thời gian.
- **Tự tin:** **75%**.

---

## C11 — LOW — Tín hiệu `consensusGate = null` đi qua cửa enforce khi convert TAY, trong khi auto-decision từ chối fail-safe — hai đường xử lý trái dấu cùng đầu vào

- **File:dòng:** `src/lib/signal-execution.ts:261-274` (điều kiện chặn yêu cầu `consensusGate != null` mới xét) vs `signal-execution.ts:1010-1013` (nhánh `gate == null` → "TỪ CHỐI fail-safe").
- **Vì sao sai:** gate null (tín hiệu cũ trước B9 / thiếu snapshot): nhánh auto `autoDecideSignalByConsensus` REJECT, nhánh trader bấm Phê duyệt/Chuyển lệnh thì **được tạo lệnh** (điều kiện `signal.consensusGate != null && !== "CONSENSUS"` bỏ qua null). Cùng trạng thái, 2 phán quyết đối nhau — cổng đồng thuận có lỗ thủ语义 cho dữ liệu legacy. Hiện tại 0 tín hiệu ACTIVE và mọi tín hiệu mới đều có snapshot nên chưa bộc lộ.
- **Gợi ý fix:** thống nhất: null → chặn cả 2 đường với thông điệp "chưa có snapshot đồng thuận" (hoặc cho phép cả 2 nếu trader duyệt tay là ý nghĩa override có chủ đích — khi đó ghi audit GATE_OVERRIDE).
- **Tự tin:** **70%**.

---

# NỢ KỸ THUẬT (không phải lỗi hôm nay, cần theo dõi)

1. **Thiếu "world context" xuyên suốt:** mỗi module tự quyết lọc sandbox (portfolioSnapshot ✓, reconciliation ledger ✓ nhưng trades ✗, kpi ✗, committed ✗, risk engine ✗, scenario ✗, anomaly ✗). Nên đưa `world: "paper"|"sandbox"` thành tham số bắt buộc của mọi hàm đọc Order/Trade/Position để xóa cả họ lỗi C1/C2/C3/C10 bằng 1 cơ chế.
2. **PARTIALLY_FILLED là trạng thái chết** — engine full-fill 1 shot; mọi guard PARTIAL chỉ phục vụ seed/legacy. Ngày bổ sung partial fill phải đồng thời sửa C8 (phí lũy kế) + reconciliation cross-window (order FILLED ở window sau nhưng trade ở window trước).
3. **Bước giá đơn giản hoá bội 100 ₫ toàn hệ thống** (`round100`), bỏ qua thang tick HOSE thật (10đ <10k, 50đ 10k-50k, 100đ >50k) — chủ ý paper, ghi nhận để không ai "vá nửa vời" chỉ 1 trong 3 nơi (tick route, signal-execution, plan).
4. **`findFirst` brokerAccount không `orderBy`** ở engine.ts/scenario.ts — thứ tự trả về không đảm bảo; ngay cả khi đã lọc accountType cũng nên cố định `orderBy: { createdAt: "asc" }` như orders/portfolio route.
5. **`marginUsed` không có writer** — toàn bộ chuỗi "biên margin/sức mua" (A8, committed, portfolio UI) đang đo một hằng số 0 (liên quan C6).
6. **Take 50 pending/tick** — nếu someday >50 lệnh chờ (TWAP nhiều tín hiệu), lệnh mới hơn đợi tick sau; deadline plan 1 phiên nên tự huỷ, nhưng стоит metric "starved ticks" nếu tăng tải.
7. **Lệnh không-plan (seed/manual) không bao giờ EXPIRED** — chỉ hủy tay; đường POST /api/orders không tồn tại nên lệnh mồ côi chỉ có thể đến từ script — runbook nên ghi rõ.
8. **risk-quant-limits đã nhiễm** (α position/sector 10-21 do breach trên nav sandbox) — sau khi vá C1 cần reset prior, không thì learning siết tiếp trên quá khứ sai.

# ĐÃ KIỂM TRA VÀ SẠCH (mô phỏng tay + bằng chứng, không finding)

1. **State machine Order:** chỉ 4 chuyển trạng thái hợp lệ (PENDING/PARTIAL → FILLED/REJECTED/EXPIRED/CANCELLED), TẤT CẢ qua `updateMany` claim có điều kiện status — không có chuyển trái phép, không cancel-sau-khớp (route cancel:59-68 claim thua → 409), không PENDING→FILLED "bỏ PARTIAL" (engine full-fill ghi `filledQuantity: quantity`).
2. **Double-execution tín hiệu:** AUD-CODE #2 đúng như thiết kế — claim `updateMany({ status: ACTIVE, actedAt: null })` + tạo N lệnh con TRONG MỘT `$transaction` (signal-execution.ts:587-734); mô phỏng 2 APPROVE đồng thời: request thua nhận 409 claim-lost, 0 lệnh sinh. F-207 chống trùng theo đúng thế giới (paper check loại sandbox, sandbox check chỉ tài khoản sandbox — mô phỏng cả 2 chiều). K1 marker idempotent ghi trong tx. REJECT cũng claim có điều kiện (F-73A-05) — không đè APPROVE.
3. **VETO không có đường bypass:** A7/A8 verdict `startsWith("VETO")` → run route:1237-1253 hạ tín hiệu MUA/HOLD trước khi lưu (AUD-CODE #6); SELL được phép dưới exposure-veto (đúng ngữ nghĩa giảm phơi nhiễm); HOLD không convert được (400); consensus gate B9 enforce=true (đã verify AppSetting `consensus`) chặn ở CỖ 3 đường tạo lệnh (decision/convert/auto-decision đều đi qua `createPaperOrderFromSignal`); sandbox chỉ auto-convert gate CONSENSUS (k-sandbox.ts:672-675). Lỗi duy nhất tìm được là C11 (gate null, legacy).
4. **Tick double-run:** mutex in-process chuỗi Promise (tick route:99-100, 956-966) + claim DB-level trong fillOrder → an toàn trong triển khai hiện tại (điểm mở duy nhất là đa process — C9).
5. **TWAP:** mô phỏng `draftTwapSlices(1000, 3)` = lát 400+300+300 (Σ=lots=10, bội 100, phần dư dồn lát đầu, lát cuối hấp thụ dư); spacing `floor(1440/3)=480`, lát cuối kích hoạt tick 960 < deadline 1440 (còn 480 tick cửa khớp); guard deadline chạy TRƯỚC guard afterTick (lát chưa tới lượt không bị expire oan — chỉ giữ); plan JSON ghi trong cùng tx (F-73A-02 — không cửa sổ lệnh sống thiếu guard); **không timer nào** (afterTick đếm từ `createdAt` qua tick) → không timer leak. `decideTwap` notional > 1% ADTV-20 với ADTV=0 → SINGLE an toàn (F-73A-07).
6. **Timezone phiên VN:** `market-session.ts` UTC+7 offset cố định (VN không DST — đúng), T2-T6 + lịch lễ 2026/2027 (Tết 5 phiên 16-20/02/2026, Giỗ Tổ bù 27/04…), sáng 09:15-11:30 + chiều 13:00-14:45 (đúng HOSE, nghỉ trưa 11:30-13:00); `inSessionElapsedMs` (plan.ts:212-238) duyệt ngày VN đúng biên, `DEFAULT_DEADLINE_TICKS=1440` = 4h phiên/10s ✓; `vnDateIso` ranh giới ngày ICT ✓.
7. **Toán tiền/phí/thuế:** biểu phí 1 nguồn constants.ts kèm guard đơn vị lệch 100× (REV-2) — 3 nguồn cũ đã gom; fill engine BUY −(N+fee), SELL +(N−fee−0,1% thuế) KHỚP công thức recompute reconciliation `round(FEE_RATE×px×qty)` từng dòng (mô phỏng 1000 cp @25.000: fee 37.500, thuế bán 25.000 — 2 tầng bằng nhau); avgPrice bình quân gia quyền `Math.round` ✓; realized P&L BigInt ✓; giá lệnh clamp dải ±7% + bội 100 (F-202) cả 2 đường sizing; khớp tại GIÁ ĐẶT khi `last` vượt điều kiện (documented "khớp tại giá đặt" — bảo thủ cho cả 2 chiều); VND BigInt → `toPlain` Number an toàn (< 2^53); không có so sánh `===` float nào trong đường tiền (Int/tolerance-1).
8. **Sizing/Kelly/risk math:** ¼-Kelly chuẩn hoá p theo Σw ∈ (0,1) clamp [0,05..0,95], chặn `dynMaxPositionPct`, b≤0 skip, CHỈ vào rationale (tham mưu — đúng spec CRB-9); EWMA λ=0,94 + √252 chuẩn RiskMetrics; HS-VaR order-statistic + CVaR≥VaR enforced `Math.max(var5, cvar1×√5)`; MC bootstrap mulberry32 seed 777 deterministic; CUSUM k=0,5σ/h=4σ reset sau alarm; Cholesky có jitter PSD; concentration check dùng quote **mới nhất** (không giá cũ); `adtv20For` trả 0 khi <20 bar (không chia mù).
9. **F-303 SELL thiếu cp:** pre-check trong tx → REJECT MỘT LẦN + audit — không retry vĩnh viễn từng tick; `autoDecideSignalByConsensus` claim có điều kiện + nhường quyền khi 409 concurrent (regex khớp cả 3 thông điệp 409 thực tế).
10. **Vòng đời tín hiệu:** sweep `expireDueSignals` ở 3 điểm (GET signals / run cycle / trước tạo lệnh) + double-check `expiresAt` sau sweep trong `createPaperOrderFromSignal` — không duyệt tín hiệu chết.
11. **Position reopen:** upsert khi position CLOSED → reset quantity/avgPrice/status OPEN + `openedAt` (cần cho K1 round-trip P&L `netRealisedFromTrades` lọc theo `openedAt` — đúng F-871-01), giữ `realizedPnl` lũy kế; SELL về 0 → CLOSED + closedAt ✓.
12. **Intraday bucket:** thuần cache, không timer; dedupe object-identity khi flush (F-841-04); bucket mới không bị xoá mù (F-841-05 đổi xoá theo identity) — không leak, không double-write.
13. **Paper reset world:** xoá đúng thứ tự khóa ngoại (Trade→Order→Position→CashSnapshot), chỉ tài khoản non-sandbox, không chạm Signal/BanditArm/AuditLog — đúng hiệu lệnh #91 (điểm thiếu duy nhất là checkpoint — C5).
14. **API routes:** orders/signals/portfolio lọc thế giới đúng (`accountType not sandbox` + orderBy cố định); range from/to validate ngày ICT (F-1091-01); decision route re-read sau claim thay vì ghi đè (F-73A-05); cancel route chỉ chặn PENDING/PARTIAL với claim.
15. **Serde:** `toPlain` xử lý BigInt/Date/Map/Set + circular guard; mọi nơi `JSON.stringify` BigInt đều `Number(...)` trước; số VND thực tế < 2^53 không mất precision.

---
*Kết luận: vòng Signal→VETO→Order của thế giới paper được bảo vệ tốt ở tầng giao dịch (claim atomic, guard vòng đời, phí đơn nguồn), nhưng tầng ĐO LƯỜNG (risk engine, reconciliation, committed, KPI) chưa nhận thức "2 thế giới tiền" của K1 #87 — C1 (CRITICAL) đang khiến toàn bộ hạn mức động/Bayes evidence/VETO-threshold của paper chạy trên danh mục sandbox, và C2 đã tạo 2 alert MISMATCH giả trong sản xuất. Khuyến nghị vá C1+C2+C3 bằng một cơ chế world-context chung, reset risk-quant-limits sau vá, và thêm unit-test "paper trống + sandbox có vị thế → engine phải proxy-mode".*

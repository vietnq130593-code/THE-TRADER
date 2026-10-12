# COUNCIL_STEWARDSHIP_BLUEPRINT — Hội đồng thấy tài khoản · đánh giá quyết định · vũ trụ đa thị trường · thí nghiệm phân bổ

> Phiên #106 · phê duyệt trader: *"Hội đồng không thấy tài khoản thì làm sao đánh giá toàn cục các quyết định mua bán lợi ích hay tổn thất… cơ chế đánh giá tổn thất và lợi ích trong các quyết định (nếu có rồi thì thôi, còn thiếu sót thì bổ sung). Thị trường bao quát có trái phiếu / forex / hàng hoá / thị trường quốc tế… đầu tư bao nhiêu, đầu tư thế nào, bao nhiêu phần bỏ vào rổ này rổ kia đấy là việc hội đồng phải tự nghiên cứu, học tập, thử nghiệm và thu nhận kết quả."*
>
> Nguyên tắc xuyên suốt: **hội đồng TỰ nghiên cứu** — hệ thống chỉ cung cấp (1) tầm nhìn, (2) sổ evaluates, (3) vũ trụ dữ liệu, (4) sân thí nghiệm. Hệ thống KHÔNG qui định tỷ trọng — mọi tỷ trọng do Hội đồng (Chủ tịch / portfolio-strategist) đề xuất từ dữ liệu và hậu quả chính nó gánh.

---

## §0. Hiện trạng khi bắt đầu (bằng chứng, kiểm tra 12/10/2026)

| Hạng mục | Hiện trạng | Nguồn доказ |
|---|---|---|
| Hội đồng thấy tài khoản? | **KHÔNG** — prompt agents chỉ thấy danh mục GIẤY (NAV 0₫); tài khoản sandbox K1 bị lọc `accountType: { not: "sandbox" }` | agent-context.ts:58, :550; k-sandbox.ts:151 |
| Đánh giá L/L quyết định? | RẢI RÁC, không có sổ trung tâm: k1 settle-equity (P&L ngày → bandit kênh-2 nhị phân per-agent), chairman-scorecard (nhãn WIN/LOSS 5 phiên — tính runtime, KHÔNG lưu), research-scorecard (per-agent hitRate/Brier) | k-sandbox.ts:779; exec/chairman-scorecard.ts:235 |
| Khối prompt "kết quả quyết định quá khứ" | **KHÔNG TỒN TẠI** — không vòng phản hồi nào nuôi prompt bằng kết quả đã đánh giá | rà `buildXrelPromptBlock`/`buildBayesPromptBlock` — không có block outcome |
| Vũ trụ đầu tư | 30 HOSE-STOCK + 5 HNX-ETF + 4 UPCOM; **0** instrument quốc tế (đã có adapter Yahoo nhưng universe chưa từng seed); KHÔNG trái phiếu/forex/hàng hoá | DB survey #106; expand-universe.ts:84-97 |
| Nguồn dữ liệu đa thị trường | Yahoo query1 → **429 chặn toàn bộ từ sandbox** (đo 12/10: 5/5 Too Many Requests). **Phát hiện mới**: `query2.finance.yahoo.com` + UA Windows → **9/9 OK** (throttle 2,5s) | đo trực tiếp §3 |
| Thí nghiệm phân bổ | KHÔNG có — AllocationDonut chỉ hiển thị; exec/allocation.ts là parse output Chủ tịch (tham mưu, không thực thi) | 106-A research |

**Phán định "cơ chế đánh giá tổn thất/lợi ích": CÓ MỘT PHẦN — thiếu sổ quyết định persisted + thiếu tầm nhìn tài khoản + thiếu vòng phản hồi vào prompt → bổ sung (đúng chỉ đạo "còn thiếu sót thì bổ sung", không dựng trùng lặp).**

---

## §1. Bốn tầng kiến trúc (C-VISION · D-LEDGER · X-MARKETS · E-ALLOC)

```
┌─ X-MARKETS ────────────── vũ trụ & dữ liệu ─────────────────────────┐
│ Treasury CSV ──► US5Y/US10Y/US30Y        (trái phiếu, % lợi suất)   │
│ Frankfurter  ──► EURUSD/USDJPY/AUDUSD    (forex majors, ECB)        │
│ er-api       ──► USDVND                   (snapshot hằng ngày)       │
│ Yahoo query2 ──► GC=F/SI=F/BZ=F/CL=F/HG=F/NG=F + VND=X + DX-Y.NYB   │
│                 + 8 cp Mỹ + 3 cp HK + 3 chỉ số (S&P500/Nasdaq/HSI)  │
│ Tất cả nạp vào Instrument/Bar/Quote hiện hành (0 model mới cho giá) │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼  baskets.ts (5 rổ: VN-EQUITY · INTL-EQUITY · BOND · FOREX · COMMODITY)
┌─ D-LEDGER ── sổ đánh giá quyết định ────────────────────────────────┐
│ evaluateDecisions(): mỗi Signal → 1 hàng DecisionEvaluation         │
│  · dự báo: pnlPct theo hướng từ ngày quyết định → close mới nhất    │
│  · thực thi: dòng tiền VND theo lệnh (mua −, bán +, phí/thuế)       │
│  · phán quyết WIN/LOSS/NEUTRAL ±0,5% (khớp ngưỡng bandit #87)       │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼  vision.ts (buildCouncilVisionBlock ≤900 ký tự)
┌─ C-VISION ── Hội đồng NHÌN THẤY ────────────────────────────────────┐
│ Tài khoản sandbox: equity · cash · P&L từ lúc kích hoạt · vị thế    │
│ + 7 quyết định gần nhất kèm phán quyết + thí nghiệm đang chạy       │
│ Tiêm 3 đường (parity XREL #103): wave E Chủ tịch · single-run · chat│
└──────────────┬──────────────────────────────────────────────────────┘
               ▼  experiments.ts + allocation-session.ts
┌─ E-ALLOC ─── sân thí nghiệm phân bổ ────────────────────────────────┐
│ Hội đồng (LLM Chủ tịch, CN 05:50) đọc: thống kê 5 rổ · quan hệ      │
│ XREL · thí nghiệm đã chạy + kết quả → đề xuất {weights, horizon}    │
│ Engine đánh giá mark-to-market NGÀY qua chỉ số rổ; kết thúc →       │
│ return/vol/sharpe/maxDD/đóng góp từng rổ → BÀI HỌC quay lại prompt  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## §2. X-MARKETS — vũ trụ & nguồn dữ liệu (kết quả đo thật 12/10/2026)

### §2.1 Bảng nguồn (đo trực tiếp từ sandbox trước khi viết 1 dòng code)

| Nguồn | Endpoint | Kết quả đo | Rổ | Độ tin cậy |
|---|---|---|---|---|
| **US Treasury** (chính thức) | `home.treasury.gov/.../daily-treasury-rates.csv/{năm}/all` | 200, CSV đầy đủ 1Mo→30Y cả năm | BOND | CAO (chính phủ Mỹ, không key) |
| **Frankfurter** (ECB) | `api.frankfurter.dev/v1/{from}..{to}?base=USD` | 200, chuỗi ngày EUR/JPY/AUD | FOREX | CAO (không key, lịch sử từ 1999) |
| **er-api** | `open.er-api.com/v6/latest/USD` | 200, VND=25.886 (chỉ GIÁ MỚI NHẤT) | FOREX (USD/VND) | CAO (tích luỹ tiến — không có lịch sử) |
| **Yahoo query2** | `query2.finance.yahoo.com/v8/finance/chart/{sym}` + UA Windows | **9/9 OK** throttle 2,5s (query1: 429/429 chặn) | COMMODITY + INTL + FOREX phụ | TRUNG BÌNH (quota IP — backoff tích luỹ dần) |

**Quyết định đơn vị (mở rộng UNIT_SPECS — single source of truth §3.2 MARKET_EXPANSION):**

| (market:type) | UnitSpec mới | Cách lưu | Ví dụ |
|---|---|---|---|
| `FOREX:FX` | `FX_RATE` ×10.000 round 1 | EURUSD 1,0852 → 10.852 | USD/VND 25.886 → 258.860.000 (Int OK) |
| `COMMODITY:CMDTY` | tái dùng `CENTS` ×100 | vàng 4.150,5 USD → 415.050 | dầu Brent 81,2 → 8.120 |
| `BOND:BOND` | tái dùng `BOND_PCT` ×100 | lợi suất 10Y 4,25% → 425 | 30Y 5,60% → 560 |
| `US/HK:*` | giữ nguyên CENTS/INDEX | — | — |

**Enum mở rộng (additive, db push an toàn):** `Market += BOND, FOREX, COMMODITY` · `InstrumentType += FX, CMDTY` (BOND đã có).

### §2.2 Universe seed (script idempotent `scripts/p106-seed-markets.ts`)

| Rổ | Mã | Nguồn |
|---|---|---|
| BOND (3) | US5Y · US10Y · US30Y | Treasury CSV (lấy cả 2025+2026 — ~2 năm lịch sử ngay lần đầu) |
| FOREX (5) | EURUSD=X · USDJPY=X · AUDUSD=X · VND=X · DX-Y.NYB | 3 mã Frankfurter (lịch sử 2023→nay) · VND=X er-api (tiến) + Yahoo (tích luỹ) · DXY Yahoo |
| COMMODITY (6) | GC=F vàng · SI=F bạc · BZ=F Brent · CL=F WTI · HG=F đồng · NG=F khí | Yahoo query2 |
| INTL (14) | AAPL MSFT NVDA GOOGL AMZN META TSLA JPM · ^GSPC ^IXIC · 0700.HK 0005.HK 3888.HK · ^HSI | Yahoo query2 (danh sách trùng khớp expand-universe.ts:84-97 — không phát minh) |

- Mọi mã kèm `name` tiếng Việt + `currency` đúng; dataSourceStatus 4 key riêng (`treasury-eod`, `frankfurter-fx`, `erapi-fx`, `intl-eod`) — honest mode real/fallback như nguồn hiện hành.
- **Trái phiếu VN: KHÔNG bịa** — không có nguồn miễn phí nào cho lợi suất TPCP VN từ sandbox; rổ BOND = Treasury Mỹ (chuẩn tham chiếu toàn cầu, thật sự ảnh hưởng VN qua kênh USD). Ghi rõ giới hạn này trong UI + §7.
- Giới hạn trung thực: Yahoo quota IP → rổ COMMODITY/INTL có thể mất vài ngày mới đầy 1 năm; engine chạy lại 06:15 hằng ngày, DataSourceStatus ghi rõ mã nào về được ngày nào.

### §2.3 Đồng bộ

- `src/lib/multi-market-sync.ts` — orchestrator 4 adapter, gọi từ `POST /api/market/intl-sync` (engine job 06:15 ICT hiện hành — không thêm lịch mới).
- Adapter Yahoo (`intl-eod.ts`): đổi mặc định `YAHOO_BASE` → query2, UA Windows, throttle 1.2s→2.5s, mở rộng `market in [US, HK, FOREX, COMMODITY]`, trần 40 mã giữ nguyên.
- Adapter Treasury: parse CSV (date MM/DD/YYYY, cột "5 Yr"/"10 Yr"/"30 Yr" % lãi) → Bar BOND_PCT, neo Quote; chạy 2 năm mỗi lần (idempotent upsert).
- Adapter Frankfurter: range 2023-01-01→nay → 3 mã FX (EURUSD=X: base USD → rates EUR; USDJPY=X: JPY; AUDUSD=X: AUD — cẩn thận chiều: frankfurter base=USD trả "1 USD = x EUR" → EURUSD=X hiển thị 0,89; **giữ đúng chiều Yahoo** — check 2 chiều khi code + test).
- Adapter er-api: 1 điểm/ngày USDVND (forward-accumulating) — upsert Bar hôm nay (15:00 UTC convention), honest `firstSeenAt` PIT.

### §2.4 Chỉ số rổ (`src/lib/council/baskets.ts`)

- `BASKETS`: `VN_EQUITY` (top-10 ADTV HOSE — tái dùng `topByAdtv` rổ DUY NHẤT của hệ thống) · `INTL_EQUITY` (equal-weight cp US/HK) · `BOND` · `FOREX` · `COMMODITY`.
- **Chuyển đổi về VND cho nhà đầu tư VN** (rõ ràng trong code + UI): INTL/COMMODITY ret_VND = (1+ret_USD)×(1+ret_USDVND)−1; nếu USD/VND thiếu ngày đó → ret_USD + ghi cờ `fxMissing`.
- BOND model hoá đơn giản (ghi rõ là mô hình): mỗi tenor ret = −D×Δy + y×(1/252), D lần lượt 4,5/8/17 — "thang trái phiếu" sleeve; equal-weight 3 tenor.
- FOREX rổ = biến động USD/VND (lợi ích giữ USD vs giữ VND — quyết định forex cốt lõi của hội đồng VN).
- `basketStats(window)` → {ret5d, ret30d, vol30d, bestDay, worstDay, members, coverageDays} + chuỗi daily returns — cache in-process 60s (pattern xrel).

---

## §3. D-LEDGER — sổ đánh giá quyết định (bổ sung vào cái đã có, không thay)

### §3.1 Model `DecisionEvaluation` (additive)

```prisma
model DecisionEvaluation {
  id String @id @default(cuid())
  signalId String @unique            // 1 Signal = 1 hàng, cập nhật hằng ngày
  instrumentId String?               // denormalise cho query nhanh
  direction String                   // BUY | SELL | HOLD
  decidedAt DateTime                 // createdAt của Signal
  agentId String?                    // agent gốc (thường Chủ tịch)
  // (a) KẾT QUẢ DỰ BÁO — mọi tín hiệu (kể cả chưa thực thi)
  entryPrice Int?                    // close ngày quyết định (đơn vị DB)
  markPrice Int?                     // close mới nhất (hoặc giá thoát nếu đóng)
  markPnlPct Float?                  // theo HƯỚNG (BUY +, SELL đảo dấu)
  peakPnlPct Float?  troughPnlPct Float?   // đỉnh/đáy từ lúc quyết định
  // (b) KẾT QUẢ THỰC THI — chỉ tín hiệu có lệnh (sandbox + giấy)
  executionKind String?              // EXECUTED_OPEN | EXECUTED_CLOSED | UNEXECUTED
  cashPnlVND BigInt?                 // dòng thuần: bán +, mua −, trừ phí/thuế
  openQty Int?                       // lượng còn mở (đánh giá unrealised)
  world String?                      // sandbox | paper
  verdict String                     // WIN | LOSS | NEUTRAL
  driversJson String?                // fills, consensusGate, note phân tích
  evaluatedAt DateTime
  @@index([evaluatedAt(sort: Desc)]) @@index([verdict])
}
```

### §3.2 Logic đánh giá (`src/lib/council/decision-eval.ts`)

- **Dự báo** (mọi Signal ≤ 90 ngày): entry = Bar close ngày quyết định (fallback Quote.last); mark = Bar close mới nhất; `markPnlPct` đổi dấu theo SELL; peak/trough quét chuỗi bar từ decidedAt.
- **Thực thi** (Order.signalId → Trade): dòng tiền từng trade `BUY: −(qty×price+fee)` · `SELL: +(qty×price−fee−tax)` (đối xứng `netRealisedFromTrades` k-sandbox.ts:747 — tái lập được); openQty = mua−bán → unrealised (mark − vwap mua)×qty. `executionKind` phân 3 nhánh trung thực.
- **Phán quyết**: có thực thi → theo cashPnl + unrealised; chưa → theo markPnlPct. Ngưỡng ±0,5% (khớp bandit #87 — một hệ ngưỡng toàn hệ thống).
- **Toàn cục** (api overview): tổng equity sandbox · realised từ lúc kích hoạt · unrealised hiện tại · phân bổ theo verdict · win-rate có trọng số.

- **Idempotent**: upsert theo `signalId`; chạy 16:45 ICT t2–t6 (engine job mới — sau k1 settle 16:30, dùng chung pattern `k1EquityDue`: gate `lastEodSyncDate === hôm nay`).
- **KHÔNG đụng** bandit kênh-2/kênh-1, chairman-scorecard, research-scorecard — 3 cơ chế kia giữ nguyên vai trò (điều chỉnh agent / nhãn Chủ tịch runtime / Brier cử tri). D-LEDGER là lớp "sổ cái quyết định" mà cả 3 có thể đọc sau.

---

## §4. C-VISION — Hội đồng nhìn thấy tài khoản (thay đổi quarantine có chủ đích)

- **Đây là điểm trader đã phê duyệt riêng** (root-cause #3 của #105-A2): sandbox vô hình với hội đồng → rủi ro tính trên 0/0, không quản được vị thế TCB.
- `src/lib/council/vision.ts` — `buildCouncilVisionBlock()`: ≤900 ký tự (~360 token — cùng ngân sách XREL #103):
  1. `TÀI KHOẢN HỘI ĐỒNG (sandbox K1)`: equity · cash · P&l từ lúc kích hoạt (₫ + %) · biến động ngày gần nhất
  2. `VỊ THẾ ĐANG NẮM`: mã × lượng × giá vốn × giá gần nhất × lãi/lỗ
  3. `KẾT QUẢ 7 QUYẾT ĐỊNH GẦN NHẤT`: hướng mã → WIN/LOSS ±pct (từ D-LEDGER)
  4. `THÍ NGHIỆM PHÂN BỔ`: đang chạy (tỷ trọng tóm tắt + lợi suất tới nay) + bài học thí nghiệm đóng gần nhất
- **Tiêm 3 đường** (parity XREL): wave E Chủ tịch (route.ts sau `portfolioWeightsBlock`) · `buildSingleRunPrompt` portfolio-strategist · `buildChatUserPrompt` strategist — fail-soft `.catch(() => null)`, cache in-process 60s.
- Chỉ ĐỌC — agents vẫn KHÔNG tự đặt lệnh sandbox ngoài cổng K1 hiện hành (auto-convert B9). Tầm nhìn ≠ quyền thực thi.

---

## §5. E-ALLOC — thí nghiệm phân bổ (việc của HỘI ĐỒNG, không phải của hệ thống)

### §5.1 Models (additive)

```prisma
model AllocationExperiment {
  id String @id @default(cuid())
  name String
  hypothesis String          // hội đồng tự viết
  weightsJson String         // [{basket, weight}] — tổng 100%
  capitalVND BigInt          // vốn giấy của thí nghiệm
  horizonDays Int            // 7..90
  startedAt DateTime @default(now())
  status String @default("RUNNING")   // RUNNING | DONE | STOPPED
  createdBy String @default("council") // council | trader | seed
  finalEquityVND BigInt?
  returnPct Float?  maxDrawdownPct Float?  sharpe Float?
  perBasketJson String?      // đóng góp lợi suất từng rổ
  lesson String?             // bài học (LLM sinh khi tổng kết phiên hội nghị sau)
  @@index([status, startedAt(sort: Desc)])
}
model ExperimentSnapshot {
  id String @id @default(cuid())
  experimentId String
  date DateTime                        // ngày ICT 15:00 UTC convention
  equityVND BigInt                     // mark-to-market
  returnPct Float                      // lũy kế từ vốn gốc
  basketsJson String                   // per-basket value + ret ngày
  @@unique([experimentId, date])
  @@index([experimentId, date])
}
```

### §5.2 Vòng đời thí nghiệm

1. **Sinh**: (a) Hội nghị phân bổ CN 05:50 (LLM Chủ tịch đọc basket-stats + XREL + thí nghiệm quá khứ → JSON proposal, parse fail-soft kiểu k4.ts) · (b) trader tạo tay qua dialog UI · (c) seed ban đầu để hệ thống có dữ liệu ngay.
2. **Đánh giá hằng ngày 16:35** (engine job mới, t2–t6, sau eod 15:45 + intl 06:15): equity = capital × Π(1+rổ ngày) theo trọng số động (rebalance daily về trọng số gốc — "constant-mix", ghi rõ trong model hoá); snapshot 1 dòng/ngày idempotent unique(experiment,date).
3. **Kết thúc**: đủ horizonDays hoặc trader dừng → tính return/vol/maxDD/Sharpe (√252)/đóng góp từng rổ; `DONE`.
4. **Học**: phiên hội nghị KẾ tiếp đọc kết quả DONE (đóng góp rổ + đường nước) → bài học tự viết → `lesson` + khối vision đưa vào prompt Chủ tịch → **vòng phản hồi khép kín: đề xuất → thí nghiệm → kết quả → bài học → đề xuất mới**.
5. **Trung thực**: rổ thiếu dữ liệu ngày nào (Yahoo chưa về) → dùng thành viên có dữ liệu + cờ coverage; thí nghiệm đầu tiên có thể chạy trong điều kiện dữ liệu chưa đầy — tất cả ghi trong basketsJson.

### §5.3 Hội nghị phân bổ (`src/lib/council/allocation-session.ts`)

- Prompt: system = ROLE_PROMPTS portfolio-strategist (tái dùng); user = bảng 5 rổ (ret5/30, vol30, members, coverage) + top quan hệ XREL + trạng thái thí nghiệm (đang chạy + 3 kết quả gần nhất kèm lesson) + khối vision tài khoản.
- Output JSON: `{reflection, lessons[], proposal:{name, hypothesis, weights[{basket,weight}], horizonDays}, narrative}` → validate (tổng trọng số 95–105%, 5 rổ hợp lệ, horizon 7–90) → tạo AllocationExperiment + broadcast AgentMessage (hiện trong "Luồng thảo luận giữa các agent").
- KHÔNG đặt lệnh thật/sandbox — thí nghiệm là danh mục giấy ĐỘC LẬP (capitalVND riêng) như chỉ đạo: *"đầu tư bao nhiêu… là việc hội đồng phải tự nghiên cứu, học tập, thử nghiệm"*.

---

## §6. Tích hợp hệ thống hiện hành

| Thành phần | Thay đổi |
|---|---|
| Schema | +2 enum value × 2 enum · +3 model (additive — 40 model tổng) |
| API | `GET /api/council/overview` · `POST /api/council/evaluate` · `GET/POST /api/council/experiments` · `POST /api/council/experiments/mark` · `POST /api/council/allocation-session` (maxDuration 60) · `GET /api/council/baskets` · `POST /api/market/intl-sync` mở rộng orchestrator |
| market-engine (:3003) | +3 job: 16:35 mark thí nghiệm (t2–t6) · 16:45 evaluate quyết định (t2–t6, gate eodSync) · CN 05:50 hội nghị phân bổ (LLM) — clone pattern `k1EquityDue` (state persist, inFlight guard, fail-soft) |
| Prompt agents | +`buildCouncilVisionBlock` 3 đường (§4) — KHÔNG đụng block hiện hữu |
| UI | Module mới "Hội đồng" (5 điểm chạm chuẩn 106-B) + card "Đa rổ thị trường" trong Thị trường + quotes-table nhóm BOND/FOREX/COMMODITY + FX_RATE format |
| K3 nhiệm vụ | KHÔNG thêm — 3 job trên là engine-side (như ml-sweep C1); hội nghị dùng ROLE_PROMPTS strategist |
| Hiển thị | Bộ chọn khoảng thời gian toàn cục #105 ăn sâu: overview/experiments lọc from/to theo ngày ICT |

---

## §7. Giới hạn & quyết định trung thực (trader cần biết)

1. **Trái phiếu VN**: không có nguồn miễn phí từ sandbox → rổ BOND = Treasury Mỹ. Chờ trader cấp nguồn (finfo/egress) thì mở rộng — InstrumentType đã sẵn.
2. **USD/VND lịch sử**: er-api chỉ có "hôm nay" → chuỗi VND=X tích luỹ TỪ NGÀY #106 trở đi (+Yahoo opportunistic khi quota mở). Chỉ số FOREX rổ trung thực "bắt đầu {ngày}".
3. **Yahoo quota IP**: rổ COMMODITY/INTL về đủ dần theo ngày (engine 06:15 retry + backoff 5s/15s/45s ×3 — có ngày trượt thì DataSourceStatus ghi rõ).
4. **BOND model hoá**: sleeve duration đơn giản (−D·Δy + carry) — KHÔNG phải giá trái phiếu thật từng bond; đủ cho nghiên cứu phân bổ, không đủ cho hedge book thật.
5. **Rebalance constant-mix hằng ngày** trong thí nghiệm — model hoá rõ ràng, kết quả khác với buy-and-hold.
6. **Executed** trên thị trường mới: giao dịch sandbox vẫn CHỈ HOSE (cổng B9/session/lot 100/trần sàn là luật VN). Đầu tư thử nghiệm trái phiếu/forex/hàng hoá/quốc tế đi qua THÍ NGHIỆM (danh mục giấy độc lập) — đúng tinh thần "tự nghiên cứu, thử nghiệm, thu nhận kết quả".

---

## §8. Kế hoạch nghiệm thu (chuẩn nhà)

1. Seed + sync thật: ≥3 rổ có bar lịch sử (BOND 2 năm · FOREX majors 2023→nay · COMMODITY/INTY theo quota Yahoo) · DataSourceStatus 4 key đúng mode.
2. D-LEDGER: 9 tín hiệu hiện có được đánh giá (3 đã có lệnh/thương vụ → executionKind đúng) · idempotent chạy 2 lần.
3. C-VISION: prompt Chủ tịch (force single-run) chứa khối TÀI KHOẢN HỘI ĐỒNG với equity 99.975.095₫ + vị thế TCB — bằng chứng tokensIn tăng ~360.
4. E-ALLOC: hội nghị phân bổ chạy LLM thật → 1 thí nghiệm RUNNING · mark 2 lần idempotent · đóng 1 thí nghiệm seed để có kết quả + lesson.
5. E2E browser desktop 1440 + mobile 390: module Hội đồng render · 0 console error · bộ chọn khoảng thời gian vẫn hoạt động · lint 0 · tsc 0.
6. Fixbug 4 lớp (Fixbug.md) trên toàn scope #106 + hồi quy #105 (5 API from/to).

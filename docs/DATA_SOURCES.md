# The Trader — Data Sources Inventory

> **Project:** The Trader — Hệ thống giao dịch đa agent (Multi-Agent Trading System) cho VNDIRECT
> **Document:** `docs/DATA_SOURCES.md` · **Version:** 0.5.0 · **Updated:** 2026-10-07
> **Cross-refs:** [DB_SCHEMA.md](./DB_SCHEMA.md) (data dictionary) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) (API surface & kiến trúc)

---

## 1. Purpose

Tài liệu này là **kho kiểm kê (inventory) mọi nguồn dữ liệu** mà The Trader tiêu thụ hiện tại hoặc dự kiến tích hợp: nguồn nội bộ (seed generator, LLM), nguồn ngoài dự kiến (API giao dịch VNDIRECT, market data, tin tức, dữ liệu thay thế). Với mỗi nguồn, tài liệu ghi rõ: endpoint/bảng dữ liệu, tần suất cập nhật, **mapping sang model Prisma** (field nào được đổ dữ liệu từ nguồn nào), và **chiến lược fallback** khi nguồn không khả dụng.

Nguyên tắc chung: **mọi dữ liệu thị trường phải qua validate §5 trước khi ghi DB**; khi nguồn ngoài chết, hệ thống **phục vụ bản cache cuối cùng và đánh dấu stale** — không bao giờ render giá "sống" từ nguồn không xác thực.

---

## 2. Inventory Summary

| # | Nguồn | Loại | Trạng thái | Hướng | Models Prisma affected |
|---|---|---|---|---|---|
| S1 | Seed generator nội bộ (`prisma/seed.ts`) | Nội bộ, deterministic | ✅ **Implemented** | → DB | Tất cả 19 models (demo) |
| S2 | LLM glm-4.6 (`z-ai-web-dev-sdk`) | AI service, backend-only | ✅ **Implemented** | → DB | `AgentMessage`, `AgentRun`, `Signal`, `Order` (paper), `AuditLog`, `Agent` (health) |
| S3 | VNDIRECT Trading API | Broker API | 🟡 **Scaffold** (flag + audit, gateway pending) | ↔ ngoài | `Order`, `Trade`, `BrokerAccount`, `Position`, `AuditLog` |
| S4 | Market data feed (VNDIRECT/VPS · HOSE/HNX) | Market data | ✅ **Implemented** (EOD thật dchart + intraday mô phỏng quanh ref thật — §4.2; nhánh realtime finfo theo mode runtime — §4.5) | → DB | `Quote`, `Bar`, `Instrument`, `DataSourceStatus` |
| S5 | Tin tức tài chính (RSS VN) | News | ✅ **Implemented** (RSS live) | → DB + LLM context | `NewsItem`, `AgentMessage` (sentiment), `Signal` (gián tiếp) |
| S6 | Alternative data (dòng khối ngoại, margin) | Quant data | ✅ **Implemented** (simulated deterministic) | → LLM context | `RiskAlert`, `DataSourceStatus` + prompt context |
| **S7** | **EOD thật VNDIRECT dchart — đa sàn** (`dchart-api.vndirect.com.vn`, `src/lib/eod-sync.ts`) | Market data EOD (public, đã adjust) | ✅ **Implemented (real)** — phiên #38 mở đa sàn: HOSE/HNX/UPCOM × STOCK/ETF/INDEX, **90 instrument active · 215.327 bar**, chuẩn hoá đơn vị theo **UnitSpec** (§3.3) | → DB | `Bar`, `Quote` (anchor), `Instrument`, `DataSourceStatus` (`eod-history`, mode `real`) |
| **S8** | **VNDIRECT finfo realtime + OAuth2 customer** (`finfo-api.vndirect.com.vn` + `auth.vndirect.com.vn` — `src/lib/vndirect.ts` · module Cài đặt) | Market data realtime | 🟡 **Implemented (chờ egress)** — §4.5 | → DB | `Quote` (tick trong phiên), `AppSetting` (creds + mode runtime), `DataSourceStatus` |
| **S9** | **EOD quốc tế Yahoo Finance v8 chart** (`query1.finance.yahoo.com` — `src/lib/intl-eod.ts`, phiên #38 — B12) | Market data EOD US/HK (đã adjust split/cổ tức) | ✅ **Implemented (real)** — sandbox #38 gặp **429 kéo dài** nên US/HK tạm 0 bar; job market-engine **06:15 ICT** tự đổ khi nguồn hồi (§3.4) | → DB | `Bar`, `Quote` (anchor theo UnitSpec cents/index), `DataSourceStatus` (`intl-eod`) |
| **S10** | **VNDIRECT finfo fundamentals** (`finfo.vndirect.com.vn/v4/financials` — `src/lib/fundamentals.ts`, phiên #38 — B11) | Dữ liệu tài chính cơ bản (P/E · EPS · BVPS · ROE) | 🟡 **Implemented (pending-egress)** — §4.6; sandbox bị chặn egress (DNS private 10.210.100.8) → `FinancialFundamental` 0 dòng, tự sáng khi deploy | → DB | `FinancialFundamental`, `DataSourceStatus` (`fundamentals`, mode `pending`) |

---

## 3. Nguồn hiện tại (Implemented)

### 3.1 S1 — Seed generator nội bộ (`prisma/seed.ts`)

**Mục đích:** sinh bộ dữ liệu demo deterministic để dashboard và 5 agent có dữ liệu hoạt động ngay mà không phụ thuộc nguồn ngoài. Chạy thủ công: `bun prisma/seed.ts` (sau `bun run db:push`). Script **xóa sạch dữ liệu cũ** trước khi ghi — chỉ dùng cho dev/demo.

**Thuật toán (đảm bảo reproducible):**

- **PRNG kiểu LCG** với seed cố định `42`: `state = (state × 1103515245 + 12345) mod 2^31` → cùng seed cho cùng dữ liệu, test ổn định. **Phạm vi deterministic (F-115, audit 2026-10-06):** giá trị bar/quote/orders/orders v.v. cố định theo **ngày chạy** — cửa sổ 90 ngày tính từ `new Date()` lúc chạy seed, nên chạy lại vào 2 ngày khác nhau cho khác mốc thời gian (cùng một ngày → dữ liệu giống hệt). Đây là chủ đích để dữ liệu demo luôn "tươi" so với hôm nay.
- **30 mã VN30** (HOSE, `STOCK`), mỗi mã có: tên công ty tiếng Việt, ngành (Ngân hàng, Bất động sản, Công nghệ, Vật liệu, Tiêu dùng, Bán lẻ, Năng lượng, Hàng không, Y tế, Chứng khoán…), **giá tham chiếu thực tế** (VCB 91,500 · FPT 138,700 · VNM 65,700…), độ biến động ngày (`vol` 1.1%–2.4%), khối lượng nền (`volBase` 0.3–9.2 triệu cp).
- **90 ngày giao dịch mỗi mã (2,700 bar):** bỏ thứ 7/CN; random-walk **có mean-reversion** về giá tham chiếu (drift 2%/ngày); `high`/`low` nở thêm ≤ 0.6 × vol; khối lượng 0.6–1.5 × `volBase`; **mọi giá làm tròn bội 100 VND** (`round100`) **và mọi OHLC nằm trong dải ±7% so close hôm trước** (Q2 — audit 2026-10-06 F-101); close phiên cuối **kéo về sát giá tham chiếu trong dải trần/sàn** để quote nhất quán.
- **Quote mới nhất mỗi mã:** `refPrice` = close hôm trước; `ceilingPrice` = round100(ref × 1.07); `floorPrice` = round100(ref × 0.93); `change`/`changePct` so close trước; bid/ask lệch ±0.1% kèm depth ngẫu nhiên (5–60 lô × 100 cp).

**Tần suất:** on-demand (re-seed khi cần). **Không phải nguồn production** — được thay bằng S4 khi tích hợp market data.

**Mapping model Prisma:**

| Model | Fields được sinh |
|---|---|
| `User` | demo `trader@thetrader.vn` (passwordHash placeholder) |
| `BrokerAccount` | VNDIRECT margin `VD0029961828`: `cashBalance` 486,500,000 · `equity` 1,284,300,000 · `marginUsed` 92,000,000 |
| `Instrument` | `symbol`, `name`, `market=HOSE`, `type=STOCK`, `sector`, `outstandingShares` |
| `Bar` | 90 × `date/open/high/low/close/volume/value` mỗi mã |
| `Quote` | toàn bộ field giá + `refPrice/ceilingPrice/floorPrice/tradedAt` |
| `Agent` × 5 | `code/name/role/description/config` (đúng config ở [TECHNICAL_BLUEPRINT.md §5](./TECHNICAL_BLUEPRINT.md)) + `healthScore` 88–100 |
| `AgentRun` | 6 run/agent: `taskStatus`, `durationMs`, `tokensIn/Out`, `costUsd`, `output`/`error` |
| `AgentTask` | 9 đầu việc tiếng Việt theo agent |
| `AgentMessage` | 5 tin broadcast có `content/reasoning/sentiment` |
| `Signal` | 8 tín hiệu BUY/SELL/HOLD với `score`, `targetPrice/stopLoss/takeProfit`, `expiresAt` +3 ngày |
| `Position` | 7 vị thế OPEN với `avgPrice`, `realizedPnl` |
| `Order` + `Trade` | 7 lệnh (FILLED/PARTIALLY_FILLED/SUBMITTED/CANCELLED) + bút toán: `fee` = 0.15% × notional, `tax` = 0.1% × notional (SELL) |
| `RiskAlert` | 3 cảnh báo (sector weight 42% > 40%, VHM loss −5.4%, rebalance deviation 6.8% > 5%) |
| `AuditLog` | 6 action chuẩn hóa |
| `Watchlist` + `WatchlistItem` | watchlist mặc định "VN30 tiêu điểm" 8 mã |

**Fallback:** không cần — nguồn nội bộ luôn khả dụng; dữ liệu demo được đánh dấu rõ trên sticky footer dashboard.

### 3.2 S2 — LLM phân tích đa agent (provider abstraction `src/lib/llm.ts`, backend-only)

**Endpoint tiêu thụ:** `POST /api/agents/run` (orchestrator — mô tả luồng đầy đủ ở [TECHNICAL_BLUEPRINT.md §5.2](./TECHNICAL_BLUEPRINT.md)) · **Giai đoạn 3 thêm 2 lối gọi theo-agent:** `POST /api/agents/[id]/run` (chạy riêng) và `POST /api/agents/[id]/chat` (chat 1-1) — cùng snapshot builder `src/lib/agent-context.ts`, **rate-limit 60s/agent** (DB-backed qua `AgentRun` cuối, 429 + `Retry-After`).

- **Lớp provider duy nhất `src/lib/llm.ts`** (chọn qua env `LLM_PROVIDER=auto`, mặc định):
  - **Opencode Zen** — `https://opencode.ai/zen/v1/chat/completions` (OpenAI-compatible REST, header `x-api-key: OPENCODE_ZEN_API_KEY` — từ 2026-10-09 gateway từ chối `Authorization: Bearer` với key `oc_sk_…` → 401 "Invalid credential"), model mặc định **`space-bunny-free`** (free-tier $0, zero-retention). **Chạy được cả ngoài sandbox** — đây là provider cho môi trường local của trader. Key lấy tại opencode.ai/zen (sign in → API key).
  - **z-ai-web-dev-sdk** v0.0.18 — model **`glm-4.6`** qua gateway nội bộ sandbox Z.ai (đọc `/etc/.z-ai-config`); chỉ dùng để phát triển/kiểm thử trong sandbox khi chưa có key Zen.
  - `auto`: có `OPENCODE_ZEN_API_KEY` → Opencode Zen, ngược lại → z-ai. Cùng một codebase chạy ở cả 2 môi trường. `GET /api/agents` trả khối `llm { provider, model, modelLabel, free, price… }` — UI hiển thị model runtime từ nguồn duy nhất này.
- **Input:** snapshot từ DB — quotes + 90-day bars của watchlist, positions + avgPrice, số dư tài khoản, risk alerts đang mở, **10 tin RSS mới nhất (S5) + dòng khối ngoại (S6)** — được pack vào role-prompt cho từng agent theo `Agent.config` (chi tiết phân bổ khối: [TECHNICAL_BLUEPRINT.md §5.2](./TECHNICAL_BLUEPRINT.md)).
- **Output parsed & persisted:**
  - `AgentMessage` (`content`, `reasoning`, `sentiment` bullish/bearish/neutral) — broadcast; **chat 1-1 lưu `broadcast=false` + `direction` USER/AGENT trong thread của agent (G3)**;
  - `Signal` từ bước tổng hợp của Portfolio Strategist (`direction`, `confidence`, `score`, `rationale`, `targetPrice/stopLoss/takeProfit`) — **G3: sinh ra `ACTIVE` chờ trader phê duyệt** (APPROVE → lệnh, REJECT → `rejectedAt`);
  - `Order` giấy chỉ tạo khi trader **APPROVE** (`/api/signals/[id]/decision`, sizing 5% NAV) hoặc **convert** (budget 50tr) — `src/lib/signal-execution.ts`;
  - `AgentRun` audit mỗi agent: `tokensIn/tokensOut`, `costUsd` (bảng giá theo provider — GLM-4.6 $0.6/$2.2 mỗi MTok, model `-free` của Zen $0; ghi đè bằng `LLM_PRICE_*_MTOK`), `durationMs`, `taskStatus`, `output` JSON (chat: `output` = câu hỏi gốc; audit `AGENT_CHAT`).
- **Tần suất:** on-demand khi trader bấm **Run agents**; đã có sẵn scheduler tự động trong mini-service market-engine (`AGENT_CYCLE_MINUTES`, **mặc định 0 = TẮT** để tiết kiệm chi phí LLM — xem [TECHNICAL_BLUEPRINT.md §6](./TECHNICAL_BLUEPRINT.md)).
- **Fallback:** nếu provider/LLM lỗi hoặc timeout (vd Opencode Zen 401 key sai — lỗi ghi rõ `HTTP <status>` vào `AgentRun.error`) → run đánh dấu `FAILED` với `error`, agent chuyển `ERROR`, UI vẫn hiển thị `AgentMessage` cũ (last cached) kèm nhãn stale; có thể sinh `RiskAlert` (severity INFO/WARNING) "agent pipeline unavailable".

### 3.3 S7 — EOD thật VNDIRECT dchart đa sàn (`src/lib/eod-sync.ts`) — ✅ Implemented (real)

**Mục đích:** thay toàn bộ bar synthetic (PRNG seed 42 của S1) bằng **giá EOD THẬT đã adjust** — từ phiên #33 cho 30 mã VN30 HOSE, **phiên #38 (MARKET_EXPANSION_BLUEPRINT) mở đa sàn lên 90 instrument active**: HOSE-STOCK 30 · HNX-STOCK 20 · UPCOM-STOCK 13 · HOSE-ETF 5 · INDEX 8 (VNINDEX · VN30 · VNMID · VNSML · VNALL · HNX · HNX30 · UPCOM). Từ nguồn này, mọi chỉ báo (SMA/RSI/valuation band/backtest), prompt 23 agent và danh mục demo đều chạy trên giá thật.

**Endpoint & giao thức** (`src/lib/eod-sync.ts`):

- `GET {DCHART_BASE_URL}/dchart/history?symbol=VCB&resolution=D&from=<unix-sec>&to=<unix-sec>` — trả JSON `{t[], o[], h[], l[], c[], v[], s:"ok"}` (Content-Type `text/plain` dù body là JSON — parse thủ công). `t` = nửa đêm UTC của ngày giao dịch (đã đối chiếu public.market_data).
- **Golden signature** (chuẩn Gen-1): keys `t,o,h,l,c,v,s` đầy đủ & cùng độ dài · `s === "ok"`; body rỗng = mã không có dữ liệu (hợp lệ, trả `empty`); `"Not support resolution"` = lỗi cấu hình → `DchartConfigError` (không retry mù); 5xx/429/timeout → retry 2 lần backoff 1s→4s (`DchartNetworkError`); 4xx khác = schema drift → `DchartSchemaError`.
- **Đơn vị — bảng tra UnitSpec (phiên #38 — B2, single source of truth):** dchart trả **STOCK/ETF VN theo nghìn VND** (VCB 57.3 = 57.300 ₫) → ×1000 + `round100` (Q1); **INDEX theo điểm thô** (VNINDEX 1.753,39) → ×100 nguyên, **KHÔNG áp trần/sàn ±7%**; US/HK theo cents ×100 (tái dùng cho S9); BOND %×100. Bảng `UNIT_SPECS` tra theo `(market, type)` — `resolveUnitSpec()` export public cho `intl-eod.ts` tái dùng.
- **Validate §5:** Q1 bội 100 (giá VN) · Q3 volume ≥ 0 (clamp INT4 2.147.483.647 cho index — VNINDEX ~2,6 tỷ cp) · Q4 upsert idempotent theo `@@unique([instrumentId, date])` · Q6 `t` UTC → `Bar.date` 15:00 UTC (cùng convention EOD rollover của tick route) · Q7 bỏ T7/CN + ngày tương lai; chặn dải giá theo loại (STOCK/ETF VN 500–5.000.000 ₫ · index/cents 100–10.000.000 đơn vị scaled); OHLC sanity `high = max(h,o,c)` / `low = min(l,o,c)`; trùng ngày giữ bản cuối — mọi bar vi phạm nặng bị bỏ + đếm `barsSkipped` (minh bạch; lần import thật: **0 bar bỏ**).
- **Tôn trọng nguồn công cộng:** throttle tối thiểu **300ms giữa 2 request**; tối đa **150 mã/chu kỳ sync** (`MAX_SYMBOLS_PER_SYNC` — nới từ 40 ở phiên #38, 150 mã ≈ 45s/lượt).

**Hàm chính:** `fetchDchartHistory` (retry/backoff) → `toRealBars` (validate + nhân theo **UnitSpec** của mã) → `syncEodFromDchart` (lookback mặc định **10 ngày** — đủ che T7/CN/lễ; upsert từng bar + **neo Quote** vào EOD cuối: `refPrice` = close phiên trước, OHLC/volume = bar cuối, change/changePct từ ref thật, trần/sàn ±7% mở theo ref thật — **null cho INDEX/quốc tế**, bid/ask ±0,1%) → `deepBackfillEod` (2013→nay: xoá bar synthetic từng instrument rồi `createMany` theo chunk 1.000).

**Tần suất:** market-engine scheduler chạy `POST /api/market/eod-sync` lúc **15:45 ICT hằng ngày** (`EOD_SYNC_AT`, chỉ 1 lần/ngày — check mỗi 60s) **+ 1 lần lúc boot** (môi trường mới tự có giá thật sớm, lookback 10 ngày); trigger thủ công qua API (body `{ days }` 2–365); deep backfill qua script `prisma/import-real-eod.ts` (`env -u DATABASE_URL bun prisma/import-real-eod.ts`). Sau khi sync, engine broadcast event WebSocket `"eod"` → client invalidate quotes/watchlist/bars/portfolio.

**Deep backfill + rebase danh mục (script `prisma/import-real-eod.ts`, idempotent):**

1. Deep backfill 2013→nay cho 30 mã (xoá bar synthetic) + neo Quote vào close thật;
2. **Rebase danh mục demo theo giá thật:** `Position.avgPrice` = close thật của ngày mở vị thế · `Trade.price/fee/tax` = giá thật + phí 0,15% / thuế TNCN 0,1% (SELL) · `Order.price` = close thật (fee = 0 khi chưa khớp) · `Signal ACTIVE` scale target/SL/TP quanh close thật theo đúng tỷ lệ seed (BUY: target +8% · SL −5% · TP +12%; SELL: −6%) · xoá RiskAlert demo (base trên giá synthetic) · `BrokerAccount.equity` = cash + Σ(qty × close thật).

**Kết quả đo thật:** phiên #33 (2026-10-06): 30/30 mã OK · **90.785 bar EOD thật 2013→2026-10-06** · 37,8s · 0 bar bỏ · VCB 91.600 ₫ (synthetic) → **57.300 ₫ (thật)** · PNJ biến động thật −6,91%/phiên, RSI14 13 · equity rebase **1.373.869.150 ₫**. **Phiên #38 (2026-10-07): mở đa sàn 30 → 90 instrument active (probe-trước-khi-tạo qua `prisma/expand-universe.ts`) · 215.327 bar EOD thật VN · backfill 98s** (HNX · UPCOM · ETF · INDEX); US/HK 0 bar tạm thời (S9).

**Mapping Prisma:**

| Model | Fields được đổ từ nguồn |
|---|---|
| `Bar` | `date` (15:00 UTC ngày giao dịch) · `open/high/low/close` (đơn vị theo **UnitSpec** của mã: VN VND bội 100 · INDEX điểm×100) · `volume` · `value` — upsert theo `@@unique([instrumentId, date])` |
| `Quote` | update-in-place neo EOD cuối: `refPrice/ceilingPrice/floorPrice` (±7% theo ref thật — **null cho INDEX/quốc tế**, theo UnitSpec) · `open/high/low/last/close/volume` · `change/changePct` · `bidPrice/askPrice/bidVolume/askVolume` · `tradedAt` (15:00 ICT = 08:00 UTC) |
| `DataSourceStatus` | key **`eod-history`** (label "Lịch sử giá EOD thật (VNDIRECT)") — mode **`real`** (mode mới của `SourceMode`), `lastSuccessAt`, `meta` (symbolsOk/Empty/Failed, barsUpserted/Skipped, lastTradeDate, lookbackDays) |

**Fallback:** dchart chết → DB chính là cache bền (bar/quote giữ nguyên, không ghi dữ liệu rác); `markSource` ghi `lastError`; scheduler thử lại ngày hôm sau (hoặc boot kế tiếp). Chế độ `MARKET_DATA_MODE=real-eod` (mặc định) đảm bảo tick KHÔNG ghi bar synthetic đè lên lịch sử thật (xem §4.2).

**Watcher re-probe ô ⚪/🟡 (phiên #38 — B14):** `POST /api/market/reprobe` chạy **Chủ nhật 04:00 ICT hằng tuần** (scheduler market-engine `REPROBE_AT` + broadcast event `reprobe`) — probe dchart **trước khi tạo** Instrument cho 18 ứng viên chuẩn (FUND VF1/VFMVF1/VFF/PRBF/BF1 · ETF HNX · UPCOM SME/KLF/V11/TUE…); mã có dữ liệu → tạo Instrument + backfill riêng mã đó (idempotent, mã đã tồn tại → `skippedExisting`) → ô ma trận độ phủ **tự sáng khi dữ liệu xuất hiện** (`GET /api/coverage` — 15 ô 3×5 + quốc tế + cơ bản, 3 màu real/empty/pending-source, hiển thị tab Đội Agent).

### 3.4 S9 — EOD quốc tế Yahoo Finance v8 chart (`src/lib/intl-eod.ts`) — ✅ Implemented (real) *(phiên #38 — B12)*

**Mục đích:** mở rộng độ phủ ra **sàn quốc tế US · HK** — 10 mã US (AAPL · MSFT · NVDA · GOOGL · AMZN · META · TSLA · JPM + index ^GSPC · ^IXIC) + 4 mã HK (0700.HK · 0005.HK · 3888.HK + index ^HSI). Probe 2026-10-07: Yahoo **query1 v8 chart HTTP 200 khi có User-Agent** (429 khi thiếu UA) — UA là yêu cầu bắt buộc.

**Endpoint & giao thức** (`src/lib/intl-eod.ts`):

- `GET {YAHOO_BASE_URL}/v8/finance/chart/{symbol}?range={range}&interval=1d&events=div,split` (env `YAHOO_BASE_URL` override được, default `query1.finance.yahoo.com`) — **User-Agent Chrome bắt buộc** mọi request.
- **Throttle 1.200ms** giữa 2 request (module-level như eod-sync); **retry 429/5xx/lỗi mạng tối đa 3 lần backoff 5s → 15s → 45s** (log từng lần); 4xx khác → `YahooConfigError` ngay (không retry mù).
- **Giá đóng: `adjclose[]` ưu tiên** (đã adjust split/cổ tức), fallback `close[]` khi adj thiếu/toàn-null/lệch độ dài — đã chọn adj thì dòng adj null bị **skip thay vì trộn 2 hệ giá** (sinh bước nhảy giả khi split) — `cleanYahooSeries()` đếm `nullSkipped` minh bạch.
- Body rỗng / `chart.error` / result rỗng / lọc xong 0 dòng → `{empty:true}` (hợp lệ); **circuit-breaker ≥3 mã lỗi liên tiếp** → ngừng sớm giữ ngân sách `maxDuration` 300s (mã bỏ qua ghi rõ trong `symbolsFailed`).

**Đồng bộ:** `POST /api/market/intl-sync` — body `{range}` whitelist `5d|1mo|3mo|6mo|1y|2y|auto`; **range auto: chưa có bar quốc tế → `1y` (backfill lần đầu) · đã có → `5d`** (đủ cho job hằng ngày); **cooldown 30s** → 429 + `Retry-After`; validator giá tái dùng 100% eod-sync theo UnitSpec (**US/HK cents ×100** — AAPL 333,63 → 33.363 · **index điểm ×100** — ^HSI 24.130,5 → 2.413.050 · **KHÔNG trần/sàn ±7%**) → upsert `Bar` idempotent → neo Quote; `take 40` mã/lượt.

**Tần suất:** market-engine scheduler **`INTL_SYNC_AT` = 06:15 ICT hằng ngày** (sau đóng cửa Mỹ) + broadcast event WebSocket `intl` → client invalidate quotes/bars/system-status. **Trạng thái sandbox phiên #38:** Yahoo rate-limit IP (429) kéo dài trong phiên nên US/HK tạm **0 bar** — DataSourceStatus `intl-eod` mode `fallback`; việc này được coi là bình thường — job 06:15 ICT ngày hôm sau tự phục hồi khi nguồn hồi (adapter đã verify AAPL/^HSI thật 21–22 bar/lượt khi nguồn sống).

**Mapping Prisma:** `Bar` (upsert `@@unique([instrumentId, date])`, đơn vị cents/điểm ×100) · `Quote` (anchor theo UnitSpec — trần/sàn null) · `DataSourceStatus` key **`intl-eod`** (label "EOD quốc tế (Yahoo Finance)", mode `real`/`fallback`, meta kèm `nullSkipped`/`adjcloseUsed[]`/`range`).

**Fallback:** Yahoo chết/429 → DB là cache bền; circuit-breaker ngừng sớm + ghi `symbolsFailed`; tick-engine **loại quốc tế (và INDEX) khỏi mô phỏng** — quote neo EOD thật, không sinh giá giả.

---

## 4. Nguồn ngoài (S3 scaffold · S4–S6 đã triển khai ở Giai đoạn 2 · S8 phiên #34 chờ egress · S10 phiên #38 pending-egress)

### 4.1 S3 — VNDIRECT Trading API (đặt lệnh & số dư) — 🟡 Scaffold

| Hạng mục | Chi tiết |
|---|---|
| **Capability** | Đặt lệnh (LO/market), hủy lệnh, tra trạng thái lệnh, số dư & hạn mức (cash, margin), lịch sử khớp |
| **Auth** | OAuth2/access token cấp cho khách hàng VNDIRECT (open API); credential broker lưu env server-side, **không** lưu plaintext trong DB — tham chiếu qua `BrokerAccount.accountNumber` |
| **Rate limit** | Theo chính sách open platform VNDIRECT — client phải dùng token-bucket + exponential backoff; không spam endpoint trạng thái (poll mở lệnh 2–5s/lệnh) |
| **Tần suất** | Event-driven theo thao tác trader/agent + polling trạng thái lệnh đang mở |
| **Điều kiện bật** | Feature flag `LIVE_TRADING` (mặc định **off**) — xem [TECHNICAL_BLUEPRINT.md §9](./TECHNICAL_BLUEPRINT.md); mọi lệnh thật vẫn qua veto của Risk Manager |
| **Mapping Prisma** | `Order.status` PENDING→SUBMITTED→PARTIALLY_FILLED/FILLED/REJECTED, `filledQuantity`, `avgFillPrice`, `fee`, `submittedAt/filledAt/cancelledAt`; `Trade` mỗi lần khớp (`price`, `quantity`, `fee`, `tax`); `BrokerAccount.cashBalance/equity/marginUsed/status` sync định kỳ; `AuditLog` mỗi thao tác (`ORDER_SUBMITTED_LIVE`…) |
| **Fallback** | Gateway không phản hồi → giữ trạng thái `SUBMITTED`, đánh dấu "unconfirmed" trên UI, thử lại theo backoff; **không** tự hủy lệnh đã gửi (side-effect ngoài không được rollback mù quáng); mọi chi tiết ghi `AuditLog` |

**Đã triển khai (scaffold, `src/lib/trading-mode.ts`):** `LIVE_TRADING=false` mặc định → mọi `Order` là paper order nội bộ. Bật `LIVE_TRADING=true` mà thiếu `VNDIRECT_API_BASE`/`VNDIRECT_API_TOKEN` → route convert trả **503** + audit `LIVE_TRADING_BLOCKED`; đủ cấu hình nhưng gateway chưa có → **501** + audit `LIVE_ORDER_GATEWAY_UNAVAILABLE`; `AuditLog` ORDER_CREATED giờ kèm `mode`. Trạng thái mode hiển thị qua `GET /api/system/status` (`trading: paper | live | live-unconfigured`). **Còn pending:** gateway mini-service thật để gửi lệnh ra VNDIRECT.

### 4.2 S4 — Market data (VNDIRECT/VPS · HOSE/HNX) — ✅ Implemented (EOD thật dchart + intraday mô phỏng quanh ref thật; nhánh realtime finfo theo mode runtime — §4.5)

| Hạng mục | Chi tiết |
|---|---|
| **Capability** | Quote level-1 realtime (bid/ask/last/volume), tick intraday, OHLCV EOD, giá tham chiếu/trần/sàn hàng ngày, danh mục mã niêm yết |
| **Endpoint dạng** | Feed realtime **đã có code hoàn chỉnh (S8 — phiên #34, chờ egress)**: mode runtime `realtime-vndirect` cấu hình qua module Cài đặt → tick route fetch **giá cuối thật finfo** (OAuth2 customer); mặc định hiện nay **EOD đi qua nguồn THẬT S7** (`POST /api/market/eod-sync` → dchart), còn tick intraday đi qua **`POST /api/market/tick`** (S4 tick engine nội bộ — có nhánh realtime khi mode bật) và mini-service market-engine gọi endpoint này mỗi 10s (`TICK_MS` — xem [TECHNICAL_BLUEPRINT.md §6](./TECHNICAL_BLUEPRINT.md)) |
| **Tần suất** | Tick: 10s (TICK_MS) **chỉ trong phiên** (`MARKET_STRICT_SESSION=true` mặc định — ngoài phiên tick bị skip, bảng giá neo ở close thật); **EOD: nguồn THẬT dchart sở hữu** — sync 15:45 ICT hằng ngày (S7); **EOD rollover khi sang ngày ICT mới:** `REAL_EOD_MODE` (mặc định, `MARKET_DATA_MODE=real-eod`) → tick **KHÔNG ghi bar synthetic** đè lên bar thật (đặt `MARKET_DATA_MODE=simulated` để quay lại hành vi cũ tự ghi bar); rollover vẫn kéo `refPrice` về close phiên trước, mở dải trần/sàn mới ±7%, reset `volume` về 0 với **ngân sách khối lượng ngày** 0,3–9,2 triệu cp/mã (FNV-1a theo `(mã, ngày)` — fix F-103); **phiên #34 — nhánh realtime (mode `realtime-vndirect`):** trong phiên + đã cấu hình → fetch finfo **throttle ≥30s kèm cache module-level** (tick 10s dùng cache), giá round100 + clamp ±7%, volume/high/low dồn phiên thật; ngoài phiên không fetch (neo close thật) |
| **Mapping Prisma** | `Quote.*` toàn bộ field (`open/high/low/last/close`, `volume`, `bid/askPrice/Volume`, `change/changePct`, `refPrice/ceilingPrice/floorPrice`, `tradedAt`) — cập nhật tại chỗ trên quote mới nhất mỗi mã; `Bar` chỉ ghi từ nguồn thật S7 (upsert theo `@@unique([instrumentId, date])`); `Instrument` (`isActive`, `listingDate`, `outstandingShares`); `DataSourceStatus` (mode/stale — xem dưới) |
| **Fallback** | **Đã implement stale marking**: `DataSourceStatus` (key `market-quotes`) ghi mode + `lastSuccessAt` mỗi tick; `GET /api/system/status` tính `stale`/`ageMinutes`; footer dashboard hiển thị dot màu (live/real=green · simulated=amber · fallback=red · stale=amber) + `lastError`; nguồn stale >4 tiếng → `escalateStaleSources()` tạo `RiskAlert` WARNING `DATA_SOURCE_STALE` (dedupe 24h, §6.4). Không ghi quote rác vào DB; **phiên #34 — realtime fail:** finfo lỗi → `markSource` mode `fallback` + `lastError` + tự chạy random-walk quanh ref EOD thật (không bỏ tick — paper matching vẫn chạy); mode realtime chưa cấu hình hoặc lần fetch cuối fail → `getEffectiveMode` tự tục về `real-eod` (UI badge "Đang fallback: EOD thật") |

**Cách triển khai thực tế (đã verify E2E — REAL_EOD_MODE mặc định từ phiên #33):** bảng giá được **neo vào EOD THẬT** bởi eod-sync (S7): ref/trần/sàn/volume/OHLC đều là dữ liệu thật của phiên cuối. Trong phiên, mỗi tick thực hiện **random-walk + mean-reversion 3%** quanh giá tham chiếu THẬT (drift ±0,4%/tick, clamp vào dải trần/sàn ±7%), tuân thủ toàn bộ data-quality rules §5: **Q1** giá làm tròn bội 100 VND · **Q2** luôn nằm trong dải `[floorPrice, ceilingPrice]` ±7% HOSE · **Q3** khối lượng chỉ tăng (có ngân sách ngày) · **Q5** `change = last − refPrice`, `changePct = change/refPrice × 100`. **Ngoài phiên** (`MARKET_STRICT_SESSION=true` — mặc định từ phiên #33): tick bị skip (`skipped: true`) và nguồn được đánh dấu **mode `real`** — bảng giá đang neo ở mức đóng cửa THẬT của phiên cuối (đúng sự thật hiển thị); trong phiên khi tick chạy sẽ trở lại `mode="simulated"`. `meta.mode` của `GET /api/market/quotes` đọc trực tiếp từ `DataSourceStatus` (F-117). Mọi POST tick chạy **tuần tự qua mutex in-process** (AUD-CODE #18 — chống lost-update khi 2 tick đồng thời). `GET /api/market/quotes` trả thêm `meta { mode, asOf }` cho stale marking phía client. **Phiên #34 — nhánh realtime (mode runtime `realtime-vndirect` qua AppSetting — §4.5):** trong phiên + đã cấu hình → tick dùng **giá cuối THẬT finfo VNDIRECT** (throttle ≥30s kèm cache, round100 + clamp dải trần/sàn ±7%, change/changePct từ ref EOD thật, volume accumulated dồn phiên — Q3 chỉ tăng); fetch ok → mode `real` + `meta.provider = "finfo-vndirect"`; fetch fail → mode `fallback` + tự fallback random-walk như mô tả ở hàng Fallback trên.

**Bộ khớp lệnh giấy (paper matching engine — fix F-206, cùng tick):** cuối mỗi tick, lệnh `PENDING`/`PARTIALLY_FILLED` giá LIMIT được khớp **toàn phần tại giá đặt** khi thị trường vượt điều kiện (BUY: `last ≤ giá đặt` · SELL: `last ≥ giá đặt`). Mỗi lệnh khớp chạy trong một Prisma transaction (claim có điều kiện chống chạy đua giữa các tick) và ghi: `Trade` (phí 0,15% notional, thuế TNCN 0,1% chỉ lệnh BÁN) + `Position` (bình quân giá vốn khi BUY / realized P&L khi SELL, tự đóng vị thế khi về 0) + `BrokerAccount.cashBalance` + `equity` (tiền mặt + GTTH vị thế mở) + `AuditLog ORDER_FILLED` (before/after — before ghi trạng thái thật của lệnh, F-302). Lệnh SELL vượt điều kiện nhưng **không đủ vị thế mở** → tự **REJECTED đúng một lần** + `AuditLog ORDER_REJECTED` kèm lý do `INSUFFICIENT_POSITION` (F-303 — không retry mỗi tick). Hủy lệnh qua **`POST /api/orders/[id]/cancel`** (chỉ PENDING/PARTIALLY_FILLED → 409 nếu đã kết thúc) ghi `AuditLog ORDER_CANCELLED`. Khi sang phiên mới (EOD rollover), `equity` của mọi tài khoản hoạt động được chốt lại = tiền mặt + GTTH (F-105); `/api/portfolio` luôn tính live.

**Ghi chú — học máy trên dữ liệu thật (phiên #35):** 3 mô hình của Phòng Học máy ([TECHNICAL_BLUEPRINT.md §5.4](./TECHNICAL_BLUEPRINT.md)) huấn luyện **trên Bar EOD thật của nguồn này** (S7/S4 — đã qua validate §5): MLP + Q-learning dùng `buildTrainingSet` — **58.726 mẫu top-20 thanh khoản** (đặc trưng RSI14/MACD/logret/SMA/z-score… từ `Bar` thật, label hướng close(t+5) ±0,5%); Q-learning chạy rổ top-10 `loadTopSeries(10)`; **bandit reward đối chiếu lại `Bar` EOD thật sau 5 phiên giao dịch** (phiếu LLM đúng hướng → reward 1, FLAT khớp 0,7) — không dùng dữ liệu mô phỏng cho huấn luyện, không bịa reward khi chưa đủ phiên.

### 4.3 S5 — Tin tức tài chính (News & Sentiment agent) — ✅ Implemented (RSS live)

**5 feed RSS đã kiểm chứng hoạt động** (crawler `src/lib/news.ts`, gọi qua `POST /api/news` hoặc scheduler market-engine mỗi 15 phút `NEWS_MS`):

| Nguồn | Feed RSS | Category | Ghi chú |
|---|---|---|---|
| **VnEconomy** (`vneconomy.vn/thi-truong.rss`) | RSS 2.0 | `market` | Tin thị trường chứng khoán |
| **CafeF** (`cafef.vn/thi-truong-chung-khoan.rss`) | RSS 2.0 | `market` | Nguồn tin VN dày nhất về chứng khoán |
| **VNExpress** (`vnexpress.net/rss/kinh-doanh.rss`) | RSS 2.0 | `macro` | Tin kinh doanh/vĩ mô |
| **Tuổi Trẻ** (`tuoitre.vn/rss/kinh-doanh.rss`) | RSS 2.0 | `macro` | Tin nhanh, đa ngành |
| **VietnamNet** (`vietnamnet.vn/rss/kinh-doanh.rss`) | RSS 2.0 | `macro` | Tin kinh doanh/vĩ mô |

> DanTri trả HTML thay vì RSS nên bị loại khỏi danh sách. Reuters (quốc tế) giữ ở roadmap nếu cần bối cảnh Fed/DXY.

- **Parser:** `fast-xml-parser` v5 (hỗ trợ RSS 2.0, RDF/RSS 1.0 và Atom — Atom dùng parser riêng giữ attribute `href`, fix F-108); strip HTML khỏi title/summary; tối đa **10 tin/feed**; timeout 8s; `User-Agent: TheTraderBot/1.0` — đã nạp thật 50 tin ở lần chạy kiểm chứng đầu tiên.
- **Rate limit:** tôn trọng nguồn — **tối thiểu 60 giây giữa 2 lần nạp** (guard in-memory; `POST /api/news` dồn lịch trả 429 kèm header `Retry-After` chuẩn — F-210); scheduler chạy cách nhau 15 phút (`NEWS_MS`).
- **Dedupe:** theo **URL** — `NewsItem.url` là unique key, crawler dùng upsert (idempotent; nạp lại chỉ update `summary` nếu đổi).
- **Tần suất tiêu thụ:** News & Sentiment agent nhận **10 tin mới nhất** (`latestNewsForContext`) mỗi run cycle; UI hiển thị 12 tin mới nhất (`GET /api/news?limit=12`).

**Mapping Prisma (CÓ model News riêng — đã thêm ở Giai đoạn 2):**

| Model | Fields được đổ từ nguồn |
|---|---|
| `NewsItem` | `title`, `summary` (đã strip HTML), `url` (dedupe), `source` (tên nguồn), `sourceUrl` (URL feed gốc), `category` (`market`/`macro`), `publishedAt` (từ `pubDate`/`published`/`updated`/`dc:date`), `fetchedAt` |
| `DataSourceStatus` | key `news`: `mode` (`live` khi nạp được / `fallback` khi mọi feed chết), `lastSuccessAt`, `lastError`, `meta.providers` |
| `AgentMessage` | **kết quả phân tích** của news-sentiment agent: `content`, `reasoning`, `sentiment` (bullish/bearish/neutral) — sentiment KHÔNG lưu ở `NewsItem` |
| `Signal` | ảnh hưởng gián tiếp qua `score`/`direction` từ bước tổng hợp của Portfolio Strategist (prompt có `newsBlock`) |
| `AuditLog` | action `NEWS_INGESTED` mỗi lần crawler chạy (kèm số liệu added/updated/mode) |

- **Fallback:** mọi feed chết → `mode=fallback` (đang phục vụ cache — news card hiển thị badge chế độ + stale), agent khai báo rõ "no new data since <timestamp>" trong message và không bịa tin; mất một nguồn chỉ giảm độ phủ, không chết luồng.

### 4.4 S6 — Alternative data (dòng khối ngoại, margin) — ✅ Implemented (simulated deterministic)

| Nguồn | Dữ liệu | Mapping |
|---|---|---|
| Khối ngoại (foreign flows) | Mua/bán ròng theo mã & theo sàn (EOD, từ HOSE/HNX hoặc tổng hợp CafeF) | Prompt context (`flowsBlock`) cho Market Analyst/Strategist/Risk Manager; `RiskAlert` khi dòng ròng đảo chiều mạnh (`metricKey: "market.foreign_flow.net"`) |
| Margin data | Dư nợ margin theo mã/định mức các broker (EOD) | Prompt context cho Risk Manager; `RiskAlert.metricKey: "portfolio.margin_concentration"` (roadmap) |

**Đã triển khai — flows simulator deterministic** (`src/lib/flows.ts`, endpoint `GET /api/market/flows`):

- Nguồn EOD chuyên dụng (HOSE/HNX, tổng hợp CafeF) chưa mở trong môi trường này → dùng **mô phỏng deterministic**: FNV-1a hash theo `(symbol, ngày)` cho hệ số ngẫu nhiên ổn định, **scale theo thanh khoản thật** từ DB (≈ 0.5–6% giá trị giao dịch phiên, giới hạn **2–80 tỷ VND/mã**) — cùng ngày cho cùng kết quả, không "nhảy" theo request.
- `mode="simulated"` ghi rõ vào `DataSourceStatus` (key `foreign-flows`) và vào payload (`note` khai báo "Mô phỏng deterministic theo thanh khoản thật") — tuân thủ nguyên tắc **no fabrication**: agent được báo rõ đây là dữ liệu mô phỏng.
- **Mapping rủi ro:** tổng bán ròng toàn thị trường < **−300 tỷ VND** → `RiskAlert` WARNING `FOREIGN_FLOW_OUTFLOW` (`metricKey: "market.foreign_flow.net"`, `metricValue` theo tỷ VND, `threshold: -300`) — **dedupe 24h** (tối đa 1 alert/ngày).
- `flowsPromptBlock()` đóng gói tổng mua/bán ròng + top 5 mua ròng/bán ròng thành `flowsBlock` nhúng vào prompt của market-analyst, risk-manager, news-sentiment và portfolio-strategist (xem [TECHNICAL_BLUEPRINT.md §5.2](./TECHNICAL_BLUEPRINT.md)).

- **Tần suất:** mỗi lần gọi `GET /api/market/flows` / mỗi run cycle (nguồn thật sẽ là EOD sau 15:00 ICT hoặc theo tuần).
- **Fallback:** thiếu metric → bỏ khỏi prompt, ghi chú trong `AgentMessage.reasoning`; không phỏng đoán (no fabrication).

### 4.5 S8 — VNDIRECT finfo realtime + OAuth2 customer (module Cài đặt) — 🟡 Implemented (chờ egress) *(phiên #34)*

**Mục đích:** thay tick intraday mô phỏng bằng **giá cuối thật** trong phiên khi người dùng tự nhập cấu hình khách hàng VNDIRECT (workspace "Cài đặt" — không cần sửa `.env` tay).

**Endpoint & giao thức** (`src/lib/vndirect.ts`):

- **OAuth2 `client_credentials`:** `POST https://auth.vndirect.com.vn/auth/oauth/token` (form-urlencoded: `grant_type` + `consumer_key` + `consumer_secret` + scope `vndirect:customer`) → `{access_token}` (hoặc `{error}`).
- **finfo lastprice:** `POST {finfo-api}/v4/lastprice` envelope `{"data":{q, columns}}` (dạng web terminal vndirect.com.vn dùng) → fallback `GET /v4/lastprice?q=…` khi HTTP lỗi/0 dòng; parse linh hoạt envelope `{data:[…]}` hoặc mảng trần; Bearer token nếu có; `AbortSignal.timeout`; mọi lỗi → message tiếng Việt.
- **Đơn vị giá — `normalizePrice` heuristic** (chưa đối chiếu trực tiếp được vì sandbox không egress): raw < 1.000 → nghìn VND ×1000 (như dchart); ≥ 1.000 → VND nguyên — VN30 không có mã dưới ~10.000 ₫ nên an toàn; **cần rà lại khi có egress thật**.

**Cấu hình runtime (bảng `AppSetting` — ghi đè env `MARKET_DATA_MODE`; chi tiết [TECHNICAL_BLUEPRINT.md §6.5](./TECHNICAL_BLUEPRINT.md)):** key `vndirect` (creds + `lastTestAt/Ok/Message`) + key `market-data` (`{mode, realtimeOk, lastRealtimeAt}`); 3 mode `real-eod` | `realtime-vndirect` | `simulated`; API `GET/PUT /api/settings` (secret **mask 4 ký tự đầu + "····"**; bỏ trống = giữ, `""` = xoá, giá trị chứa marker masked bị bỏ qua chống echo) + `POST /api/settings/test` (probe thật; test bằng creds đã lưu → ghi `lastTest` vào AppSetting — creds mới trong body không lưu/không đè).

**Luồng fallback an toàn realtime → real-eod:** `getEffectiveMode` — mode `realtime-vndirect` nhưng **chưa cấu hình** creds hoặc **lần fetch cuối fail** → tự tục về `real-eod` (UI badge "Đang fallback: EOD thật"); trong phiên fetch fail → `markSource` mode `fallback` + `lastError` + tiếp tục random-walk quanh ref EOD thật (tick không bỏ — paper matching vẫn chạy); fetch ok → mode `real` + meta provider `finfo-vndirect` + `realtimeSymbols`/`cacheAgeSec`.

**Probe sandbox (đo thật 2026-10-06):** `finfo-api.vndirect.com.vn` DNS resolve (kể cả DoH dns.google + cloudflare) về **10.210.100.8 — địa chỉ RFC1918 private** → HTTP 000 timeout mọi hình thức (POST/GET envelope); `auth.vndirect.com.vn` → NXDOMAIN (DoH Status 3); `api-vnds` → NO-DNS; chỉ `dchart-api` (160.250.74.45) sống (HTTP 200, 0,3s). **Kết luận:** sandbox chặn egress tới VNDIRECT — realtime finfo cần **máy chủ có egress thật/whitelist** khi deploy; cho tới đó hệ thống tự an toàn fallback `real-eod`.

**Mapping Prisma:**

| Model | Fields được đổ từ nguồn |
|---|---|
| `Quote` | tick trong phiên (mode realtime): `last` (round100, clamp ±7%) · `change/changePct` từ ref EOD thật · `volume` (accumulated dồn phiên — Q3 chỉ tăng) · `high/low` dồn phiên · `tradedAt` |
| `AppSetting` | key `vndirect` (creds + `lastTestAt/Ok/Message`) · key `market-data` (`mode`, `realtimeOk`, `lastRealtimeAt`) |
| `DataSourceStatus` | key `market-quotes`: mode `real` (fetch ok) / `fallback` (fetch fail) + `meta.provider = "finfo-vndirect"`, `realtimeSymbols`, `cacheAgeSec`, `lastError` |

### 4.6 S10 — VNDIRECT finfo fundamentals (dữ liệu tài chính cơ bản) — 🟡 Implemented (pending-egress) *(phiên #38 — B11)*

**Mục đích:** bổ sung **P/E · EPS · BVPS · ROE** cho agent fair-value (trước #38 định giá thuần theo dải giá lịch sử — khai báo giới hạn trong prompt). Nguồn: **`finfo.vndirect.com.vn`** — endpoint `GET /v4/financials?symbol=…&period=quarter` (fallback `/v4/financial-statements` chỉ khi có HTTP response nhưng lỗi/0 dòng; lỗi mạng → `FinfoNetworkError` ngay, KHÔNG thử endpoint kế).

**Adapter `src/lib/fundamentals.ts`:**

- **Field mapping robust** theo alias lowercase (revenue\|totalRevenue\|doanhThu… · netProfit\|profit\|loiNhuan… · eps\|basicEps · bvps\|bookValuePerShare · roe · "P/E" · "P/B") + period 3 hình thức (quarter 1..4 → "Q1".."Q4" · 0/null → FY · chuỗi "Q1/2024"/"FY2023"/"2024") + year 2000..năm+1.
- **Heuristic đơn vị** (ghi trong code + `meta.unitHeuristic` DataSourceStatus để review): revenue/netProfit \|raw\| > 1e9 → coi **VND nguyên** (BigInt giữ nguyên), ≤ 1e9 → coi triệu VND × 1e6; eps/bvps/roe/roa/pe/pb lưu **nguyên giá trị finfo trả** — chờ đối chiếu T11.3 (P/E VCB ±5%) khi có egress thật.
- **Dedupe MERGE theo (period, year)** — dòng sau bổ sung/đè trường non-null (finfo tách income/balance/ratio nhiều dòng cùng kỳ); cap phòng thủ 60 dòng/mã; bỏ dòng mã-sai/dòng-rác.

**Tần suất:** **ingest 1 lần/tuần — Chủ nhật ICT** chạy trong `runDataCollector` (service data-collector của chu kỳ — chỉ chạy Chủ nhật hoặc khi chưa có row nguồn); rate-limit **500ms/request**, cap 150 mã VN/lượt; **bất kỳ lỗi mạng đầu tiên → cả kết quả về mode `pending`** + `lastError` "finfo chặn egress từ sandbox (DNS private 10.210.100.8) — pipeline pending, tự sáng khi deploy máy chủ có egress" — **KHÔNG throw** (chu kỳ 23 agents sống sót — T11.1).

**Tiêu thụ:** `latestFundamentals(instrumentId)` — bản mới nhất mode `real` (trong cùng năm ưu tiên FY → Q4 → Q3 → Q2 → Q1) → **valuation block của fair-value chỉ thêm cột P/E · EPS · BVPS · ROE KHI CÓ dữ liệu mode `real`** (sandbox hiển thị trung thực không có, không bịa).

**Mapping Prisma:**

| Model | Fields được đổ từ nguồn |
|---|---|
| `FinancialFundamental` | `period` (Q1–Q4\|FY) · `year` · `revenue`/`netProfit` (**VND nguyên** BigInt) · `eps`/`bvps` (VND Float) · `roe`/`roa`/`pe`/`pb` (**tỷ lệ thô** — 0,15 = 15%) · `source` "finfo" · `mode` `real`\|`pending` — upsert `@@unique([instrumentId, period, year])` (chi tiết [DB_SCHEMA.md §6.22](./DB_SCHEMA.md)) |
| `DataSourceStatus` | key **`fundamentals`** (label "Dữ liệu tài chính cơ bản (finfo)") — mode **`pending`** trong sandbox (0 dòng FinancialFundamental — no-fabrication), `meta` kèm provider/endpoint/instrumentsTried/rowsUpserted/unitHeuristic |

**Fallback:** lỗi mạng finfo → ingest fail-mềm về mode `pending` (giữ phần rows đã upsert), valuation block tự bỏ cột cơ bản — không crash, không bịa số.

---

## 5. Data Quality Rules (áp cho mọi nguồn ghi vào DB)

| # | Quy tắc | Chi tiết |
|---|---|---|
| Q1 | **Bội số 100 VND** | Mọi giá HOSE phải `price % 100 == 0` (tick size). Vi phạm → reject (nguồn ngoài) / round + flag (nguồn chính thức) |
| Q2 | **Dải giá ±7% (HOSE)** | `floorPrice ≤ price ≤ ceilingPrice`, với trần/sàn = round100(ref × 1.07 / × 0.93). HNX ±10%, UPCOM ±15% áp khi mở rộng thị trường. *Ngoại lệ:* không áp cho **EOD lịch sử thật đã adjust** (S7 — giá đóng cửa thật có thể vượt dải mô phỏng của ngày khác); dải chỉ ràng buộc tick intraday và trần/sàn hôm nay |
| Q3 | **Khối lượng không âm** | `volume ≥ 0`, `quantity > 0`, `value ≥ 0`; `value` nhất quán ≈ Σ(price × qty) |
| Q4 | **Dedup OHLCV** | `Bar` ràng buộc `@@unique([instrumentId, date])` — ingest lại dùng upsert (idempotent); `Quote` **update-in-place** tại quote mới nhất mỗi mã (1 row/mã, `tradedAt` ghi mỗi tick; lưu lịch sử tick là roadmap — audit 2026-10-06 F-204) |
| Q5 | **Đồng nhất change** | `change = last − refPrice`; `changePct = change / refPrice × 100` (làm tròn 2 chữ số) |
| Q6 | **Timezone** | Lưu UTC trong DB; hiển thị `Asia/Ho_Chi_Minh` (UTC+7); ngày giao dịch closes 15:00 ICT; `Bar.date` chuẩn hóa EOD |
| Q7 | **Lịch giao dịch** | Thứ 2–thứ 6 + **lịch nghỉ lễ VN 2026 ước lượng** (Tết Dương lịch, Tết Bính Ngọ, Giỗ Tổ, 30/4–1/5, Quốc khánh) đã cài trong `src/lib/market-session.ts`; lịch chính thức từng năm — roadmap; ngoài phiên → không sinh quote mới |
| Q8 | **Phiên HOSE** | ATO 09:00–09:15 · liên tục **09:15–11:30** · liên tục **13:00–14:45** · ATC 14:45–15:00 — logic "in-session" dùng cho scheduler & stale marking |
| Q9 | **Số nguyên VND** | Không nhận giá tiền dạng thập phân; quy đổi tại ingest nếu nguồn trả decimal (xem [DB_SCHEMA.md §3](./DB_SCHEMA.md)) |

---

## 6. Fallback Strategy (tổng quát)

1. **Serve last cached**: quote/bản tin cuối vẫn hiển thị — DB chính là cache bền (tin tức RSS lưu bền trong `NewsItem`).
2. **Mark stale**: **đã implement** — bảng `DataSourceStatus` (singleton-theo-key) ghi `mode` + `lastSuccessAt` mỗi lần nguồn thành công/thất bại; registry 5 nguồn trong `SOURCE_DEFS` của `src/lib/sources.ts`: `eod-history` ("Lịch sử giá EOD thật (VNDIRECT)") · `market-quotes` · `news` · `foreign-flows` · `trading` + **2 hàng phiên #38 do adapter riêng đảm bảo**: `intl-eod` ("EOD quốc tế (Yahoo Finance)") · `fundamentals` ("Dữ liệu tài chính cơ bản (finfo)") — tổng 7 nguồn; `SourceMode` gồm `live`/`real`/`simulated`/`fallback`/`paper` (cột DB String nên `fundamentals` ghi `pending` — pipeline chờ egress). `GET /api/system/status` tính `stale`/`ageMinutes` cho từng nguồn; footer dashboard hiển thị chip từng nguồn (dot màu: **live/real = green** (label "EOD thật" cho `real`) · simulated=amber · fallback=red · stale=amber, kèm `lastError`); `GET /api/news` meta cũng mang `stale`/`ageMinutes`/`providers`. **Phiên #38 — ma trận độ phủ:** `GET /api/coverage` tổng hợp trạng thái cả 15 ô tổ hợp (market×type) + quốc tế + cơ bản theo 3 mức trung thực `real`/`empty`/`pending-source` (tab Đội Agent — "không tô xanh giả").
3. **No fabrication**: agent không được bịa số liệu khi thiếu nguồn — khai báo rõ "no new data" trong `AgentMessage`; dữ liệu mô phỏng (S4 tick, S6 flows) luôn gắn `mode="simulated"` và được báo rõ trong prompt.
4. **Escalate**: **đã implement** — nguồn stale kéo dài **quá 4 tiếng** → `RiskAlert` WARNING (`code: DATA_SOURCE_STALE`, `metricKey: source.<key>.stale_minutes`, dedupe 24h) để trader quyết định tiếp tục paper-run hay dừng; chạy tự động mỗi lần `GET /api/system/status` được gọi (`escalateStaleSources()`).

---

## 7. Implementation Checklist

**✅ Done (verified trong codebase):**

- [x] Prisma schema **25 models** + 12 enums đã push vào **Supabase Postgres** (schema `trader` — backup trước push #38 ở `db/backup-pre-b1/`) — [DB_SCHEMA.md](./DB_SCHEMA.md)
- [x] Seed generator deterministic: 30 mã VN30, 90 ngày OHLCV, quote kèm trần/sàn ±7%, demo portfolio, 5 agent + runs/messages/tasks/signals/orders/trades/positions/risk alerts/watchlist (`prisma/seed.ts`)
- [x] Chuẩn integer VND + round100 + fee 0.15% / tax 0.1% TNCN trong dữ liệu mẫu
- [x] LLM phân tích đa agent qua `z-ai-web-dev-sdk` (glm-4.6, backend-only) trong `POST /api/agents/run`, có audit `AgentRun` (tokens/cost/duration)
- [x] Ràng buộc dedup `Bar @@unique([instrumentId, date])` + composite indexes cho truy vấn feed
- [x] **Market data ingestion job (S4):** tick engine `POST /api/market/tick` (random-walk + mean-reversion quanh ref THẬT, Q1–Q5, mutex in-process AUD-CODE #18) được market-engine gọi mỗi 10s (`TICK_MS`); `MARKET_STRICT_SESSION` chỉ cho tick trong phiên (**mặc định true từ phiên #33**)
- [x] **EOD thật VNDIRECT dchart (S7 — real, phiên #33):** `src/lib/eod-sync.ts` (fetch golden-signature + validate §5 + throttle 300ms) · `POST /api/market/eod-sync` · scheduler market-engine **15:45 ICT hằng ngày + lúc boot** + broadcast event `eod` · deep backfill + rebase danh mục `prisma/import-real-eod.ts` — **90.785 bar thật 2013→nay, 30/30 mã, 0 bar bỏ**; REAL_EOD_MODE mặc định (`MARKET_DATA_MODE=real-eod`): tick không ghi bar synthetic
- [x] **Đánh dấu stale cho quote cache (S4):** `DataSourceStatus` + `GET /api/system/status` + chips trạng thái nguồn trên footer + `escalateStaleSources()` → RiskAlert `DATA_SOURCE_STALE`
- [x] **News crawler RSS + dedupe (S5):** 5 feed VN kiểm chứng (VnEconomy, CafeF, VNExpress, Tuổi Trẻ, VietnamNet), parser `fast-xml-parser`, dedupe theo `url` (model `NewsItem`), rate-limit 60s, audit `NEWS_INGESTED`
- [x] **Alternative data EOD (S6 — simulated):** flows simulator deterministic (`GET /api/market/flows`) + RiskAlert `FOREIGN_FLOW_OUTFLOW` (−300 tỷ, dedupe 24h) + `flowsBlock` trong prompt agent
- [x] **WebSocket mini-service realtime quotes:** `mini-services/market-engine` (port 3003) broadcast `quotes`/`news`/`eod`/`cycle` + scheduler; client nối qua gateway `io("/?XTransformPort=3003")` (hook `useRealtimeMarket`)
- [x] **Job scheduler chu kỳ agent run tự động trong phiên:** có sẵn trong market-engine (`AGENT_CYCLE_MINUTES`) — **mặc định 0 = TẮT** để tiết kiệm chi phí LLM
- [x] S3 scaffold: feature flag `LIVE_TRADING` + cổng kiểm tra + audit (`LIVE_TRADING_BLOCKED` / `LIVE_ORDER_GATEWAY_UNAVAILABLE`)
- [x] **Module Cài đặt + realtime finfo (S8 — phiên #34, chờ egress):** `src/lib/{settings,vndirect}.ts` + `GET/PUT /api/settings` (secret mask 4 đầu + "····") + `POST /api/settings/test` (probe thật OAuth2 + finfo, ghi lastTest) + mode runtime `AppSetting` ghi đè env (real-eod / realtime-vndirect / simulated) + tick route nhánh realtime trong phiên (throttle ≥30s, round100 + clamp ±7%, KLGD dồn phiên) + luồng fallback an toàn realtime → real-eod (`getEffectiveMode`); probe sandbox: finfo/auth KHÔNG reachable (DNS finfo → 10.210.100.8 private) — cần máy chủ egress thật khi deploy
- [x] Lịch giao dịch T2–T6 + nghỉ lễ VN 2026 ước lượng (`src/lib/market-session.ts`) + sessionPhase (ATO/liên tục/trưa/ATC)
- [x] **S7 đa sàn (phiên #38 — MARKET_EXPANSION_BLUEPRINT B2–B4):** universe **30 → 90 instrument active** (HOSE/HNX/UPCOM × STOCK/ETF/INDEX, probe-trước-khi-tạo `prisma/expand-universe.ts`) · **215.327 bar EOD thật VN** (backfill 98s) · bảng tra **UnitSpec** (market×type) chuẩn hoá đơn vị (INDEX điểm ×100 không trần/sàn) · `MAX_SYMBOLS_PER_SYNC` 40 → 150 · tick-engine **loại INDEX khỏi mô phỏng** (quote neo EOD thật)
- [x] **S9 — EOD quốc tế Yahoo Finance (phiên #38 — B12):** `src/lib/intl-eod.ts` (UA bắt buộc · throttle 1,2s · retry 429 ×3 backoff 5/15/45s · adjclose ưu tiên + null-skip · circuit-breaker ≥3 lỗi liên tiếp) + `POST /api/market/intl-sync` (range auto 1y lần đầu → 5d, cooldown 30s) + universe US 10 mã · HK 4 mã + **scheduler market-engine 06:15 ICT hằng ngày** + broadcast `intl` — sandbox #38 Yahoo 429 kéo dài → US/HK tạm 0 bar, job tự đổ khi nguồn hồi (adapter verify AAPL 33.363 cents · ^HSI 2.413.050 điểm×100)
- [x] **S10 — finfo fundamentals (phiên #38 — B11, pending-egress):** `src/lib/fundamentals.ts` (2 endpoint + alias field + heuristic đơn vị VND nguyên · dedupe MERGE theo kỳ) + ingest **Chủ nhật ICT trong runDataCollector** (500ms/request, cap 150 mã, fail-mềm KHÔNG throw) + valuation block fair-value thêm P/E·EPS·BVPS·ROE chỉ khi mode `real` — sandbox 0 dòng (no-fabrication)
- [x] **Watcher re-probe + ma trận độ phủ (phiên #38 — B14):** `POST /api/market/reprobe` (18 ứng viên, probe-trước-khi-tạo, idempotent, cooldown 60s) chạy **Chủ nhật 04:00 ICT** (scheduler `REPROBE_AT` + broadcast `reprobe`) + `GET /api/coverage` (15 ô 3×5 + quốc tế + cơ bản — 3 màu real/empty/pending-source) hiển thị **tab Đội Agent**

**🔜 Pending (theo roadmap [TECHNICAL_BLUEPRINT.md §9](./TECHNICAL_BLUEPRINT.md)):**

- [ ] Tích hợp VNDIRECT Trading API thật (auth, đặt/hủy lệnh, sync số dư) sau feature flag `LIVE_TRADING` — gateway mini-service còn pending
- [ ] **Egress máy chủ cho realtime finfo (S8)** — client + module Cài đặt đã xong (phiên #34, §4.5); cần máy chủ có egress thật tới VNDIRECT (sandbox bị chặn — DNS finfo → 10.210.100.8 private, auth NXDOMAIN) + đối chiếu lại đơn vị giá finfo (`normalizePrice` heuristic) khi có egress; **EOD bar thật đã xong** qua S7 dchart (215.327 bar đa sàn 2013→nay — phiên #38, upsert idempotent + ref/trần/sàn thật đầu phiên qua anchor Quote)
- [ ] **Egress máy chủ cho fundamentals finfo (S10 — phiên #38)** + đối chiếu heuristic đơn vị (T11.3: P/E VCB ±5%) khi có egress thật — pipeline đã sẵn, deploy là tự sáng
- [ ] **US/HK bar thật (S9):** chờ Yahoo hết rate-limit IP 429 — job market-engine **06:15 ICT** tự đổ khi nguồn hồi (range auto 1y lần đầu → 5d); không cần thao tác tay
- [ ] Dữ liệu khối ngoại/margin thật (EOD) thay flows simulator
- [ ] ~~HNX/UPCOM (dải giá ±10% / ±15%)~~ — **✅ done phiên #38** (90 instrument active đa sàn + UnitSpec; HNX/UPCOM có bar thật); còn lại: lịch nghỉ Tết chính thức từng năm
- [ ] Reuters/tin quốc tế cho bối cảnh Fed/DXY (tuỳ chọn)

---

## 8. Change Log

| Ngày | Thay đổi |
|---|---|
| 2026-10-05 | Tái tạo tài liệu sau reset workspace; đối chiếu `prisma/seed.ts`, `prisma/schema.prisma`, `package.json` |
| 2026-10-06 | **Giai đoạn 2:** S3 → 🟡 Scaffold (flag `LIVE_TRADING` + audit, gateway pending); S4 → ✅ Implemented (tick engine mô phỏng + stale marking `DataSourceStatus`); S5 → ✅ Implemented (crawler RSS live 5 nguồn VN + model `NewsItem` dedupe url); S6 → ✅ Implemented (flows simulator deterministic + RiskAlert `FOREIGN_FLOW_OUTFLOW`); cập nhật §4.1–4.4, §5 Q7 (lịch lễ 2026), §6 fallback đã implement, checklist tick các mục realtime/scheduler/crawler |
| 2026-10-06 | **v0.3 — Phiên #33 (dữ liệu EOD THẬT + audit 30 findings):** (1) nguồn mới **S7 — EOD thật VNDIRECT dchart** (§3.3: endpoint/golden signature/đơn vị nghìn VND ×1000/validate §5 Q1–Q9/throttle 300ms/scheduler 15:45 ICT + boot/deep backfill 90.785 bar 2013→2026-10-06 + rebase danh mục theo giá thật — equity 1.373.869.150 ₫); (2) **§4.2 S4 — REAL_EOD_MODE mặc định** (`MARKET_DATA_MODE=real-eod`): tick chỉ mô phỏng intraday quanh ref thật, EOD rollover KHÔNG ghi bar synthetic, ngoài phiên Quote neo close thật + mode `real`, `MARKET_STRICT_SESSION` mặc định true, mutex tick in-process; (3) `SourceMode` thêm **`real`** + nguồn footer `eod-history` (dot xanh "EOD thật") — §6.2; (4) §5 Q2 chú thích ngoại lệ EOD lịch sử đã adjust; (5) checklist: thêm mục S7 done, thu hẹp pending còn feed realtime thật; (6) phản ánh 30 fix audit cùng phiên (sweep Signal EXPIRED, VETO hard-enforce, transaction claim APPROVE, watchdog AgentRun RUNNING…) — chi tiết ở [TECHNICAL_BLUEPRINT.md §10](./TECHNICAL_BLUEPRINT.md) |
| 2026-10-06 | **v0.4.0 — Phiên #34 (module Cài đặt + realtime finfo S8 + Bộ tổng hợp Bayes):** (1) nguồn mới **S8 — VNDIRECT finfo realtime + OAuth2 customer** (§4.5): 🟡 Implemented (chờ egress) — `src/lib/vndirect.ts` (OAuth2 `client_credentials` auth.vndirect.com.vn + finfo `/v4/lastprice` POST envelope `{"data":{q,columns}}` + GET fallback + parse linh hoạt + `normalizePrice` heuristic nghìn-VND) + module Cài đặt (`GET/PUT /api/settings` — secret mask 4 đầu + "····", bỏ trống = giữ, `""` = xoá, guard chống echo + `POST /api/settings/test` probe thật ghi lastTest) + **mode runtime AppSetting ghi đè env `MARKET_DATA_MODE`** (real-eod \| realtime-vndirect \| simulated) + luồng fallback an toàn realtime → real-eod (`getEffectiveMode`: chưa cấu hình hoặc fetch cuối fail → real-eod); (2) **§4.2 S4** thêm nhánh realtime: trong phiên mode `realtime-vndirect` kéo giá cuối thật finfo (throttle ≥30s kèm cache, round100 + clamp ±7%, change/changePct từ ref EOD thật, KLGD/high/low dồn phiên), fail → mode `fallback` + random-walk quanh ref EOD thật; ok → mode `real` + meta provider `finfo-vndirect`; (3) **ghi chú probe sandbox:** finfo-api + auth.vndirect KHÔNG reachable (DNS finfo → 10.210.100.8 RFC1918 private kể cả DoH; auth NXDOMAIN; api-vnds NO-DNS) — chỉ dchart-api (160.250.74.45) sống → realtime cần **máy chủ có egress thật** khi deploy; (4) checklist: thêm mục S8 done (chờ egress), thu hẹp pending còn egress + đối chiếu đơn vị giá; (5) ghi nhận **Bộ tổng hợp Bayes nhân quả** (Đợt D mới trong chu kỳ 6 đợt A→F — [TECHNICAL_BLUEPRINT.md §5.3](./TECHNICAL_BLUEPRINT.md)) tiêu thụ S4/S5/S6/S7 làm bằng chứng quant: breadth từ Quote · lexicon NLP từ NewsItem 24h · flows ròng từ S6 · Holt/regime từ Bar EOD — 46 bằng chứng, 0 LLM |
| 2026-10-07 | **v0.4.1 — Phiên #35 (học máy trên dữ liệu EOD thật):** thêm ghi chú §4.2 — MLP + Q-learning của Phòng Học máy huấn luyện trên **Bar EOD thật S7/S4 (58.726 mẫu top-20 thanh khoản)**, Q-learning rổ top-10 `loadTopSeries(10)`, **bandit reward đối chiếu Bar EOD thật sau 5 phiên giao dịch** (FLAT khớp 0,7 — không bịa reward khi chưa đủ phiên); bằng chứng `mlp-forecast` + `rl-policy` mới chảy vào Bộ tổng hợp Bayes (46→50 bằng chứng) — chi tiết [TECHNICAL_BLUEPRINT.md §5.4](./TECHNICAL_BLUEPRINT.md) |
| 2026-10-07 | **v0.5.0 — Phiên #38 (MARKET_EXPANSION_BLUEPRINT v1.1 — 15/15):** (1) **§3.3 S7 đa sàn:** universe **30 → 90 instrument active** (HOSE-STOCK 30 · HNX-STOCK 20 · UPCOM-STOCK 13 · HOSE-ETF 5 · INDEX 8) · **215.327 bar EOD thật VN** (backfill 98s) · bảng tra **UnitSpec** (STOCK/ETF VN nghìn VND ×1000 bội 100 · INDEX điểm ×100 KHÔNG trần/sàn · US/HK cents ×100 · BOND %×100) · `MAX_SYMBOLS_PER_SYNC` 40 → 150; (2) **nguồn mới S9 — EOD quốc tế Yahoo Finance v8 chart** (§3.4: UA bắt buộc · throttle 1,2s · retry 429 ×3 backoff 5/15/45s · adjclose ưu tiên + null-skip · circuit-breaker · `POST /api/market/intl-sync` range auto 1y→5d · scheduler **06:15 ICT** + broadcast `intl` — sandbox gặp 429 kéo dài nên US/HK tạm 0 bar, job tự đổ khi nguồn hồi); (3) **nguồn mới S10 — finfo fundamentals** (§4.6: pending-egress — ingest Chủ nhật ICT trong runDataCollector · heuristic đơn vị VND nguyên · valuation block P/E·EPS·BVPS·ROE chỉ khi mode real · sandbox 0 dòng no-fabrication); (4) **watcher re-probe Chủ nhật 04:00 ICT** (`POST /api/market/reprobe` — probe-trước-khi-tạo 18 ứng viên) + **ma trận độ phủ** `GET /api/coverage` 15 ô 3 màu trung thực (§3.3/§6.2); (5) §6.2: registry 5 + 2 nguồn mới = 7 nguồn (`intl-eod` · `fundamentals` mode `pending`); (6) checklist: 4 mục done mới + pending thu hẹp (egress S10 · chờ Yahoo 429); (7) tick-engine loại INDEX + quốc tế khỏi mô phỏng |

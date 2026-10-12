# COUNCIL_STEWARDSHIP_BLUEPRINT v2.2 — Hội đồng thấy tài khoản · đánh giá quyết định · theo dõi đa thị trường · ĐẦU TƯ CHỈ TẠI THỊ TRƯỜNG VIỆT NAM

> Phiên #106 dựng v1.0 (4 tầng C-VISION · D-LEDGER · X-MARKETS · E-ALLOC).
> **v2.0 hiệu chỉnh phiên #107** theo làm rõ của trader:
>
> *"Rổ ở đây ý là quyết định đầu tư vào đâu — cổ phiếu, trái phiếu… của công ty nào, ngân hàng nào… — không nhất thiết là 5 nguồn đầu tư cố định nào; có thể chúng ta hiểu nhầm ở đây. Ngoài ra chế độ thử nghiệm đã là chơi kiểu thí nghiệm rồi, cần gì Thí nghiệm phân bố đa rổ — khác gì vẽ rắn thêm chân. Tôi đã set up một số tiền để làm Thử nghiệm rồi thì các agent cứ thế mà sử dụng: triển khai nghiên cứu thị trường, đầu tư từ khoản tiền đấy. Từ đấy là đủ để học rồi còn gì. Hội đồng ngoài nắm được thông tin các thị trường còn nắm thông tin số tiền hiện có, các khoản đầu tư và giá trị các khoản đầu tư hiện tại đang biến động theo thị trường như thế nào — là điều chắc chắn cần biết. Vì phải biết được thông tin thị trường thế nào và mình có gì mới đánh giá được các quyết định từng đưa ra đến hiện tại kết quả là gì, dự đoán được các quyết định hiện tại thì tương lai sẽ thế nào. Qua đó chính là mục tiêu của việc học để hiểu về thị trường và đầu tư đúng."*
>
> **v2.2 hiệu chỉnh phiên #108** theo chỉ thị mới của trader (thu hẹp vũ trụ ĐẦU TƯ):
>
> *"Trừ thị trường tiền tệ thì các thị trường đầu tư chỉ ở trong Việt Nam thôi, nước ngoài tôi biết thế quái nào được. Vậy nên các agent có đầu tư tài chính thì cũng tại thị trường Việt Nam thôi. Tất nhiên ngoại hối, tiền tệ nước ngoài cũng cần theo dõi vì bản chất nó cũng có lúc ảnh hưởng tới thị trường."*
>
> **Thay đổi lớn v2.1 → v2.2:** vũ trụ GIAO DỊCH (đặt lệnh sandbox) chỉ còn **CP/ETF Việt Nam** (HOSE/HNX/UPCOM — luật lot-100 như hiện hành). Toàn bộ tài sản quốc tế (cp Mỹ/HK · trái phiếu Mỹ · hàng hoá) và **forex (kể cả USD/VND, EURUSD, AUDUSD) hạ cấp xuống THAM CHIẾU — theo dõi để hiểu ảnh hưởng quốc tế (đặc biệt kênh tỷ giá) đến thị trường VN, KHÔNG đầu tư**. Khối prompt đổi tên VŨ TRỤ GIAO DỊCH → THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU); cổng thực thi chặn mọi tín hiệu phi-VN với thông điệp chính sách rõ ràng.
>
> **Thay đổi lớn v1 → v2:** BỎ toàn bộ tầng E-ALLOC (thí nghiệm phân bổ đa rổ — vốn giấy riêng 100tr₫, hội nghị CN 05:50 đề xuất tỷ trọng 5 rổ cố định, mark 16:35). Khoản tiền thử nghiệm sandbox K1 **CHÍNH LÀ thí nghiệm duy nhất**: agents nghiên cứu thị trường và đầu tư TRỰC TIẾP từ khoản tiền đó vào cổ phiếu/ETF VN (v2.2) — "rổ" chỉ còn là **lớp thống kê thị trường** để nhìn nhanh bức tranh 5 nhóm tài sản (trong đó 4 nhóm quốc tế thuần túy THAM CHIẾU).
>
> Nguyên tắc xuyên suốt (bảo toàn v1): **hội đồng TỰ nghiên cứu** — hệ thống chỉ cung cấp (1) tầm nhìn tài khoản & danh mục, (2) sổ đánh giá quyết định, (3) vũ trụ dữ liệu thị trường, (4) sân thực thi từ khoản tiền thử nghiệm. Hệ thống KHÔNG quy định đầu tư vào đâu hay bao nhiêu — mọi quyết định do Hội đồng tự đưa ra từ dữ liệu và hậu quả chính nó gánh.

---

## §0. Hiện trạng & bằng chứng

### §0.1 Khi bắt đầu #106 (lịch sử — bảo toàn làm mốc)

| Hạng mục | Hiện trạng lúc đó | Nguồn доказ |
|---|---|---|
| Hội đồng thấy tài khoản? | **KHÔNG** — prompt agents chỉ thấy danh mục GIẤY (NAV 0₫); sandbox K1 bị lọc `accountType: { not: "sandbox" }` | agent-context.ts:58, :550 |
| Đánh giá L/L quyết định? | RẢI RÁC — k1 settle-equity (bandit kênh-2), chairman-scorecard (runtime), research-scorecard — không có sổ persisted trung tâm | k-sandbox.ts:779 |
| Vũ trụ đầu tư | 30 HOSE-STOCK + 5 HNX-ETF + 4 UPCOM; 0 instrument quốc tế; không trái phiếu/forex/hàng hoá | expand-universe.ts |
| Nguồn đa thị trường | Yahoo query1 429 chặn toàn bộ → phát hiện query2 + UA Windows 9/9 OK | đo #106 §3 |

### §0.2 Sau #106 — điểm khởi đầu của v2 (đo lại #107, 12/10/2026)

| Hạng mục | Trạng thái | Ghi chú cho v2 |
|---|---|---|
| C-VISION | ✅ chạy — khối TÀI KHOẢN HỘI ĐỒNG + VỊ THẾ + 7 quyết định tiêm 3 đường prompt (wave E · single-run · chat) | **GIỮ** — chỉ đổi mục 4 (bỏ "thí nghiệm phân bổ", thay bằng ảnh chụp thị trường đa tài sản §4) |
| D-LEDGER | ✅ chạy — 9 hàng DecisionEvaluation (1 EXECUTED_OPEN TCB cashPnl −34.905₫ · 8 HOLD UNEXECUTED) · job 16:45 t2–t6 | **GIỮ NGUYÊN** — đúng nghĩa "đánh giá quyết định từng đưa ra kết quả là gì" |
| X-MARKETS | ✅ ~9.700 bar thật (Treasury 1.332 · Frankfurter 2.898 · er-api · Yahoo 22 mã 5.481) · 28 instrument mới · 4 adapter sync 06:15 | **GIỮ** — baskets.ts hạ cấp thành lớp thống kê (§2.4) |
| E-ALLOC | ⚠️ **code đang chạy nhưng CẦN THÁO** — 2 job engine (16:35 mark · CN 05:50 hội nghị) + 3 API route + card UI + dialog tạo + 2 model | **BỎ** theo phán định §5-old; hội nghị CN 05:50 **sẽ sinh thí nghiệm mới** vào CN 18/10 05:50 nếu chưa tháo kịp |
| DB thí nghiệm | 2 thí nghiệm STOPPED (ret 0) · 1 DONE −1,05% có lesson | Lesson của thí nghiệm DONE xuất ra docs trước khi drop bảng (§9 P1) |
| Prompt vũ trụ phi-VN | ❌ buildMarketBlock bảng chính vẫn HOSE-STOCK (agent-context.ts:108) — agents CHƯA thấy mã trái phiếu/forex/hàng hoá/quốc tế trong prompt | **THIẾU then chốt** — không thấy thì không quyết định "đầu tư vào đâu" ngoài CP VN (E-EXEC §5) |
| Sandbox execution | ❌ chỉ HOSE: lot 100 cứng (signal-execution.ts:42), băng ±7%, phiên 09:15–15:00; tick engine tự loại thị trường mới | **THIẾU then chốt** — E-EXEC §5 mở theo luật TỪNG thị trường |

**Phán định v2:** cơ chế "đánh giá tổn thất/lợi ích trong các quyết định" (D-LEDGER) và "hội đồng thấy tài khoản" (C-VISION) là ĐÚNG và ĐÃ CHẠY — khớp từng chữ trader mô tả. Phần SAI là E-ALLOC (hiểu nhầm "rổ" thành 5 nguồn cố định cần thí nghiệm tỷ trọng riêng). Phần THIẾU là khả năng đầu tư khoản tiền thử nghiệm ra thị trường phi-VN (prompt + execution). v2 = bỏ cái sai, vá cái thiếu, giữ 2 cái đúng.

---

## §1. Kiến trúc hiệu chỉnh — một vòng học khép kín trên MỘT khoản tiền

```
┌─ X-MARKETS ────────── vũ trụ & dữ liệu thị trường ──────────────────┐
│ VN hiện hành (HOSE/HNX/UPCOM) + Treasury CSV (3 tenor) +             │
│ Frankfurter (EUR/AUD) + er-api (USD/VND) + Yahoo query2 (hàng hoá + │
│ cp Mỹ/HK + DXY) → nạp Instrument/Bar/Quote (0 model giá mới)        │
│ baskets.ts = LỚP THỐNG KÊ 5 nhóm tài sản (chỉ để NHÌN — §2.4)       │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─ C-VISION ── Hội đồng NHÌN THẤY (tiêm 3 đường prompt) ──────────────┐
│ 1. TÀI KHOẢN THỬ NGHIỆM: equity · cash · P&L từ kích hoạt · %/ngày  │
│ 2. VỊ THẾ ĐANG NẮM: mã × lượng × giá vốn × giá hiện tại × lãi/lỗ    │
│    (CP/ETF VN; tài sản phi-VN lịch sử nếu còn → hiển thị trung     │
│    thực kèm quy đổi USD→VND)                                        │
│ 3. KẾT QUẢ 7 QUYẾT ĐỊNH GẦN NHẤT (D-LEDGER): hướng → WIN/LOSS ±pct  │
│ 4. THỊ TRƯỜNG ĐA TÀI SẢN: 5 nhóm ret5/ret30 + USD/VND               │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼  QUYẾT ĐỊNH: MUA/BÁN/GIỮ mã CỤ THỂ — CHỈ CP/ETF VIỆT
                  NAM (HOSE/HNX/UPCOM); thị trường quốc tế & forex =
                  THAM CHIẾU bối cảnh — KHÔNG đầu tư (v2.2)
┌─ E-EXEC ──── thực thi từ KHOẢN TIỀN THỬ NGHIỆM (§5 — thay E-ALLOC) ─┐
│ Signal → cổng B9 đồng thuận (luật như cũ) → lệnh sandbox theo luật  │
│ VN (lot 100 · phiên 09:15–15:00 · băng ±7% · phí 0,15%) · tín hiệu │
│ phi-VN bị chặn tại cổng với thông điệp chính sách rõ ràng           │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─ D-LEDGER ── sổ đánh giá quyết định (job 16:45 t2–t6 — GIỮ) ────────┐
│ mỗi Signal = 1 hàng: (a) dự báo ±pct · peak/trough                  │
│ (b) thực thi dòng tiền VND (phí/thuế) · verdict WIN/LOSS ±0,5%      │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼  VÒNG HỌC KHÉP KÍN — KHÔNG cần tầng thí nghiệm riêng
   C-VISION chu kỳ sau mang kết quả vào prompt → quyết định mới
   tốt hơn. Cộng 3 cơ chế học hiện hành (giữ nguyên):
   bandit kênh-2 settle mỗi thương vụ round-trip · chairman-scorecard
   nhãn WIN/LOSS 5 phiên · research-scorecard Brier từng cử tri.
   THÍ NGHIỆM = lịch sử toàn bộ tài khoản sandbox, không gì khác.
```

**Vì sao đủ học không cần tầng thí nghiệm riêng (lời trader: "từ đấy là đủ để học rồi còn gì"):**
quyết định → tiền thật (sandbox) di chuyển → vị thế biến động theo thị trường mỗi ngày → D-LEDGER phán quyết → C-VISION đưa phán quyết vào chu kỳ sau. Đó là một vòng phản hồi hoàn chỉnh trên đúng khoản tiền trader đã set up — thêm danh mục giấy 100tr₫ riêng là cộng thêm một thế giới song song không chảy vào tài khoản thật của hội đồng (vẽ rắn thêm chân).

---

## §2. X-MARKETS — vũ trụ & nguồn dữ liệu (GIỮ v1 — kết quả đo thật 12/10/2026)

### §2.1 Bảng nguồn (đo trực tiếp từ sandbox trước khi viết 1 dòng code)

| Nguồn | Endpoint | Kết quả đo | Nhóm | Độ tin cậy |
|---|---|---|---|---|
| **US Treasury** (chính thức) | `home.treasury.gov/.../daily-treasury-rates.csv/{năm}/all` | 200, CSV đầy đủ 1Mo→30Y cả năm | BOND | CAO (chính phủ Mỹ, không key) |
| **Frankfurter** (ECB) | `api.frankfurter.dev/v1/{from}..{to}?base=USD` | 200, chuỗi ngày EUR/JPY/AUD | FOREX | CAO (không key, lịch sử từ 1999) |
| **er-api** | `open.er-api.com/v6/latest/USD` | 200, VND=25.886 (chỉ GIÁ MỚI NHẤT) | FOREX (USD/VND) | CAO (tích luỹ tiến) |
| **Yahoo query2** | `query2.finance.yahoo.com/v8/finance/chart/{sym}` + UA Windows | **9/9 OK** throttle 2,5s | COMMODITY + INTL | TRUNG BÌNH (quota IP — backoff) |

### §2.2 Đơn vị (GIỮ v1 — UNIT_SPECS single source of truth)

| (market:type) | UnitSpec | Cách lưu | Ví dụ |
|---|---|---|---|
| `FOREX:FX` | `FX_RATE` ×10.000 round 1 | EURUSD 1,0852 → 10.852 | USD/VND 25.886 → 258.860.000 |
| `COMMODITY:CMDTY` | tái dùng `CENTS` ×100 | vàng 4.150,5 USD → 415.050 | Brent 81,2 → 8.120 |
| `BOND:BOND` | tái dùng `BOND_PCT` ×100 | yield 10Y 4,25% → 425 | 30Y 5,60% → 560 |
| `US/HK:*` | giữ nguyên CENTS/INDEX | — | — |

Enum đã mở rộng từ #106 (additive): `Market += BOND, FOREX, COMMODITY` · `InstrumentType += FX, CMDTY`.

### §2.3 Universe seed (đã nạp #106 — script idempotent `scripts/p106-seed-markets.ts`)

BOND (3): US5Y · US10Y · US30Y · FOREX (5): EURUSD=X · USDJPY=X · AUDUSD=X · VND=X · DX-Y.NYB · COMMODITY (6): GC=F · SI=F · BZ=F · CL=F · HG=F · NG=F · INTL (14): AAPL MSFT NVDA GOOGL AMZN META TSLA JPM · ^GSPC ^IXIC · 0700.HK 0005.HK 3888.HK · ^HSI — kèm `name` tiếng Việt + `currency` đúng + dataSourceStatus 4 key riêng, honest mode real/fallback.

Giới hạn trung thực (GIỮ v1): trái phiếu VN không có nguồn miễn phí từ sandbox → nhóm BOND = Treasury Mỹ (chuẩn tham chiếu toàn cầu, thật sự ảnh hưởng VN qua kênh USD); Yahoo quota IP → COMMODITY/INTL về đủ dần, DataSourceStatus ghi rõ từng ngày.

### §2.4 Lớp thống kê thị trường (`src/lib/council/baskets.ts` — HẠ CẤP từ "rổ đầu tư")

- `BASKETS` 5 nhóm **chỉ để NHÌN nhanh bức tranh**: `VN_EQUITY` (top-10 ADTV HOSE) · `INTL_EQUITY` (equal-weight cp US/HK) · `BOND` · `FOREX` (biến động USD/VND) · `COMMODITY`.
- Dùng để: (a) card "Đa rổ thị trường" ở module Thị trường (bức tranh breadth), (b) ảnh chụp 1 dòng trong C-VISION mục 4 (§4), (c) ngữ cảnh hội nghị nghiên cứu nếu trader kích hoạt lại sau này.
- **KHÔNG dùng để**: đặt lệnh, đề xuất tỷ trọng, làm đối tượng thí nghiệm. Không có "tỷ trọng rổ" ở bất kỳ đâu — tỷ trọng danh mục là KẾT QUẢ tích luỹ của các quyết định cụ thể trên tài khoản sandbox, không phải con số ai đặt ra.
- Chuyển đổi VND (GIỮ v1): INTL/COMMODITY ret_VND = (1+ret_USD)×(1+ret_USDVND)−1, cờ `fxMissing` khi thiếu; BOND duration sleeve −D·Δy+carry (D=4,5/8/17); cache 60s.

---

## §3. D-LEDGER — sổ đánh giá quyết định (GIỮ NGUYÊN v1 — đúng trọng tâm trader)

Mỗi quyết định từng đưa ra → 1 hàng `DecisionEvaluation`, cập nhật hằng ngày 16:45 ICT (job engine t2–t6, gate eodSync):

- **(a) Kết quả dự báo** (mọi tín hiệu ≤ 90 ngày, kể cả chưa thực thi): entry = close ngày quyết định → mark = close mới nhất; `markPnlPct` theo hướng (SELL đảo dấu); peak/trough quét chuỗi bar — *"đánh giá được các quyết định từng đưa ra đến hiện tại kết quả là gì"*.
- **(b) Kết quả thực thi** (Order → Trade): dòng tiền VND từng trade (BUY −, SELL +, trừ phí/thuế — đối xứng `netRealisedFromTrades`); openQty → unrealised (mark − vwap)×qty; `executionKind` 3 nhánh trung thực EXECUTED_OPEN/CLOSED/UNEXECUTED.
- **Phán quyết** WIN/LOSS/NEUTRAL ±0,5% (một hệ ngưỡng với bandit #87).
- **Idempotent** upsert theo signalId; **KHÔNG đụng** 3 cơ chế học hiện hành (bandit kênh-1/2, chairman-scorecard, research-scorecard) — D-LEDGER là sổ cái trung tâm cả 3 có thể đọc.
- **Mở rộng duy nhất của v2 (E-EXEC §5.6):** tài sản phi-VND — markPnlPct tính trên Bar cùng instrument (native, % không phụ thuộc tỷ giá); cashPnlVND đã sẵn là VND; `driversJson` tách rõ **lãi giá + lãi tỷ giá** cho vị thế USD đang mở → hội đồng thấy được kênh nào sinh lời.

---

## §4. C-VISION — Hội đồng nhìn thấy tài khoản (GIỮ + hiệu chỉnh mục 4)

`src/lib/council/vision.ts` — `buildCouncilVisionBlock()` ≤900 ký tự (~360 token, ngân sách XREL #103), tiêm 3 đường parity (wave E Chủ tịch route.ts sau `portfolioWeightsBlock` · single-run strategist · chat strategist), fail-soft, cache 60s. Chỉ ĐỌC — tầm nhìn ≠ quyền thực thi (lệnh vẫn qua cổng K1/B9).

1. `TÀI KHOẢN HỘI ĐỒNG (sandbox K1)`: equity · cash · P&L từ lúc kích hoạt (₫ + %) · biến động ngày gần nhất — *"số tiền hiện có"*.
2. `VỊ THẾ ĐANG NẮM`: mã × lượng × giá vốn × giá hiện tại × lãi/lỗ — **v2.2: CP/ETF VN** (tài sản phi-VN lịch sử nếu còn → hiển thị trung thực kèm quy đổi VND + tách lãi giá/lãi tỷ giá) — *"các khoản đầu tư và giá trị các khoản đầu tư hiện tại đang biến động theo thị trường"*.
3. `KẾT QUẢ 7 QUYẾT ĐỊNH GẦN NHẤT` (từ D-LEDGER): hướng mã → WIN/LOSS ±pct — *"đánh giá được các quyết định từng đưa ra đến hiện tại kết quả là gì"*.
4. **v2 ĐỔI NỘI DUNG** (v1 là "thí nghiệm phân bổ đang chạy" — BỎ): `THỊ TRƯỜNG ĐA TÀI SẢN`: 1 dòng 5 nhóm — CP VN ±x% · CP quốc tế ±x% · trái phiếu ±x% · forex (USD/VND ±x%) · hàng hoá ±x% (ret5/ret30 từ baskets.ts) — *v2.2: 4 nhóm quốc tế THAM CHIẾU — "ngoại hối, tiền tệ nước ngoài cũng cần theo dõi vì bản chất nó cũng có lúc ảnh hưởng tới thị trường"* — *"ngoài nắm được thông tin các thị trường"*.

Cộng khối thị trường VN sẵn có trong prompt (bảng HOSE-STOCK + XREL + flows) → đủ bộ đôi trader yêu cầu: **thị trường thế nào + mình có gì**.

---

## §5. E-EXEC — đầu tư TỪ KHOẢN TIỀN THỬ NGHIỆM, CHỈ TẠI THỊ TRƯỜNG VIỆT NAM (v2.2)

> *Nếu tôi đã set up một số tiền để làm Thử nghiệm rồi thì các agent cứ thế mà sử dụng triển khai nghiên cứu thị trường, đầu tư từ khoản tiền đấy.* (#107)
> *Trừ thị trường tiền tệ thì các thị trường đầu tư chỉ ở trong Việt Nam thôi, nước ngoài tôi biết thế quái nào được. Vậy nên các agent có đầu tư tài chính thì cũng tại thị trường Việt Nam thôi. Tất nhiên ngoại hối, tiền tệ nước ngoài cũng cần theo dõi vì bản chất nó cũng có lúc ảnh hưởng tới thị trường.* (#108 — v2.2)

Không vốn giấy riêng, không danh mục song song, không tỷ trọng ai đặt. Một tài khoản sandbox duy nhất (100tr₫ trader đã cấp #87), agents tự quyết định mua/bán **cổ phiếu/ETF Việt Nam cụ thể** (công ty nào, sàn nào) theo luật vi mô VN hiện hành — *giữ nguyên như trước #107: lot 100 · phiên 09:15–11:30/13:00–15:00 T2–T6 · băng trần/sàn ±7%/±10% · phí 0,15% · tiền VND · sizing %NAV của k-sandbox.*

### §5.1 Vũ trụ GIAO DỊCH vs THAM CHIẾU (v2.2 — bảng trung tâm)

| Nhóm | Đặt lệnh được (sandbox) | THAM CHIẾU — theo dõi, KHÔNG đầu tư (v2.2) |
|---|---|---|
| CP/ETF VN | HOSE/HNX/UPCOM stock + ETF (như hiện hành) | VNINDEX · VN30 |
| CP quốc tế | — | AAPL MSFT NVDA GOOGL AMZN META TSLA JPM · 0700.HK 0005.HK 3888.HK · ^GSPC ^IXIC ^HSI |
| Trái phiếu | — | US5Y · US10Y · US30Y (mô hình duration §7) |
| Forex | — | EURUSD=X · AUDUSD=X · VND=X · DX-Y.NYB · USDJPY=X |
| Hàng hoá | — | GC=F · SI=F · BZ=F · CL=F · HG=F · NG=F |

Lý do (lời trader #108): thị trường ngoài VN thì trader "biết thế quái nào được" — agents đầu tư tài chính chỉ tại thị trường VN; ngoại hối/tiền tệ nước ngoài **cần theo dõi** vì có lúc ảnh hưởng tới thị trường (kênh tỷ giá USD/VND, giá hàng hoá đầu vào, cảm xúc quốc tế). Vì vậy 4 nhóm quốc tế vẫn được **đồng bộ dữ liệu X-MARKETS + hiển thị trong khối THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU) của prompt Chủ tịch/strategist + ảnh chụp 5 nhóm ở C-VISION mục 4** — đúng nghĩa "ngoài nắm được thông tin các thị trường", nhưng **cổng tín hiệu + thực thi chặn sạch mọi mã phi-VN**:

- `execRuleFor()` (market-rules.ts) chỉ còn luật cho HOSE/HNX/UPCOM (trừ INDEX); **mọi thị trường US/HK/BOND/FOREX/COMMODITY → null** → map `instrumentIdBySymbol` tự loại (tín hiệu mã ngoài VN bị bỏ với nhắc nhở rõ — như mã hallucinate) · `createPaperOrderFromSignal` chặn 400 với thông điệp chính sách.
- Prompt Chủ tịch: quy tắc tín hiệu "chỉ chọn mã có trong bảng chỉ báo" (CP/ETF VN); khối quốc tế đổi tên **VŨ TRỤ GIAO DỊCH → THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU)** và ghi rõ vì sao theo dõi + vì sao không đầu tư.

### §5.2 Luật vi mô — duy nhất thị trường VN (v2.2 thu hẹp từ v2.1)

| Thị trường | Đơn vị lệnh tối thiểu | Phiên ICT | Băng giá | Phí mô phỏng | Tiền | Định giá |
|---|---|---|---|---|---|---|
| CP/ETF VN | lot 100 | 09:15–11:30 · 13:00–15:00 T2–T6 | ±7%/±10% | 0,15% (+thuế bán 0,1%) | VND | trực tiếp |

Bảng luật phi-VN của v2.1 (cp Mỹ/HK 0,01cp · trái phiếu danh nghĩa 1tr₫ · forex nano lot 100 · hàng hoá danh nghĩa 1tr₫ · khớp tại close đa phiên) **được tháo khỏi đường thực thi** cùng với matching phi-VN trong tick route — bộ định giá VND đa thị trường (markPositionVND · idx · USD/VND) **GIỮ lại** để (a) hiển thị trung thực bất kỳ vị thế phi-VN lịch sử nào còn sót (hiện 0), (b) D-LEDGER tiếp tục đánh giá tín hiệu lịch sử đầy đủ. Lịch sử thiết kế v2.1 bảo toàn ở §9.2.

### §5.3 Kế toán MỘT đồng tiền (VND)

- Cash sandbox VND; mua/bán CP VN trừ/cộng tiền + phí/thuế như luật hiện hành từ trước #107.
- Định giá hằng ngày k1 settle 16:30 (job sẵn có): equity = cash + Σ(qty × giá) — chỉ CP VN nên không phụ thuộc tỷ giá.

### §5.4 Tín hiệu & cổng

- **B9 đồng thuận giữ nguyên** cho CP VN — không đổi gì so với trước #107.
- Signal map: bảng chính HOSE-STOCK trong prompt GIỮ; khối THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU) vào prompt **Chủ tịch / portfolio-strategist** — bối cảnh quốc tế cho quyết định VN.
- Sizing: `k-sandbox.sizePct` %NAV giữ nguyên; lot 100.

### §5.5 Matching engine & D-LEDGER

- Tick simulator + khớp lệnh sandbox: **chỉ VN** (như trước #107). Nhánh khớp phi-VN tại close của v2.1 đã tháo (không còn lệnh phi-VN nào để khớp — 0 pending khi đổi chính sách).
- D-LEDGER job 16:45 t2–t6 GIỮ NGUYÊN — đánh giá mọi tín hiệu lịch sử (markPnlPct trên Bar native; tài sản USD: driversJson tách lãi giá/lãi tỷ giá — dành cho dữ liệu quá khứ).

---

## §6. Tích hợp hệ thống (bảng delta so với #106 đang chạy)

| Thành phần | Thay đổi v2 |
|---|---|
| Schema | **−2 model** (AllocationExperiment · ExperimentSnapshot — drop tables sau khi export lesson) · **+0 model mới** (E-EXEC dùng Signal/Order/Trade/Position/CashSnapshot hiện hành) · lot/hệ số/phiên = hằng code `LOT_SPECS` (không đổi schema) |
| API | **−3 route** (`experiments` · `experiments/mark` · `allocation-session`) · `overview` bỏ trường thí nghiệm · `baskets` **GIỮ** (thống kê cho card Thị trường + C-VISION mục 4) · `evaluate` **GIỮ** |
| market-engine (:3003) | **−2 job** (16:35 mark · CN 05:50 hội nghị) · 16:45 evaluate **GIỮ** · #108: tháo luôn matching phi-VN trong tick route (chỉ VN) |
| Prompt | vision mục 4: THÍ NGHIỆM PHÂN BỔ → THỊ TRƯỜNG ĐA TÀI SẢN · #107 từng có khối VŨ TRỤ GIAO DỊCH · #108 đổi thành **THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU)** — chỉ bối cảnh, không đầu tư |
| UI | council-workspace: −card Thí nghiệm −dialog tạo; card VỊ THẾ nhóm thị trường (nhóm phi-VN chỉ hiển thị nếu có vị thế lịch sử) · card "Đa rổ thị trường" module Thị trường **GIỮ** (bức tranh thống kê — 4 nhóm quốc tế thuần tham chiếu) |
| K3 nhiệm vụ | không đổi (16:45 là engine-side như cũ) |
| Bộ chọn khoảng #105 | GIỮ — overview + sổ phán quyết vẫn lọc from/to ngày ICT |

---

## §7. Giới hạn & quyết định trung thực (trader cần biết — v2.2)

1. **Chính sách đầu tư chỉ tại thị trường VN (#108 — quyết định của trader, không phải giới hạn kỹ thuật)**: mọi thị trường ngoài VN (cp Mỹ/HK · trái phiếu Mỹ · forex · hàng hoá) KHÔNG đặt lệnh sandbox — lý do trader: *"nước ngoài tôi biết thế quái nào được"*. Ngoại hối/tiền tệ nước ngoài vẫn đồng bộ + hiển thị THAM CHIẾU vì *"có lúc ảnh hưởng tới thị trường"*. Nếu sau này trader muốn mở lại đầu tư phi-VN: luật v2.1 bảo toàn ở §9.2 + bộ định giá markPositionVND còn nguyên → bật lại execRuleFor là đủ.
2. **Trái phiếu VN**: chưa có nguồn miễn phí từ sandbox → nhóm BOND = Treasury Mỹ (chỉ tham chiếu từ v2.2). InstrumentType sẵn sàng khi trader cấp nguồn.
3. **USD/VND lịch sử**: er-api chỉ "hôm nay" → chuỗi VND=X tích luỹ từ #106; job đồng bộ hằng ngày tiếp tục vì tỷ giá là dữ liệu THAM CHIẾU quan trọng nhất với thị trường VN.
4. **Yahoo quota IP**: hàng hoá/quốc tế về đủ dần theo ngày 06:15; DataSourceStatus ghi rõ.
5. **BOND = mô hình duration** (−D·Δy + carry, D=4,5/8/17) — từ v2.2 chỉ còn ở lớp thống kê baskets + D-LEDGER đánh giá tín hiệu lịch sử.
6. **Bộ định giá VND đa thị trường (markPositionVND · idx · USD/VND) GIỮ lại** sau v2.2 — hiển thị trung thực vị thế lịch sử phi-VN nếu còn (hiện 0) + đánh giá D-LEDGER tín hiệu quá khứ; không sinh lệnh mới.

### §7.5a Tinh chỉnh thực thi P2 (code hoá #107 — LỊCH SỬ từ v2.2: toàn bộ chỉ còn hiệu lực với bộ định giá/D-LEDGER)

1. **Đơn vị danh nghĩa 1tr₫/đv cho hàng hoá + trái phiếu** (gốc §5.3 v2.0 định nghĩa hợp đồng thật × hệ số — GC=F 100 oz ≈ 10,8 tỷ₫/hợp đồng, KHÔNG mua nổi trên tài khoản 100tr₫ no-margin full-value). Mỗi đơn vị = 1.000.000₫ triển khai, giá trị theo chỉ số VND của tài sản gốc — tư duy “chứng chỉ danh nghĩa”.
2. **CP Mỹ/HK tính đơn vị lẻ 0,01 cp** (fractional shares) — để định cỡ 5% NAV mua nổi cả mega-cap (AAPL ≈ 5,9tr₫/cp > 5%×96,7tr₫ nếu nguyên cp).
3. **Forex lot nano 100 đv tiền gốc** (gốc nói 1.000 — với tài khoản 100tr₫, 1.000 EUR ≈ 28tr₫ = 28% NAV vượt mọi giới hạn sizing; 100 EUR ≈ 2,8tr₫ khớp khẩu vị 5%).
4. **Trái phiếu BUY khớp khi yield ≥ giá đặt** (trái phiếu “rẻ” khi lợi suất cao — ngược chiều giá trị) — SELL khi yield ≤ giá đặt; các mức targetPrice/stopLoss của bond đều là LỢI SUẤT.
5. **D-LEDGER nhánh SELL trái phiếu**: giá trị thu được = bondRet(y₀→y_vwap) (−D·Δy+carry) — cùng chiều “bán cao = tốt” như cổ phiếu.

---

## §8. Kế hoạch nghiệm thu v2.2 (chuẩn nhà)

1. **Chính sách VN-only chặn sạch**: `execRuleFor` trả null cho MỘI instrument phi-VN (kể cả VND=X · EURUSD=X · AAPL · GC=F · US10Y · 0700.HK); map `instrumentIdBySymbol` không chứa mã phi-VN; `createPaperOrderFromSignal` với instrument phi-VN → 400 thông điệp chính sách; 0 vị thế/lệnh phi-VN mở trong DB.
2. **Prompt** (Chủ tịch/strategist): khối THỊ TRƯỜNG QUỐC TẾ (THAM CHIẾU) có ≥ 3 nhóm phi-VN + ghi rõ KHÔNG đầu tư; quy tắc tín hiệu chỉ cho phép mã bảng chỉ báo VN; vision mục 4 THỊ TRƯỜNG ĐA TÀI SẢN + USD/VND còn nguyên (theo dõi).
3. **Hồi quy CP VN nguyên vẹn**: tín hiệu + lệnh TCB lot-100 · phiên VN · băng ±7% · B9 như cũ; D-LEDGER 9 hàng cũ không đổi số; date-range #105; module Hội đồng render · 0 console error · mobile 390 sw=cw; tick route chạy không lỗi.
4. **Tháo E-ALLOC sạch (giữ từ v2.1)**: 0 tham chiếu AllocationExperiment/ExperimentSnapshot; engine đúng 1 job council (16:45).
5. **Chất lượng**: lint 0 · tsc 0 (src) · E2E agent-browser desktop 1440 + mobile 390 · **giao thức Fixbug 4 lớp (Fixbug.md §4) trên toàn scope #107+#108** theo chỉ thị trader — vòng lặp tới khi 0 finding + Vòng Xác Nhận sạch.

---

## §9. Kế hoạch delta & lịch sử hiệu chỉnh

### §9.1 Trình tự triển khai (chờ trader duyệt từng pha)

| Pha | Việc | Lý do thời gian |
|---|---|---|
| **P1 — Tháo E-ALLOC** | export lesson thí nghiệm DONE → drop 2 model + xoá experiments.ts/allocation-session.ts + 3 API route + card UI + dialog + 2 job engine + vision mục 4 đổi nội dung | **cần xong trước CN 18/10 05:50** — không thì hội nghị LLM sinh thí nghiệm mới từ cơ chế đã bác |
| **P2 — E-EXEC core** | LOT_SPECS + phiên đa thị trường (market-session) + signal eligibility mở rộng + matching tại close + kế toán USD→VND (mua/bán/định giá k1 settle) | tầng thực thi khoản tiền thử nghiệm |
| **P3 — Prompt + UI** | khối VŨ TRỤ GIAO DỊCH (Chủ tịch/strategist) · council-workspace v2 (vị thế nhóm thị trường, chip quy đổi) · E2E full | |
| **P4 — Nghiệm thu §8** | fixbug 4 lớp + hồi quy #105/#106 | |

### §9.2 Lịch sử

- **v1.0 (#106)**: dựng 4 tầng C-VISION · D-LEDGER · X-MARKETS · E-ALLOC + toàn bộ code + ~9.700 bar thật + hội nghị LLM đo thật 44s. E-ALLOC khi đó diễn giải "rổ" thành 5 nguồn cố định + vốn giấy riêng 100tr₫.
- **v2.0 (#107)**: trader làm rõ → bỏ E-ALLOC (vẽ rắn thêm chân), "rổ" = quyết định đầu tư mã cụ thể, khoản tiền thử nghiệm sandbox LÀ thí nghiệm, hội đồng phải thấy thị trường + tiền + vị thế + giá trị biến động. Giữ C-VISION/D-LEDGER/X-MARKETS; thêm E-EXEC (blueprint — CHƯA code, chờ duyệt §9.1).
- **v2.1 (#107 triển khai)**: trader phê duyệt triển khai toàn bộ blueprint ("Tiến hành luôn cho tôi"). P1–P4 code hoá: tháo E-ALLOC sạch (2 bảng drop + 5 file xoá + 3 route xoá + 2 job engine tháo trước mốc CN 18/10) · E-EXEC core (market-rules.ts · matching tại close đa phiên · kế toán avgCostVND/openIdxUnits · sizing theo đơn vị thị trường · D-LEDGER bond/fx) · prompt VŨ TRỤ GIAO DỊCH 3 đường + vision mục 4 THỊ TRƯỜNG ĐA TÀI SẢN + bỏ hardcode VCB · UI Hội đồng v2 (vị thế nhóm thị trường + chip quy đổi). 4 tinh chỉnh thực thi ghi trung thực §7.5a (đơn vị danh nghĩa 1tr₫/đv cho hàng hoá + trái phiếu vì hợp đồng thật quá to cho tài khoản 100tr₫; cp Mỹ/HK tính đơn vị lẻ 1/100 cp; forex lot nano 100 đv). Nghiệm thu: scripts/p107-verify.ts 49/49 PASS + auto-convert E2E EURUSD=X (lệnh lot-100 → khớp phiên forex → avgCostVND chính xác 0,19₫ → realized chỉ mất phí spread → dọn sạch hermetic).
- **v2.2 (#108)**: trader chỉ thị thu hẹp — *"các thị trường đầu tư chỉ ở trong Việt Nam thôi, nước ngoài tôi biết thế quái nào được… ngoại hối, tiền tệ nước ngoài cũng cần theo dõi"*. Vũ trụ giao dịch thu về CP/ETF VN (lot-100 như cũ); toàn bộ tài sản quốc tế + forex hạ cấp THAM CHIẾU (khối prompt đổi tên THỊ TRƯỜNG QUỐC TẾ + mục 4 vision giữ theo dõi 5 nhóm + USD/VND). Code: execRuleFor chặn phi-VN → null · tháo nhánh sizing/khớp phi-VN (signal-execution + tick route) · GIỮ markPositionVND/idx/USD-VND cho hiển thị trung thực + D-LEDGER lịch sử · giao thức Fixbug 4 lớp chạy trên toàn scope #107+#108 theo chỉ thị trader.

---

## §10. Phụ lục lịch sử — bài học thí nghiệm E-ALLOC (xuất từ DB trước khi drop bảng, #107)

> Thí nghiệm duy nhất kết thúc đầy đủ trước khi E-ALLOC bị tháo theo phán định "vẽ rắn thêm chân". Bài học được bảo toàn làm bằng chứng lịch sử cho C-VISION.

- **Tên**: "Khởi động: cân bằng 5 rổ (hồi tính 25 phiên)" · vốn 100.000.000₫ · chạy 07/09→12/10/2026 · createdBy seed.
- **Trọng số**: 20%/rổ × 5 (VN_EQUITY · INTL_EQUITY · BOND · FOREX · COMMODITY).
- **Kết quả**: return **−1,05%** · maxDD 2,38% · Sharpe −1,65 · đóng góp từng rổ: VN_EQUITY −0,92% · INTL_EQUITY +0,47% · BOND −0,70% · FOREX −0,10% · COMMODITY +0,22%.
- **Bài học (LLM hội nghị tự viết)**: *"Cân bằng 20%/rổ cho kết quả −1,05%, Sharpe −1,65 và maxDD 2,38%: rổ thắng (COMMODITY, INTL_EQUITY) bị pha loãng bởi VN_EQUITY/BOND âm và FOREX biến động gần như bằng 0. Bài học: đa dạng hóa đều không thay thế được lựa chọn thiên lệch theo chất lượng và độ phủ dữ liệu của từng rổ."*
- 2 thí nghiệm khác ("Bám dẫn đầu: hàng hoá + CP quốc tế" · "Phòng thủ: trái phiếu + hàng hoá") dừng ở trạng thái STOPPED ret 0 (chưa có snapshot) — không có dữ liệu đáng bảo toàn.

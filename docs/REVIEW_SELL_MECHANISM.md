# REVIEW CƠ CHẾ BÁN — THE TRADER (Task 151 · 20/10/2026 — sửa xong Task 152 · 20/10/2026)

> Yêu cầu chủ sở hữu: "Điều kiện để các agent thống nhất thực hiện lệnh bán là gì, và cơ chế này có đang hoạt động đúng không?"
> Phương pháp: đọc code toàn chuỗi (consensus → persist → auto-decision → order → fill → D-LEDGER) + đo DB thật bằng `scripts/review-sell-mechanism.ts` (read-only). Nguyên tắc Fixbug §5: không tin lời comment, chỉ tin phép đo.
> **Task 152 đã vá F-151-1 + F-151-2 và verify end-to-end F-151-3 — xem §4 cuối file.**

---

## 1. Điều kiện để lệnh BÁN được thực hiện (theo code)

Một lệnh bán phải vượt **6 lớp cổng nối tiếp** — tất cả đều phải đạt:

| # | Cổng | Điều kiện | Code |
|---|---|---|---|
| 1 | **Phiếu bầu 7 cử tri** | 5 agent nghiên cứu LLM (market-analyst · fair-value · news-sentiment · liquidity · macro-economist) + risk-manager + ml-forecast, mỗi phiếu hướng UP/DOWN/FLAT với trọng số `wᵢ = clamp(health/100 × bandit posterior, 0,3, 1)` | `bayes/synthesis.ts` computeConsensus |
| 2 | **Cổng đồng thuận 80%** | `S(d) = Σ wᵢ·[voteᵢ=d]`; `ratio = max S / Σ w`; **ratio ≥ 0,80 − 1e⁻⁹ → CONSENSUS**. Pool < 4 cử tri → fail-safe NO_CONSENSUS. 50–79,9% → WEAK_MAJORITY (ép GIỮ). **Enforcement đang BẬT từ 08/10** | `consensus.ts` |
| 3 | **Chủ tịch đề xuất SELL** | LLM Chủ tịch đọc assessment (tally + posterior + stance từng mã + VETO + hạn mức quant) → đề xuất tín hiệu `direction=SELL` kèm mã + targetPrice. Snapshot gate/ratio **bind vào tín hiệu lúc sinh** (không đánh giá lại) | `agents-run/persist.ts:255` |
| 4 | **VETO Ủy ban Kiểm soát** | Exposure VETO chỉ chặn MUA (**SELL được phép** — giảm phơi nhiễm); Compliance/controlUnavailable chặn CẢ SELL (fail-closed). VETO tối thượng, vượt cổng đồng thuận | `agents-run/persist.ts:220-236` |
| 5 | **Auto-decision (#91)** | Cuối chu kỳ: SELL + `gate=CONSENSUS` → **DUYỆT NGAY** (ACTED) + tạo lệnh giấy `nav5pct`; mọi trường hợp khác (HOLD · <80% · gate null) → TỪ CHỐI NGAY. Idempotent + claim atomic | `signal-execution.ts:893` |
| 6 | **Guard thực thi** | (a) phải có vị thế mở ≥ 100 cp của đúng mã — không có → từ chối, không treo lệnh; (b) khối lượng = min(5% NAV/giá, vị thế đang giữ) làm tròn lot 100; (c) giá LIMIT = max(targetPrice, 0,99×last) kẹp dải trần/sàn ±7%; (d) fill engine khớp khi giá chạm — đủ cp thì khớp (realized P&L + thuế bán 0,1% + phí 0,15%), thiếu cp → REJECT một lần (F-303) | `signal-execution.ts:512-533`, `market/tick/route.ts:264` |

Sau đó **D-LEDGER** tự chấm lại mỗi tín hiệu bán ngày sau: verdict WIN/LOSS/NEUTRAL ngưỡng ±0,5%, `markPnlPct` đảo dấu cho SELL (giá giảm sau tín hiệu → WIN).

## 2. Cơ chế có đang hoạt động đúng không? — Kết luận đo DB thật

### ✅ Hoạt động ĐÚNG (5 bằng chứng)

1. **Toán cổng đúng**: đo 3 chu kỳ gần nhất (20/10) — tally 7 cử tri, trọng số 0,45–0,61, dominant FLAT ratio 85,2% → gate CONSENSUS; chu kỳ 19/10 20:26 ratio 100% (7/7 FLAT). Công thức khớp tay tính.
2. **Enforcement sống**: `AppSetting consensus = {"enforce":true}` tự bật đúng hẹn 08/10 sau 10+ chu kỳ shadow (có `enforcedAt` audit).
3. **Tín hiệu SELL duy nhất qua cổng (FPT 10/10) xử lý đúng toàn quy trình**: đồng thuận DOWN 5/6 cử tri (83,3%) + stance SELL riêng của FPT (pDown 84,8%, dự báo −5,37%) → auto-DUYỆT đúng cơ chế #91 → lệnh giấy không đặt được (tài khoản paper 0 ₫ do trader purge) → tín hiệu vẫn đóng ACTED + audit `SIGNAL_AUTO_APPROVED` ghi rõ `orderCreated:false` + lý do — **đúng thiết kế "quyết định thuộc cổng, không phụ thuộc số dư"**.
4. **K1 sandbox cũng tôn trọng cổng**: `k-sandbox.ts:672` — auto-convert chỉ chạy khi `consensusGate === "CONSENSUS"`; audit K1_SANDBOX_AUTO_ORDER gần nhất (TCB BUY 19/10) xác nhận đường này sống.
5. **D-LEDGER trung thực**: cả 5 tín hiệu SELL lịch sử đều được chấm lại — **5/5 LOSS** (giá tăng sau tín hiệu bán, markPnl −0,52%…−4,00%) — vòng phản hồi ghi cả quyết định sai, không tô hồng.

### ⚠️ 2 phát hiện cần lưu ý (không phá vỡ, nhưng là kẽ thiết kế)

**F-151-1 (MEDIUM) — Gate đồng thuận KHÔNG kiểm tra hướng số đông khớp hướng tín hiệu.**
Gate chỉ yêu cầu "tồn tại đồng thuận ≥80% ở MỘT hướng nào đó" — kể cả **FLAT**. Trạng thái hiện tại là ví dụ sống: 6/7 cử tri FLAT → dominant FLAT 85,2% → gate=CONSENSUS. Nếu Chủ tịch lúc này đề xuất SELL (hoặc BUY) thì auto-decision **duyệt ngay** — dù hội đồng đồng thuận "đi ngang", không phải "giảm". Sự ràng buộc hướng hiện chỉ là **advisory** qua prompt ("nếu posterior đạt stance") + thói quen LLM Chủ tịch; không có guard cứng. Trường hợp FPT trùng hướng chỉ vì số đông hôm đó là DOWN.
→ **Đề xuất sửa**: thêm 1 dòng trong `autoDecideSignalByConsensus` + `persistSignalAndExecution`: tín hiệu SELL chỉ qua cổng khi `dominant === "DOWN"` (BUY ↔ UP), hoặc tối thiểu `dominant !== "FLAT"`. Kèm test hermetic.

**F-151-2 (LOW) — Tín hiệu SELL không lưu stopLoss/takeProfit.**
`persist.ts:250-251`: `stopLoss/takeProfit` chỉ ghi cho BUY. Hệ quả: Kelly hint tham mưu cho SELL yếu đi (thiếu mốc cắt lỗ), và không thể hậu kiểm "đáng lẽ chặn lỗ ở đâu" cho quyết định bán. Bán không có stop-loss cũng đúng bản chất (vị thế gốc thuộc BUY), nhưng lời khuyên quản trị rủi ro một chiều là khoảng trống nhỏ.

**F-151-3 (QUAN SÁT) — Con đường bán chưa từng thực thi trọn vẹn trong production.**
Toàn sổ: **0 lệnh SELL từng được đặt** (chỉ BUY/FILLED = 9, toàn bộ thuộc thế giới sandbox). Nguyên nhân: (a) thế giới paper — tài khoản 0 ₫ + 0 vị thế → equity = 0 → không định cỡ được; (b) thế giới sandbox — vị thế đang giữ là VIC/VPB/TCB, chưa có tín hiệu SELL đồng thuận nào rơi đúng các mã này. Tức là **cơ chế sẵn sàng nhưng chưa từng chạy hết đường ray ở môi trường thật** (fill engine nhánh SELL — F-303, realized P&L, thuế 0,1%, đóng vị thế — chỉ được cover bởi test tự động, chưa từng exercise trên dữ liệu production).

### Số liệu nền (đo 20/10/2026)

- 59 tín hiệu: BUY=17 · **SELL=5** · HOLD=37 → SELL hiếm (8,5%) — hợp lý vì 5 phiên gần đây council nghiêng FLAT/DOWN nhẹ
- SELL theo gate: CONSENSUS=1 (FPT 83,3%) · null=4 (dữ liệu trước B9 — 3 EXPIRED + 1 ACTED thời duyệt tay)
- Auto-decision: 10 APPROVED (1 SELL) · 13 REJECTED (0 SELL — các SELL không-đồng thuận sinh trước #91 nên chỉ EXPIRED)
- VETO hạ HOLD: 0 lần trong lịch sử
- Tài khoản: paper cash 0 ₫ · sandbox cash 48,9M + 1.000 cp (VIC 100 · VPB 200 · TCB 700)

## 3. Câu hỏi kèm theo — lõi miễn phí z.ai trong sandbox

Đã đo trực tiếp `z-ai-web-dev-sdk` với 8 tên model (`glm-4.6`, `glm-4.6-flash`, `glm-5.3-flash`, `glm-5`, `glm-5.3`, `glm-4.5-flash`, `glm-4.5-air`…):

- **Mọi tên model đều được phục vụ bởi CÙNG một lõi** — response trả `model: "glm-4-plus"` ở cả 8 trường hợp. Tham số `model` bị gateway bỏ qua: gọi "glm-5.3-flash" vẫn silently nhận GLM-4.6.
- → **GLM 5.3 Flash KHÔNG có thật trong sandbox z.ai này.** Lõi chat duy nhất: **GLM-4.6** (glm-4-plus nội bộ), miễn phí theo sandbox.
- Năng lực riêng khác của SDK (endpoint khác, không phải lõi chat): **glm-5v-turbo** (VLM nhìn ảnh — đã dùng chấm verify CV), TTS, ASR, image-generation.
- Danh sách **model free** (`glm-5.3-flash-free`, `nemotron-3.5-lightning-free`, `deepseek-v4.1-flash-free`…) thuộc **Zen gateway** (`https://opencode.ai/zen/v1` — provider opencode-zen). **Cập nhật Task 152 (đo bằng key oc_sk thật):** gateway đang liệt kê 44 model, CÓ `glm-5.3-flash` + `glm-5.3-flash-free`; key xác thực hợp lệ nhưng **paid → 402 "Insufficient account funds"** (hết credit), **free → 403 "free tier can only be used from within OpenCode"** với curl thô, và qua CLI OpenCode trong sandbox thì bị **chặn tầng IP** ("abusive traffic from this IP") — không dùng được từ sandbox này. GLM-5.3-flash mà các app CRM/TMO dùng là qua gateway bên ngoài (OpenRouter/Zen có credit), không phải sandbox z.ai.

---

## 4. Task 152 (20/10/2026) — VÁ F-151-1 · F-151-2 + VERIFY E2E F-151-3

**F-151-1 (MEDIUM) — ĐÃ VÁ (4 tầng guard, defense-in-depth):**

| Tầng | File | Cơ chế |
|---|---|---|
| Sinh tín hiệu | `agents-run/persist.ts` | Bind thêm `consensusDominant` (cột mới schema Signal) vào snapshot B9 |
| Auto-decision #91 | `signal-execution.ts` autoDecideSignalByConsensus | Duyệt chỉ khi `dominant` khớp hướng (SELL↔DOWN · BUY↔UP); lệch → TỪ CHỐI + audit `consensus-direction-mismatch`; thiếu snapshot → fail-safe `missing-dominant-snapshot` |
| Chốt lệnh (hội tụ 3 đường: auto #91 · duyệt tay · K1) | `signal-execution.ts` createPaperOrderFromSignal | 409 "chặn hướng" khi gate CONSENSUS nhưng dominant lệch/null (chỉ khi enforce=true, đồng bộ khối B9 cũ) |
| K1 sandbox | `k-sandbox.ts` autoConvertSignalToSandbox | Skip có lý do `huong-so-dong-khong-khop-{FLAT/null}` |

`computeConsensus` (bayes/synthesis.ts) giờ trả `dominant` ra snapshot; UI chip đồng thuận hiển thị luôn hướng ("Đồng thuận 85,2% · giảm").

**F-151-2 (LOW) — ĐÃ VÁ:** `persist.ts` lưu `stopLoss/takeProfit` cho cả MUA lẫn BÁN (SELL = mốc của chính quyết định bán; Kelly hint vốn đã dùng).

**F-151-3 (QUAN SÁT) — ĐÃ VERIFY E2E:** `scripts/p152-sell-e2e-verify.ts` — hermetic trên schema Postgres scratch `p152e2e` (cùng DB Supabase, cách ly tuyệt đối, dọn sạch sau chạy): **23/23 PASS** — synth tín hiệu SELL đồng thuận DOWN → auto-duyệt → lệnh LIMIT 200cp @29.700 (nav5pct · cap vị thế · kẹp dải ±7%) → fill engine khớp (fee 8.910/thuế 5.940/realized +340.000/cash 105.925.150/audit ORDER_FILLED/equity) → 5 guard hướng đều chặn đúng (FLAT · BUY-ngược · null · K1-skip · manual-409). Đường bán CHÍNH THỨC đã chạy hết ray trong môi trường kiểm soát.

*Điều phối chạy lại: CREATE SCHEMA p152e2e → `DATABASE_URL=<url>?schema=p152e2e bunx prisma db push --skip-generate` → `DATABASE_URL=<url>?schema=p152e2e bun scripts/p152-sell-e2e-verify.ts` → DROP SCHEMA CASCADE.*

---

*Task 151 · read-only review · script `scripts/review-sell-mechanism.ts` + output `scripts/review-sell-output.txt`
*Task 152 · fix + E2E · `scripts/p152-sell-e2e-verify.ts` · 0 dòng hành vi cũ bị đổi ngoài guard hướng + stop/take SELL*

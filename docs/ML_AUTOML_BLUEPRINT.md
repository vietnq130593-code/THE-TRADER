# ML AUTOML BLUEPRINT — L1 DETERMINISTIC SWEEP CONTROLLER + TÍNH NĂNG HOÁ ĐẦU VÀO TIN TỨC

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/ML_AUTOML_BLUEPRINT.md` · **Version:** 1.0 · **Created:** 2026-10-12 (phiên #98 — xây theo chỉ đạo của trader: *"Tiến hành xây dựng blueprint trước cho tôi… Dựa vào các thắc mắc của tôi có thể tiếp tục nâng cấp, bổ sung cho blueprint nếu cần thiết"*)
> **Status:** **DỰ THẢO — CHỜ TRADER DUYỆT ĐỊNH HƯỚNG (chưa triển khai dòng code nào)**
> **Nguồn gốc:** Kiểm toán kiến trúc #97 (phán quyết **LEVEL 0 — Static ANN** trưởng thành · L1 ~30% hương vị · L2/L3 0%) + 6 câu hỏi kiểm kê của trader phiên #98 (hàm thưởng · hàm mất mát · Keras · lan truyền tiến/ngược · tin tức trong DB · tin tức → học quy luật).
> **Cross-refs:** [ML_OPS_BLUEPRINT.md](./ML_OPS_BLUEPRINT.md) v1.4 (cổng B2 · serving-swap guard · A4 retrain) · [ML_LEARNING_BLUEPRINT.md](./ML_LEARNING_BLUEPRINT.md) v1.1.0 (L1 BM25 RAG) · [DATA_PLATFORM_BLUEPRINT.md](./DATA_PLATFORM_BLUEPRINT.md) (FeatureContract P0-3 · PIT P1-2) · [MARKET_EXPANSION_BLUEPRINT.md](./MARKET_EXPANSION_BLUEPRINT.md) (B7/B8/B9) · [DB_SCHEMA.md](./DB_SCHEMA.md) v0.9.1 · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) v1.8.2 · `worklog.md` Task ID 97 (audit đầy đủ)
> **Người soạn:** Kiến trúc sư AI / System & Architecture Auditor (phiên #98)

---

## §0. Kiểm kê bằng chứng — trả lời 6 câu hỏi của trader (đo trực tiếp 2026-10-12)

> Mọi kết luận dưới đây đều có `file:dòng` hoặc truy vấn DB sống kèm theo (chuẩn pgbouncer, cùng quy tắc mọi phiên). **Không suy đoán.**

### 0.1 Bảng trả lời nhanh

| # | Câu hỏi | Trả lời | Bằng chứng chính |
|---|---|---|---|
| 1 | Có hàm thưởng không? | **CÓ — 2 vòng reward thật** | `ml/rl.ts:198` (Q-learning) · `ml/bandit.ts` (Thompson) |
| 2 | Có hàm mất mát không? | **CÓ — Cross-entropy class-weighted + L2** | `ml/nn.ts:337-522` · `ml/gru.ts` |
| 3 | Dùng Keras triển khai đạo hàm backprop? | **KHÔNG — 0 thư viện ML, đạo hàm VIẾT TAY** | `package.json` (0 dep ML) · `nn.ts:198-207` · `nn.ts:427-455` |
| 4 | Lan truyền tiến thì sao? | **CŨNG VIẾT TAY** — matmul Float64Array + softmax ổn định | `nn.ts:298-327` · `gru.ts` (3 cổng z/r/h) |
| 5 | DB có dữ liệu bài báo hằng ngày không? | **CÓ — NewsItem, 5 nguồn RSS VN, nạp 15 phút/lần** | `prisma/schema.prisma:590-604` · `lib/news.ts:18-24` · engine `NEWS_MS` |
| 6 | Tin tức có thành thông tin giá trị / học được quy luật? | **CÓ 4 đường tiêu thụ, NHƯNG CHƯA vào đặc trưng ML** (gap → hạng mục C2 blueprint này) | §0.6–§0.8 dưới đây |

### 0.2 Hàm thưởng (reward) — 2 vòng, đều thật và đang chạy

**Vòng 1 — Q-learning exposure** (`ml/rl.ts:198`, epsilon-greedy 1,0→0,05, 300 episode × ~230 bước):

```text
reward(t) = exposure(t) × ret(t+1) − 0,001 × |Δexposure|
           (lãi/phơi nhiễm)        (phạt đảo lệnh)
Q[s,a] ← Q[s,a] + α·(r + γ·max Q[s′] − Q[s,a])   với α=0,1 · γ=0,95
```

State 48 = xu hướng(2) × RSI-bucket(4) × mom5(2) × phơi nhiễm(3); action 3 = giảm/hold/tăng exposure ±0,5 (clamp 0..1). Serving rl-q v3 (10-11), stance hiện tại có đọc bằng `policyStance()`.

**Vòng 2 — Thompson sampling 6 arm** (`ml/bandit.ts`, Beta-Bernoulli conjugate):

```text
reward = 1   nếu vote đúng hướng realized rổ top-10 sau 5 phiên (±0,5%)
       = 0   nếu sai hướng
       = 0,7 vote FLAT & realized FLAT · 0,2 vote FLAT & realized khác
alpha += reward · beta += (1 − reward)   → posterior Beta(α+1, β+1)
```

6 arm = 5 agent LLM nghiên cứu + ml-forecast. **Vòng này chưa từng đóng** (BanditEvent=0, 6 arm toàn Beta(1,1) pulls=0 — đo DB #97/#98) vì assessment đầu tiên chỉ mới 3 phiên tuổi khi DB reset; phiếu chín đầu tiên rơi vào **2026-10-13** nếu settle chạy đúng lịch A1 16:15 ICT.

### 0.3 Hàm mất mát (loss) — Cross-entropy có trọng số lớp + L2

`ml/nn.ts:337-522` (MLP) và `ml/gru.ts` (GRU, cùng phong cách):

```text
L = −Σ class-weight w_c × log p(y)      với w_c = (N/3)/N_c × lossWeights[c]
                                          (1/tần suất × trọng số từng đầu ra
                                           [DOWN·FLAT·UP] do trader đặt 0,1–10)
L2: + l2 × ||W||²   áp CHỈ lên W, không áp bias (nn.ts:467-469)
valLoss KHÔNG class-weight — so epoch↔epoch công bằng (early-stop patience 12)
```

Đây là loss **đa đầu ra có trọng số** (3 class DOWN/FLAT/UP) — nhưng là *hằng số người đặt*, không phải adaptive multi-task loss của HyperNAS (mức L3, đã loại ở audit #97).

### 0.4 Keras / đạo hàm / lan truyền ngược — KHÔNG dùng thư viện, viết tay 100%

- `package.json` của The Trader: **0 dependency ML ngoài stack** (chỉ Next/React/Prisma/Radix/TanStack/Zustand/socket.io/z-ai-sdk). Quét `keras|tensorflow|pytorch|torch|synaptic|brain.js|onnx` trên package.json + bun.lock: **0 match**.
- **Đạo hàm activation viết tay** — `nn.ts:198-207` `actDerivFromOut(kind, a)` tính đạo hàm TỪ GIÁ TRỊ SAU kích hoạt (không cần giữ z): `relu: a>0?1:0 · tanh: 1−a² · sigmoid: a(1−a)`.
- **Gradient CE lớp ra viết tay** — `nn.ts:423`: `dzOut[c] = (p[c] − 1[y=c]) × w_class / batchSize` (đích thị ∂CE/∂z của softmax+CE).
- **Chuỗi lan truyền ngược viết tay** — `nn.ts:427-455`: delta truyền từ khối ra về từng lớp ẩn, nhân đạo hàm activation, cộng dồn gradient W/b.
- **Adam viết tay** — `nn.ts:458-474`: β1 0,9 · β2 0,999 · ε 1e-8, bias-correction `lrT` đầy đủ.
- **Kiểm chứng bằng gradient check** (phiên #81, worklog): finite-difference 60 vị trí × 13 khối tham số GRU-BPTT → sai số tương đối tối đa **2,1e-6** (khớp giải tích ≥ 4 chữ số). Đạo hàm viết tay ĐÚNG, có bằng chứng số.

### 0.5 Lan truyền tiến — cũng viết tay

- `nn.ts:298-327` `forward()`: vòng lặp matmul trên `Float64Array` phẳng row-major (không alloc trong loop khi train), activation từng lớp, khối ra **softmax ổn định số học** (trừ max trước mũ hoá — `nn.ts:169-180`).
- `gru.ts`: forward GRU 3 cổng (z update · r reset · h) viết tay trên window 20 phiên × 16 chiều, dropout input 0,2 chỉ khi train.
- Cùng một implementation forward phục vụ cả train và serving (`predictProba` — tự áp z-score norm nhúng trong weights JSON). Không có runtime AI inference nào của bên thứ ba.

### 0.6 Tin tức thị trường trong DB — CÓ, nạp tự động 15 phút/lần

Bảng `NewsItem` (`prisma/schema.prisma:590-604`): `title · summary · url (@unique — dedupe) · source · sourceUrl · category · publishedAt · fetchedAt · createdAt` + 2 index (publishedAt desc · source+publishedAt).

Crawler RSS 5 nguồn Việt Nam (`lib/news.ts:18-24`, chạy trong engine `NEWS_MS` = 15 phút, max 10 tin/feed/lần, timeout 8s/feed, rate-limit route 60s, reliability per-feed tích luỹ P2-2/#62):

| Nguồn | Feed | Category | Số tin đo 10-12 |
|---|---|---|---|
| CafeF | `cafef.vn/thi-truong-chung-khoan.rss` | market | 16 |
| VNExpress | `vnexpress.net/rss/kinh-doanh.rss` | macro | 13 |
| VietnamNet | `vietnamnet.vn/rss/kinh-doanh.rss` | macro | 13 |
| Tuổi Trẻ | `tuoitre.vn/rss/kinh-doanh.rss` | macro | 12 |
| VnEconomy | `vneconomy.vn/thi-truong.rss` | market | 10 |

Tổng **64 tin** (đo 2026-10-12 ICT), khoảng `2026-10-09 → 2026-10-11`, 50 tin trong 24h gần nhất. **Kiểu tin theo lĩnh vực hiện có 2 nhóm:** `market` (thị trường chứng khoán — 26 tin) và `macro` (kinh doanh/vĩ mô — 38 tin). Nit nhỏ: comment schema ghi nguồn thứ 5 là "Seed" nhưng feed thật là VietnamNet (`news.ts:23`) — vô hại, nên đồng bộ khi có dịp sửa schema.

### 0.7 Tin tức → thông tin có giá trị — 4 đường, ĐỀU ĐANG SỐNG

1. **Agent LLM `news-sentiment` (A4, cử tri Hội đồng Nghiên cứu):** prompt chứa 10 tin mới nhất (`agent-context.ts:276-289` buildNewsBlock — kèm nguồn + độ tuổi tin) → agent chấm bullish/bearish/neutral + confidence → **phiếu bầu 1 trong 6 cử tri** vào tổng hợp Bayes đồng thuận 80%.
2. **Bằng chứng quant lexicon tiếng Việt** (`bayes/evidence.ts:149-166` × `quant/sentiment.ts`): từ điển polarity tài chính VN **~75 thuật ngữ** (n-gram 3→2→1 ưu tiên cụm dài, xử lý phủ định "không tăng"→âm) chấm toàn bộ tin 24h → score ∈ [−1,1] → block bằng chứng định lượng `news-lexicon` vào Bayes kèm ghi chú trung thực ("Lexicon N tin 24h: score…").
3. **RAG BM25 (L1 #83 — ML_LEARNING_BLUEPRINT):** NewsItem nằm trong corpus truy hồi (~≤700 docs, cùng AgentMessage broadcast) — tin CŨ cũng truy hồi được theo liên quan khi agent nghiên cứu chạy → tiêm top-K vào prompt 5 agent nghiên cứu + Chủ tịch. `RetrievalLog` ghi lại 14 lần truy hồi (đo #98), có cờ `usedInPrompt`.
4. **Vòng phản hồi tin cậy (bandit):** phiếu của arm `news-sentiment` (và 5 arm kia) được **settle reward sau 5 phiên thật** — và posterior ĐÃ ĐƯỢC NỐI THẲNG VÀO TRỌNG SỐ PHIẾU BẦU: `bayes/evidence.ts:229-264` đọc `BanditArm`, `posteriorByCode` nhân vào `voteWeight` (*"agent bầu đúng hướng giá thực tế nhiều → posteriorMean cao → tin hơn"*). Nghĩa là: **hệ thống TỰ HỌC độ tin cậy của nguồn tin tức** — agent tin tức dự báo sai sẽ bị hạ trọng số phiếu tự động. Hiện toàn arm Beta(1,1)→0,5 trung tính, chờ settle chín đầu tiên 10-13 (§6 C3).

### 0.8 GAP duy nhất phát hiện — tin tức CHƯA vào bộ đặc trưng học sâu

16 đặc trưng v2-lag16 (`ml/psi.ts:102-120`) toàn **giá/khối lượng kỹ thuật**: RSI14, MACD-hist, logret 1/5/10, SMA20/50, giá/SMA20, z-score KL, độ lệch ret20, giá/đỉnh60 + 6 chiều lag/đạo hàm. **Không một chiều nào sinh từ NewsItem.**

→ Tin tức hiện chỉ đến được *quyết định* qua vòng LLM/Bayes/RAG (0.7) — chưa bao giờ đến được *mạng học* (MLP/GRU/Q-learning). Nói cách khác: tri thức tin tức là **gợi ý lúc ra quyết định**, chưa phải **quy luật đã học từ dữ liệu**. Đây chính là khoảng trống hạng mục **C2** của blueprint này (§5) — sinh trực tiếp từ câu hỏi của trader: *"có thể học về quy luật thị trường trong database không"*.

---

## §1. Phán quyết cấp độ & động lực leo cấp (tóm tắt audit #97)

| Cấp | Điểm | Ghi chú |
|---|---|---|
| **L0 Static ANN** | ✅ 100% — "L0 done right" | PIT windowHash · time-split · deterministic · champion/challenger · PSI · Wilson · Brier · kill-switch |
| L1 NAS/RL | ~30% hương vị | RL/bandit ở TẦNG NHIỆM VỤ (exposure, trust, risk) — **0 controller sinh cấu hình**; "NAS" hiện là THỦ CÔNG bởi trader qua editor #94 |
| L2 One-Shot | 0% | Không supernet/weight-sharing — chứng minh DB: 4 bản train cùng windowHash ra valAcc 0.395 IDENTICAL |
| L3 HyperNAS | 0% | Không H(z) · không graph encoder · không surrogate zero-shot · lossWeights hằng số |

**Động lực leo cấp hợp lệ ngay bây giờ (từ audit):** hạ tầng cho L1 đã có sẵn toàn bộ — (i) không gian arch tham số hoá + editor UI = *search space* hoàn chỉnh; (ii) serving-swap guard valAcc + Brier paired bootstrap = *evaluator*; (iii) chu kỳ engine 60s + lịch A4 Chủ nhật = *hạ tầng lập lịch*; (iv) mỗi ứng viên train chỉ ~12s (đo #60) → budget sweep 20 ứng viên ≈ 4 phút, rẻ. Thiếu duy nhất: **controller** — và controller L1 deterministic KHÔNG phá 2 nguyên tắc bất biến đang bảo vệ hệ thống (§2).

L2/L3 **chưa đủ dữ liệu nuôi**: 60k mẫu EOD một độ phân giải NGÀY, autocorr lag-1 vắt 0 (đo B2: CI [−0,017; +0,037]) — mở L2/L3 phải chờ dòng intraday 5-phút (`IntradayBar` đã thu từ #83) tích luỹ. Không đề xuất trong blueprint này ngoài ghi cổng §7.

---

## §2. Nguyên tắc bất biến (kế thừa 8 nguyên tắc ML_OPS §1 + 3 nguyên tắc mới)

Kế thừa nguyên văn: **(1)** PIT tuyệt đối · **(2)** time-split 80/20 theo thời gian · **(3)** deterministic seed · **(4)** không bịa chất lượng (kèm n + CI) · **(5)** serving chỉ khi thắng baseline · **(6)** fail-soft + kill-switch · **(7)** viết tay TypeScript thuần 0 dependency · **(8)** cổng bằng chứng đo được.

Mới cho AutoML L1:

9. **Sweep phải deterministic và có budget trần** — cùng seed + cùng windowHash → cùng danh sách ứng viên, cùng thứ tự, cùng kết quả. Budget ứng viên/đợt là số nguyên nhỏ (mặc định 16), không vòng lặp vô hạn, không "tìm kiếm đến khi thắng" (chống p-hacking chọn val).
10. **Champion board công khai toàn bộ** — mọi ứng viên đã đánh giá (kể cả thua) đều lưu hàng MlModel kèm meta `sweepRunId` + hiển thị trên UI; không có ứng viên nào bị bỏ âm thầm. Người đánh giá cuối cùng của kiến trúc vẫn là **cổng bằng chứng**, không phải bảng xếp hạng.
11. **Đặc trưng tin tức (C2) phải PIT tuyệt đối** — chỉ dùng tin `publishedAt ≤ 15:45 ICT` của phiên T cho đặc trưng gắn mẫu phiên **T+1** trở đi (cùng chuẩn "không nhìn tương lai" của Bar EOD); không backfill tin giả sử; cổng dữ liệu ≥ 60 phiên có tin trước khi train.

---

## §3. Hạng mục C0 — MỞ KẸT ML-GATE COLD-START [AUD-97-F1] (TIỀN ĐỀ TUYỆT ĐỐI)

**Vấn đề (đo #97):** DB hiện không có bản dl-mlp serving nào (v1–v4 toàn archived) → `mlForecastEnsemble` đang fallback linreg thuần (cử tri ml-forecast mất giọng MLP). Cơ chế kẹt 2 tầng:

```text
(1) AppSetting "ml-gate" không tồn tại (mất khi đổi DB) → gateVerdictOf() = null
(2) Không có serving row → featureSetOf(null) = "v1-lag10" ≠ "v2-lag16" → sameSet = false
→ promoted = beatsValAcc && (sameSet || PASS) = false VĨNH VIỄN cho mọi bản lag16 mới
→ scripts/ml-evidence-gate.ts cần baseline lag10 cùng windowHash — DB không còn bản lag10 nào
```

**Phương án (đề xuất hybrid — trader chọn ở §9 Q1):**

| Hướng | Việc | Ưu | Nhược |
|---|---|---|---|
| **(c) vá code** | Train route: khi `serving == null` → bỏ ràng buộc featureSet (đúng lại doc comment sẵn có *"Không có bản serving trước đó → promote"*) | Triệt để, tự chữa cho mọi DB sạch tương lai, 1 nhánh if | Chạm code đã qua fixbug |
| **(a) re-baseline gate** | Train 1 bản lag10 twin trên windowHash hiện tại → chạy `ml-evidence-gate.ts` đo thật → ghi AppSetting ml-gate verdict | Đúng quy trình cổng nhất, có số liệu B2 mới cho lag16 trên cửa sổ hiện tại | +1 lần train lag10 chỉ để làm baseline |
| **(b) admin promote** | Đưa thẳng v4 lên serving (valAcc 39,5% > baseline ngẫu nhiên 33% — nguyên tắc §1.5 thoả) | Nhanh nhất (1 câu SQL) | Bỏ qua cổng — mâu thuẫn văn hoá bằng chứng |

**Khuyến nghị của người soạn: (c) + (a) làm một đợt** — vá nhánh `serving==null` (chữa vĩnh viễn cold-start) rồi chạy lại gate có baseline mới để verdict ml-gate phản ánh đúng cửa sổ dữ liệu hiện tại. (b) chỉ dùng nếu trader muốn giọng MLP quay lại serving ngay trong hôm nay.

**Nghiệm thu C0:** (i) có ≥ 1 bản dl-mlp status=serving trên DB; (ii) `mlForecastEnsemble` trả `modelVersion ≠ null`; (iii) tái sinh kịch bản DB sạch (xoá MlModel + ml-gate) → train 1 lần → bản đầu TIÊN lên serving được (không kẹt); (iv) gate verdict mới có measuredAt; (v) chu kỳ agent + E2E 0 lỗi console.

---

## §4. Hạng mục C1 — L1 DETERMINISTIC SWEEP CONTROLLER ("NAS-Lite" có kỷ luật)

### 4.1 Mục tiêu & không phải gì

**LÀ:** một controller chạy đợt (sweep run) chọn N ứng viên kiến trúc+hyper từ không gian editor #94 theo **dãy deterministic có seed**, train tuần tự từng ứng viên (~12s), đánh giá trên cùng windowHash, xếp champion board, và **chỉ đề xuất** champion cho serving-swap guard hiện có.

**KHÔNG PHẢI:** RL controller (không policy gradient, không ε-greedy trên không gian arch — không phá deterministic); không train song song vô hạn; không tự đổi mô hình serving trực tiếp (vẫn qua cổng valAcc/Brier như luật §1.5 hiện hành); không thêm dependency.

### 4.2 Không gian tìm kiếm (chính là editor #94 — một nguồn)

| Nhóm | Biến | Phạm vi | Ghi chú |
|---|---|---|---|
| Kiến trúc | `hidden[]` | 1..5 lớp × 2..96 nơ-rôn | guard sẵn `MLP_ARCH_LIMITS` |
| Kiến trúc | `activations[]` | relu \| tanh \| sigmoid từng lớp | |
| Loss | `lossWeights[3]` | 0,1..10 mỗi đầu ra [DOWN·FLAT·UP] | |
| Hyper | `epochs · patience · batchSize · lr · l2 · valFraction · seed` | đúng phạm vi `MLP_TUNING_FIELDS` | seed sweep riêng (mặc định 20261012) |

Quy mô tổ hợp ~10⁵–10⁶ → controller KHÔNG dò toàn bộ; dùng **chiến lược 2 giai đoạn**:

- **Giai đoạn coarse (12 ứng viên):** lưới thô tiêu biểu — arch hạt nhân {16-[24,12]-3, 16-[32,16]-3, 16-[48,24,12]-3, 16-[16]-3, 16-[64,32,16,8]-3, 16-[12,8]-3} × activation {relu, relu-tanh} + hyper mặc định. Mục đích: tìm *vùng topo* tốt.
- **Giai đoạn refine (4 ứng viên):** quanh top-2 coarse — mở/rút 1 lớp ±8 nơ-rôn, thử lossWeights lệch (UP nặng hơn), lr ×0,5/×2.

Dãy ứng viên sinh bằng **quy tắc cố định từ seed** (mulberry32 — same seed ⇒ same dãy ⇒ same kết quả, nguyên tắc §2.9). Tổng ≤ 16 ứng viên × ~12s ≈ **~4 phút/đợt** + chi phí lưu hàng.

### 4.3 Evaluator (tái sử dụng 100% hạ tầng có sẵn)

Mỗi ứng viên chạy đúng đường `trainDlMlp` hiện tại (cut 80/20 theo thời gian, early-stop valLoss) rồi chấm:

```text
score(ứng viên) = valAcc
                  − 0,0002 × max(0, paramCount − 2.000)/100    (phạt quá tham số hoá)
                  + 0,01 × I[Brier_val ≤ Brier_serving]         (kèm Brier — B8)
```

- **Brier paired bootstrap** (tái sử dụng `ml-evidence-gate.ts`) giữa champion và serving trên cùng val block → CI 95% — dùng cho **cổng quyết định**, không cho xếp hạng.
- Mọi ứng viên lưu `MlModel kind "dl-mlp", meta.sweepRunId, status "archived"` — **không đụng serving** trong lúc sweep.

### 4.4 Cổng quyết định champion (nguyên tắc §1.5 mở rộng)

Champion của đợt chỉ được **đề xuất swap** khi thoả MỌI điều kiện:

1. `valAcc_champion ≥ valAcc_serving + δ` với **δ = 0,01** (1 điểm % — vượt hẳn ngoài nhiễu 60k mẫu; kèm Wilson CI cho tỉ lệ — A2);
2. ΔBrier CI 95% hoàn toàn < 0 (bootstrap 1.000× — cùng phương pháp cổng B2);
3. `paramCount ≤ 2× paramCount_serving` (chống "thắng vì to");
4. Ban đầu khi cùng windowHash với đợt trước: skip-guard như A4 (không sweep lại khi không có bar mới).

Không thoả → champion nằm lại bảng với nhãn *"không đủ vượt cổng"* — trung thực, không ép.

### 4.5 Lưu trữ & hiển thị (schema additive — 1 model + 1 AppSetting)

```prisma
model SweepRun {
  id            String    @id @default(cuid())
  startedAt     DateTime  @default(now())
  finishedAt    DateTime?
  windowHash    String    // cùng chuẩn MlModel.meta
  candidates    Int       // số ứng viên ngân sách
  evaluated     Int       // số ứng viên đã train xong
  seed          Int       // seed dãy ứng viên — deterministic
  status        String    // running | done | failed | skipped
  championJson  String?   // {arch, activations, lossWeights, hyper, valAcc, brier, paramCount, swapProposed, reason}
  logJson       String?   // [{i, arch, activations, valAcc, valLoss, brier, params, ms, error?}] toàn bộ ứng viên
}
```

- `AppSetting "ml-sweep"`: `{enabled, budgetCandidates, seed, deltaSwap, maxParamFactor, lastRunAt}` — kill-switch từng đợt như mọi AppSetting khác (§1.6).
- **UI:** tab mới **"Tự động tìm kiếm"** trong module Học máy (#89): champion board (bảng `logJson` — mọi ứng viên kèm valAcc/Brier/tham số/thời gian), cấu hình budget + công tắc, lịch sử các đợt (SweepRun), giải thích công khai công thức score + 4 điều kiện cổng. Không có nút "áp dụng ngay" vượt cổng.

### 4.6 Lịch chạy & fail-soft

- Engine thêm lịch **`SWEEP_AT` = Chủ nhật 04:15 ICT** (sau A4 retrain 04:00 — sweep chỉ chạy khi có windowHash mới, skip-guard dùng chung).
- Budget trần thời gian: quá 20 phút giữa chừng → dừng an toàn, status "failed" + logJson giữ những ứng viên đã xong (không rollback gì).
- Fail-soft tuyệt đối: sweep lỗi không chạm chu kỳ agent, không chạm serving, không chạm retrain A4.

### 4.7 Nghiệm thu C1 (định trước)

1. Deterministic: chạy 2 đợt cùng windowHash + cùng seed → 2 logJson IDENTICAL (từng số).
2. Budget: đợt thử nghiệm 16 ứng viên ≤ 6 phút thực đo; quá giờ → cắt an toàn.
3. Cổng: cài kịch bản champion thua δ → KHÔNG swap, bản serving nguyên vẹn, UI nhãn đúng lý do.
4. Bit-flip: tắt `ml-sweep.enabled` → toàn bộ nhánh sweep im, A4 + chu kỳ agent kết quả cũ 100%.
5. Hermetic: script verify (pattern `ml-arch-verify.ts`) — sinh dãy ứng viên từ seed, kiểm guard phạm vi, kiểm score + 4 điều kiện cổng bằng số dựng sẵn; ≥ 12 test.

---

## §5. Hạng mục C2 — NEWS-TO-FEATURE PIPELINE (tin tức → đặc trưng mạng học được)

> Sinh trực tiếp từ câu hỏi trader §0.8: biến NewsItem thành *bằng chứng học được* chứ không chỉ *gợi ý lúc ra quyết định*.

### 5.1 Rào chắn dữ liệu — nói thật trước khi thiết kế

RSS chỉ thu **tức thời** (bắt đầu từ khi hệ thống chạy) — không có lịch sử backfill. Hiện chỉ 64 tin / 3 ngày. Muốn train đặc trưng tin tức cần **≥ 60 phiên giao dịch có tin tích luỹ** (~3 tháng chạy liên tục) — đó là cổng dữ liệu C2 (§7). Không mua dữ liệu, không bịa backfill (nguyên tắc §2.11). Trong thời gian chờ, pipeline có thể dựng + đo coverage lexicon trên 64 tin sẵn có (không train).

### 5.2 Thiết kế đặc trưng — bộ `v3-news22` (16 hiện có + 6 chiều mới)

Tất cả tính từ NewsItem **PIT-strict**: chỉ tin `publishedAt ≤ 15:45 ICT phiên T`, gắn đặc trưng cho mẫu phiên **T+1** trở đi:

| # | Đặc trưng | Công thức | Ý nghĩa |
|---|---|---|---|
| x[16] | `newsSent24h` | lexicon score trung bình tin 24h tới phiên T | cảm tính tin tức tổng hợp |
| x[17] | `newsVol24h` | `log(1 + số tin 24h)` | "độ nóng" truyền thông |
| x[18] | `newsSent5d` | score trung bình trượt 5 phiên | cảm tính bền |
| x[19] | `newsBuzzΔ` | `vol24h − mean(vol5d)` / (std+ε) | bùng nổ đột biến lượng tin |
| x[20] | `newsMacroRatio` | tỉ lệ tin macro / tổng (24h) | chế độ tin vĩ mô vs thị trường |
| x[21] | `newsExtreme` | max \|score từng tin\| 24h | sự kiện cực đoan (dù ít tin) |

- Lexicon dùng lại `quant/sentiment.ts` (~75 thuật ngữ) — đo coverage trên corpus thật, chỉ mở rộng từ điển khi coverage < 60% tiêu đề có ≥1 hit.
- Feature contract mở đúng kiểu B1: 16 chiều đầu GIỮ NGUYÊN thứ tự (bản serving v2 đọc x[0..15] như cũ), 6 chiều mới nối cuối — tương thích ngược.

### 5.3 Cổng bằng chứng B2-style (tái sử dụng nguyên phương pháp)

- `scripts/ml-news-gate.ts`: **rank-IC Spearman** từng chiều mới (x[16..21]) trên val block + **ΔBrier paired bootstrap 1.000×** (v3-news22 vs v2-lag16 cùng windowHash, cluster theo mã) → verdict `AppSetting "ml-gate-news"` PASS/FAIL — cùng ngữ nghĩa ml-gate hiện có.
- FAIL → giữ serving v2-lag16, đặc trưng news nằm archived (đường B4 y như GRU đã đi). PASS → cho phép swap qua serving-swap guard có nhận thức featureSet (guard đã so featureSet từ B1).
- Kỳ vọng trung thực: tự tương quan giữa tin tức 2 ngày liên tiếp có thể CAO (tin về cùng sự kiện) — nếu autocorr chiều news vượt ngưỡng, cân nhắc chỉ giữ 2–3 chiều ortho nhất (IC giữa các chiều news cũng đo).

### 5.4 Không đổi gì ở 4 đường tiêu thụ hiện có

LLM vote · lexicon evidence · RAG · bandit posterior giữ nguyên 100% (chống đếm kép T7.5: đặc trưng news trong MLP là *đầu vào học*, phiếu ml-forecast vẫn là *một* phiếu bầu — không thêm cử tri mới).

---

## §6. Hạng mục C3 — ĐÓNG VÒNG BANDIT & TRỌNG SỐ THẬT (bị động, tự chín)

- Cơ chế ĐÃ nối đủ (§0.7-4): settle 16:15 ICT hằng ngày (A1) → reward → posterior → trọng số phiếu chu kỳ kế tiếp. **Không cần code mới cho vòng chính.**
- Việc cần: (i) theo dõi 10 settle đầu (10-13 → 10-24) — xác nhận `BanditEvent` tăng + posterior arm `news-sentiment`/`ml-forecast` tách khỏi 0,5; (ii) UI posterior trajectory đã có nền A2 (analytics) — chỉ cần soi; (iii) nếu sau ≥ 30 event mà arm nào posterior < 0,35 kéo dài → cân nhắc hạ LR cap phiếu arm đó (đề xuất sau, có số liệu).
- Cổng kết luận gì về "agent tin tức dự báo tốt/kém" phải chờ ≥ 30 event (nguyên tắc §1.4 — n < 30 hiển thị "chưa đủ mẫu").

---

## §7. Bảng cổng kích hoạt tổng hợp

| Hạng mục | Điều kiện mở | Ai quyết | Trạng thái |
|---|---|---|---|
| **C0 mở kẹt ml-gate** | Không cần cổng — tiền đề | Trader chọn a/b/c (§9 Q1) | 🔴 Chờ duyệt |
| **C1 Sweep Controller** | C0 xong + trader duyệt budget + `ml-sweep.enabled` | Trader (§9 Q2) | 🔴 Blueprint chờ duyệt |
| **C2 News features** | NewsItem tích luỹ ≥ 60 phiên có tin + coverage lexicon đo + gate-news | Tự chín theo dữ liệu | 🔴 Cổng dữ liệu ~3 tháng |
| **C3 Bandit loop** | Settle 10-13 tự chạy | Tự chín | 🟡 Cơ chế sống, chờ event đầu |
| L2 One-Shot NAS | Dòng intraday 5-phút đủ nuôi supernet (đo lại autocorr) | Cổng §6 ML_OPS (tái đo) | ⛔ Không đề xuất giai đoạn này |
| L3 HyperNAS | L2 có bằng chứng + surrogate có dữ liệu | Cổng xa | ⛔ Không đề xuất |

## §8. Giao thức triển khai & fixbug (kế thừa EXECUTION_OPS 3 vòng đối kháng)

Mỗi hạng mục (C0 → C1 → C2-code) triển khai theo đúng giao thức nhà: **Vòng 1** code + verify hermetic (script tự dọn pattern `k3k4-verify.ts`) → **Vòng 2** review như-chưa-từng-fix + E2E agent-browser desktop/mobile 0 console error → **Vòng 3** docs sync (TECHNICAL/DB_SCHEMA/AUTONOMY + blueprint này lên version) + lint/tsc + commit/push. Thứ tự bắt buộc: **C0 trước C1** (sweep dựa vào serving-swap guard — guard phải sống đã). C2-code chỉ sau khi cổng dữ liệu chín.

## §9. Câu hỏi mở chờ trader

- **Q1 (C0):** Chọn hướng mở kẹt ml-gate — khuyến nghị **(c) vá nhánh `serving==null` + (a) re-baseline gate đo thật**; hay (b) promote nhanh v4 hôm nay?
- **Q2 (C1):** Duyệt budget sweep mặc định **16 ứng viên ~4 phút/đợt, Chủ nhật 04:15 ICT tự động sau A4**? Muốn tay (nút bấm) hay lịch? δ swap = 0,01 valAcc có chấp nhận?
- **Q3 (C1):** Có muốn sweep cũng dò `lossWeights` (đầu ra UP/DOWN) như không gian ở §4.2, hay giữ lossWeights ngoài sweep để "ý người" còn ở phần nào?
- **Q4 (C2):** Duyệt nguyên tắc chờ **≥ 60 phiên tin tích luỹ** (không backfill) trước khi train `v3-news22`? Trong lúc chờ có muốn dựng sẵn pipeline đo coverage lexicon trên 64 tin hiện có?
- **Q5 (tổ chức):** Sweep đặt ở engine (như A4) hay route API `/api/ml/sweep` gọi từ engine? (Người soạn đề xuất: route + engine bấm như A4 — một pattern, một fail-soft.)

## §10. Changelog

| Version | Ngày | Nội dung |
|---|---|---|
| 1.0 | 2026-10-12 (#98) | Bản đầu: kiểm kê 6 câu hỏi trader (reward/loss/Keras/forward-backward/news 4 đường + gap đặc trưng) · phán quyết L0 audit #97 · nguyên tắc 9–11 · C0 mở kẹt ml-gate [AUD-97-F1] · C1 sweep controller deterministic 16 ứng viên + cổng 4 điều kiện + SweepRun schema additive + UI champion board · C2 news-to-feature v3-news22 PIT-strict + gate B2-style + cổng dữ liệu 60 phiên · C3 theo dõi vòng bandit · 5 câu hỏi mở. |

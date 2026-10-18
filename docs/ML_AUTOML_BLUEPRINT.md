# ML AUTOML BLUEPRINT — L1 DETERMINISTIC SWEEP CONTROLLER + TÍNH NĂNG HOÁ ĐẦU VÀO TIN TỨC

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/ML_AUTOML_BLUEPRINT.md` · **Version:** 1.1 · **Created:** 2026-10-12 (#98) · **Revised:** 2026-10-12 ~03:10 ICT (#99 — trader duyệt: *"review blueprint, xử lý/bổ sung nếu có; các câu hỏi theo khuyến nghị; tôi thích những gì có thể tự động"*)
> **Status:** **ĐÃ DUYỆT THEO KHUYẾN NGHỊ — ĐÃ TRIỂN KHAI XONG #99** (C0 ✅ serving v5→v9 · ml-gate đo FAIL trung thực với twin tự lành · C1 ✅ sweep thật 28s swap champion 0,423 qua cổng 4 điều kiện + skip-guard 916ms + rerun identical · C2-pipeline ✅ block tiến độ 2/60 phiên tự chín · engine `ML_SWEEP_AT SUN:04:15` wired · 15/15 verify · lint/tsc 0 · E2E desktop+mobile 0 console error — bằng chứng §0.9 + worklog #99 + TECHNICAL v1.9.0 · DB_SCHEMA v0.9.2 · AUTONOMY v1.5)
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

### 0.9 Đối soát v1.0 → v1.1 (phiên #99) — 10 lỗi/thiếu sót đã vá

Đối soát lại TOÀN BỘ claim của v1.0 trực tiếp trên code + DB sống (03:05 ICT): **mọi claim §0 khớp 100%** — nn.ts (softmax 169-180 · actDerivFromOut 198-207 · forward 298-327 · CE class-weight 337+ · dzOut 423 · backprop 427-455 · Adam 458-474 · L2 chỉ W) · rl.ts:198 (reward exposure×ret − 0,001|Δexp| · α 0,1 · γ 0,95 · 300 episode · state 48 · action 3) · bandit Thompson 6 arm · DB (64 tin đúng bkd 16/13/13/12/10 · BanditEvent 0 · 6 arm Beta(1,1) pulls 0 · ml-gate KHÔNG tồn tại · dl-mlp v1–v4 archived valAcc 0,395 cùng windowHash 30f2d982fa · rl-q v3 serving · RetrievalLog 14) · engine (NEWS_MS 15 phút · SETTLE_AT 16:15 · ML_TRAIN_AT SUN:04:00) · MLP_ARCH_LIMITS 1..5 lớp × 2..96 nơ-rôn · MLP_TUNING_FIELDS 7 hyper. Phát hiện **10 vấn đề** — vá thẳng vào v1.1:

| # | Mức | Phát hiện (đo được) | Vá trong v1.1 |
|---|---|---|---|
| **F1** | P1 | **Phương án (a) §3 không chạy được như mô tả**: `scripts/ml-evidence-gate.ts` thoát cứng khi (i) không có bản serving (`:216` "chưa có bản dl-mlp serving") và (ii) không tìm thấy bất kỳ bản lag-10 nào làm baseline (`:263` `process.exit(1)`). Từ B1 trở đi train route CHỈ sinh v2-lag16 — **không còn đường nào train lag-10**, DB hiện 0 bản lag-10. | (a) nâng cấp thành **gate tự lành**: script tự train twin lag-10 khi thiếu baseline (chi tiết §3-mới) — đúng gu "tự động" của trader. |
| **F2** | P1 | §4.3 nói "mỗi ứng viên chạy đúng đường `trainDlMlp` hiện tại" nhưng hàm này nằm **bên trong** `api/ml/train/route.ts:343` — route khác không import được route của route. | Bóc `trainDlMlp` + `saveModel` + guard thành `src/lib/ml/train-mlp.ts` — train route và sweep route cùng dùng MỘT nguồn (chia sẻ mutex + đánh version). |
| **F3** | P1 | §4.6 thiếu guard bắn chồng: engine tick 60s, sweep ~4 phút → không guard sẽ POST lại mỗi phút trong lúc sweep đang chạy (A4 có sẵn `mlTrainInFlight` + `lastMlTrainSunday` persisted P0-5 + timeout 280s + retry phút-sau — `market-engine/index.ts:825-861`). | Sweep clone đúng pattern A4/K1: `sweepInFlight` + `stats.lastMlSweepSunday` persisted + timeout 20 phút + retry phút sau + broadcast WS `"ml-sweep"` + env `ML_SWEEP_AT`/`ML_SWEEP_DISABLED`. |
| **F4** | P2 | §4.4 điều kiện 3 (`paramCount ≤ 2× serving`) không xác định khi serving == null (DB sạch). | serving == null → cap mặc định `2 × MLP_ARCH_LIMITS.paramWarnThreshold` (10.000) · điều kiện 1 so baseline 1/3 + δ · điều kiện 2 so Brier uniform 0,667. Nhánh chỉ dành cho DB sạch — sau C0 serving luôn tồn tại. |
| **F5** | P2 | Công thức score §4.3 phạt từ mốc 2.000 tham số — lệch hằng số nhà `paramWarnThreshold = 5.000` (`tuning.ts:127`). | Formula dùng `paramWarnThreshold` (một nguồn sự thật, khỏi lệch số). |
| **F6** | P2 | `MlpMetrics` KHÔNG có Brier (`nn.ts:35-42` chỉ epochs/samples/trainAcc/valAcc/trainLoss/valLoss) — score §4.3 cần Brier từng ứng viên. | Evaluator tự tính Brier trên val block (cùng cut 80/20 thời gian như `fit()`) bằng `predictProba` — đúng method gate script `:343-358`. |
| **F7** | P3 | SweepRun thiếu index cho UI lịch sử + thiếu field featureSet (tương lai C2 sweep trên v3-news22 phải migrate). | `@@index([startedAt(sort: Desc)])` + field `featureSet String @default("v2-lag16")`. |
| **F8** | P3 | §4.4 điều kiện 4 chữ "Ban đầu khi" gây mập mờ (đọc như chỉ áp dụng khi khởi động). | Viết lại: skip-guard windowHash như A4 áp dụng LUÔN cho mọi đợt. |
| **F9** | P3 | §4.5 UI thiếu chi tiết tích hợp thật (chỉ nói "tab mới trong module Học máy"). | Tab "Tự động tìm kiếm" = tab thứ 8 `SYNTHESIS_TABS` (`synthesis-workspace.tsx:161` — hiện 7 tab) · component `ml/sweep-tab.tsx` · dữ liệu `/api/ml/sweep` (GET cấu hình + lịch sử, POST chạy ngay) · WS `"ml-sweep"` · hook `use-ml-sweep.ts` theo pattern `use-ml.ts`. |
| **F10** | P3 | Q3 bỏ ngỏ khiến không gian §4.2 (có nhắc lossWeights) mâu thuẫn câu hỏi §9. | Chốt §9: lossWeights tham gia sweep CHỈ ở refine (2 preset), coarse giữ lossWeights trader đang đặt trong ml-tuning (hiện [1,1,1] — đo 03:05 ICT). |

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

## §3. Hạng mục C0 — MỞ KẸT ML-GATE COLD-START [AUD-97-F1] (TIỀN ĐỀ TUYỆT ĐỐI) — 🟢 ĐÃ DUYỆT (c)+(a) BẢN TỰ LÀNH

**Vấn đề (đo #97, tái khẳng định #99 — đọc trực tiếp `train/route.ts:439-457`):** DB hiện không có bản dl-mlp serving (v1–v4 toàn archived) → `mlForecastEnsemble` fallback linreg thuần. Cơ chế kẹt 2 tầng:

```text
(1) AppSetting "ml-gate" không tồn tại (mất khi đổi DB) → gateVerdictOf() = null
(2) Không có serving row → featureSetOf(null) = "v1-lag10" ≠ "v2-lag16" → sameSet = false
→ promoted = beatsValAcc && (sameSet || PASS) = false VĨNH VIỄN cho mọi bản lag16 mới
   (trong khi doc comment `route.ts:59` lại hứa "Không có bản serving trước đó → promote")
```

**Phương án đã duyệt (c)+(a) một đợt — có vá F1 cho (a):**

| Bước | Việc | Chi tiết |
|---|---|---|
| **(c) vá code** | Train route: `servingRow == null` → thoả ràng buộc featureSet (đúng lại doc comment sẵn có) | 1 dòng: `const sameSet = servingRow == null || servingFeatureSet === ML_FEATURE_SET;` — chữa vĩnh viễn cho mọi DB sạch tương lai, bản ĐẦU TIÊN lên serving luôn. |
| **(a) gate tự lành** | `scripts/ml-evidence-gate.ts`: khi thiếu baseline lag-10 → **tự train twin** rồi mới đo | Twin = MLP **10 chiều đầu** của CHÍNH tập `buildTrainingSet` vừa build ("10 chiều đầu giữ nguyên công thức" — đúng ngữ nghĩa `featureSetOf`), **cùng arch/activations/lossWeights/lr/batchSize/epochs/patience/l2/valFraction/seed** như bản ứng viên lag-16 (đọc từ `candidate.meta.tuning`) — so sánh apples-to-apples "cùng dữ liệu, khác bộ đặc trưng" · lưu `MlModel kind dl-mlp, status archived, meta {featureSet:"v1-lag10", windowHash, twin:true, twinOf:version}` · `predictProba` của bản 10 chiều đọc an toàn từ vector 16 chiều (nn.ts tự cắt — đã đối chiếu `applyNormInternal` + `forward` chỉ đọc `arch.in` chiều đầu). Chạy `bun run scripts/ml-evidence-gate.ts`. |
| **kích hoạt** | Train 1 bản serving thật | `POST /api/ml/train {target:"dl-mlp", force:true}` → bản v5 promoted (sau bước c) → gate đo trên serving sống. |

(b) admin promote **BỎ** — mâu thuẫn văn hoá bằng chứng, và (c) làm được điều (b) hứa mà vẫn qua cổng.

**Nghiệm thu C0 (định trước):** (i) có ≥ 1 bản dl-mlp status=serving trên DB; (ii) `mlForecastEnsemble` trả `modelVersion ≠ null`; (iii) tái sinh kịch bản DB sạch (xoá MlModel dl-mlp + ml-gate) → train 1 lần → bản đầu TIÊN lên serving được (không kẹt); (iv) AppSetting ml-gate TỒN TẠI kèm verdict + measuredAt + baseline twin (không còn exit(1) "không tìm thấy bản lag-10"); (v) chu kỳ agent + E2E 0 lỗi console.

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

- **Giai đoạn coarse (12 ứng viên):** lưới thô tiêu biểu — arch hạt nhân {16-[24,12]-3, 16-[32,16]-3, 16-[48,24,12]-3, 16-[16]-3, 16-[64,32,16,8]-3, 16-[12,8]-3} × activation {relu, relu-tanh} + hyper mặc định. Mục đích: tìm *vùng topo* tốt. **lossWeights = bản trader đang đặt trong AppSetting ml-tuning** (đo 03:05 ICT: [1,1,1]) — "ý người" giữ ở coarse (Q3 §9).
- **Giai đoạn refine (4 ứng viên):** quanh top-2 coarse — 2 biến thể kiến trúc (mở/rút 1 lớp ±8 nơ-rôn) + **1 preset lossWeights UP-heavy [1,1,2,5] (Q3)** + 1 biến thể lr ×0,5 hoặc ×2.

Dãy ứng viên sinh bằng **quy tắc cố định từ seed** (mulberry32 — same seed ⇒ same dãy ⇒ same kết quả, nguyên tắc §2.9). Tổng ≤ 16 ứng viên × ~12s ≈ **~4 phút/đợt** + chi phí lưu hàng.

### 4.3 Evaluator (tái sử dụng hạ tầng có sẵn — có bổ sung F2/F5/F6)

**F2:** bóc `trainDlMlp` + `saveModel` + guard khỏi `api/ml/train/route.ts` thành `src/lib/ml/train-mlp.ts` — train route (hiện hành) và sweep route cùng gọi MỘT hàm, chia sẻ mutex + đánh version (không 2 hàng trùng version khi sweep đang chạy mà trader bấm train tay).

Mỗi ứng viên chạy đúng đường `trainDlMlp` (cut 80/20 theo thời gian, early-stop valLoss) rồi chấm:

```text
score(ứng viên) = valAcc
                  − 0,0002 × max(0, paramCount − paramWarnThreshold)/100   (F5 — mốc 5.000 = MLP_ARCH_LIMITS.paramWarnThreshold, một nguồn)
                  + 0,01 × I[Brier_val ≤ Brier_serving]                       (F6 — Brier tự tính trên val block bằng predictProba,
                                                                                   đúng method gate script :343-358; Brier_serving lấy từ
                                                                                   AppSetting ml-gate.deltaBrier.v2 nếu có, không có thì bỏ số hạng)
```

- **Brier paired bootstrap** (tái sử dụng method `ml-evidence-gate.ts`) giữa champion và serving trên cùng val block → CI 95% — dùng cho **cổng quyết định**, không cho xếp hạng.
- Mọi ứng viên lưu `MlModel kind "dl-mlp", meta.sweepRunId, status "archived"` — **không đụng serving** trong lúc sweep.

### 4.4 Cổng quyết định champion (nguyên tắc §1.5 mở rộng — có bổ sung F4/F8)

Champion của đợt chỉ được **đề xuất swap** khi thoả MỌI điều kiện:

1. `valAcc_champion ≥ valAcc_serving + δ` với **δ = 0,01** (1 điểm % — vượt hẳn ngoài nhiễu 60k mẫu; kèm Wilson CI cho tỉ lệ — A2). **F4:** serving == null (DB sạch) → baseline = 1/3 (ngẫu nhiên);
2. ΔBrier CI 95% hoàn toàn < 0 (bootstrap 1.000× — cùng phương pháp cổng B2). **F4:** serving == null → Brier baseline uniform 0,667;
3. `paramCount ≤ max(maxParamFactor × paramCount_serving; ⌊nTrain / 15⌋)` (chống "thắng vì to" — mặc định maxParamFactor = 2). **F4:** serving == null → cap hệ số `2 × paramWarnThreshold` = 10.000. **F-19 (#133):** cap hiệu chỉnh theo mẫu dữ liệu — quy tắc cổ điển 10–20 mẫu/tham số, lấy bảo thủ 15: dữ liệu 60k mẫu (nTrain 48.000) cấp cap 3.200 tham số — mô hình lớn được áp dụng khi **dữ liệu đủ lớn chứng minh** cho nó (valAcc + ΔBrier CI95 đã bảo vệ ý nghĩa thống kê); dữ liệu nhỏ (nTrain 5.000 → cap 333) vẫn bị kẹp chặn;
4. **F8:** skip-guard windowHash như A4 áp dụng LUÔN cho mọi đợt — cùng windowHash với đợt trước ⇒ không sweep lại (không có bar mới = không có gì mới để tìm).

Không thoả → champion nằm lại bảng với nhãn *"không đủ vượt cổng"* — trung thực, không ép.

#### 4.4.1 LỖI CHỌN LỌC (selection bias — audit 137 B4)

Champion được **chọn** theo score trên val, rồi valAcc của chính champion trên **cùng val đó** lại vào điều kiện cổng 1 — đây là winner's curse trên ~16 ứng viên (mỗi ứng viên đã early-stop theo val): kỳ vọng của max của ~16 biến ngẫu nhiên thiên lệch LÊN, nên `valAcc_champion` là số post-selection, không phải ước lượng không thiên lệch ngoài mẫu. Cùng block val đó còn được dùng lần thứ 3 bởi calibration gate (B5). Hàng rào hiện có là **bộ phận**: δ = 0,01 (điều kiện 1) và ΔBrier paired CI95 < 0 (điều kiện 2 — paired cùng cửa sổ, chấm lại serving weights trên val block hiện tại, phần này sạch); riêng `servingValAcc` ở điều kiện 1 đọc từ metrics CŨ của bản serving train trên cửa sổ dữ liệu khác — so chéo cửa sổ, chỉ công bằng khi route 04:00 hôm đó vừa retrain + promote cùng windowHash.

**Walk-forward / heldout sau val (chấm Brier/accuracy cổng trên block post-val hoặc k-fold thời gian) ĐÃ ĐẠ KẾ HOẠCH, CHƯA TRIỂN KHAI** — ghi nợ kỹ thuật #2 của audit 137 (cùng họ với B5 calibration holdout đã vá nửa-đầu/nửa-sau và B6 macro holdout tail 60 phiên). Lưu ý sau audit 137 B1 (chuẩn hoá train-only): **valAcc công bố sau vá NHẠT HƠN số cũ** — đó là đổi chuẩn đo trung thực (loạt 42,9% trước đây lạc quan hệ thống vì mean/std z-score dính block val), không phải mô hình sa sút. So sánh champion-vs-serving (cùng leak cả hai trước vá / cùng sạch cả hai sau vá) ít bị ảnh hưởng hơn con số tuyệt đối.

### 4.5 Lưu trữ & hiển thị (schema additive — 1 model + 1 AppSetting; F7/F9)

```prisma
model SweepRun {
  id            String    @id @default(cuid())
  startedAt     DateTime  @default(now())
  finishedAt    DateTime?
  windowHash    String    // cùng chuẩn MlModel.meta
  featureSet    String    @default("v2-lag16") // F7 — sẵn cho v3-news22 tương lai, khỏi migrate
  candidates    Int       // số ứng viên ngân sách
  evaluated     Int       // số ứng viên đã train xong
  seed          Int       // seed dãy ứng viên — deterministic
  status        String    // running | done | failed | skipped
  championJson  String?   // {arch, activations, lossWeights, hyper, valAcc, brier, paramCount, swapProposed, reason}
  logJson       String?   // [{i, arch, activations, valAcc, valLoss, brier, params, ms, error?}] toàn bộ ứng viên

  @@index([startedAt(sort: Desc)]) // F7 — UI lịch sử
}
```

- `AppSetting "ml-sweep"`: `{enabled, budgetCandidates, seed, deltaSwap, maxParamFactor, lastRunAt}` — kill-switch từng đợt như mọi AppSetting khác (§1.6).
- **F9 UI:** tab **"Tự động tìm kiếm"** = tab thứ 8 của `SYNTHESIS_TABS` (`synthesis-workspace.tsx:161`) · component `src/components/dashboard/ml/sweep-tab.tsx` (champion board = bảng `logJson` mọi ứng viên kèm valAcc/Brier/tham số/thời gian · cấu hình budget + công tắc + seed + δ · lịch sử các đợt SweepRun · giải thích công khai công thức score + 4 điều kiện cổng · **nút "Chạy đợt ngay"** — deterministic nên không thể "câu" kết quả, mọi champion vẫn phải qua cổng) · dữ liệu `/api/ml/sweep` (GET cấu hình + lịch sử; POST chạy ngay, body `budget?` clamp 1..64 ghi rõ vào SweepRun) · WS `"ml-sweep"` Invalidate cache như `"ml-train"`. **Không có nút "áp dụng ngay" vượt cổng.**

### 4.6 Lịch chạy & fail-soft (có bổ sung F3)

- Engine thêm lịch **`SWEEP_AT` = Chủ nhật 04:15 ICT** (env `ML_SWEEP_AT` mặc định `"SUN:04:15"` — sau A4 retrain 04:00; sweep chỉ chạy khi có windowHash mới, skip-guard dùng chung; `ML_SWEEP_DISABLED=1` tắt như A4).
- **F3 — clone đúng pattern A4/K1:** guard `sweepInFlight` chặn tick 60s bắn chồng khi sweep đang chạy (4 phút++); `stats.lastMlSweepSunday` **persisted sống sót restart** (P0-5); timeout POST 20 phút; thất bại → KHÔNG đánh dấu Chủ nhật — phút sau thử lại; broadcast WS `"ml-sweep"` sau khi xong.
- Budget trần thời gian: quá 20 phút giữa chừng → dừng an toàn, status "failed" + logJson giữ những ứng viên đã xong (không rollback gì).
- Fail-soft tuyệt đối: sweep lỗi không chạm chu kỳ agent, không chạm serving, không chạm retrain A4.

### 4.7 Nghiệm thu C1 (định trước)

1. Deterministic: chạy 2 đợt cùng windowHash + cùng seed → 2 logJson IDENTICAL (từng số).
2. Budget: đợt thử nghiệm 16 ứng viên ≤ 6 phút thực đo; quá giờ → cắt an toàn.
3. Cổng: cài kịch bản champion thua δ → KHÔNG swap, bản serving nguyên vẹn, UI nhãn đúng lý do.
4. Bit-flip: tắt `ml-sweep.enabled` → toàn bộ nhánh sweep im, A4 + chu kỳ agent kết quả cũ 100%.
5. Hermetic: script verify (pattern `ml-arch-verify.ts`) — sinh dãy ứng viên từ seed, kiểm guard phạm vi, kiểm score + 4 điều kiện cổng bằng số dựng sẵn; ≥ 12 test.
6. **(F3)** route trả 429 khi sweep đang chạy (mutex); engine không bắn chồng đợt trong lúc in-flight.
7. **(F2)** train tay khi sweep đang chạy → xếp hàng cùng mutex, KHÔNG sinh 2 hàng trùng (kind, version).

---

## §5. Hạng mục C2 — NEWS-TO-FEATURE PIPELINE (tin tức → đặc trưng mạng học được)

> Sinh trực tiếp từ câu hỏi trader §0.8: biến NewsItem thành *bằng chứng học được* chứ không chỉ *gợi ý lúc ra quyết định*.

### 5.1 Rào chắn dữ liệu — nói thật trước khi thiết kế

RSS chỉ thu **tức thời** (bắt đầu từ khi hệ thống chạy) — không có lịch sử backfill. Hiện chỉ 64 tin / 3 ngày. Muốn train đặc trưng tin tức cần **≥ 60 phiên giao dịch có tin tích luỹ** (~3 tháng chạy liên tục) — đó là cổng dữ liệu C2 (§7). Không mua dữ liệu, không bịa backfill (nguyên tắc §2.11). **Q4 đã duyệt (§9): dựng pipeline đo coverage NGAY** — `scripts/ml-news-coverage.ts`: (i) đếm số phiên giao dịch có ≥ 1 tin (PIT ≤ 15:45 ICT mỗi phiên) + tiến độ /60; (ii) coverage lexicon — % tiêu đề có ≥ 1 hit trong từ điển ~75 thuật ngữ + phân bố hit theo nguồn; (iii) xem trước tương quan thô score-vs-không-gì (không kết luận, chỉ descriptive). Kết quả hiển thị block **"Cổng dữ liệu tin tức → đặc trưng"** trong tab Dữ liệu (data-tab) — **tự chín** theo crawler 15 phút (agent không phải bấm gì). Chỉ train khi cổng mở + gate-news PASS.

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
| **C0 mở kẹt ml-gate** | Không cần cổng — tiền đề | **ĐÃ DUYỆT (c)+(a) tự lành — §9 Q1** | 🟢 Triển khai ngay #99 |
| **C1 Sweep Controller** | C0 xong + budget + `ml-sweep.enabled` | **ĐÃ DUYỆT — Chủ nhật 04:15 ICT TỰ ĐỘNG sau A4 + nút chạy ngay — §9 Q2/Q5** | 🟢 Triển khai #99 (sau C0) |
| **C2 pipeline đo coverage** | Không cần cổng — chỉ đo, không train | **ĐÃ DUYỆT — dựng ngay, tự chín — §9 Q4** | 🟢 Triển khai #99 (song song C1, file rời) |
| **C2 train v3-news22** | NewsItem tích luỹ ≥ 60 phiên có tin + coverage lexicon đo + gate-news | Tự chín theo dữ liệu | 🔴 Cổng dữ liệu ~3 tháng |
| **C3 Bandit loop** | Settle 10-13 tự chạy | Tự chín | 🟡 Cơ chế sống, chờ event đầu |
| L2 One-Shot NAS | Dòng intraday 5-phút đủ nuôi supernet (đo lại autocorr) | Cổng §6 ML_OPS (tái đo) | ⛔ Không đề xuất giai đoạn này |
| L3 HyperNAS | L2 có bằng chứng + surrogate có dữ liệu | Cổng xa | ⛔ Không đề xuất |

## §8. Giao thức triển khai & fixbug (kế thừa EXECUTION_OPS 3 vòng đối kháng)

Mỗi hạng mục (C0 → C1 → C2-code) triển khai theo đúng giao thức nhà: **Vòng 1** code + verify hermetic (script tự dọn pattern `k3k4-verify.ts`) → **Vòng 2** review như-chưa-từng-fix + E2E agent-browser desktop/mobile 0 console error → **Vòng 3** docs sync (TECHNICAL/DB_SCHEMA/AUTONOMY + blueprint này lên version) + lint/tsc + commit/push. Thứ tự bắt buộc: **C0 trước C1** (sweep dựa vào serving-swap guard — guard phải sống đã). C2-pipeline (đo coverage) không đụng file C1 → chạy song song được.

## §9. Quyết định đã chốt (trader phiên #99: *"các câu hỏi thì theo như khuyến nghị của bạn" + "tôi thích những gì có thể tự động"*)

- **Q1 (C0) → (c) + (a) BẢN TỰ LÀNH:** vá nhánh `serving==null` trong train route (1 dòng — bản đầu tiên luôn lên serving) + nâng cấp `ml-evidence-gate.ts` tự train twin lag-10 khi thiếu baseline (F1). Hướng (b) admin-promote BỎ.
- **Q2 (C1) → TỰ ĐỘNG:** lịch **Chủ nhật 04:15 ICT** chạy sau A4 04:00, KHÔNG cần bấm gì; budget mặc định **16 ứng viên ~4 phút/đợt**; δ swap = **0,01** valAcc. VẪN CÓ nút "Chạy đợt ngay" cho tiện — deterministic (cùng windowHash + cùng seed ⇒ cùng kết quả) nên không thể "câu" kết quả, mọi champion vẫn phải qua cổng 4 điều kiện.
- **Q3 (C1) → lossWeights vào sweep Ở REFINE:** 2/4 ứng viên refine dùng preset (UP-heavy [1,1,2,5] · lr ×0,5/×2), coarse giữ nguyên lossWeights trader đang đặt trong ml-tuning — "ý người" còn ở enabled/budget/δ/seed + cổng 4 điều kiện.
- **Q4 (C2) → DUYỆT CỔNG 60 PHIÊN + DỰNG PIPELINE ĐO NGAY:** không backfill, không bịa dữ liệu; `scripts/ml-news-coverage.ts` + block tiến độ trong UI chạy ngay hôm nay, tự chín theo crawler 15 phút.
- **Q5 (tổ chức) → ROUTE + ENGINE BẮM NHƯ A4:** `/api/ml/sweep` (GET cấu hình + lịch sử · POST chạy ngay có mutex 429) + engine `SWEEP_AT SUN:04:15` bấm tự động — một pattern, một fail-soft, đúng gu tự động của trader.

## §10. Changelog

| Version | Ngày | Nội dung |
|---|---|---|
| 1.0 | 2026-10-12 (#98) | Bản đầu: kiểm kê 6 câu hỏi trader (reward/loss/Keras/forward-backward/news 4 đường + gap đặc trưng) · phán quyết L0 audit #97 · nguyên tắc 9–11 · C0 mở kẹt ml-gate [AUD-97-F1] · C1 sweep controller deterministic 16 ứng viên + cổng 4 điều kiện + SweepRun schema additive + UI champion board · C2 news-to-feature v3-news22 PIT-strict + gate B2-style + cổng dữ liệu 60 phiên · C3 theo dõi vòng bandit · 5 câu hỏi mở. |
| 1.1 | 2026-10-12 ~03:10 ICT (#99) | **Bản review do trader chỉ đạo** — đối soát toàn bộ claim (khớp 100%) + **10 vá**: §0.9 F1–F10 (gate tự lành twin lag-10 · extract train-mlp.ts · guard bắn chồng engine · serving==null defaults · mốc paramWarnThreshold · Brier tự tính · SweepRun index+featureSet · skip-guard viết lại · chi tiết UI tab 8 · chốt lossWeights refine) · §3 C0 duyệt (c)+(a) tự lành · §4 chốt automation-first · §5 C2 dựng pipeline đo ngay · §7 bảng cổng cập nhật · §9 chốt toàn bộ Q1–Q5 theo khuyến nghị (automation-first) · §8 cho phép C2-pipeline song song C1. |

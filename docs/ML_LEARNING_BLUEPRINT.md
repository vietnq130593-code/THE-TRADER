# ML LEARNING BLUEPRINT — PHÒNG HỌC MÁY: TÍCH LUỸ TRI THỨC & HỌC TỪ KẾT QUẢ

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/ML_LEARNING_BLUEPRINT.md` · **Version:** 1.1.0 · **Updated:** 2026-10-10 (#83 triển khai L1)
> **Status:** **L1 ✅ ĐÃ TRIỂN KHAI (#83 — BM25 RAG + RetrievalLog + tiêm prompt 6 agent LLM + A13 nâng cấp) · L2 ✅ hấp thụ vào A2 ML_OPS (#79) · L3-L5 chờ cổng §6** (duyệt định hướng #51; hiệu lệnh triển khai L1 do user phát động #83: "trước hết triển khai L1")
> **Cross-refs:** [CONTROL_RISK_QUANT_BLUEPRINT.md](./CONTROL_RISK_QUANT_BLUEPRINT.md) (CRB-6 đặc trưng logistic · CRB-1 σ cho state RL — **ĐÃ TRIỂN KHAI #51**) · [MARKET_EXPANSION_BLUEPRINT.md](./MARKET_EXPANSION_BLUEPRINT.md) (B7 ensemble · B8 scorecard/Brier · B9 đồng thuận) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [DATA_SOURCES.md](./DATA_SOURCES.md)
> **Người soạn:** Kỹ sư AI / Kiến trúc sư hệ thống (phiên #50–#51)

---

## §0. Bối cảnh & chẩn đoán hiện trạng (đo trực tiếp mã nguồn #49–#50)

Tầm nhìn của user: *"Nhóm Phòng học máy có vai trò tích luỹ kiến thức, kinh nghiệm, nâng cao chất lượng triển khai công việc của các agents ở tầng tri thức, tư duy. Mỗi ngày đều có rất nhiều bài báo, thông tin về thị trường đổ về, các agents nghiên cứu, đưa ra lựa chọn cũng cần ghi nhận lại để có thể đối chiếu và đánh giá chất lượng dựa vào kết quả dự đoán sau này."*

Chẩn đoán 4 chức năng cốt lõi của nhóm (7 agents: A13–A19, S3):

| Chức năng | Hiện trạng (file) | Xếp hạng |
|---|---|---|
| Dự báo | `ml/ensemble.ts` — 0,7 MLP + 0,3 tanh(z-linreg), deadband FLAT, chạy thật mỗi chu kỳ | 🟢 Mạnh |
| Đối chiếu & đánh giá kết quả dự đoán | `ml/bandit.ts` — Thompson sampling Beta-Bernoulli 6 arm; mọi phiếu bầu được settle sau 5 phiên THẬT đối chiếu realized direction rổ (±0,5%); `BanditEvent.confidence` đã lưu (nền Brier B8) | 🟢 Mạnh — đúng chữ "ghi nhận lại để đối chiếu" |
| Kiểm định | `runBacktest` A14 — 90 phiên, 1 chiến lược equal-weight | 🟡 Trung bình |
| **Tích luỹ tri thức & truy hồi** | `runLearningRag` A13 — **chỉ đếm** (broadcastCount, agents, newsTotal) + "truy xuất top-8 theo thời gian" (recency-only, không xếp hạng theo liên quan) | 🔴 **Yếu nhất** |

Kết luận chẩn đoán: hạ tầng dữ liệu cho tri thức **đã có đủ** (AgentMessage broadcast có `reasoning`/`sentiment` · NewsItem RSS nạp liên tục · MarketAssessment.detail có drivers/votes đầy đủ) — chỉ thiếu **cơ chế truy hồi theo liên quan** và **lớp chưng cất tri thức**. Đây chính là khoảng trống blueprint này lấp, theo nguyên tắc ghi nhận–đối chiếu–đánh giá của user.

## §1. Nguyên tắc nền tảng

1. **Viết tay TypeScript thuần** — BM25, Wilson interval, Brier tự tính bằng `Float64Array`/`Map`, 0 dependency ngoài stack. **KHÔNG dùng LlamaIndex** (Python — mâu thuẫn stack TS/Bun/Next.js; xem §4 bảng quyết định "không áp dụng").
2. **Supabase Postgres là đủ cho toàn lộ trình** — quy mô hiện tại 215k bar + vài nghìn message/tin + 17 model là rất nhỏ so với năng lực Postgres; L3 semantic dùng **pgvector của chính Supabase** (tắt extension khi tới giai đoạn), không thêm DB thứ hai. Cột vector nằm NGOÀI Prisma schema (raw SQL migration) vì Prisma client chưa hỗ trợ kiểu `vector` native.
3. **z-ai-web-dev-sdk chỉ ở backend** (quy tắc hệ thống) — embeddings sinh trong API route/service, không ở client.
4. **Không bịa dữ liệu + không bịa chất lượng**: mọi chỉ số hiệu năng hiển thị kèm **số mẫu n** và khoảng tin cậy (CLT áp đúng chỗ — Wilson, §5); n < 30 → hiển thị "chưa đủ mẫu" thay vì con số gây hiểu lầm.
5. **Schema additive**; RAG chỉ **bổ sung ngữ cảnh** cho prompt agent — KHÔNG thay bằng chứng định lượng Bayes (tránh đếm kép T7.5: tri thức truy hồi là ngữ cảnh, không phải evidence).
6. **Mỗi giai đoạn có cổng kích hoạt bằng dữ liệu thật** (§6) — không bật L3/L4/L5 vì "thứ hay để có".

## §2. Lộ trình 5 giai đoạn

```
L1 BM25 RAG viết tay ──► L2 Agent Performance Analytics ──► L3 Embeddings + pgvector
        (ngay khi duyệt)        (1 chu kỳ sau L1)                 (chỉ khi L1 chứng minh
                                                             RAG được dùng ≥ 10% chu kỳ)
                                                              │
L4 RL regime-conditioned ◄────────────── (chỉ khi ≥ 250 phiên/regime) ─┘
        │
L5 Chưng cất tri thức (lessons learned) — vòng học "tầng tri thức, tư duy"
        (chỉ khi ≥ 3 tháng BanditEvent tích luỹ)
```

### L1 — BM25 RAG viết tay (~200 dòng TS, 0 dependency)

**Thuật toán** (`src/lib/ml/rag.ts` mới — nâng cấp `runLearningRag` A13):

1. **Tokenizer tiếng Việt** (tái dùng pattern `quant/sentiment.ts`): lowercase, bỏ dấu câu, tách khoảng trắng. Không stemming (tin tài chính VN ngắn, stemming dễ sai nghĩa).
2. **Corpus**: 500 `AgentMessage` broadcast gần nhất (`memoryWindow: 500` đã có trong config A13) + 200 `NewsItem` gần nhất. Index in-process **đếm tần số tài liệu** df(t) khi build (≤ 700 docs × ~200 token — tính < 50ms, không cần index DB).
3. **Hàm xếp hạng hybrid**:
```
score(d, q) = 0,7 · BM25(d, q) + 0,3 · recency(d)
BM25:   Σ_t IDF(t) · (f(t,d)·(k₁+1)) / (f(t,d) + k₁·(1 − b + b·|d|/avgdl))
        IDF(t) = ln(1 + (N − df(t) + 0,5)/(df(t) + 0,5)) · k₁ = 1,5 · b = 0,75 (chuẩn)
recency(d) = exp(−ageHours(d)/72)     — nửa đời 3 ngày, tin càng cũ điểm càng thấp
query = [symbol liên quan, từ khoá ngành, "signal", "veto", "rủi ro"] sinh từ
        ngữ cảnh chu kỳ hiện tại (mã trong tín hiệu mở + top mover phiên)
```
4. **Tiêm prompt**: top-K = 8 dòng rút gọn (≤ 1.200 token) vào prompt của 5 agent nghiên cứu + Chủ tịch, nhãn khối `TRI THỨC TRUY HỒI (RAG — tin/tin nhắn cũ liên quan)`. Kèm log `RetrievalLog` (mỗi lần truy hồi: query, top-8 id, điểm) — **đo được RAG có được nhìn thấy/không**.
5. **Vô hại hoá**: nội dung cũ chỉ là ngữ cảnh; prompt ghi rõ "dữ liệu quá hạn dùng để đối chiếu, không phải tin mới".

**Nghiệm thu L1:** (1) truy hồi 8 kết quả ≤ 50ms trên corpus 700 docs; (2) query "VCB" trả về tin nhắn/tin tức từng nói về VCB (test seeded dữ liệu giả); (3) khối RAG ≤ 1.200 token — không phá ngân sách chu kỳ (≤ 185s sau CRB); (4) RetrievalLog ghi đầy đủ để L3 dùng làm cổng.

### L2 — Agent Performance Analytics · Data Analytics (~250 dòng)

**Từ dữ liệu BanditEvent đã có** (confidence B8 đã lưu từ #38) — không thu thập thêm gì:

1. **Hit-rate kèm Wilson 95% CI** cho từng arm (6 cử tri):
```
wilson(p̂, n, z=1,96): (p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
Hiển thị: "market-analyst: 62% [CI 48–74%] · n=54" — CLT áp đúng chỗ cho TỈ LỆ,
không dùng CI bình thường ±1,96σ (sai với biến nhị phân, p gần 0/1 thì méo)
```
2. **Brier score + calibration bucket**: chia phiếu theo confidence thành 5 bucket (≤0,4 / 0,4–0,55 / 0,55–0,7 / 0,7–0,85 / >0,85); mỗi bucket vẽ (confidence khai báo vs thực tế) → đường calibration; Brier = mean((conf − outcome)²) phân rã reliability/resolution/uncertainty (murphy decomposition, viết tay ~30 dòng).
3. **Posterior Beta trajectory**: đường posteriorMean theo thời gian từng arm (từ BanditEvent settle cộng dồn) — thấy được "agent nào từng tốt rồi sa sút".
4. **Bảng agent × chế độ thị trường**: hit-rate từng arm trong BULL/BEAR/SIDEWAYS/VOLATILE (regime `quant/regime.ts` tính hồi cho mốc settle) — trả lời "ai giỏi chế độ nào".
5. **UI**: mở rộng scorecard B8 trong module Đội Agent (đã có chỗ) — thêm tab "Hiệu năng & calibration".

**Nghiệm thu L2:** (1) mọi con số hiển thị kèm n + CI; n < 30 hiển thị "chưa đủ mẫu"; (2) Wilson tái lập với thư viện tham chiếu trên 1.000 (p̂, n) giả lập; (3) Brier phân rã tổng = reliability − resolution + uncertainty (bất đẳng thức kiểm tra); (4) không thêm model DB nào — thuần truy vấn BanditEvent/BanditArm.

### L3 — Embeddings + pgvector (semantic RAG — chỉ khi cổng §6 mở)

1. **Bật extension pgvector** trên Supabase (`CREATE EXTENSION IF NOT EXISTS vector;`) + bảng `trader.agent_embedding` (raw SQL migration, NGOÀI Prisma): `id · refTable ("AgentMessage"|"NewsItem") · refId · embedding vector(1024) · modelVersion · createdAt @@unique([refTable, refId])`.
2. **Sinh embeddings qua z-ai-web-dev-sdk trong backend** (batch 100, chạy kèm job ingest news/broadcast — không chặn chu kỳ); modelVersion ghi rõ từng dòng (đổi mô hình → embed lại toàn bộ, không trộn).
3. **Hybrid retrieval**: RRF fusion (Reciprocal Rank Fusion):
```
RRFscore(d) = Σ_list 1/(60 + rank_list(d))     — gộp bảng xếp hạng BM25 (L1) và cosine
                                               (pgvector ORDER BY embedding <=> query_vec)
top-K = 8 như L1 — giữ cùng interface tiêm prompt
```
4. Fallback đầy đủ: pgvector lỗi/chưa migrate → tự rơi về BM25 thuần (L1 vẫn chạy độc lập).

**Nghiệm thu L3:** (1) recall@8 hybrid ≥ recall@8 BM25 trên 20 query gán nhãn tay (không được kém hơn BM25 thuần); (2) embeddings chỉ sinh backend, 0 SDK ở client; (3) bảng vector nằm ngoài Prisma nhưng seed/sweep script biết đọc (raw SQL qua Prisma `queryRaw`); (4) chi phí embedding ghi TrackingLog theo batch.

### L4 — RL regime-conditioned (~180 dòng sửa `ml/rl.ts`)

Mở rộng state 48 → **192** bằng điều hoá theo chế độ (KHÔNG nhân thẳng 48×16 = 768 — Q-table thưa với dữ liệu hiện có):

```
State hiện tại: xu hướng(2) × RSI bucket(4) × mom5(2) × exposure(3)          = 48
L4:           × regime(4: BULL/BEAR/SIDEWAYS/VOLATILE — quant/regime.ts)    = 192
Điều kiện tiên quyết (cổng §6): mỗi regime có ≥ 250 phiên dữ liệu để visite đủ
Q-table layout: 4 bảng Q 48×3 riêng (mỗi regime một bảng) — code đổi min,
visite/khám phá độc lập từng regime (ε-greedy decay riêng)
Kèm: reward shape thêm hệ số CRB-1 (đảo chiều exposure khi vol mult ≤ 0,75
được thưởng nhẹ +0,02) — RL học cộng hưởng với hạn mức động Ủy ban
Retrain định kỳ: Chủ nhật 04:00 ICT (chung cửa sổ re-probe engine, tránh
thêm một lịch chạy mới)
```

**Nghiệm thu L4:** (1) 4 bảng Q độc lập — thay đổi dữ liệu BULL không dịch Q của SIDEWAYS; (2) tổng reward/episode sau retrain ≥ bản 48-state trên cùng dữ liệu backtest (điều kiện lên serving, không đạt → giữ 48 như tham mưu cũ); (3) deterministic seed như cũ.

### L5 — Chưng cất tri thức · lessons learned (vòng học "tầng tri thức")

Đúng tinh thần user — hệ thống **tự viết bài học** từ lịch sử đúng/sai:

1. **Phát hiện bài học định lượng** (deterministic): quét 3 tháng BanditEvent + BayesDriver sensitivity (`MarketAssessment.detail.drivers` có sẵn Δᵢ) — bằng chứng loại nào (llm-vote nguồn nào / flows / breadth) có |Δ| lớn mà realized ngược → gom cụm "bằng chứng loại X đang được trọng âm quá mức".
2. **Sinh AgentLesson** (1 lần/tháng, duy nhất chỗ dùng LLM trong blueprint này — chi phí 1 call): LLM đọc cụm phát hiện → viết 1–3 bài học ≤ 40 từ, dạng nguyên tắc ("Khi breadth > 60% mà dòng ngoại bán ròng, phiếu bullish của news-sentiment đã sai 4/5 lần gần nhất…").
3. **Lưu `AgentLesson`** (kind · content · evidenceStats Json · validFrom/To) + tiêm vào prompt hệ thống của đúng agent liên quan (≤ 3 bài/kỳ — chống phình prompt).
4. **Vòng lặp kiểm chứng**: bài học có hiệu lực 60 ngày; hết hạn tự đánh giá lại bằng cùng cơ chế (1) — đúng thì gia hạn, sai thì khai tử + AuditLog.

**Nghiệm thu L5:** (1) bài học trích dẫn được số liệu gốc (n mẫu, tỉ lệ) — không sáo rỗng chung chung; (2) prompt agent chỉ tăng ≤ 300 token; (3) khai tử/gia hạn có audit trail; (4) tắt được bằng AppSetting (kill-switch).

## §3. Thay đổi schema (additive — chỉ khi giai đoạn tương ứng kích hoạt)

| Đối tượng | Giai đoạn | Thay đổi | Lý do |
|---|---|---|---|
| `RetrievalLog` (model mới) | L1 | `id · cycleAt · query Text[] · topK Int · results Json (refTable/refId/score) · usedInPrompt Boolean` | đo chất lượng RAG + cổng kích hoạt L3 |
| `AgentLesson` (model mới) | L5 | `id · kind · content · evidenceStats Json · validFrom · validTo · agentCode? · createdAt` | tri thức chưng cất có vòng đời + kiểm chứng |
| `agent_embedding` (bảng ngoài Prisma, raw SQL) | L3 | `refTable · refId · embedding vector(1024) · modelVersion` | pgvector — Prisma chưa hỗ trợ kiểu vector native |
| BanditArm/BanditEvent | — | **KHÔNG đổi** (confidence đã có từ B8) | tận dụng hiện trạng |
| AppSetting | L5 | key `ml-lessons` (kill-switch + cấu hình) | an toàn |

## §4. Quyết định "KHÔNG áp dụng" (kỷ luật kiến trúc — ghi rõ để không lặp lại tranh luận)

| Công nghệ | Quyết định | Lý do kỹ thuật |
|---|---|---|
| **LlamaIndex** | ❌ Không | Framework Python — hệ thống là TS/Bun/Next.js; 90% giá trị (BM25 + hybrid + top-K) tự viết được trong ~200 dòng đúng phong cách codebase; thêm runtime Python = điểm hỏng vận hành + egress mới |
| **Deep RL / DQN** | ❌ Chưa (điều xét lại khi ≥ 10k phiên/regime) | dữ liệu non-stationary ~90k bar; Q-tabular regime-conditioned đủ lực cho 3 hành động ±0,5 exposure; deep RL cần ε exploration thật trên tài khoản thật — rủi ro so với lợi ích không hợp lý ở giai đoạn này |
| **Vector DB riêng (Pinecone/Milvus)** | ❌ Không | pgvector của Supabase cùng cluster = 0 ops thêm; quy mô corpus (≤ vài chục nghìn docs) quá nhỏ để đáng |
| **Data warehouse riêng / ClickHouse** | ❌ Không | toàn bộ phân tích quét ≤ vài trăm nghìn dòng — Postgres + index đủ; thêm warehouse = over-engineering |
| **XGBoost/LightGBM cho dự báo** | ❌ Không | 10 đặc trưng × ~50k mẫu: MLP nhỏ + linreg đã có; GBM khó giải thích (mâu thuẫn văn hoá deterministic/audit) và dễ overfit đặc trưng ít |

## §5. Quan hệ với CLT & thống kê (áp đúng chỗ, ghi giới hạn)

- **Wilson interval (L2)**: CLT áp cho **tỉ lệ nhị phân** — Wilson là bản chuẩn hoá của khoảng ±1,96σ thô (p̂ gần 0/1 thì CI thường méo/âm, Wilson sửa đúng tâm và biên). Đây là chỗ CLT "tăng độ chính xác" của Data Analytics mà user hỏi — áp có kiểm soát.
- **Brier phân rã (L2)**: reliability/resolution/uncertainty — đo calibration (độ tự tin khớp thực tế) không lệ thuộc giả định phân phối.
- **√h scaling (đã có)**: CI80 Holt + VaR×√5 (CRB-2) — giả định i.i.d., ghi giới hạn ở CONTROL_RISK_QUANT_BLUEPRINT §8.
- **Bootstrap MC (CRB-3)**: lý luận CLT hội tụ về chuẩn của trung bình — đã chạy trong gói CRB.
- Giới hạn chung: return đuôi FAT + non-stationary → mọi CI hiển thị như **ước lượng tham khảo**, không dùng làm ràng buộc giao dịch tự động.

## §6. Cổng kích hoạt từng giai đoạn (dữ liệu thật quyết định — không bật vì "hay")

| Giai đoạn | Cổng mở khi | Dữ liệu đo |
|---|---|---|
| L1 | User phê duyệt triển khai | ✅ **ĐÃ TRIỂN KHAI #83** — rag.ts (BM25+recency ~460d) · RetrievalLog · tiêm chu kỳ + single-run · A13 báo cáo |
| L2 | Sau L1 ≥ 1 chu kỳ kiểm định RetrievalLog hoạt động | ✅ **hấp thụ vào A2 ML_OPS #79** (Wilson/Brier/calibration chạy thật — không đợi L1) |
| L3 | RetrievalLog ≥ 30 ngày VÀ khối RAG được dùng (tin nhắn/tin nằm trong top-8 của ≥ 10% chu kỳ) | truy vấn RetrievalLog |
| L4 | Mỗi regime có ≥ 250 phiên dữ liệu lịch sử | quét Bar theo nhãn regime hồi tố |
| L5 | ≥ 3 tháng BanditEvent settle + ≥ 200 phiếu có confidence | count BanditEvent |

## §7. Ước lượng công sức & rủi ro

| Giai đoạn | Dòng code | Chi phí vận hành | Rủi ro chính & giảm nhẹ |
|---|---|---|---|
| L1 | ~200 | ~50ms/chu kỳ, 0 ₫ | prompt phình → cap 1.200 token + đo |
| L2 | ~250 | query theo yêu cầu UI, 0 ₫ | n nhỏ gây hiểu lầm → CI + "chưa đủ mẫu" |
| L3 | ~300 + SQL | embedding batch (~₫/1k tin), amortised | lệ thuộc SDK → fallback BM25 đầy đủ |
| L4 | ~180 sửa | retrain Chủ nhật ~10s | Q thưa → cổng 250 phiên/regime + so sánh trước khi lên serving |
| L5 | ~220 | 1 LLM call/tháng | bài học sai → vòng kiểm chứng 60 ngày + kill-switch |

## §8. Câu hỏi mở khi quyết định triển khai (trả lời khi kích hoạt)

1. L1 tiêm RAG vào **5 agent nghiên cứu + Chủ tịch** hay chỉ Chủ tịch (để cô lập ảnh hưởng đo A/B)?
2. L2 hiển thị calibration ở tab Hiệu năng (Đội Agent) hay thêm module riêng "Phòng Học máy"?
3. L3 model embeddings chọn kích thước 1024 (cân bằng chi phí/chất lượng) — user duyệt mức chi phí embedding/tháng tối đa?
4. L4 có giữ bản 48-state chạy song song 1 tháng (shadow) trước khi thay serving như pattern consensus B9?
5. L5 bài học viết bằng LLM (đề xuất) hay template định lượng thuần (0 ₫, kém linh hoạt)?

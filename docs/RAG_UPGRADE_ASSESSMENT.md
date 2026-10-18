# ĐÁNH GIÁ NÂNG CẤP RAG → LIGHTRAG / GRAPHRAG

> **Task 140 · F-24 assessment** — đọc-only, 0 dòng sản phẩm bị sửa.
> Câu hỏi chủ sở hữu: *“Kiểm tra khối lượng dữ liệu của THE TRADER trong database,
> cho tôi biết có thể nâng cấp từ RAG thành lightRAG hoặc GraphRAG không, nếu nâng
> cấp thì giữa LightRAG và GraphRAG loại nào phù hợp hơn?”*
>
> **Cập nhật Task 141 (cùng ngày):** chủ sở hữu cung cấp API key NVIDIA NIM để
> gỡ ràng buộc lõi embed §4.1 — đo thật và cập nhật toàn bộ phán quyết ở **§9**.
>
> Bằng chứng: `scripts/p140-rag-data-volume.ts` (SELECT-only + 3 cuộc gọi LLM thật
> glm-4.6 để đo chi phí trích xuất thực thể) + `scripts/p141-nim-embed-test.ts`
> (kiểm tra key NIM, đo dim/latency/chất lượng ngữ nghĩa tiếng Việt). Toàn bộ số
> liệu dưới đây đo trên DB Supabase sống + API NIM thật ngày 2026-10-18.

---

## §0 — TL;DR

| Câu hỏi | Trả lời |
|---|---|
| **Có thể nâng cấp không?** | **CÓ, về mặt kỹ thuật** — LLM glm-4.6 trích xuất thực thể/quan hệ tiếng Việt chạy tốt (micro-test §3). Sau Task 141 còn 2 ràng buộc thật: độ trễ 7-15s/cuộc trích xuất → indexing phải chạy nền (§4.2), và corpus hiện tại 62% là telemetry vận hành chứ không phải tri thức thị trường (§2). Ràng buộc thứ ba (không có lõi embed) **đã được gỡ bằng NVIDIA NIM** (§9). |
| **LightRAG hay GraphRAG?** | **LightRAG — thắng tuyệt đối ở quy mô và kiến trúc hiện tại.** GraphRAG chỉ hợp khi corpus lớn gấp 20-50×, và use case đổi từ “tiêm ngữ cảnh” sang “hỏi tổng quan chủ đề” (§5, §7). Có lõi embed NIM (§9) không đổi phán quyết này — embeddings chỉ là 1 trong 7 tiêu chí. |
| **Khuyến nghị thực tế** | Đừng “thay máy” L1 BM25. Nâng cấp đúng nghĩa = **thêm lớp L2 tri thức dài hạn kiểu LightRAG** trên corpus được tuyển lọc, bootstrap từ dữ liệu ĐÃ CÓ (104 mã Instrument, MACRO_SYNONYMS, 40 cạnh MarketRelation đo được) — giữ L1 BM25 làm lớp nóng (§6). |
| **Lõi embed NVIDIA NIM (141)** | **DÙNG ĐƯỢC**: key hợp lệ, egress thông, 2 model sống đều **2.048 dim** (đúng trí nhớ của chủ sở hữu) — `nemotron-3-embed-1b` tách nghĩa tiếng Việt tài chính xuất sắc: doc cùng nghĩa 0,55 vs doc ngoài đề 0,06 (biên 9×). L2 nên chạy hybrid BM25 + vector ngay từ đầu, fail-soft về BM25 (§9). |

---

## §1 — KHỐI LƯỢNG DỮ LIỆU ĐO ĐƯỢC (trả lời trực tiếp câu hỏi đầu)

### 1.1 Toàn DB: 168,0 MB — nhưng RAG chỉ quan tâm ~1 MB

| Bảng | Dung lượng | Dòng | Liên quan RAG? |
|---|---|---|---|
| Bar | 107,2 MB | 225.644 | ✗ chuỗi số OHLC — đầu vào MLP, không phải văn bản |
| MlModel | 2,7 MB | 109 | ✗ trọng số JSON |
| IntradayBar | 1,8 MB | 5.032 | ✗ |
| **AgentMessage** | **1,6 MB** | **1.328** | **✓ corpus chính** |
| AgentRun | 1,4 MB | 1.380 | ✗ (chỉ dùng tham chiếu chi phí §4.3) |
| **NewsItem** | **1,1 MB** | **975** | **✓ corpus chính** |
| AuditLog | 1,0 MB | 1.125 | ~ (audit trail, không phải tri thức truy hồi) |
| **MarketAssessment** | **0,6 MB** | **62** | **✓ kho văn bản LỚN NHẤT chưa dùng** (773k ký tự narrative/JSON tổng hợp chu kỳ, TB 12.469 ký tự/row) |
| 32 bảng còn lại | ~1,6 MB | ~600 | ✗ |

### 1.2 Kho văn bản tri thức (ứng viên corpus RAG)

| Nguồn | Số doc | Ký tự | p50/p90 ký tự/doc | Nhịp tăng |
|---|---|---|---|---|
| AgentMessage broadcast (AGENT) | 1.316 | 644.667 | 286 / 560 | **112,1 tin/ngày** (06→18/10) |
| NewsItem (5 nguồn RSS) | 975 | 236.968 | 242 / 315 | **73,4 tin/ngày** (05→18/10) |
| **Tổng corpus ứng viên** | **2.291** | **881.635 (~0,85 MB ≈ ~350k token VN)** | — | **~185 doc/ngày** |
| MarketAssessment.detail (L2) | 62 | 773.099 | 12.469 TB | ~5 row/ngày |
| Signal.rationale (L2) | 51 | 16.515 | — | ~4/ngày |
| RelationInsight.narrative (L2) | 1 | 917 | — | 1/tuần |

**Nhận định quy mô:** 2.291 docs × ~385 ký tự TB = corpus NHỎ (GraphRAG được
thiết kế cho kho ≥ hàng trăm ngàn đến hàng triệu từ, cả sách/wiki/lưu trữ tin
nhiều năm). Ngoài ra cửa sổ corpus L1 hiện tại (500 tin + 200 tin) chỉ phủ
**~3-5 ngày** lịch sử — hệ thống thực chất “không có trí nhớ dài hạn”, đây mới
là khoảng trống thật mà nâng cấp nên lấp.

### 1.3 Mức sử dụng RAG hiện tại (RetrievalLog — cổng đo L3)

- 33 lần truy hồi (13 ngày gần nhất), **100% vào prompt**, topK TB 8,0 — RAG
  đang chạy thật mỗi chu kỳ qua `agent-context.ts:1195` → tiêm khối vào prompt
  5 agent nghiên cứu + Chủ tịch (≤1.200 token, guardrail “vô hại hoá”).
- Nghĩa là: nâng cấp có **người tiêu thụ sống sẵn** — không phải xây cho kho.

---

## §2 — HIỆN TRẠNG RAG L1 (để so sánh công bằng)

`src/lib/ml/rag.ts` — BM25 viết tay thuần TypeScript (0 dependency):

- Corpus cuộn: 500 AgentMessage broadcast + 200 NewsItem gần nhất, index
  in-process TTL 60s (~<50ms tính, 200-400ms WAN đọc DB).
- Xếp hạng hybrid `0,7·BM25 + 0,3·recency` (nửa đời 72h), k₁=1,5 · b=0,75.
- Tokenizer tiếng Việt giữ dấu + từ điển đồng nghĩa vĩ mô MACRO_SYNONYMS
  (F-12a: “lạm phát” ↔ “cpi” ↔ “inflation”…) — mở rộng query chi phí 0.
- Tham số tuỳ biến qua AppSetting ml-tuning (#89).

**Điểm yếu đo được:** (a) chỉ lexical — “cục nóng tín dụng” không trúng doc chỉ
nói “CRT2 nâng trần”; (b) cửa sổ 3-5 ngày — không có trí nhớ dài hạn; (c) xếp
hạng theo TỪ, không theo THỰC THỂ/quan hệ — không trả lời được “nhóm ngân hàng
từng phản ứng thế nào khi lãi suất điều hành tăng”.

**Điểm mạnh phải giữ:** fail-soft 100% (lỗi corpus → prompt y như cũ), chi phí
0 LLM/token khi query, guardrail vô hại hoá, cổng đo RetrievalLog.

---

## §3 — MICRO-TEST LLM THẬT (không ước lượng trên giấy)

3 cuộc gọi glm-4.6 qua z-ai-web-dev-sdk, prompt trích xuất thực thể kiểu
LightRAG/GraphRAG (chunk ≤1.200 ký tự, yêu cầu JSON `{entities, relationships}`):

| Tài liệu | Ký tự | Kết quả trích xuất | Token in/out | Độ trễ |
|---|---|---|---|---|
| AgentMessage (cash-management) | 777 | **12 thực thể + 4 quan hệ** | 466 / 676 | 14,3s |
| NewsItem macro (Tuổi Trẻ) | 203 | 4 thực thể + 3 quan hệ | 206 / 335 | 15,1s |
| NewsItem market (CafeF) | 316 | 4 thực thể + 3 quan hệ | 242 / 342 | 6,8s |

- **Chất lượng:** trích xuất tiếng Việt hoạt động tốt — nhận đúng kiểu thực thể
  tài chính (tổ chức/chỉ số/cổ phiếu/chỉ báo vĩ mô) và quan hệ nhân quả.
- **Chi phí TB/cuộc gọi:** 305 token vào / 451 token ra → **$0,0012/cuộc**
  (GLM-4.6 $0,6/$2,2 mỗi MTok).
- **Độ trễ:** 7-15s/cuộc → indexing PHẢI chạy nền tăng dần (async), không thể
  inline trong chu kỳ 240 phút (chu kỳ đang ~35-90s/agent là chấp nhận được,
  thêm 15s chặn từng chunk thì không).

---

## §4 — RÀNG BUỘC NỀN TẢNG (4 cái quyết định tính khả thi)

### 4.1 KHÔNG có endpoint embeddings trong z-ai-web-dev-sdk
Kiểm tra SDK: chỉ chat/vision/TTS/ASR/image/video/web-search — **không có
embeddings**. Cả LightRAG lẫn GraphRAG đều dựa vector embedding khi truy vấn:

- **LightRAG chịu được**: retrieval của nó là duyệt đồ thị thực thể theo từ khoá
  (local/global/hybrid mode) — có thể cắm `embedding_func` giả (TF-IDF/BM25
  sparse) hoặc **dùng lại query-builder BM25 + MACRO_SYNONYMS sẵn có = 0 cuộc
  gọi LLM thêm khi truy vấn**. Suy giảm chất lượng xếp hạng, không suy giảm
  kiến trúc.
- **GraphRAG gãy răng chính**: local search (mode tương thích “tiêm ngữ cảnh”)
  cần embedding để xếp hạng ứng viên; không embedding chỉ còn global search
  (map-reduce 10-30 cuộc gọi/truy vấn — xem 4.4).

Supabase có pgvector, nhưng không có model sinh embedding trong sandbox →
vector phải tự tính local (TF-IDF/SVD) → mất gần hết lợi ích “ngữ nghĩa” mà
đi lên graph-RAG nhằm tìm.

> **CẬP NHẬT TASK 141:** ràng buộc trên **ĐÃ ĐƯỢC GỠ** — chủ sở hữu cung cấp
> API key NVIDIA NIM (`integrate.api.nvidia.com/v1`); đo thật từ sandbox: key
> hợp lệ, egress thông, 2 model embedding sống được đều 2.048 dim, chất lượng
> ngữ nghĩa tiếng Việt tài chính tốt — chi tiết + tác động đến từng kết luận
> ở **§9**. SDK z-ai vẫn không có embeddings, nhưng NIM là lõi embed BÊN NGOÀI
> hợp lệ về mặt kiến trúc (giống các adapter Yahoo/Frankfurter đã có).

### 4.2 Độ trễ LLM 7-15s/cuộc trích xuất
Index toàn bộ 2.291 chunk × 2 cuộc = **~15 giờ LLM nối tiếp** (4 luồng song song
≈ 3,8h) — chỉ chấp nhận được như task nền Chủ nhật (đúng nhịp learning-rag A13
đã có). Incremental ~185 chunk/ngày ≈ 25-45 phút nền mỗi tối.

### 4.3 Chi phí — so với ngân sách LLM hiện tại $5,51/tháng (đo từ AgentRun 30 ngày)
| Kịch bản | Index 1 lần | Duy trì/ngày | ~Tháng |
|---|---|---|---|
| LightRAG (2 call/chunk) | **$5,38** (4.582 call) | $0,44 → **$0,20-0,25 nếu tuyển corpus §6** | ~$6-13 |
| GraphRAG (≈3,5 call/chunk + báo cáo cộng đồng) | **$9,47** (8.059 call) | $0,77 + tái phân cụm | ~$23+ |
| Tham chiếu: toàn hệ thống agent hiện tại | — | — | **$5,51** |

GraphRAG cộng thêm chi phí **tái phân cụm Leiden + viết lại báo cáo cộng đồng**
mỗi khi corpus đổi đáng kể — với nhịp +185 doc/ngày là gánh nặng lặp lại.

### 4.4 Kiến trúc tiêu thụ: RAG của THE TRADER là “MÁY TIÊM NGỮ CẢNH”, không phải “MÁY TRẢ LỜI”
`retrieveForCycle()` trả về **khối văn bản** ≤1.200 token, chèn vào prompt 6
agent, kèm guardrail “dữ liệu quá khứ dùng ĐỐI CHIẾU, không thay bằng chứng
định lượng hiện tại” (chống nhiễu quyết định + chống đếm kép T7.5):

- **LightRAG map 1:1**: truy hồi local/low-level → trả snippet ngữ cảnh thực thể
  → đóng thành khối — cùng hình dạng sản phẩm.
- **GraphRAG global search trả LỜI GIẢI TRÍCH ra từ LLM** sau map-reduce —
  tiêm “kết luận tổng hợp từ tin cũ” vào prompt hội đồng là **vi phạm ngược
  guardrail vô hại hoá** + mỗi truy vấn 10-30 cuộc gọi LLM.

---

## §5 — SO SÁNH TRỰC TIẾP (7 tiêu chí, toàn bộ theo số đo ở trên)

| Tiêu chí | LightRAG | GraphRAG (Microsoft) | Ghi chú theo § |
|---|---|---|---|
| Quy mô corpus hợp lý | 10²-10⁴ docs (đúng 2.291) | ≥10⁴-10⁶ docs | §1.2 |
| Chi phí index (đo) | $5,38 | $9,47 + tái phân cụm | §4.3 |
| Chi phí/truy vấn | 0-1 cuộc LLM (tách từ khoá; hoặc 0 dùng BM25 query sẵn) | 10-30 cuộc (global) / cần embedding (local) | §4.1, §4.4 |
| Lõi embed (cập nhật 141) | **CÓ**: NIM `nemotron-3-embed-1b` 2.048 dim đo thật (§9) | Cũng có — nhưng vẫn thua 6 tiêu chí còn lại | §4.1, §9 |
| Cập nhật tăng dần (+185 doc/ngày) | Insert incremental — thực thể gộp dần | Cần tái phân cụm cộng đồng | §4.3 |
| Khớp kiến trúc tiêm khối ngữ cảnh | Đúng 1:1 | Không khớp (sinh câu trả lời) | §4.4 |
| Đồ thị đủ sâu để phân cụm cộng đồng có nghĩa? | Không cần cộng đồng | **Chưa đủ**: ~2.291 doc ngắn → ~500-1.500 thực thể sau gộp — cộng đồng Leiden sẽ nông/trivial | §1.2 |

**Phán quyết: LightRAG phù hợp hơn trên cả 7 tiêu chí.** GraphRAG không “xấu” —
nó giải bài toán khác (sensemaking kho lớn, hỏi tổng quan chủ đề) mà THE TRADER
chưa có dữ liệu đủ lớn lẫn use case tiêu thụ (§7).

---

## §6 — LỘ TRÌNH KHUYẾN NGHỊ NẾU LÀM (không thay L1, mà THÊM L2)

> Nguyên tắc giữ gìn: fail-soft 100%, 0 thay đổi hành vi chu kỳ khi L2 lỗi,
> cổng đo trước/sau (RetrievalLog mở rộng), guardrail vô hại hoá giữ nguyên.

1. **TUYỂN CORPUS trước khi đổi công nghệ** (bài toán chất lượng > thuật toán):
   hiện broadcast gồm ml 406 + platform 242 + control 166 = **814/1.316 tin
   (62%) là telemetry vận hành** (“train xong valAcc…”, “nguồn dữ liệu sống”).
   Corpus L2 chỉ lấy: research 290 tin + executive 212 tin + NewsItem macro 687
   + MarketAssessment narrative (773k ký tự — kho lớn nhất chưa khai thác) +
   DecisionEvaluation (WIN/LOSS 48 tín hiệu — “bài học” đúng nghĩa) +
   RelationInsight. → ~1.500 doc (~1.550 chunk), ~1,1 MB, chi phí index rơi về
   **~$3-4 một lần**.
2. **Bootstrap đồ thị từ dữ liệu ĐÃ CÓ thay vì để LLM tự sáng**:
   - 104 mã Instrument (kèm market/ngành) = từ điển thực thể gốc — trích xuất
     LLM chỉ cần BỔ SUNG thực thể ngoài danh mục (tổ chức nước ngoài, sự kiện),
     giảm gọi và tăng chuẩn hoá tên;
   - MACRO_SYNONYMS = ontology vĩ mô sẵn 11 nhóm;
   - MarketRelation (40 cạnh, corr + P(đích|nguyên) đo được) = cạnh định lượng
     THẬT — cạnh LLM trích chỉ mang vai trợ giải thích, không được đè lên số đo.
3. **Kiến trúc mini-service nền**: indexing tăng dần trong nhiệm vụ learning-rag
   A13 (Chủ nhật) + hàng đêm ~30 phút; lưu đồ thị ở bảng Postgres mới
   (KnowledgeEntity/KnowledgeEdge/KnowledgeChunk — không cần neo4j, 2.291 chunk
   Postgres xử lý nhẹ nhàng); nhớ `created_at` mỗi cạnh để **lọc thời gian khi
   truy hồi** (bài toán half-life 72h của domain — đồ thị tri thức phải biết
   mình cũ ở đâu). Vector 2048 dim (§9) lưu cùng chunk dạng JSONB/bytea —
   2.291 doc × 2.048 float ≈ 19MB RAM, quét cosine in-memory <50ms; **pgvector
   chỉ cần khi kho vượt ~50k doc** (đúng ngưỡng reconsider GraphRAG §7).
4. **Truy vấn hybrid BM25 + vector NIM (cập nhật Task 141)**: giữ query-builder
   BM25 + MACRO_SYNONYMS sẵn có làm đường từ khoá; THÊM embedding query qua NIM
   `nemotron-3-embed-1b` (2.048 dim, ~0,6s, §9) xếp hạng NGỮ NGHĨA top-K chunk
   → ánh xạ token vào thực thể đồ thị → duyệt 1-2 bước láng giềng → top-K cạnh
   /snippet kèm mốc thời gian → đóng khối “TRI THỨC DÀI HẠN (L2)” tách khỏi khối
   L1 hiện tại. Fail-soft 2 tầng: NIM lỗi/quá hạn/key hết credit → rơi về BM25
   thuần, chu kỳ không bao giờ bị phá (nguyên tắc §6 giữ tuyệt đối).
   RetrievalLog thêm `layer: "L1"|"L2"` để đo cổng.
5. **Cổng quyết định theo văn hoá THE TRADER**: sau ≥30 ngày chạy song song, so
   (a) tỉ lệ L2 hit có thực thể liên quan đúng, (b) thay đổi chất lượng phiếu
   hội đồng (nếu có), (c) chi phí — rồi mới cân nhắc mở rộng corpus toàn văn
   bài báo / bật pgvector / nâng tỉ trọng vector trong hybrid.

## §7 — KHI NÀO CÂN NHẮC LẠI GRAPHRAG

Cả 3 điều kiện phải đồng thời đạt:
1. **Corpus ≥ 50-100k doc** — ví dụ ingest toàn văn bài báo (hiện chỉ title +
   summary ~250-315 ký tự, quá mỏng để trích quan hệ giàu); ở nhịp +185
   doc/ngày cần ~1-1,5 năm, hoặc chủ động bật crawler toàn văn.
2. **Có endpoint embeddings thật** — ~~chưa có~~ **ĐÃ ĐẠT từ Task 141** (NIM
   `nemotron-3-embed-1b`, §9); điều này còn giúp GraphRAG local search chạy
   được về mặt kỹ thuật.
3. **Use case đổi sang “hỏi tổng quan”** — vd. báo cáo tuần cho chủ sở hữu
   “5 chủ đề lớn tác động VN30 tháng này” — lúc đó global search map-reduce
   chính là sản phẩm, chạy 1 lần/tuần (không phải mỗi chu kỳ).

→ Sau Task 141, GraphRAG chỉ còn bị chặn bởi **điều kiện 1 và 3** — đều là bài
  toán dữ liệu/use case, không phải hạ tầng.

## §8 — GIỚI HẠN CỦA BẢN ĐÁNH GIÁ

- Micro-test chỉ 3 cuộc gọi — đủ đo bậc độ lớn chi phí/độ trễ, chưa đo chất
  lượng trích xuất trên mẫu lớn (đánh giá chất lượng thực thể cần human review
  ~100 doc — nằm ở bước cổng §6.5 nếu triển khai).
- Chi phí GraphRAG dùng hệ số 3,5 call/chunk + 40 báo cáo cộng đồng (literature
  LightRAG/GraphRAG: index GraphRAG đắt hơn LightRAG ~1,5-2× ở dạng chuẩn có
  embedding; ở đây dạng rút gọn vì không embedding) — chênh lệch tuyệt đối nhỏ
  ($5-10) nên không đổi kết luận.
- Số liệu AgentMessage chỉ phủ 13 ngày (DB epoch hiện tại 06/10→18/10) — corpus
  sẽ lớn dần; §7 đã nêu ngưỡng reconsider.

## §9 — CẬP NHẬT TASK 141: LÕI EMBED NVIDIA NIM (đo thật với key của chủ sở hữu)

Chủ sở hữu hỏi: *"endpoint embeddings ở đây là lõi embed phải không, nếu dùng 1
lõi embed của NVIDIA NIM được không — tôi nhớ NIM có lõi 2048 dim"*. Trả lời
bằng số đo từ `scripts/p141-nim-embed-test.ts` (chạy thật từ sandbox, key đặt
trong `.env.local` — không in key ra log):

### 9.1 Xác nhận thuật ngữ + kết nối + quyền
- **Thuật ngữ:** đúng — "endpoint embeddings" = **lõi embed** (model nhúng văn
  bản): biến đoạn text → vector sao cho *văn gần nghĩa → vector gần nhau*. Thiếu
  nó thì graph-RAG chỉ tìm theo CHỮ (BM25/keyword), không theo NGHĨA.
- **Egress sandbox → `integrate.api.nvidia.com/v1`: THÔNG** (169-173ms).
- **Key HỢP LỆ.** Catalogue: 81 model, trong đó 7 model embedding; 0 rerank.
- **Trí nhớ "2048 dim" ĐÚNG:** cả 2 model chạy được đều trả **2.048 chiều**.
- Lưu ý catalogue đã đổi đời: 4 tên model đời cũ (`llama-3.2-nv-embedqa-1b-v2`,
  `nv-embedqa-e5-v5`, `baai/bge-m3`, `nv-embed-v1`) giờ **HTTP 410 Gone (EOL)**;
  5/7 model còn lại **HTTP 404 "Function not found for account"** (bị chặn theo
  tài khoản, không phải EOL).

### 9.2 Hai model sống được — dim / latency / token

| Model | Dim | Độ trễ query | Độ trễ batch 3 doc | Token in |
|---|---|---|---|---|
| **nvidia/nemotron-3-embed-1b** ⭐ khuyến nghị | **2.048** | 572ms | 789ms | 22 / 120 |
| nvidia/llama-nemotron-embed-vl-1b-v2 | 2.048 | 783ms | 980ms | 21 / 127 |

Batch-nhiều-text-trong-1-request hoạt động → index 2.291 doc chỉ ~25-50 request.
Độ trễ ~0,6s/cuộc query chấp nhận được cho pipeline truy hồi chu kỳ (đang tốn
200-400ms chỉ đọc DB).

### 9.3 Chất lượng ngữ nghĩa tiếng Việt tài chính (cosine, cao = gần nghĩa)

Query: *"lạm phát CPI tháng 9 tăng nóng, dư địa lãi suất điều hành"*

| Model | Doc CPI tiếng Việt | Doc CPI tiếng Anh | Doc bóng đá | Biên tách nghĩa |
|---|---|---|---|---|
| **nemotron-3-embed-1b** | **0,548** | 0,455 | **0,059** | **0,489 (~9×)** |
| llama-nemotron-embed-vl-1b-v2 | 0,499 | 0,362 | 0,086 | 0,413 |

Đọc đúng cách: với bài toán RAG, điều quyết định là **biên xếp hạng related-vs-
unrelated**, không phải trị tuyệt đối — `nemotron-3-embed-1b` tách doc cùng nghĩa
vs doc hoàn toàn ngoài đề với biên 0,489 (tỉ lệ ~9×) → xuất sắc cho top-K
ranking; cross-lingual 0,455 dùng tốt cho tin tiếng Anh (US10Y, Fed…). Đây chính
là thứ BM25 thuần lexical KHÔNG làm được (điểm yếu §2-a) — và là lý do L2 nên
chạy hybrid ngay từ đầu.

### 9.4 Tác động đến từng kết luận của Task 140

| Mục | Trước (Task 140) | Sau (Task 141) |
|---|---|---|
| Ràng buộc lõi embed §4.1 | SDK không có → keyword mode | **ĐÃ GỠ** — NIM 2 model 2.048 dim sống, latency query ~0,6s |
| Đề xuất truy vấn §6.4 | BM25 + đồ thị thực thể (0 LLM) | **Hybrid BM25 + vector NIM** — fail-soft về BM25 khi NIM lỗi/hết credit |
| LightRAG vs GraphRAG §5 | LightRAG 7/7 | **LightRAG 6/7 tiêu chí còn lại** — lõi embed chỉ là 1/7; corpus 2.291 doc vẫn là đất LightRAG |
| Điều kiện GraphRAG §7 | 3 điều kiện | Điều kiện 2 **đã đạt**; còn chặn ở corpus ≥50-100k doc + use case hỏi tổng quan |

### 9.5 Chi phí embedding (từ token đo được — cần đối chiếu bảng giá/credit NIM)
- Corpus tuyển §6.1 (~1.550 chunk ≈ 240k token): one-time embed **$0,005-0,02**
  nếu giá kiểu OpenAI (~$0,02-0,10/MTok) — hoặc **~$5-7** nếu NIM tính
  ~$0,02/1K token. Toàn kho 2.291 doc (~353k token) tương ứng $0,007-0,04 /
  $7.
- Incremental ~185 doc/ngày ≈ 15k token/ngày: không đáng kể ở cả hai mức giá;
  query 1 chu kỳ ~50 token.
- **Nghiệm vụ cho chủ sở hữu:** xem số dư credit + đơn giá chính xác của key
  `nvapi-cld-…` tại build.nvidia.com (credit dev thường được tặng — số dư quyết
  định chuyện này gần như miễn phí hay $5-10/tháng).

### 9.6 Bảo mật key
- Key nằm trong **`.env.local`** (bị git ignore) — KHÔNG trong `.env` (file này
  đang được track theo #113 để khôi phục cấu hình sau sandbox reset). Lần đầu
  append nhầm vào `.env` đã revert sạch trước khi commit (đối chiếu `git diff
  .env` = 0 dòng).
- Key từng dán trong hội thoại chat — nếu hội thoại được chia sẻ rộng, nên
  **rotate** tại build.nvidia.com.
- Riêng tư dữ liệu: nội dung gửi ra NIM là tin tức công khai + nhận định thị
  trường nội bộ (không PII) — nêu rõ để chủ sở hữu quyết định chủ động.
- Kiến trúc khi triển khai: lib `nim-embed.ts` gọi backend-only, key không lộ về
  client, timeout 30s + fail-soft về BM25 thuần.

**Kết luận §9: NVIDIA NIM gỡ đúng ràng buộc lớn nhất của Task 140 và xác nhận
trí nhớ 2.048 dim của chủ sở hữu. Lộ trình L2 (§6) chuyển sang hybrid BM25 +
vector NIM (`nemotron-3-embed-1b`) ngay từ đầu. Phán quyết LightRAG vs GraphRAG
KHÔNG ĐẢO — corpus vẫn quá nhỏ cho GraphRAG.**

---

## §10 — TRIỂN KHAI L2 (Task 142 · 2026-10-18) — NGHIỆM THU

Chủ sở hữu: *"Tiến hành triển khai lớp L2 đi"* — đã dựng trọn §6 và đo sống:

### 10.1 Kiến trúc triển khai (mọi con số đều verify được)
| Thành phần | Hiện trạng |
|---|---|
| **Schema** | 3 bảng mới: `KnowledgeChunk` (embedding Bytes Float32[2048] 8KB, unique refTable+refId, embedAttempts<3) · `KnowledgeEntity` (70 thực thể: stock 33 + macro 11 + org 10 + node 9 + index 3 + asset 4) · `KnowledgeEdge` (510 cooccur + 40 market-relation) + `RetrievalLog.layer` (L1/L2, backfill 33 hàng cũ = L1) |
| **Kho** | **1.639 chunk — 100% có vector NIM**: 502 AgentMessage research/executive + 975 NewsItem + 62 narrative MarketAssessment (kho 773k ký tự lần đầu được dùng) + 51 Signal + 48 bài học DecisionEvaluation + 1 RelationInsight · pending = 0 |
| **Client NIM** | `src/lib/ml/nim-embed.ts` — backend-only, key shim đọc `.env.local` kiểu db.ts #110-g (dev server boot trước khi key tồn tại vẫn chạy), batch 16, retry 429, throw để caller fail-soft |
| **Retrieval** | Hybrid `0,45·BM25 + 0,45·cosine + 0,1·độ tươi (nửa đời 30 ngày)`; filter `bm25>0 ∨ cos≥0,30`; query vector cache 60s (6 agent/chu kỳ chung query); đồ thị 4 dòng (market-relation corr/P(cond)/n/lag ưu tiên trước cooccur) |
| **Tiêm prompt** | 13 điểm: 6 single-run (agent-context) + 5 agent nghiên cứu + risk-manager + Chủ tịch (run route) — sau L1, trước XREL (tầng nóng → dài hạn → quan hệ) |
| **Tự chữa** | Mỗi truy hồi index ≤32 doc mới (budget 12s) — kho tự lớn theo +185 doc/ngày, không cần cron mới; bootstrap lại qua `POST /api/ml/l2` |
| **Đo lường** | RetrievalLog layer="L2" + `GET /api/ml/l2` + `GET /api/ml/status` field l2 + thẻ UI "Tri thức dài hạn (L2)" (tab Dữ liệu — 1.639 chunk · vector 100% · 70 thực thể) |

### 10.2 Bằng chứng sống (verify 18-10, `scripts/p142-verify-l2.ts` — PASS toàn bộ)
- Vector decode 2.048 dim finite từ DB · roundtrip Bytes↔Float32 cosine=1 · 0 trùng (refTable,refId).
- Truy hồi thật: **8/8 hit có điểm cosine** (vector sống trên cả corpus) · query vector NIM dùng thật · block 1.830 ký tự ≤2.200 · 4 dòng đồ thị · cạnh market-relation mang meta corr.
- **Fail-soft BM25-only**: rankL2 với queryVector=null vẫn trả 8 hit — NIM chết/hết credit hệ thống vẫn sống (đúng §6 nguyên tắc).
- **Vào prompt agent THẬT**: single-run macro-economist 16:41 → RetrievalLog layer=L2 `usedInPrompt=true` — chuỗi NIM→chunk→hybrid→prompt→phản hồi agent khép kín.
- E2E browser desktop + mobile 390px: thẻ L2 render đúng số liệu sống · 0 lỗi console/page · 0 tràn ngang · footer flush.

### 10.3 Chi phí NIM thực chi (bootstrap)
1.639 chunk embed ở lần chạy đầu ≈ **~300k token vào** (corpus ~750k ký tự ÷ 2,5) — chưa thấy 402/429; chủ sở hữu đối chiếu credit tại build.nvidia.com. Incremental ~185 doc/ngày ≈ 15k token/ngày + 1 query/chu kỳ (~50 token) — không đáng kể.

### 10.4 Còn treo (đúng thiết kế — không phải nợ ẩn)
- **LLM trích thực thể bổ sung** (§6.2 phần "LLM chỉ BỔ SUNG"): chưa bật — chờ chủ sở hữu xác nhận số dư credit NIM; từ điển hiện phủ 70 thực thể xác suất cao (mã + vĩ mô + org + node MarketRelation).
- **Cổng §6.5**: cần ≥30 ngày chạy song song L1/L2 trước khi so sánh chất lượng phiếu hội đồng — mọi số đo đã sẵn (RetrievalLog theo layer).
- 2 lần truy hồi L2 đầu tiên `usedInPrompt=false` là của verify script (trung thực — không phải chu kỳ thật); lần 16:41 single-run = true.

---

*Tài liệu liên quan: `docs/ML_LEARNING_BLUEPRINT.md` (L1-L3), `docs/AUDIT_137.md`
(văn hoá trung thực số liệu), script bằng chứng `scripts/p140-rag-data-volume.ts`
+ `scripts/p141-nim-embed-test.ts`.*

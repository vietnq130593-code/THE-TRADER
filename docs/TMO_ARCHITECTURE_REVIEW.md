# ĐÁNH GIÁ KIẾN TRÚC TMO (THEOPUSFLASHLITE) — GÓC NHÌN KIẾN TRÚC SƯ

> Tài liệu đánh giá kiến trúc phục vụ 2 mục đích: (1) bằng chứng chuyên môn khi phỏng vấn vị trí AI Engineer; (2) nguồn dựng bullet CV cho dự án TMO (bổ sung vào CV docs như THE TRADER và CRM Level 1 Haircare).
> Đánh giá bởi vai trò kỹ sư AI / kiến trúc sư hệ thống, dựa trên khảo sát trực tiếp repo `vietnq130593-code/TMO` (Task 150-a, 20/10/2026).
> Quy ước: mọi số liệu đều kèm nguồn verify trong repo. KHÔNG dùng tên "Magnum Opus" trong CV — gọi **TMO (Theopusflashlite)**.

---

## 1. Tuyên bố kiến trúc (architecture statement)

TMO là **nền tảng AI đa tác tử tổng dụng** (general-purpose AI platform) kết hợp 4 trụ cột:

1. **Code Team** — quy trình sinh mã đa tác tử (Team Lead → Generator → Verifier)
2. **Skills Marketplace** — 52 skill hệ thống + 6 năng lực AI (Web Search, Page Reader, TTS, ASR, VLM, Image Generation)
3. **GraphRAG Knowledge Base** — ingest PDF → trích xuất thực thể/quan hệ → đồ thị tri thức + vector
4. **Hybrid Search** — truy vấn lai vector + duyệt đồ thị + hợp nhất thứ hạng + sinh câu trả lời có hiệu chuẩn độ tin cậy

Khác THE TRADER (đa tác tử ra quyết định giao dịch, REST-first, BM25 RAG trên dữ liệu thị trường), TMO là **graph-first**: tri thức được tổ chức thành đồ thị Neo4j + vector Qdrant, agent tự sinh–kiểm chứng mã nguồn, và có lớp tự động hóa–tự quan sát–tự sao lưu cho vận hành dài hạn.

---

## 2. Bản đồ kiến trúc (đã verify trong code)

```
UI SPA (Next.js 16 · TypeScript 5 · 1 page.tsx ~3.231 dòng · tabs Chat/Agents/Smolab/Database/Analytics/Explorer/Neural)
└─ 226 API routes / 49 nhóm (openclaw, opencode, query, ingestion, brain, observation, debt, eval, redteam, voice…)
   ├─ AGENT LAYER — 15 agents / 4 đội
   │   · Code Team 5: MEGATRON-TL → SHOCWAVE-G1 → RAMPAGE-G2A / SENTINEL-G2B → CATALYST-G3
   │     (code-team/ 20.952 dòng: workflow-engine, tool-executor, pending-edit review)
   │   · Research Team 5: NEMESIS (TL) · SIVIL/BELI (G1) · LISMA (G2) · HAN (G3)
   │   · Standalone 4: OMEGA (orchestrator + Agent Factory tự sinh agent) · ALISTA · Linh Sickyx · FORGE
   │   · OPUS — CTO meta-agent (review dossier 5 tầng, không tự thi công)
   │   · agent-roster: danh bạ kỹ năng inject vào system prompt mọi agent
   │   · goal-loop DURABLE 9.146 dòng: DB-as-queue + checkpoint + sweepOrphans + starvation preemption
   ├─ AI/ML LAYER — ML TypeScript thuần 0 thư viện
   │   · llm.ts 6.411 dòng: pool NVIDIA NIM + Mistral + OpenRouter + Cerebras + Zen,
   │     xoay key theo slot + failover + token payroll theo từng agent
   │   · brain/ 11.338 dòng: 4 não (calibration MLP / surrogate / policy mixture / knowledge)
   │   · EVO-NAS: search không gian 144 chiều (attention + SSM block + micro-MoE, tournament)
   │   · calibration V1 → V2 (10-feature) → V3 (5-fold CV Brier, fail-open)
   ├─ GRAPHRAG LAYER
   │   · ingestion: PDF → chunk → LLM extract entities/rels → entity-resolver
   │     (Naive Bayes + fuzzy) → buffer → Neo4j + Qdrant
   │   · Neo4j: 175.823 entity nodes / 204.629 rels (comment code TASK 52) · 13 label · 15 rel types
   │   · Qdrant: 6 collection (documents, chunks, communities, episodes, agent_memory,
   │     task_context) · embed 2048-dim nemotron-3-embed-1b (OpenRouter fallback)
   │   · kb-routing 5.246 dòng: intent-classifier → query-rewriter → hybrid vector + graph
   │     + RRF → MMR → reranker → synthesis kèm hiệu chuẩn độ tin cậy
   │   · Leiden community detection 680 dòng thuần TS → community summary embed
   ├─ AUTOMATION LAYER
   │   · automation-engine: cron cấu trúc + webhook HMAC + heartbeat + standing orders
   │   · 4 mini-services: cron-scheduler :3004 · openclaw-gateway :18789 ·
   │     opencode-server :18790 · gateway-bridge :18791 (REST→WebSocket)
   └─ RESILIENCE / OBSERVABILITY
       · DebtLedger: sổ nợ lỗi hạ tầng — 4 đường ghi crash-proof (đường thứ 4 khép P-R16-1/V2)
       · ObservationEvent ledger + timeline + alerts thế hệ 2 · giao thức quan sát 18 vòng (R1–R18)
       · ToolMetric 1:1 mọi tool call · MemWatchdog + SelfExitDrain (RSS ratchet exit sạch)
       · Backup R2/S3 sha256-verify + restore drill + swap atomic · Supabase sync 24 bảng
```

---

## 3. Đánh giá kiến trúc sư

### 3.1 Điểm mạnh (chọn lọc theo keyword AI Engineer)

1. **GraphRAG end-to-end tự xây** — theo hướng Microsoft GraphRAG: trích xuất thực thể/quan hệ bằng LLM → đồ thị 175K nodes/204K rels → Leiden community detection thuần TS → community summary embed → hybrid retrieval (vector + graph traversal + RRF + MMR + reranker) → synthesis kèm hiệu chuẩn độ tin cậy 3 thế hệ (logistic → 10-feature → MLP, 5-fold CV Brier, fail-open). **Đây là điểm khác biệt lớn nhất so với 99% portfolio RAG chỉ chunk + embed + cosine.**
2. **Multi-agent có kỷ luật production** — 15 agents/4 đội + danh bạ kỹ năng inject prompt + Omega Agent Factory (tự sinh agent theo nhu cầu) + Opus CTO review 5-tầng-dossier + goal loop durable sống sót restart. Đúng keyword "AI Agent" của JD ở mức kiến trúc, không phải demo chatbot.
3. **Automation + self-healing là tính năng thật** — DebtLedger ghi nợ lỗi hạ tầng 4 đường crash-proof (mỗi run crash = 1 lần ghi, dedup), giao thức quan sát 18 vòng lặp, alerts thế hệ 2, MemWatchdog chống RSS ratchet. AI ops thực chiến, có commit lịch sử chứng minh từng vòng vá.
4. **ML TypeScript thuần ~11K dòng** (4 não + EVO-NAS 144-dim với attention/SSM/MoE) — nhất quán triết lý THE TRADER: implement từ số 0 để hiểu bản chất.
5. **LLM API ops** — pool 4+ provider xoay key slot + failover + token payroll từng agent. Đúng keyword "tích hợp LLM API" + ý thức chi phí.

### 3.2 Điểm hạn chế / thách thức (chuẩn bị trả lời phỏng vấn — KHÔNG ghi CV)

| Hạn chế | Cách trả lời khi bị hỏi |
|---|---|
| 4 mini-service chia sẻ SQLite và do app spawn — "single-operator platform", chưa multi-tenant/multi-node; SQLite là trần scale | "Thiết kế cố ý cho single-operator với PM2 + Caddy; biết rõ trần scale của SQLite buffer, roadmap tách Postgres khi cần đa người dùng" |
| Bus factor 1 + 55 docs tiếng Việt trộn blueprint thiết kế với log vận hành — ngoài tác giả khó onboard; README drift (1536-dim vs 2048-dim thật) | "Đây là dự án solo có chủ đích; README drift là bài học — THE TRADER đã có quy ước docs version nghiêm ngặt hơn (DB_SCHEMA v0.9.6)" |
| Một số subsystem ở chế độ cờ OFF (Brain-C policy steering, một số cờ observation) | "Đã triển khai + kill-switch, đang thu thập dữ liệu trước khi bật — trung thực hơn là nói 'đang chạy'" |

### 3.3 So sánh với THE TRADER (1 câu)

> THE TRADER là cụm 24 AI agent đồng thuận 80% ra quyết định giao dịch realtime (REST-first, BM25 RAG trên dữ liệu thị trường), còn TMO mở rộng thành nền tảng AI tổng dụng: GraphRAG graph-first (Neo4j + Qdrant + Leiden) cho tri thức, agent tự sinh–kiểm chứng mã nguồn, và lớp tự động hóa–tự quan sát–tự sao lưu cho vận hành dài hạn.

---

## 4. Fact sheet — số liệu verify (nguồn: khảo sát repo 20/10/2026)

| Chỉ số | Giá trị | Nguồn verify |
|---|---|---|
| LOC TS/TSX | **299.580** | `git ls-files '*.ts' '*.tsx' | xargs wc -l` |
| File TS/TSX | ~839–857 | rg --files / git ls-files |
| API routes | **226** trong 49 nhóm | `find src/app/api -name route.ts` |
| Phân bổ LOC | src/lib 157.860 · src/app 51.373 · components 41.673 · mini-services 2.248 | wc -l |
| Model Prisma | **106** (schema 2.818 dòng, 5 migration) | `rg -c '^model '` prisma/schema.prisma |
| Agents | **15** = 4 standalone (Omega, ALISTA, Linh Sickyx, FORGE) + 5 Code Team (MEGATRON-TL, SHOCWAVE-G1, RAMPAGE-G2A, SENTINEL-G2B, CATALYST-G3) + 5 Research (NEMESIS, SIVIL, BELI, LISMA, HAN) + Opus CTO | standalone-agents.ts · code-team/agents.ts · research-team/agents.ts · opus/opus-agent.ts |
| Module lớn | code-team 20.952 · research-team 18.484 · brain 11.338 · goal-loop 9.146 · llm 6.411 · kb-routing 5.246 · leiden 680 (thuần TS) | wc -l |
| Neo4j graph | **175.823 nodes / 204.629 rels** · 13 label · 15 rel types | comment code kb-routing/communities.ts (TASK 52) + neo4j.ts |
| Qdrant | **6 collection** · embed **2048-dim** nemotron-3-embed-1b (OpenRouter fallback) | backup/qdrant-snapshot.ts · embeddings.ts |
| Mini-services | **4**: cron-scheduler :3004 · openclaw-gateway :18789 · opencode-server :18790 · gateway-bridge :18791 | mini-services/*/index.ts |
| Skills | **52** filesystem + 6 năng lực AI marketplace | `ls skills/` · skill-tool-schema.ts |
| SSE endpoints | **6** streaming | rg 'text/event-stream' |
| Test | **97** file test (87 tests/ + 10 src/); vòng test đánh số tới r126 (27/27 pass vòng cuối) | find + commit R17 |
| LLM pool | NVIDIA NIM + Mistral + OpenRouter + Cerebras + Zen; slot-rotation key + failover + token payroll theo agent | llm.ts (6.411 dòng) |
| ASR | gRPC NVIDIA Riva parakeet-ctc-0.6b-vi (Việt–Anh streaming, proto nhúng JSON) | riva/asr.ts + @grpc/grpc-js |
| Backup | R2/S3 + SQLite auto-backup 24h sha256-verify + restore drill + swap atomic | backup/ · PLAYBOOK round-32 |
| Supabase | cloud sync **24 bảng** | supabase-sync.ts |
| Docs/blueprint | **55** file md (BLUEPRINT-BRAIN/EVO-NAO/HYPERNAS/STATS/OBSERVATION-V3, ALISTA, OPENCLAW, SMOLAB + 16 TB-xx + QUAN-SÁT R8–R17) | find docs |
| Git | shallow clone 50 commit (13–20/10/2026) — lịch sử thật dài hơn (PLAYBOOK round-68, test r126); ghi CV trung thực "50+ commit chỉ trong tuần cuối" | git log |

---

## 5. Bullet CV tiếng Việt (đã chốt cho generate.cjs — Task 150)

> Tiêu đề: **TMO (THEOPUSFLASHLITE) — Nền tảng AI đa tác tử: GraphRAG, đội agent sinh mã tự chủ, tự động hóa vận hành**
> Meta: Kiến trúc sư và nhà phát triển duy nhất — solo, end-to-end · Next.js 16 · TypeScript 5 · Neo4j · Qdrant · Bun · PM2

1. **Quy mô + đa tác tử**: Thiết kế nền tảng AI Agent gần 300.000 dòng TypeScript: 226 API routes, 106 mô hình dữ liệu, 15 agents chia 4 đội (điều phối · sinh mã · kiểm chứng · nghiên cứu) cùng CTO meta-agent review 5 tầng và Agent Factory tự sinh agent mới theo nhu cầu.
2. **GraphRAG**: Tự xây pipeline GraphRAG end-to-end: PDF → phân đoạn → LLM trích xuất thực thể/quan hệ → đồ thị Neo4j hơn 175.000 thực thể / 204.000 quan hệ + Qdrant vector 2048 chiều; truy vấn lai vector + duyệt đồ thị + hợp nhất thứ hạng RRF, phân cụm cộng đồng Leiden thuần TypeScript, hiệu chuẩn độ tin cậy câu trả lời bằng MLP.
3. **Automation + self-healing**: AI automation tự chữa: engine cron lịch cấu trúc + webhook ký HMAC + standing orders; vòng goal-loop dài giờ sống sót restart (DB-as-queue, checkpoint, quét tác vụ mồ côi); sổ nợ lỗi hạ tầng DebtLedger 4 đường ghi crash-proof, hệ tự quan sát 18 vòng.
4. **LLM ops + kỹ nghệ**: Pool LLM API đa nhà cung cấp (NVIDIA NIM, Mistral, OpenRouter) xoay key theo slot, failover tự động, tracking token theo từng agent; 4 mini-services, nhận diện giọng nói Việt–Anh qua gRPC NVIDIA Riva, streaming SSE, Monaco editor kèm diff review, backup R2 tự verify + Supabase sync 24 bảng.

---

## 6. Q&A phòng thủ phỏng vấn riêng TMO (bổ sung cho bảng Q&A của THE TRADER)

| Câu hỏi khó | Trả lời xoay sáng |
|---|---|
| **Sao tự code Leiden / NAS / calibration mà không dùng thư viện Python?** | Cùng triết lý THE TRADER: tự triển khai để hiểu đen hộ — biết chính xác layer nào framework giấu. GraphRAG của Microsoft là tham chiếu thiết kế, không phải dependency; khi dùng framework sẽ debug + tune được thay vì gọi magic |
| **176K nodes graph vậy retrieval nhanh không?** | Hybrid 2 lớp: vector hit trước (Qdrant 2048-dim) → graph expansion quanh thực thể hit → RRF hợp nhất; Leiden community summary giúp truy vấn tổng quan không phải duyệt toàn đồ thị |
| **Đa tác tử sinh mã có tin được không?** | Đúng nên hoài nghi — nên có pending-edit review (Generator không tự merge), Verifier riêng, Opus CTO phán đoán run-KẾT, DebtLedger ghi nợ mọi lỗi hạ tầng để vòng sau tự chữa |
| **15 agents có phải marketing không?** | Mỗi agent có roster kỹ năng inject system prompt + token payroll riêng + ToolMetric 1:1 mọi tool call — đo được thì không phải marketing |

---

*Tài liệu Task 150 (20/10/2026). Số liệu lấy từ khảo sát repo trực tiếp — xem fact sheet §4 để đối chiếu nguồn khi phỏng vấn.*

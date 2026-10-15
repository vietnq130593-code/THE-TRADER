# TÀI LIỆU NGUỒN DỰNG CV — DỰ ÁN THE TRADER

> Tài liệu nội bộ phục vụ soạn CV + chuẩn bị phỏng vấn vị trí **AI Engineer (LLM / RAG / AI Automation)**.
> Tên dự án: **The Trader** — Hệ thống giao dịch đa tác tử (Multi-Agent Trading System).
> ⚠️ Ghi chú: KHÔNG dùng tên "TMO" (đó là dự án khác, đã viết nhầm) — mọi nơi trong CV/phỏng vấn đều gọi **The Trader**.

---

## 1. Bối cảnh ứng tuyển (nắm chắc trước khi viết CV)

| Hạng mục | Chi tiết |
|---|---|
| Công ty | NEXGEN BROS CO., LTD (25–99 nhân viên, lĩnh vực eCommerce/MarTech) |
| Vị trí | AI Engineer (LLM / RAG / AI Automation) |
| Địa điểm | 564 Võ Nguyên Giáp, P. Phước Long A, TP. Thủ Đức, HCM |
| Thu nhập | 15–25 triệu (thỏa thuận theo năng lực) |
| Giờ làm | T2–T6, 8h30–17h30 + Thứ 7 cách tuần |
| **Hạn nộp** | **31/10/2026** |
| Nộp CV | `lananh.ta@nexgenbros.com` — tiêu đề: `HỌ VÀ TÊN – AI ENGINEER` |

**JD — Bạn sẽ làm gì:**
1. Xây dựng **RAG, AI Agent, chatbot và workflow AI** cho sản phẩm eCommerce/MarTech
2. **Tích hợp LLM API, xử lý dữ liệu, tối ưu prompt & chất lượng output**
3. Phối hợp cùng team Dev, Marketing và Vận hành triển khai tính năng AI thực tế

**JD — Yêu cầu:**
1. Từ 1 năm kinh nghiệm AI/ML/Backend **hoặc có project thực tế** về LLM, RAG, AI Agent
2. Biết **Python, REST API, database** và nền tảng LLM
3. **Portfolio/GitHub/Demo AI là lợi thế**

→ **Đọc vị**: 3 từ khóa trọng tâm là RAG → AI AGENT → AUTOMATION. The Trader trúng cả 3 ở mức "tự triển khai từ gốc", chỉ cần chuyển lời sang đúng ngôn ngữ JD.

---

## 2. Vốn liệu giá trị từ The Trader (góc nhìn nhà tuyển dụng)

### 2.1 🥇 RAG thực chiến — không phải RAG tutorial

90% ứng viên "biết RAG" chỉ gọi API vector DB. The Trader chứng minh khác biệt:

- **BM25 tự triển khai** — hàm `bm25Score` / `rankRag` tự viết từ công thức, không wrap thư viện → hiểu retrieval ở mức toán, chỉnh được từng tham số
- **Hyperparameter vận hành thật**: `topK / k1 / b / wRecency` là ô nhập trong UI, lưu DB (AppSetting), reset được, có audit `ML_TUNING_UPDATED`; thay giá trị → `RetrievalLog.topK` phản ánh đúng ngay lần truy hồi sau (verify hermetic 5/5 PASS)
- **Truy vết từng bước**: mỗi lần truy hồi ghi `RetrievalLog` (VD thật: "L1 truy hồi 8/700 docs · query 16 token · block 2.802 ký tự ~1.121 token") → RAG đo lường được, debug được
- **Token budgeting** từng block context → ý thức chi phí LLM thực tế
- Corpus ~700 docs, cache + cooldown

### 2.2 🥈 Kiến trúc AI Agent — 23 agents có "nhà nước", không phải bầy chatbot

- **Phân vai hội đồng**: strategist / analyst / risk / council — chu kỳ orchestrated qua REST API, có K-level agent (K1 auto-convert sandbox, K3/K4 audit)
- **Cổng đồng thuận cứng 80%**: 23 cử tri → tỷ lệ đồng thuận → ≥80% DUYỆT NGAY / <80% TỪ CHỐI NGAY — quyết định AI **deterministic + audit được**, không "LLM nói gì nghe nấy"
- **Anti-pattern đã xử lý ngoài thực chiến**:
  - TOCTOU (2 chu kỳ đua tay) → **claim atomic** đồng bộ
  - Chạy lặp sau reset → **idempotent**, audit không kép
  - LLM hỏng giữa chừng → **fail-soft** (auto-decision lỗi thì còn đường duyệt tay dự phòng)
- **Bandit Thompson sampling + Q-learning** chọn nguồn tin theo reward — exploration/exploitation đúng bài
- **Ensemble MLP + GRU**: MLP serving v8 (10-16-8-3) + GRU-24 3 cổng BPTT, trọng số ensemble 2/3 giọng — trực quan hóa bằng trọng số THẬT (sơ đồ SVG vẽ W từng cạnh, dày/mảnh theo |W|)

### 2.3 🥉 Workflow AI / Automation — scheduler engine sản phẩm thật

- **Mini-service engine riêng (:3003, socket.io)** chạy 4 job: tick giá 10s · crawler RSS 5 nguồn VN /15 phút · sync EOD 15:45 sau phiên · sync quốc tế 06:15 sau đóng cửa Mỹ
- **Bền vững trước sự cố**: backoff nhân đôi 30p→4h khi nguồn lỗi thật · guard in-flight chống bắn POST chồng · mutex 429 phân biệt "lỗi thật" vs "tự chặn"
- **Pipeline quyết tự động đầu-cuối**: dữ liệu → RAG → 23 agents → đồng thuận → auto-decision → lệnh giấy → **ngày sau D-LEDGER mở sổ chấm lại chính mình** (DecisionEvaluation, verdict ±0,5% dự báo vs thực thi, job 16:45 T2–T6)
- Vòng phản hồi này chính là "AI automation with feedback loop" mà MarTech cần — hiếm ứng viên năm đầu làm được

### 2.4 "Tối ưu prompt & chất lượng output" — chứng minh bằng số

- **3 đường tiêm prompt** (C-VISION) + prompt chủ tịch + hội nghị LLM (đo thật 44s)
- **DecisionEvaluation** chấm lại từng quyết định ±0,5% → có metric chất lượng output theo thời gian
- Narrative render markdown → `<strong>` đúng chuẩn UI · lexicon dấu trừ U+2212 đồng bộ toàn app
- Auto-decision nghiệm thu **12/12 hermetic PASS** (đủ duyệt / thiếu từ chối / idempotent / fail-safe)

### 2.5 Kỹ nghệ production — thứ khiến Tech Lead gật đầu

- **Supabase Postgres cloud**: 90 instruments · **215.627 bar thật** · 42 signals · ~1.100 AgentRun — nguồn dữ liệu chính, bền qua reset
- Đa nguồn dữ liệu thật: Treasury CSV 1.332 · Frankfurter ECB 2.898 · er-api VND=X · Yahoo query2 22/22 mã 5.481 bar (~9.700 bar đa tài sản)
- **Giao thức fixbug 4 lớp, trần 8 vòng**, báo cáo §9, P0/P1/P2 phân tầng, vòng xác nhận độc lập
- **Nghiệm thu tự động hóa**: E2E browser automation (desktop + mobile 390, 0 console error) + VLM chấm screenshot + regression curl toàn API
- **Worklog 115 phiên bản commit** chi tiết từng finding (F-207, F-1115-01…) — trung thực ghi cả lỗi lẫn cách vá
- Next.js 16 · TypeScript 5 strict · Tailwind 4 · Prisma · PM2 · tự vá bẫy env platform (`env -u DATABASE_URL`) để hệ tự sống lại sau reset

### 2.6 Bộ tài sản portfolio sẵn có

- Repo GitHub sống (THE-TRADER) + demo chạy trực tiếp
- Docs bộ ba: DB_SCHEMA v0.9.6 · TECHNICAL v1.9.4 · DATA_SOURCES
- **215+ screenshot nghiệm thu** theo phiên bản
- UI 8 module hoàn chỉnh: Tổng quan · Danh mục · Tín hiệu · Đội Agent · Thị trường · Tổng hợp · Hội đồng · Cài đặt (+ Học máy 5 tab)

---

## 3. Bullet CV sẵn dùng (copy–paste, đã sửa tên The Trader)

### Bản tiếng Việt (CV TopCV)

> **The Trader — Hệ thống giao dịch chứng khoán đa tác tử AI (solo project, đang vận hành)**
> - Dựng hệ **23 LLM agents** theo kiến trúc hội đồng (chiến lược/ phân tích/ rủi ro/ chủ tịch) với **cổng đồng thuận 80%** — quyết định tự duyệt/từ chối tức thì, có audit trail đầy đủ
> - Tự triển khai **RAG engine với thuật toán BM25 tự code** (không dùng thư viện) — hyperparameter (topK/k1/b/recency-weight) tinh chỉnh vận hành qua UI, lưu DB; mỗi truy hồi ghi RetrievalLog đo lường token & chất lượng
> - Xây **AI workflow tự động end-to-end**: scheduler engine riêng (tick 10s · RSS 15p · sync EOD · sync quốc tế) với backoff nhân đôi + guard chống request chồng; **vòng phản hồi D-LEDGER tự chấm lại chính xác dự báo ±0,5%** mỗi ngày
> - **Machine Learning tự code**: MLP 10-16-8-3 + GRU-24 (BPTT 3 cổng) ensemble, Bandit Thompson chọn nguồn tin, trực quan hóa bằng trọng số thật
> - Công nghệ: **Next.js 16 · TypeScript strict · Prisma · Supabase Postgres (215k+ rows thật) · socket.io · PM2**; nghiêm ngặt QA: giao thức fixbug 4 lớp, E2E browser + VLM, 12/12 test hermetic

### Bản tiếng Anh (nếu CV song ngữ / apply LinkedIn)

> **The Trader — Multi-Agent AI Trading System (solo, in production)**
> - Built **23-LLM-agent council architecture** with an **80% consensus gate** — instant approve/reject decisions with full audit trail and human-in-the-loop fallback
> - Implemented **RAG engine with hand-coded BM25** (no library): tunable hyperparameters (topK/k1/b/recency) via UI + DB persistence, per-retrieval logging (docs hit, tokens, block size) for measurable quality
> - Engineered **end-to-end AI automation**: dedicated scheduler service (10s ticks, RSS crawling, EOD/intl syncs) with exponential backoff & in-flight guards; **D-LEDGER feedback loop self-grades forecast accuracy ±0.5% daily**
> - Hand-coded **ML stack**: MLP (10-16-8-3) + GRU-24 ensemble, Thompson-sampling bandit for source selection, weight-true visualizations
> - **Next.js 16 · TypeScript strict · Prisma · Supabase Postgres (215k+ real rows) · socket.io · PM2**; rigorous QA: 4-layer fix protocol, E2E browser + VLM verification, 12/12 hermetic tests

### Mẫu 6 dòng mở CV (đặt đầu mục Experience — mỗi chữ trúng keyword JD)

> Multi-agent AI system in production: **23 LLM agents** · hand-coded **BM25 RAG** with per-retrieval logging · **consensus-gated auto decision (80%)** · 4-job **automation scheduler** with backoff · **self-evaluating decision ledger (±0.5%)** · **Supabase Postgres 215k+ rows** · Next.js 16 / TypeScript strict

---

## 4. Kịch bản demo 3 phút (mang theo phỏng vấn)

1. **Mở module Tín hiệu** → chỉ dòng "Đồng thuận 89,8% → **Đã duyệt**" vs "78,3% → **Đã từ chối** + lý do full-text" → chốt: *"Quyết định AI của em deterministic — cổng đồng thuận 80%, mọi quyết định có audit và lý do."*
2. **Mở dialog tier-3 của 1 tín hiệu** → trỏ JSON: consensusRatio, paperOrdered, rationale đầy đủ → *"Đây là mức truy vết sâu em thiết kế cho từng quyết định."*
3. **Mở module Học máy → tab Mạng thần kinh** → sơ đồ MLP vẽ bằng **trọng số thật** (W từng cạnh, dày/mảnh theo |W|) → *"ML em tự code từ đầu — đồ thị này đọc trực tiếp từ model serving."*
4. **Nói về RetrievalLog** (nếu được hỏi RAG): *"Mỗi lần truy hồi BM25 em log: 8/700 docs, 16 token query, ~1.121 token context — RAG của em đo được từng bước, tune topK/k1/b qua UI được."*

**Câu chốt 30 giây cuối**: *"JD cần RAG, Agent, Automation — The Trader có cả ba ở mức tự triển khai từ gốc, và đặc biệt: hệ tự chấm lại chất lượng quyết định của chính nó mỗi ngày. Em muốn mang vòng phản hồi đó vào sản phẩm MarTech của công ty."*

---

## 5. Q&A phòng thủ (recruiter chắc chắn sẽ hỏi)

| Câu hỏi khó | Trả lời xoay sáng |
|---|---|
| **JD cần Python, anh viết TypeScript?** | Tư duy thuật toán chuyển ngôn ngữ dễ (FastAPI/LangChain ~2 tuần); bằng chứng: BM25/MLP/GRU/ensemble **tự code từ công thức bằng TS** chứ không nhờ thư viện Python — hiểu bản chất, không cargo-cult. Có thể demo script Python BM25 viết lại từ chính code TS |
| **The Trader là trading, ta làm eCommerce/MarTech?** | Kiến trúc 3 lớp RAG → Agent đồng thuận → Workflow tự động là **domain-agnostic**; dữ liệu tài chính còn khắt khe hơn MarTech về độ trễ, chất lượng và hậu quả quyết định sai — chuyển sang MarTech là đi từ khó sang dễ |
| **Solo project, có làm team chưa?** | 23 agents + docs bàn giao + worklog 115 phiên + quy ước branch/backup chính là làm việc **có process như team**; The Trader còn phối hợp "đa bộ phận" ở dạng agents giữ vai Dev/Marketing/Vận hành — tư duy cross-team có sẵn |
| **Sao không dùng LangChain/LlamaIndex?** | Tự triển khai để **hiểu đen hộ** — giờ biết chính xác layer nào framework giấu; khi dùng framework sẽ debug + tune được thay vì gọi magic. Điều này tương thích chuẩn "tối ưu prompt & chất lượng output" trong JD |
| **Lương mong muốn?** | Dải JD 15–25M thỏa thuận theo năng lực — để portfolio The Trader nói; mốc mở đầu tùy quy trình công ty, nhấn mạnh mức năng lực verify được qua demo live |

---

## 6. Việc cần làm trước hạn 31/10/2026

- [ ] **Script Python BM25 demo** (60–100 dòng, port từ `rankRag` TS, chạy trên corpus ~700 docs) — xóa sổ gap "Python" trong JD, để kèm link trong CV
- [ ] **Dọn repo công khai**: xác nhận README có badge + screenshot + link demo nổi đầu (recruiter mở repo 10 giây phải thấy giá trị)
- [ ] **CV 1–2 trang** mở đầu bằng 6 dòng The Trader (mục 3), ghi rõ số liệu định lượng (mục 7)
- [ ] **Rehearse demo 3 phút** (mục 4) — quay thử 1 lần tự xem
- [ ] Gửi sớm trước 31/10 — tiêu đề mail đúng format `HỌ VÀ TÊN – AI ENGINEER`

---

## 7. Fact sheet — số liệu định lượng để trích dẫn (không bị hỏi lạc đề)

| Số liệu | Giá trị |
|---|---|
| Số LLM agents | 23 |
| Cổng đồng thuận | 80% (duyệt/từ chối tức thì) |
| Thuật toán RAG | BM25 tự code · corpus ~700 docs · tuning 4 tham số |
| Scheduler jobs | 4 (tick 10s · RSS 15p · EOD 15:45 · intl 06:15) |
| ML | MLP 10-16-8-3 · GRU-24 BPTT · Thompson bandit · ensemble 2/3 |
| Vòng phản hồi | DecisionEvaluation ±0,5%/ngày |
| Dữ liệu thật | 90 instruments · 215.627 bar · ~9.700 bar đa tài sản 4 nguồn |
| AgentRun đã chạy | ~1.100 (chu kỳ thật 60–150s, 0 failure) |
| Hermetic test auto-decision | 12/12 PASS |
| Fixbug protocol | 4 lớp · trần 8 vòng · 36 findings/phiên lớn nhất |
| Worklog phiên bản | 115 commit chi tiết |
| Screenshot nghiệm thu | 215+ |
| Stack | Next.js 16 · TypeScript 5 strict · Tailwind 4 · Prisma 6 · Supabase PG 17 · socket.io · PM2 |

---

*Tài liệu này là nguồn dựng CV — mọi số liệu lấy từ hệ thống đang vận hành + worklog phiên #112–#115. Cập nhật lần cuối: 15/10/2026.*

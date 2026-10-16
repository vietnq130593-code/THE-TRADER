# TÀI LIỆU NGUỒN DỰNG CV — DỰ ÁN THE TRADER

> Tài liệu nội bộ phục vụ soạn CV + chuẩn bị phỏng vấn vị trí **AI Engineer (LLM / RAG / AI Automation)**.
> Tên dự án: **The Trader** — Nền tảng AI đa tác tử tự vận hành 24/7 (paper trading, domain chứng khoán VN).
> ⚠️ Ghi chú: KHÔNG dùng tên "TMO" (đó là dự án khác, đã viết nhầm) — mọi nơi trong CV/phỏng vấn đều gọi **The Trader**.
> ✅ **v2 — đã qua review chuyên gia CV 15/10/2026** (bullet v2 ngắn theo luật 6-giây-scan · đủ keyword ATS · khung hóa paper trading · cảnh báo bảo mật repo).

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

- **Supabase Postgres cloud**: 90 instruments · **219.313 bar thật (2013→nay)** · 48 signals · 1.213 AgentRun — nguồn dữ liệu chính, bền qua reset
- Đa nguồn dữ liệu thật: Treasury CSV 1.332 · Frankfurter ECB 2.898 · er-api VND=X · Yahoo query2 22/22 mã 5.481 bar (~9.700 bar đa tài sản)
- **Giao thức fixbug 4 lớp, trần 8 vòng**, báo cáo §9, P0/P1/P2 phân tầng, vòng xác nhận độc lập
- **Nghiệm thu tự động hóa**: E2E browser automation (desktop + mobile 390, 0 console error) + VLM chấm screenshot + regression curl toàn API
- **Worklog 120 phiên bản commit** chi tiết từng finding (F-207, F-1115-01…) — trung thực ghi cả lỗi lẫn cách vá
- Next.js 16 · TypeScript 5 strict · Tailwind 4 · Prisma · PM2 · tự vá bẫy env platform (`env -u DATABASE_URL`) để hệ tự sống lại sau reset

### 2.6 Bộ tài sản portfolio sẵn có

- Repo GitHub sống (THE-TRADER) + demo chạy trực tiếp
- Docs bộ ba: DB_SCHEMA v0.9.6 · TECHNICAL v1.9.4 · DATA_SOURCES
- **215+ screenshot nghiệm thu** theo phiên bản
- UI 8 module hoàn chỉnh: Tổng quan · Danh mục · Tín hiệu · Đội Agent · Thị trường · Tổng hợp · Hội đồng · Cài đặt (+ Học máy 5 tab)

---

## 3. Bullet CV v2 (đã áp dụng review chuyên gia — 1 bullet = 1 achievement, ≤2 dòng, keyword JD đặt nửa đầu)

> **NGUYÊN TẮC 2 TẦNG**: CV viết cho HR + ATS bằng tiếng ngành chuẩn; jargon sâu (BPTT, TOCTOU, hermetic, fail-soft…) chỉ dùng khi phỏng vấn gặp tech lead.

### Bản tiếng Việt (CV TopCV)

> **The Trader — Nền tảng AI đa tác tử tự vận hành 24/7** (paper trading, chứng khoán VN) · 07/2026 → nay · 120 phiên bản có worklog · GitHub + demo theo điều kiện §6.1
> - Thiết kế **23 LLM agents** chạy tự động theo kiến trúc hội đồng 5 nhóm — **~1.200 chu kỳ, 98%+ hoàn tất**; **62 REST API endpoint** (Next.js 16) + chat REST đa lượt với từng agent
> - Tự code **RAG engine BM25** (0 thư viện): 4 hyperparameter **tinh chỉnh qua UI lưu DB**; mỗi truy hồi ghi log đo lường docs/token → chất lượng retrieval kiểm chứng được
> - **Prompt engineering + cổng đồng thuận 80%**: 3 đường tiêm prompt, chấm điểm output tự động; quyết định LLM tự duyệt/từ chối tức thì kèm lý do + audit trail (12/12 test tự động)
> - **AI automation 4 job** (tick 10s · crawl tin 15p · 2 job sync dữ liệu thật): backoff nhân đôi, chống request chồng; **vòng phản hồi tự chấm lại độ chính xác dự báo ±0,5%/ngày**
> - **ML thuần tự code** (MLP + GRU ensemble, Thompson sampling) · **Postgres cloud 219.000+ bản ghi dữ liệu thật** · QA tự động E2E browser + VLM

### Bản tiếng Anh (nếu CV song ngữ / apply LinkedIn)

> **The Trader — Self-running multi-agent AI platform** (paper trading, Vietnam equities) · Jul 2026 → present · 120 documented releases · GitHub + live demo per §6.1
> - Designed **23 LLM agents** in a 5-group council architecture — **~1,200 automated cycles, 98%+ completed**; **62 REST API endpoints** (Next.js 16) + per-agent conversational chat API
> - Hand-coded **BM25 RAG engine** (zero libraries): 4 hyperparameters **tunable via UI with DB persistence**; every retrieval logged (docs hit, token budget) for measurable quality
> - **Prompt engineering + 80% consensus gate**: 3-path prompt injection, automated output scoring; LLM decisions auto-approved/rejected instantly with full audit trail (12/12 automated tests)
> - **AI automation with feedback loop**: 4 scheduled jobs (10s ticks, RSS crawling, 2 data syncs) with exponential backoff & in-flight guards; **self-grades forecast accuracy ±0.5% daily**
> - **Hand-coded ML stack** (MLP + GRU ensemble, Thompson sampling) · **Supabase Postgres with 219,000+ real market-data records** · automated QA: E2E browser + VLM review

### Mẫu 6 dòng mở CV (summary — mỗi chữ trúng keyword JD)

> Nền tảng AI đa tác tử **đang chạy tự động 24/7**: **23 LLM agents** · **RAG BM25 tự code** (0 thư viện) · **AI automation 4 job + vòng phản hồi tự đánh giá ±0,5%/ngày** · **prompt engineering** với chấm điểm output tự động · **cổng đồng thuận 80%** · **62 REST API** · Postgres cloud 219K+ bản ghi thật · Next.js 16 / TypeScript strict

### Mục Skills cho CV (mẫu — kê trung thực, Python khai đúng mức)

> - **AI/LLM**: RAG (BM25 tự triển khai) · Prompt engineering · AI Agent orchestration · chatbot/agent-chat API · đánh giá chất lượng output tự động
> - **Backend**: REST API (62 endpoint) · PostgreSQL/Prisma · scheduler & cron automation · socket.io realtime
> - **Ngôn ngữ**: TypeScript (chuyên — dự án thật 4 tháng) · Python (thành thạo cơ bản, có demo port BM25 — §6.2) · SQL
> - **Frontend**: Next.js 16 · React 19 · Tailwind 4
> - **DevOps/QA**: PM2 · Git (115 phiên commit có quy trình) · Supabase · kiểm thử tự động (E2E browser, VLM review)

### ❌ Bullet v1 (LƯU TRỮ — không dùng: quá dài 3-4 dòng, thiếu keyword chatbot/REST API/prompt, jargon trộn lẫn — giữ lại để đối chiếu)

> **The Trader — Hệ thống giao dịch chứng khoán đa tác tử AI (solo project, đang vận hành)**
> - Dựng hệ **23 LLM agents** theo kiến trúc hội đồng (chiến lược/ phân tích/ rủi ro/ chủ tịch) với **cổng đồng thuận 80%** — quyết định tự duyệt/từ chối tức thì, có audit trail đầy đủ
> - Tự triển khai **RAG engine với thuật toán BM25 tự code** (không dùng thư viện) — hyperparameter (topK/k1/b/recency-weight) tinh chỉnh vận hành qua UI, lưu DB; mỗi truy hồi ghi RetrievalLog đo lường token & chất lượng
> - Xây **AI workflow tự động end-to-end**: scheduler engine riêng (tick 10s · RSS 15p · sync EOD · sync quốc tế) với backoff nhân đôi + guard chống request chồng; **vòng phản hồi D-LEDGER tự chấm lại chính xác dự báo ±0,5%** mỗi ngày
> - **Machine Learning tự code**: MLP 10-16-8-3 + GRU-24 (BPTT 3 cổng) ensemble, Bandit Thompson chọn nguồn tin, trực quan hóa bằng trọng số thật
> - Công nghệ: **Next.js 16 · TypeScript strict · Prisma · Supabase Postgres (215k+ rows thật) · socket.io · PM2**; nghiêm ngặt QA: giao thức fixbug 4 lớp, E2E browser + VLM, 12/12 test hermetic

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

## 6. Việc cần làm trước hạn 31/10/2026 (đã sắp lại theo ưu tiên review CV)

- [ ] **§6.1 QUYẾT ĐỊNH ĐƯỜNG LINK PORTFOLIO (quan trọng nhất — rủi ro bảo mật)**: repo hiện chứa `.env` credentials Supabase trong git tree + history (commit #113 chủ đích để khôi phục sandbox). Chọn 1: **(A) khuyến nghị** — repo private + CV chỉ kèm demo video 3 phút + 5-6 screenshot tuyển · **(B)** dựng public mirror sạch (không .env, history flatten, README 30 dòng) · **(C)** giữ public hiện tại thì PHẢI rotate key Supabase + xoá .env + làm sạch history trước khi đưa link vào CV. ⚠️ Tuyệt đối không đưa link repo hiện trạng vào CV khi chưa xử lý — tech lead thấy commit .env = red flag vệ sinh bảo mật.
- [ ] **§6.2 Script Python BM25 demo** (60–100 dòng, port từ `rankRag` TS, chạy trên corpus ~700 docs) — xóa sổ gap "Python" trong JD, để kèm link trong CV
- [ ] **Cập nhật README làm landing portfolio** (nếu đi phương án B/C): 3 dòng mở (là gì · nổi bật gì · bằng chứng đâu) + 3 screenshot đẹp; vá thông tin lỗi thời ("6 cử tri shadow-mode" → auto-decision live #112 · "7 workspace" → 8 + ML)
- [ ] **CV 1–2 trang**: mở đầu bằng 6 dòng summary (mục 3) + bullet v2 + Skills (mục 3) — kiểm tra bảng keyword §8 trước khi xuất file
- [ ] **Rehearse demo 3 phút** (mục 4) — quay thử 1 lần tự xem
- [ ] Gửi sớm trước 31/10 — tiêu đề mail đúng format `HỌ VÀ TÊN – AI ENGINEER`

---

## 7. Fact sheet — số liệu định lượng để trích dẫn (không bị hỏi lạc đề)

| Số liệu | Giá trị |
|---|---|
| Số LLM agents | 23 (5 nhóm hội đồng) |
| Cổng đồng thuận | 80% (duyệt/từ chối tức thì) |
| **REST API endpoint** | **62** (verify 15/10/2026 — `git ls-files "src/app/api/**/route.ts"`) |
| Thuật toán RAG | BM25 tự code · corpus ~700 docs · tuning 4 tham số |
| Scheduler jobs | 4 (tick 10s · RSS 15p · EOD 15:45 · intl 06:15) |
| ML | MLP 10-16-8-3 · GRU-24 BPTT · Thompson bandit · ensemble 2/3 |
| Vòng phản hồi | DecisionEvaluation ±0,5%/ngày |
| Dữ liệu thật | 90 instruments · 219.313 bar (2013→nay) · ~9.700 bar đa tài sản 4 nguồn |
| AgentRun đã chạy | 1.213 (98,3% hoàn tất · 0 lỗi 5 ngày gần nhất) |
| Hermetic test auto-decision | 12/12 PASS |
| Fixbug protocol | 4 lớp · trần 8 vòng · 36 findings/phiên lớn nhất |
| Worklog phiên bản | 120 commit chi tiết |
| Screenshot nghiệm thu | 215+ |
| Stack | Next.js 16 · TypeScript 5 strict · Tailwind 4 · Prisma 6 · Supabase PG 17 · socket.io · PM2 |

---

## 8. Bảng tự kiểm ATS keyword (chạy trước khi xuất CV — mỗi dòng JD phải tìm thấy chữ tương ứng trong CV)

| Keyword JD | Nơi xuất hiện trong CV (bullet v2) | Trạng thái |
|---|---|---|
| RAG | Bullet 2 "RAG engine BM25" + Skills | ✅ |
| LLM | Bullet 1 "23 LLM agents" + Skills "nền tảng LLM" | ✅ |
| AI Agent | Bullet 1 "23 LLM agents… kiến trúc hội đồng" | ✅ |
| **Chatbot** | Bullet 1 "chat REST đa lượt với từng agent" (tính năng thật: `/api/agents/[id]/chat`) + Skills "chatbot/agent-chat API" | ✅ (v2 mới bổ sung — v1 thiếu) |
| Workflow AI / Automation | Bullet 4 "AI automation 4 job" | ✅ |
| LLM API / tích hợp | Bullet 1 + Skills "AI/LLM" | ✅ |
| **Tối ưu prompt** | Bullet 3 "Prompt engineering + cổng đồng thuận…" + Skills | ✅ (v2 mới bổ sung — v1 thiếu) |
| Chất lượng output | Bullet 3 "chấm điểm output tự động" | ✅ |
| Python | Skills "Python (thành thạo cơ bản, demo port BM25)" — cần §6.2 xong mới ghi | 🔶 chờ demo |
| **REST API** | Bullet 1 "62 REST API endpoint" + Skills | ✅ (v2 mới bổ sung — v1 thiếu) |
| Database | Bullet 5 "Postgres cloud 219K+ bản ghi" + Skills SQL | ✅ |
| Portfolio/GitHub/Demo | §6.1 quyết định đường link + demo video | 🔶 chờ quyết định |

> Mẹo ATS TopCV: copy CV ra file .docx/plain-text rồi Ctrl+F từng keyword trên — nếu dòng nào KHÔNG tìm thấy chữ nguyên vẹn (đừng đếm từ đồng nghĩa), sửa trước khi nộp.

---

*Tài liệu này là nguồn dựng CV — mọi số liệu lấy từ hệ thống đang vận hành + worklog phiên #112–#115. v2 sau review chuyên gia CV 15/10/2026. Cập nhật lần cuối: 15/10/2026.*

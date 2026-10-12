# M2_RELATION_BLUEPRINT — Học Quan hệ ảnh hưởng qua lại giữa các Thị trường (Cơ chế số 2)

> Phiên #103 · Trả lời trực tiếp câu hỏi trader: *"Dựa vào các tin tức thị trường đã qua và
> biến đổi của thị trường đã qua, có cơ chế học rút ra nhận định, đánh giá về các mối quan hệ
> ảnh hưởng qua lại của thị trường chưa?"*
>
> **Trả lời trước #103: CHƯA.** Cơ chế số 1 (tin tức → hiểu & dự báo thị trường) đã có từ #83–#102
> (A4 LLM · RAG BM25 · lexicon Bayes · bandit 6 tay · gate C2). Cơ chế số 2 (học **quan hệ
> liên thị trường** từ dữ liệu đã qua) là khoảng trống duy nhất còn lại — blueprint này lấp nó.

## 0. Nguyên tắc nền

1. **Học từ dữ liệu ĐÃ QUA, không phỏng đoán**: mọi quan hệ lưu đều kèm `obs` (số quan sát),
   cửa sổ dữ liệu `windowFrom→windowTo`, tương quan Pearson + xác suất điều kiện tính trên
   chuỗi giá/tin THẬT trong DB. Không có đủ mẫu → không lưu, báo trung thực.
2. **Thompson-vs-quant tách bạch**: đây là lớp **quant hồi cứu** (event-study + lead-lag), KHÔNG
   đụng bandit 6 tay (bandit học độ chính xác *tay dự báo*, cơ chế này học *quan hệ thị trường*).
3. **Vô hại hoá (fail-soft)**: lỗi engine → block null → prompt/página y như trước. Không
   module nào của M2 được phép làm hỏng chu kỳ agent hay route hiện có.
4. **0 dependency mới**: TypeScript thuần + Prisma + LLM có sẵn.

## 1. Phân đoạn thị trường (segment)

Nguồn sự thật: bảng `Instrument` (sector VN + ETF HNX). Không có mã US/HK trong DB
(enum có sẵn nhưng chưa nạp instrument) → M2范围的 "thị trường" hiện tại là **liên ngành
+ liên chỉ số nội địa**, sẵn sàng mở rộng khi B12 nạp mã quốc tế.

| key | Nhãn | Thành phần (tự động từ DB) |
|---|---|---|
| `vn30` | Chỉ số VN30 | ETF E1VFVN30 (proxy chuẩn — sẵn 2.998 phiên) |
| `vn100` | Chỉ số VN100 | ETF FUEVN100 |
| `banks` | Ngân hàng | 10 mã HOSE sector "Ngân hàng" (VCB, CTG, BID…) |
| `sec` | Chứng khoán | SSI, HCM, VND |
| `re` | Bất động sản | VIC, VHM, VRE |
| `steel` | Thép/Vật liệu | HPG, HSG |
| `tech` | Công nghệ | FPT, CMG |
| `air` | Hàng không | HVN, VJC |
| `energy` | Năng lượng | GAS, PLX |
| `consume` | Tiêu dùng | MSN, VNM… |
| `retail` | Bán lẻ | MWG… |
| `health` | Y tế | DHG |
| `macro-news` | Tin vĩ mô (ảo) | tổng hợp lexicon điểm tin category=macro theo ngày |
| `market-news` | Tin thị trường (ảo) | tổng hợp lexicon điểm tin category=market theo ngày |

Segment giá = trung bình equal-weight lợi suất log các thành viên có bar trong ngày
(yêu cầu ≥ nửa thành phần có dữ liệu ngày đó mới tính).

## 2. Ba lớp học

### Lớp 1 — Engine quant (deterministic, 0 LLM) `src/lib/ml/xrel.ts`

- Cửa sổ: **750 phiên** (~3 năm) gần nhất mỗi mã — đủ dài để quan hệ ổn định, đủ ngắn để phản ánh cơ chế hiện hành.
- **Giá→Giá (price)**: mọi cặp có thứ tự (A→B), A≠B, độ trễ `lag ∈ {0, 1}` (0 = cùng ngày,
  1 = B phản ứng ngày kế):
  - `corr` = Pearson(A_t, B_{t+lag}) trên chuỗi ngày chung.
  - `condUp` = P(B_{t+lag} > 0 | A_t > +0,75%) — "A bật mạnh thì B làm gì".
  - `condDown` = P(B_{t+lag} < 0 | A_t < −0,75%).
  - Ngưỡng lưu: `|corr| ≥ 0,15` ∧ `obs ≥ 60` ∧ cú sốc ≥ 15 mẫu mỗi chiều (điều kiện).
- **Tin→Giá (news)**: sentiment lexicon trung bình theo ngày ICT (macro / market) đối chiếu
  lợi suất segment cùng ngày & ngày kế, cùng bộ chỉ số. Ngưỡng lưu: `obs ≥ 15` ngày có tin
  (trung thực: kho tin hiện ~4 ngày → lớp này tự báo "đang tích luỹ, chưa đủ mẫu" cho tới khi
  crawler nuôi đủ — engine KHÔNG bịa quan hệ từ 4 điểm).
- `strength = |corr| × min(1, obs/250)` — xếp hạng hiển thị & tiêm prompt.
- Persist: upsert theo khoá `(sourceKey, targetKey, lag, kind)`; giữ top-40 price + top-20 news.
- Trọng số `B→A` ≠ `A→B` (quan hệ ảnh hưởng có HƯỚNG — đúng bản chất "ảnh hưởng qua lại").

### Lớp 2 — Tổng hợp nhận định LLM (1 gọi/tuần) `xrel.ts synthesizeRelationInsight`

- Input: top quan hệ vừa học (kèm số liệu) + độ phủ tin tức + giới hạn mẫu.
- Output: `RelationInsight.narrative` — 4–7 câu tiếng Việt dẫn số liệu: (i) 3–4 quan hệ
  đáng chú ý nhất & ý nghĩa dẫn dắt; (ii) quan hệ ngược chiều/phân tách bất thường nếu có;
  (iii) 1 câu trung thực về giới hạn dữ liệu; (iv) hàm ý theo dõi cho phiên tới.
- Chu kỳ: Chủ nhật 05:00 trong nhiệm vụ K3 `learning-rag` (A13 — đúng charter "tích luỹ tri
  thức"); chộp khi insight cũ < 6 ngày → skip (tiết kiệm token). Nút tay trong UI luôn ép chạy.

### Lớp 3 — Phục vụ tri thức (serving)

- **Prompt agents** (`agent-context.ts`): khối `QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC (XREL)` top-10 dòng
  (≤ ~900 ký tự) tiêm cho market-analyst · news-sentiment · portfolio-strategist (chu kỳ + single-run
  + chat compact) — fail-soft như RAG L1. Agents giờ "biết" vn30 thường đi cùng/kế banks…
- **UI**: card "Quan hệ thị trường" trong module Thị trường (dưới Tin tức) — bảng quan hệ
  (kind badge, A→B, lag, corr, P(↑|↑), P(↓|↓), obs), khối nhận định LLM truy vết, 2 nút
  `Học lại` (refresh quant) + `Tổng hợp nhận định` (LLM), thống kê cửa sổ.
- **API**: `GET /api/market/relations` (serve + lazy-refresh nếu stale > 12h) ·
  `POST /api/market/relations/refresh` · `POST /api/market/relations/insight`.

## 3. Schema Prisma (2 model mới)

```prisma
model MarketRelation { /* sourceKey/targetKey/lag/kind unique · corr/condUp/condDown/obs/strength · windowFrom/To · computedAt */ }
model RelationInsight  { /* narrative · model · relationsCount · statsJson · generatedAt */ }
```

## 4. Kế hoạch验 thu (chuẩn nhà)

1. `db:push` → 2 bảng mới; engine chạy thật trên 109k bars (13 năm) → quan hệ price đầy đủ;
   lớp news trung thực "chưa đủ mẫu".
2. Insight LLM thật 1 lần (nút tay + API), narrative lưu DB.
3. E2E agent-browser: card render, Học lại, Tổng hợp nhận định, 0 console error, mobile 390
   không tràn; lint + tsc 0 lỗi src.
4. Prompt block xuất hiện trong single-run market-analyst (log dev).
5. Worklog #103 + push origin main.

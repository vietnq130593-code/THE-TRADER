# TECHNICAL BLUEPRINT — UNIVERSE TIERING: TOÀN SÀN (T0) + RỔ TRỌNG TÂM (T2)

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/UNIVERSE_TIERING_BLUEPRINT.md` · **Version:** 1.0 · **Updated:** 2026-10-24
> **Status:** **ĐÃ CHỐT TRIỂN KHAI** — owner duyệt trong chat (Task 187/188): *"Được triển khai theo đề xuất của em đi"* — nạp toàn sàn nhưng bám chặt mã trọng tâm; nút thắt duy nhất là dung lượng Supabase free tier.
> **Cross-refs:** [MARKET_EXPANSION_BLUEPRINT.md](./MARKET_EXPANSION_BLUEPRINT.md) (§3.4 rổ 2 tầng · B3 probe-trước-khi-tạo · B4 quota · B14 watcher) · [DATA_SOURCES.md](./DATA_SOURCES.md) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [STATE_SPACE_BLUEPRINT.md](./STATE_SPACE_BLUEPRINT.md) (SS-6 common factor hưởng lợi cross-section rộng)
> **Khởi nguồn:** Task 186 (Q&A vì sao chỉ theo dõi rổ con) → Task 187 (đo Supabase live 205,45MB/500MB · 497B/bar · phương án (c) cửa sổ cuộn ≈84MB steady)

---

## §0. Quyết định đã chốt từ owner

| # | Câu hỏi | Trả lời của owner | Khoản triển khai |
|---|---|---|---|
| 0 | Theo dõi toàn sàn để nhiều lựa chọn hơn? | **Có** — nhưng lo DUY NHẤT dung lượng Supabase free 500MB (LLM sandbox miễn phí) | §1 tầng T0 bar-ngày cửa sổ cuộn |
| 1 | "Nạp toàn sàn nhưng bám chặt các mã trọng tâm, tiềm năng nhất" | **Chốt** — pattern phễu broad universe + focus list | §1 ba tầng · §4 screen trọng tâm |
| 2 | Triển khai Phase 1 ngay | **Được triển khai theo đề xuất của em đi** (Task 188) | §2–§6 (seed → sync → prune → breadth → screen → UI) |

## §1. Kiến trúc 3 tầng — granularity gán đúng chi phí

| Tầng | Phạm vi | Dữ liệu tiêu thụ | Ngân sách (đo Task 187) |
|---|---|---|---|
| **T0 — Toàn sàn** | **1.451 mã BROAD đo thật 24-10** (HOSE 374 STOCK + 15 ETF · HNX 289 STOCK · UPCOM 788 STOCK sau lọc hoạt động §3 — finfo listing 1.540 ứng viên) | 1 bar EOD/ngày · **cửa sổ cuộn 420 ngày (~260 phiên)** · KHÔNG Quote realtime · KHÔNG tin/RAG/LLM | 410.210 bar = **≈187MB đo thật** (497B/bar × ~260 phiên × 1.451 mã) |
| **T1 — Rổ bằng chứng** | 68 mã CORE hiện tại (top-ADTV §3.4 MARKET_EXPANSION) | Deep backfill 12 năm + Quote neo EOD + breadth segment + phiếu Bayes | 107MB đã trả — giữ nguyên |
| **T2 — Mã trọng tâm** | ~20-30 mã từ screen §4 (hysteresis) | (Phase 2) bar 5-phút · tin gắn mã + RAG · phiếu LLM trong chu kỳ 23 agents | ~16MB/30 mã (16-bit bar 5-phút) — Phase 1 CHƯA đụng |

**Nguyên tắc bất di bất dịch:** bức tranh rộng = T0 breadth (A/D · %MA) + 8 chỉ số segment sàn; tín hiệu thực thi = T1/T2 nơi thanh khoản. T0 KHÔNG đụng chu kỳ agent (≤180s) — mọi phép tính T0 chạy sau EOD hoặc on-demand có cache.

**Số đo nền (Task 187 — query live Supabase):** kho 205,45MB trước Phase 1 · Bar 226.154 EOD=107,21MB (497B/bar) · IntradayBar 368B/bar · KnowledgeChunk 9,7KB/chunk · baseline hệ thống ~50MB. **Đo thật sau Phase 1 (24-10): 322,54MB/500MB** — đúng dải hứa 300-330MB của Task 187.

## §2. Phát hiện hạ tầng quan trọng (đổi kết luận Task 186)

`api-finfo.vndirect.com.vn/v4/stocks?q=...` **resolve + 200 OK từ sandbox** (đo 2026-10-24). Task 181 probe sai cửa: bị chặn là `finfo.vn`, còn api-finfo cùng nhà dchart thì sống. → **CÓ endpoint danh-sách-toàn-sàn đã xác minh** (thay cho kết luận "không có" của Task 186); đồng thời mở lại cửa cho các tính năng Pha B đang treo chờ finfo (F-03b P/E, F-02 cơ bản) — để dành task sau, KHÔNG trong phạm vi blueprint này.

Số đếm live (`q=floor:X~status:LISTED~type:Y`): HOSE 406 STOCK + 21 ETF · HNX 299 STOCK · UPCOM 814 STOCK — tổng 1.540 mã listed, nhiều hơn dự phóng 650 vì UPCOM chứa lượng lớn mã zombie.

## §3. B3' — Seed T0: probe-trước-khi-tạo + lọc hoạt động

Script một lần `prisma/expand-universe-t0.ts` (idempotent — chạy lại bỏ mã đã có):

1. **Lấy danh sách** từ finfo listing (phân trang size=100, `_fields=code,floor,type,shortName,companyName,listedDate,status`), lọc `status=LISTED` + `floor ∈ {HOSE, HNX, UPCOM}` + `type ∈ {STOCK, ETF}`.
2. **Bỏ mã đã tồn tại** (symbol unique — 104 CORE giữ nguyên, KHÔNG hạ cấp/đụng).
3. **Probe dchart từng mã** (cửa sổ 420 ngày — cùng convention cutoff `loadSegmentBaskets`): rỗng → bỏ (không tạo instrument chết — đúng B3).
4. **Lọc hoạt động** — ngưỡng số phiên CÓ bar trong cửa sổ 420 ngày: HOSE/HNX/ETF ≥ 60 phiên (~3 tháng giao dịch) · UPCOM ≥ 120 phiên (~nửa năm) — zombie UPCOM không đáng tiền lưu trữ lẫn breadth. Ngưỡng là hằng số khai báo trong script — chỉnh được khi review.
5. **Tạo** `Instrument { universeTier: BROAD, currency: VND, listingDate từ finfo }` + `createMany` bar theo chunk 1.000 (đúng pattern deep backfill — PIT firstSeenAt=syncAt).
6. **KHÔNG tạo Quote** cho BROAD (§5).

## §4. Screen mã trọng tâm (T2) — hysteresis từ lịch sử

Hàm thuần từ Bar (deterministic — không state phụ thêm, chạy lại ra cùng kết quả):

- Xếp hạng **ADTV20** (trung bình `value` 20 phiên cuối — VND; thiếu value → close×volume) trên toàn bộ STOCK VN CORE+BROAD.
- **Focus list = top-30**, điều kiện ổn định: rank ADTV20 hôm nay ≤ 30 **VÀ** rank tính tại mốc T-10 phiên ≤ 40 (2 snapshot — chống mã nhảy vào do 1 phiên volume bất thường).
- Đầu ra **mang tính đề xuất** trong Phase 1 (badge THĂNG CẤP T2 cho mã BROAD vào focus · GIỮ cho CORE ở lại · HẠ CẤP cho CORE rơi khỏi top-60). Phase 2 (khi bật tiêu thụ dữ liệu T2) mới ép luật 2-trong-3-tuần vào/ra chuỗi 10 phiên như bản thiết kế đầy đủ.
- Hiển thị kèm: momentum 20 phiên · %trên MA50 · ADTV20 (tỷ VND).

## §5. Tích hợp — 7 điểm vá bắt buộc (bảo vệ chu kỳ 180s & rổ bằng chứng)

| # | Điểm | Vá |
|---|---|---|
| 1 | `syncEodFromDchart` (eod-sync.ts) | mặc định `universeTier: CORE` — mọi caller cũ giữ hành vi 100% |
| 2 | `deepBackfillEod` | filter CORE — **ngăn thảm hoạ 1,9GB** nếu operator chạy `force=deep` sau khi có 1.000 BROAD |
| 3 | MỚI `syncBroadEod()` | chọn BROAD theo **CURSOR XOAY VÒNG** trên danh sách symbol-asc (350 mã/lượt, cursor tiến qua AppSetting `eod-broad.cursor`) — mọi mã tới lượt cứ mỗi ceil(N/350) = **5 ngày với N=1.451 đo thật**; lookback 12 ngày tự vá khoảng hở. *Bản v1.0 dùng filter "chưa tươi >3 ngày" — lượt đo thật 15:12Z 24-10 lộ lỗ hổng bỏ đói: mã đình chỉ chiếm slot đầu queue vĩnh viễn → v1.1 đổi sang cursor theo vị trí (không thể bỏ đói)* |
| 4 | `loadSegmentBaskets` (ml/features.ts) | filter CORE — rổ bằng chứng top-ADTV §3.4 đứng yên tuyệt đối |
| 5 | `runPostIngestChecks` (ingest-pipeline.ts) | filter CORE mặc định — A9/corporate scan không quét 1.000 mã mỗi 15:45 |
| 6 | `fundamentals.ts` ingest | filter CORE (chỉ T1 xứng đáng nạp cơ bản) |
| 7 | tick route (sinh quote mô phỏng) | filter CORE — BROAD không bao giờ có Quote → không vào tick-engine/market-summary/bảng giá |

**Mới thêm:** engine scheduler `EOD_BROAD_SYNC_AT` (mặc định **16:00 ICT** — sau CORE 15:45, trước bandit settle 16:15 không chặn vì settle chỉ cần CORE) → POST `/api/market/eod-sync {tier:"broad", days:12}` (mutex route dùng chung — chống chồng lấn CORE/BROAD) · broadcast WS `"eod-broad"`.

## §6. Prune cửa sổ cuộn — điều kiện sống của ngân sách

Cuối mỗi `syncBroadEod`: xoá bar BROAD có `date < now − 420 ngày` (2 bước: lấy id BROAD → `deleteMany {instrumentId in, date lt cutoff}` — 1 lệnh DELETE gọn; **không bao giờ đụng bar CORE**). Xoá là vĩnh viễn theo thiết kế: T0 chỉ cần ~260 phiên cho breadth MA200 + screen ADTV20. Kết quả prune đếm được → meta DataSourceStatus key **`eod-broad`** (label "EOD toàn sàn T0 (dchart)").

Tin/chunk RAG > 90 ngày: **hoãn** — kho hiện 27MB, không phải nút thắt; ghi nợ ở §8.

## §7. Breadth toàn sàn — API + UI (Phase 1 hiển thị, chưa bỏ phiếu Bayes)

- `src/lib/breadth-market.ts` — 1 query bar toàn STOCK VN CORE+BROAD từ cutoff 420 ngày (≈ 280K dòng — đo thật 24-10 fixbug #189: breadth **10,5s** · focus **7,9s** cold-cache từ sandbox WAN, cache TTL 10 phút phía sau; on-demand, KHÔNG trong chu kỳ agent): A/D (tăng/giảm/giữ so close hôm trước) · %trên MA20/50/200 · tổng mã tính · theo từng sàn + gộp.
- `GET /api/market/breadth` · `GET /api/market/focus` (screen §4, top ~40 dòng trả về).
- UI: card **"Toàn sàn — bức tranh rộng (T0)"** trong workspace Thị trường (ngay sau MarketSummary): chip thống kê + bảng theo sàn + bảng mã trọng tâm (cuộn `max-h-96` custom scrollbar) + chú thích nguồn/cửa sổ.
- **Chưa** đưa breadth toàn sàn vào bằng chứng Bayes (ổn định synthesis — T5.2 deterministic; để Phase 2 kèm bài toán trọng số).

## §8. Nghiệm thu Phase 1 (checklist đóng dấu)

- **T1.1** seed idempotent: chạy 2 lần → lần 2 tạo 0 instrument mới, 0 bar đúp (unique instrumentId+date).
- **T1.2** mọi instrument BROAD ≥ ngưỡng hoạt động §3.3; 0 BROAD có Quote; 104 CORE giữ nguyên universeTier=CORE + số bar không đổi.
- **T1.3** `syncEodFromDchart()` không opts → chỉ CORE (đối chiếu symbolsOk ⊆ CORE).
- **T1.4** `deepBackfillEod` không đụng BROAD (đếm trước/sau).
- **T1.5** `syncBroadEod` chạy 2 lần liên tiếp → lần 2 lấy 350 mã KẾ TIẾP theo cursor (không trùng lần 1), cursor tiến đúng 350 mod N; chạy ceil(N/350) lần → quay về đầu danh sách — không mã nào bị bỏ đói kể cả mã đình chỉ (đã đo thật: ATA đình chỉ chỉ tốn đúng 1 slot lượt của nó).
- **T1.6** prune: cài bar BROAD giả tuổi 500 ngày → biến mất sau sync; bar CORE 500 ngày (VCB) CÒN.
- **T1.7** breadth: tổng mã tính ≈ số STOCK BROAD+CORE có ≥2 bar; A/D + %MA khớp tính tay trên 1 mã抽查.
- **T1.8** focus: top-30 có ADTV20 > 0, có ≥1 mã BROAD mang badge THĂNG CẤP (hoặc ghi trung thực nếu chưa có).
- **T1.9** dung lượng Supabase sau seed ≤ 400MB (đo `pg_database_size`).
- **T1.10** chu kỳ agent 23 agents sau tất cả: ≤180s, 0 lỗi (breadth/focus không xuất hiện trong evidence).
- **T1.11** UI desktop 1280 + mobile 390: card mới render, bảng cuộn, 0 console error.
- **T1.12** `bun run lint` sạch.

## §9. Rủi ro & rollback

| Rủi ro | Mức | Giảm nhẹ |
|---|---|---|
| Phình vượt 500MB (UPCOM nhiều mã hơn dự phóng) | 🟡 vừa | lọc hoạt động §3.3 + prune §6 + đo T1.9; núm chỉnh ngưỡng UPCOM |
| dchart chặn tải (1.540 probe + sync tăng ~10× request/ngày) | 🟡 vừa | throttle 300ms giữ nguyên · sync BROAD chia 350 mã/lượt × 5 ngày xoay vòng · chạy 16:00 ngoài giờ phiên |
| Chu kỳ agent chậm do DB to ra | 🟢 thấp | mọi đường phân tích lọc CORE (§5.4-5.5); breadth on-demand cache 10' |
| finfo listing đổi schema | 🟢 thấp | validate trường + bỏ qua dòng lỗi (probe dchart vẫn là cửa sự thật khi tạo) |
| **Rollback** | — | tắt = dừng scheduler EOD_BROAD + xoá BROAD: `deleteMany Instrument where universeTier=BROAD` (cascade Bar) — CORE không dính 1 byte |

## §10. Pha kế tiếp (để dành — KHÔNG hôm nay)

1. Phase 2-T2: tiêu thụ focus list (bar 5-phút selective · tin gắn mã · phiếu LLM gọn theo mã) + luật hysteresis đầy đủ 2/3 tuần.
2. Bỏ phiếu breadth toàn sàn vào Bayes composite (kèm trọng số & test T5.2).
3. Mở lại F-03b/F-02 Pha B qua `api-finfo.vndirect.com.vn` (đã xác minh resolve §2).
4. Prune tin/chunk RAG > 90 ngày khi kho vượt ~380MB.
5. SS-6 common factor (STATE_SPACE Phase 3 ~6/11) dùng cross-section ~1.000 mã.

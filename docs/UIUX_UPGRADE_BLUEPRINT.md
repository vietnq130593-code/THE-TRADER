# UIUX_UPGRADE_BLUEPRINT — Kế hoạch nâng cấp thiết kế UI/UX toàn app

> Phiên #106 · yêu cầu trader: *"dựa vào chấm điểm UI/UX tôi cần 1 file .md nâng cấp thiết kế dựa trên những gì bạn đã phân tích về UI/UX"*.
>
> Nguồn: bảng chấm điểm 9 view phiên #105 (VLM glm-5v-turbo + rà code) — điểm tổng **~6.0/10 "functional but fatiguing"**. Phiên #105 đã triển khai GIAI ĐOẠN 0 (hệ màu emerald-teal + header 3 vùng + bộ chọn khoảng thời gian); tài liệu này là kế hoạch **các giai đoạn kế tiếp** cho từng module, từng dialog, từng cách hiển thị — kèm chỉ tiêu nghiệm thu đo được.
>
> **Hiệu chỉnh v1.1 (#107)** theo làm rõ của trader: bỏ toàn bộ UI "thí nghiệm phân bổ" (E-ALLOC #106 — vẽ rắn thêm chân; khoản tiền thử nghiệm sandbox LÀ thí nghiệm). Module Hội đồng còn và chỉ còn: KPI tài khoản + đường cong equity + **vị thế nhóm theo thị trường** + sổ phán quyết. M4.4/M4.6/M4.8/M4.9 đã cập nhật; các mục khác bảo toàn.

---

## §1. Chẩn đoán tổng (bảng chấm #105 — bảo toàn làm mốc)

| # | View | Điểm | Vấn đề chủ đạo (đã định danh bằng chứng) |
|---|---|---|---|
| 1 | Tổng quan | 6.5 | Thông tin tốt nhưng dày đặc; thiếu phân cấp "một màn hình trả lời 3 câu hỏi" |
| 2 | Thị trường | 6.5 | Bảng giá + chart + tin + quan hệ xếp dọc dài; thiếu "chiều sâu thị trường" theo lớp tài sản |
| 3 | Danh mục | **5.0** | "Floating island" — nửa trang trống dưới tile; tabs vị thế/lệnh/giao dịch không phản ánh vòng đời |
| 4 | Tín hiệu | **4.5** | Wall-of-text — mỗi tín hiệu 1 khối chữ dày; lý do + kiểm soát + trạng thái trộn lẫn |
| 5 | Đội Agent | 5.5 | "Wall of gray" — 23 thẻ agent gần giống nhau; khó tìm agent đang RUNNING/ERROR |
| 6 | Tổng hợp | 7.0 | 8 tab tốt nhưng tab active mờ (đã giảm bớt #105); nội dung ML nặng chữ |
| 7 | Cài đặt | 6.0 | Input thiếu affordance (biết bấm được không); nhóm cấu hình dài |
| 8 | Dialog kho tin | 6.0 | Bảng tin tốt; legend dài dòng; lịch đôi đã cải thiện #102 |
| 9 | Chi tiết agent | 7.5 | Tốt nhất — đủ cấu trúc, có nhịp thị giác |
| — | Mobile 390 | 5.5 | Header gọn 2 hàng OK; bảng giá bảng lệnh phải cuộn ngang; touch target một số chỗ < 44px |

**Root causes (nguyên nhân gốc, #105):**
- RC1 — **Thế giới xám trắng**: PRIMARY trắng zero-chroma (dark `oklch(0.922 0 0)`) + card ≈ nền (ΔL ≈ 0.06) + muted-foreground quá mờ → toàn app như bản nháp xám. *(ĐÃ vá #105 giai đoạn 0: PRIMARY emerald-teal `0.76 0.125 170`, nền dark `0.17 0.014 250`, card `0.223`, border 13%, tabs pill `/60`)*
- RC2 — **Rối mắt**: thiếu hệ phân cấp thị giác thống nhất — mọi Card "cùng to cùng trọng lượng"; không có khái niệm tier-1 (3–4 KPI) → tier-2 (danh sách) → tier-3 (chi tiếtDialog).
- RC3 — **Văn dài không cấu trúc**: lý do agent/nhận định/note là 1 khối chữ — không chip, không bullet, không nhấn số.
- RC4 — **Kích thước/bố cục**: padding các nơi khác nhau (p-3/p-4/p-6 lẫn lộn), grid không khí khoảng trắng ("floating island" Danh mục), mobile bảng min-w 600–900px phải cuộn ngang.
- RC5 — **Trạng thái im lặng**: loading = 8 skeleton giống nhau; empty = 1 dòng mờ; error = text đỏ — không phân biệt được "đang tính" với "không có gì".

---

## §2. Nguyên tắc thiết kế dẫn đường (mọi module đều theo)

1. **3 giây hiểu được**: mỗi module phải trả lời ngay câu hỏi trung tâm bằng vùng tier-1 (Tổng quan: thị trường đang怎样 + tín hiệu mới nhất; Danh mục: tôi đang lãi/lỗ bao nhiêu; Tín hiệu: có gì cần quyết; Hội đồng: tài khoản + phán quyết gần nhất; Đội Agent: ai đang chạy/ai lỗi).
2. **Hệ phân cấp 3 tầng**: tier-1 = 3–4 ô số lớn có màu ngữ nghĩa; tier-2 = danh sách cuộn `max-h-96 custom-scrollbar`; tier-3 = dialog chi tiết (không nhồi vào màn chính).
3. **Màu có nghĩa, không trang trí**: màu chỉ mang 4 ngữ nghĩa — tăng (xanh dương chuẩn #45) · giảm (đỏ) · đứng/cảnh báo (amber) · thương hiệu/acción (emerald-teal #105). Số trung tính thì tabular-nums, KHÔNG tô màu tùy hứng.
4. **Một ngôn ngữ thành phần**: StatTile · ListRow (label trái — số phải) · ChipMeta · VerdictBadge · Sparkline SVG · EmptyState có hành động. Một thành phần = một mục đích, dùng lại mọi module (đối xứng cách ML_OPS quản lý model).
5. **Trung thực trạng thái**: loading skeleton CÓ kích thước đúng nội dung; empty kèm "việc cần làm để có dữ liệu" (pattern NewsCard/RelationsCard #103); error nêu bước khắc phục.
6. **Mobile là граж dân hạng nhất**: mọi bảng có biến thể thẻ dọc ≤ 390px (không cuộn ngang); touch target ≥ 44px; header đã 2 hàng #105 — giữ.

---

## §3. Design tokens (mở rộng của #105 giai đoạn 0 — một nguồn sự thật)

### §3.1 Màu (globals.css — đã có #105, bổ sung)
- Giữ: PRIMARY emerald-teal `oklch(0.76 0.125 170)` (dark) / `0.52 0.115 163` (light); nền dark `0.17 0.014 250` có chiều sâu lạnh.
- **Bổ sung**: `--tile-bg` (mặt ô KPI = card + 1 mức nổi, ΔL ≈ 0.02 so card) · `--tier-1-value` (font-weight 700, 1.35rem) · màu "đang chạy" = PRIMARY pulse nhẹ; màu ERROR kept đỏ 600; PAUSED amber.
- **Cấm**: indigo/blue之外的 ui màu mới; tô màu toàn hàng bảng (chỉ cột số + badge).

### §3.2 Typography (thang 5 bậc, cố định)
| Bậc | Kích thước / cân | Dùng cho |
|---|---|---|
| T1 | 28px/700 tabular | số KPI tier-1 (equity, P&L, xác suất) |
| T2 | 16px/600 | CardTitle, giá trị hàng chính |
| T3 | 14px/500 (sm) | nhãn, dữ liệu phụ |
| T4 | 12px/400 (text-xs) | meta, timestamp |
| T5 | 11px/400 (text-[11px]) | footnote mô hình hoá/ghi chú trung thực |

### §3.3 Density & layout
- Card padding chuẩn hoá: `p-4` nội dung + `gap-4` (mục #106 UI Rules); KPI tile `p-3`; danh sách hàng `py-2.5 px-4`.
- Lưới module: mobile 1 cột → sm 2 → xl 5/7 hoặc 7/5 (chỉ 2 cột tối đa trên desktop, tránh "5 cột micro-card").
- Khoảng trắng có chủ đích: hết "floating island" — nếu nội dung ngắn, footer vẫn đáy (rule sticky footer nhà).

---

## §4. Thiết kế lại từng module (mục tiêu điểm → thay đổi cụ thể)

### M4.1 Danh mục 5.0 → mục tiêu 8.0 *(ưu tiên 1 — tệ nhất bảng)*
1. **Bỏ "floating island"**: bố cục mới = hàng KPI tier-1 4 ô (Tổng tài sản · Lãi/lỗ chưa thực hiện ± màu + % · Biến động ngày · Sức mua) → hàng 2: **đường cong equity** (SVG pattern #106 CouncilWorkspace) + AllocationDonut cạnh nhau → tabs Vị thế/Lệnh/Giao dịch chỉ còn phần dưới.
2. **Tabs theo vòng đời**: thêm nhãn đếm trên tab ("Vị thế 3 · Lệnh chờ 1") — thấy ngay có việc đang chờ (tận dụng waiting-hint #96).
3. Bảng vị thế: cột Lãi/lỗ tô màu ngữ nghĩa + cột "% NAV"; hàng hover hiện roadmap tới biểu đồ mã (setSelectedSymbol + chuyển module Thị trường — điều hướng chéo đã có pattern #88).
4. Empty-state từng tab có hành động: "Chưa có lệnh — tín hiệu CONSENSUS gần nhất: TCB MUA (chuyển tới Tín hiệu)".

### M4.2 Tín hiệu 4.5 → mục tiêu 8.0 *(ưu tiên 2)*
1. **Chống wall-of-text**: mỗi tín hiệu = 1 hàng ListRow cấu trúc: [Badge hướng MUA/BÁN/GIỮ + màu] [mã + score] [chip đồng thuận CONSENSUS/WEAK] [1 dòng lý do rút gọn 120 ký tự] [chip trạng thái ACTIVE/ACTED/EXPIRED] → nút "Chi tiết" mở dialog tier-3 chứa FULL rationale + JSON tín hiệu + hành động Duyệt/Từ chối.
2. Nhóm theo trạng thái: "Cần quyết" (ACTIVE + đủ điều kiện) nổi trên cùng có viền PRIMARY; "Đã thực thi / Hết hạn" gọn hơn (chỉ 1 dòng).
3. Gắn **phán quyết sổ đánh giá D-LEDGER (#106)** lên tín hiệu đã đánh giá: chip "LỢI +2,3%" / "TỔN THẤT −1,1%" — vòng phản hồi thị giác (trader thấy ngay quyết định cũ kèm hậu quả).
4. Mobile: hàng tín hiệu xếp dọc thành thẻ 2 dòng, hành động bấm to.

### M4.3 Đội Agent 5.5 → mục tiêu 7.5
1. **Thống kê squad trên cùng**: 4 ô KPI (đang chạy · lỗi ·healthScore trung bình · chu kỳ gần nhất xong/giờ) + dải ngang hiển thị 23 chấm trạng thái (xanh chạy · đỏ lỗi · vàng pause · xám idle — hover xem tên) → "map sức khoẻ đội" 1 giây đọc xong.
2. Danh sách agent mặc định GỌN (1 hàng: tên + nhóm + chấm trạng thái + healthScore mini-bar), thẻ đầy đủ (mô tả, model, nhiệm vụ) chỉ mở ra qua nút — hết "wall of 23 gray cards".
3. Bộ lọc nhóm nhanh (Nghiên cứu/Kiểm soát/Điều hành/Nền tảng/ML) thành chip-toggle.

### M4.4 Tổng quan 6.5 → 7.5
1. Tier-1 "bảng chốt phiên": 3 số (VN30 hướng + % · tín hiệu mới nhất + hướng · P&L hội đồng hôm nay) — P&L hội đồng giờ có thật từ #106 D-LEDGER.
2. Tin nhanh chỉ 5 tiêu đề + chip nguồn/điểm lexicon; nhận định Bayes thành 1 thẻ có posterior bar (pUp/pDown) thay chữ mô tả.
3. Cột phải (xl+): "Việc cần làm" gom: tín hiệu chờ duyệt · lệnh chờ khớp + nextOpenLabel (#96) · nhiệm vụ K3 sắp đến · vị thế hội đồng đang nắm kèm lãi/lỗ từng mã (D-LEDGER #106).

### M4.5 Thị trường 6.5 → 7.5
1. Card Đa rổ #106 đã vào — nâng cấp: thêm sparkline 30 phiên mỗi rổ (SVG pattern #106) + click rổ → lọc quotes-table theo nhóm đó.
2. Bảng giá: giữ nhóm sàn + 3 nhóm mới #106; thêm chế độ "giọn" (6 cột) mặc định mobile, "đầy đủ" qua toggle (giữ quotesExpanded).
3. Giá vàng/dầu/forex hiển thị đúng đơn vị FX_RATE/центs #106 — kiểm tra formatUnitPrice mọi nơi xuất hiện (bảng + chart tooltip).

### M4.6 Hội đồng (mới #106 · hiệu chỉnh #107 — bỏ toàn bộ phần thí nghiệm phân bổ)
- 3 tầng GIỮ: hàng KPI tài khoản (equity · cash · P&L từ kích hoạt · biến động ngày) + đường cong equity (SVG sparkline K1-daily) + sổ phán quyết D-LEDGER (verdict badge · peak/trough · Σ P&L).
- Nâng cấp: bảng **VỊ THẾ NHÓM THEO THỊ TRƯỜNG** (CP VN · CP quốc tế · trái phiếu · forex · hàng hoá — mỗi nhóm chip tổng giá trị + lãi/lỗ; tài sản USD kèm chip quy đổi USD→VND và tách lãi giá / lãi tỷ giá); badge "hội đồng thấy tài khoản" đầu card nhắc quyền năng; khi E-EXEC (#107 blueprint §5) vào thì thêm chip phiên đánh dấu nguồn giá close thị trường đó. **KHÔNG còn** card thí nghiệm · dialog tạo thí nghiệm · dòng bài học thí nghiệm.

### M4.7 Tổng hợp 7.0 → 7.5
- Tab active đã pill /60 (#105); tiếp: mỗi tab ML thêm "1 dòng đọc nhanh" đầu tab (kết luận + 3 số) trước khối chi tiết kỹ thuật; sơ đồ mạng thần kinh thêm chú giải cạnh (đã có tooltip W) — giữ.

### M4.8 Cài đặt 6.0 → 7.0
- Input affordance: mọi ô cấu hình thêm label nổi + placeholder ví dụ thật + nút "Kiểm tra" nơi có thể (pattern VNDIRECT đã có Test); nhóm card theo trình tự hành động (Kết nối → Chạy agent → Thử nghiệm → Phân bổ) với số bước 1-2-3.
- Khối Cơ chế thử nghiệm + Khối Hội đồng (mô tả job đánh giá quyết định 16:45 hằng ngày · nguồn dữ liệu đa thị trường 06:15/15:45 · link sang module Hội đồng).

### M4.9 Dialog chuẩn hoá (kho tin + chi tiết agent + form tạo nhiệm vụ K3)
- Mọi dialog: max-w nhất quán (sm:max-w-lg vừa · 3xl lớn), tiêu đề động từ hành động, footer luôn Huỷ + hành động chính DISABLED-CÓ-LÝ-DO (tooltip vì sao chưa bấm được — pattern dialog kho tin #102).
- Legend dài → popover "?" thay footnote dài dòng.

### M4.10 Mobile 5.5 → 7.0
- Bảng min-w lớn: biến thể "thẻ dọc" cho vị thế/lệnh/tín hiệu ở <sm (map trường: tiêu đề = symbol+hướng; dòng 2 = số chính; dòng 3 = meta) — kết thúc cuộn ngang.
- Touch target: nút icon nhỏ nhất 36×36 vùng bấm (padding ảo), nút chính ≥ 44px.
- Tabbar module dạng cuộn ngang với snap khi sidebar dài (hoặc giữ logo-toggle + badge module như hiện tại — đo A/B bằng thời gian tìm module).

---

## §5. Kế hoạch triển khai 4 pha (mỗi pha nghiệm thu độc lập)

| Pha | Phạm vi | nghiệm thu đo được | Phụ thuộc |
|---|---|---|---|
| **P1** | M4.1 Danh mục + M4.2 Tín hiệu (2 view tệ nhất) | ảnh chụp trước/sau + VLM chấm lại ≥ 7.5 · mobile 390 không cuộn ngang · 0 console | #106 D-LEDGER (chip phán quyết) |
| **P2** | M4.3 Đội Agent + M4.4 Tổng quan + dialog chuẩn | dải 23 chấm + KPI squad · "3 giây hiểu" kiểm thử người · 0 lỗi lint/tsc | chỉ giao diện |
| **P3** | M4.5 Thị trường + M4.7 Tổng hợp + M4.8 Cài đặt | click rổ lọc bảng · mọi đơn vị mới format đúng | dữ liệu #106 đã có |
| **P4** | M4.10 Mobile toàn app + tokens §3 dọn xong | scrollWidth=clientWidth 390 mọi view · touch ≥ 44px audit | sau P1-P3 |

**Quy tắc mỗi pha**: giữ ngữ nghĩa màu #45 (tăng xanh dương · giảm đỏ · đứng amber) bất diệt; lint 0 · tsc 0 · E2E agent-browser desktop 1440 + mobile 390 · 0 console error · chấm điểm VLM lại view vừa sửa · worklog + push.

---

## §6. Những gì KHÔNG đổi (đã đúng — bảo vệ)
- Ngữ nghĩa màu tăng/giảm/đứng (#45 trader duyệt) — mọi nâng cấp chỉ tăng CỰC mạnh độ tương phản, không đổi hướng.
- Cấu trúc điều hướng 1 route + sidebar overlay + header 3 vùng (#105) — ổn định, tăng badge trạng thái thôi.
- Bộ chọn khoảng thời gian toàn cục (#105) — đã đúng, các view mới (Hội đồng #106) đã ăn theo.
- Sticky footer + min-h-screen flex (chuẩn nhà).
- Toàn bộ nội dung tiếng Việt + format vi-VN + tabular-nums cho số.

> Trình tự đề xuất: **P1 trước** (Danh mục + Tín hiệu — 2 điểm thấp nhất, người dùng nhìn nhiều nhất). Trader duyệt pha nào triển khai pha đó — như quy trình blueprint của các cơ chế trước (#85, #98, #103, #106).

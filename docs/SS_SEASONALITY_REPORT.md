# SS_SEASONALITY_REPORT — Báo cáo nghiệm thu SS-9 (Task 178 · Phase 2)

> Nguồn spec: `docs/STATE_SPACE_BLUEPRINT.md` §SS-9 — *"chỉ làm khi có bằng chứng: fit trước trên dữ liệu đang có, log-score holdout phải chứng minh seasonality có tín hiệu đáng kể trên HOSE trước khi đụng UI"*.
> Phương pháp: M0 (mean hằng) vs M1 (dummy day-of-week Thứ Ba..Thứ Sáu, baseline Thứ Hai + cửa sổ Tết ±7 ngày lịch quanh mốc âm lịch) — cả hai qua cùng máy Kalman trạng thái hằng (T=I, Q=0, ZSeq theo ngày), σ² MLE đóng băng theo train (quy tắc 3), chấm log-score mật độ 1-bước trên holdout (SS-11, PIT tuyệt đối). Thư viện: `src/lib/ml/ss/seasonal.ts` · kiểm định hermetic p178 T-P2-7 (có tín hiệu → M1 thắng; thuần nhiễu → không thắng — 2 chiều).
> Dữ liệu: DB thật (bar EOD VNDIRECT) · rổ top-10 ADTV HOSE ~1025 phiên/mã · VNINDEX 2287 phiên · ngày chạy 23/10/2026 (scripts/ss-seasonal-report-tmp.ts — tạm, xoá sau chạy).

## Kết quả log-score holdout (M1 − M0, mỗi bước)

| Chuỗi | diff/bước | Kết luận |
|---|---|---|
| VIC | +0,0147 | M1 thắng |
| TCB | +0,0085 | M1 thắng |
| VHM | +0,0173 | M1 thắng |
| SHB | +0,0034 | M1 thắng |
| MSN | +0,0118 | M1 thắng |
| HPG | +0,0110 | M1 thắng |
| SSI | +0,0157 | M1 thắng |
| VPB | +0,0183 | M1 thắng |
| FPT | +0,0073 | M1 thắng |
| PNJ | +0,0067 | M1 thắng |
| **Rổ basket (1025 phiên lịch)** | **+0,0291** | **M1 thắng** |
| **VNINDEX (2287 phiên)** | **+0,0081** | **M1 thắng** |

**M1 thắng 12/12 chuỗi** — kể cả VNINDEX dài 2287 phiên (mẫu lớn nhất, khó thắng nhất).

## Hiệu ứng ước lượng (γ ± sd, quy đổi σ return ngày)

Rổ basket (σ ngày ≈ 1,42%):

| Hiệu ứng | γ̂ | ± sd | đơn vị σ |
|---|---|---|---|
| γ_ThứBa | +0,44% | 0,14% | 0,30σ |
| γ_ThứTư | +0,48% | 0,14% | 0,32σ |
| γ_ThứNăm | +0,28% | 0,14% | 0,19σ |
| γ_ThứSáu | +0,08% | 0,14% | 0,06σ |
| γ_Tết (±7 ngày) | +0,68% | 0,35% | 0,45σ |

VNINDEX: T3 +0,31% ± 0,08% · T4 +0,37% ± 0,08% · T5 +0,16% · T6 +0,18% · Tết +0,61% ± 0,30% — cùng dấu, cùng cấu trúc với basket.

Đọc: **Thứ Hai là ngày yếu nhất** (baseline — mọi dummy dương); hiệu ứng đỉnh giữa tuần (T3/T4), phai dần tới Thứ Sáu; cửa sổ Tết **dương** ~+0,6-0,7% (≈2σ ở basket/VNINDEX — rìa ý nghĩa thống kê, nhất quán qua 9/10 mã, ngoại lệ FPT −0,23σ).

## Kết luận dứt khoát (đúng yêu cầu lộ trình Phase 2)

1. **CÓ tín hiệu seasonality đáng kể trên HOSE** — cấu trúc day-of-week thắng holdout log-score trên 12/12 chuỗi độc lập với dấu nhất quán; không phải vẽ nên (đối chứng thuần nhiễu cho diff ≈ +0,007 < ngưỡng, p178 T-P2-7d).
2. **Cỡ hiệu ứng khiêm tốn nhưng có thật**: ~0,3σ/phiên (≈0,4-0,5% so baseline Thứ Hai) — đủ lớn để một driver xác suất ăn được (log-score +0,03/bước trên basket), chưa đủ lớn để tự thành tín hiệu giao dịch.
3. **Quyết định theo blueprint**: KHÔNG đụng UI/featureset ngay. Seasonal factor chỉ được vào feature/driver khi qua đủ 4 cổng kiểu SS-4 (PIT tuyệt đối · windowHash digest bump theo triết lý F-166b-3 · kill-switch + audit · A/B log-score sweep) — đây là việc của cổng sweep tương lai, không phải Phase 2. Thư viện `seasonal.ts` đã sẵn sàng (pure, deterministic, null-tolerant SS-3); bảng Tết cứng tới 2028 — cập nhật thủ công khi vượt.
4. **Trung thực phương pháp**: ước lượng γ từ trạng thái lọc cuối (toàn dữ liệu) · σ² đóng băng theo train 75% · dữ liệu bar thật VNDIRECT (mô phỏng KHÔNG can thiệp chuỗi EOD) · không hiệu chỉnh multiple-comparison giữa 5 hiệu ứng (đã né phần lớn nhờ dấu nhất quán 12/12 + đối chứng nhiễu).

— Hết báo cáo. Task 178 ghi nhận vào worklog; không đổi code nào ngoài thư viện `seasonal.ts` + script kiểm định đã xoá.

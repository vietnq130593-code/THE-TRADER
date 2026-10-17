# AI Engineer Review — Kiến trúc & Vận hành "Bộ não" The Trader

**Ngày review:** 17/10/2026 · **Reviewer:** Kỹ sư AI (vai độc lập) · **Phạm vi:** toàn bộ chuỗi dữ liệu → học → quyết định → phản hồi
**Mục tiêu tham chiếu của chủ sở hữu:** bộ não cực mạnh trong phân tích dữ liệu thị trường — dùng dữ liệu cũ phán đoán nền kinh tế, biến động tài chính, cổ phiếu, trái phiếu.

---

## 1. Phán quyết tổng quan

| Khía cạnh | Điểm | Nhận định |
|---|---|---|
| Kỷ luật kỹ thuật (ops, fail-soft, idempotent, versioning, trung thực số liệu) | **9/10** | Mạnh hơn đa số dự án production cùng cỡ |
| Chuỗi trách nhiệm-phản hồi (D-LEDGER, Bandit, đánh giá cả tín hiệu bị bác) | **8,5/10** | Hiếm có — điểm sáng lớn nhất |
| Độ phủ dữ liệu cho phân tích kinh tế | **4/10** | **Nghẽn cổ chai số 1** — xem P0-1 |
| Khả năng dự báo hiện tại (valAcc 39,4% vs 33% mù) | **5/10** | Cạnh biên +6,4 điểm phần trăm — thật nhưng mỏng |
| Triết lý học nhất quán | **6/10** | Tách kênh đúng, nhưng còn 1 chỗ học mù (P0-3) |

**Kết luận:** Không phát hiện lỗi chết (fatal bug). Hệ thống hôm nay là **bộ não phân tích kỹ thuật giá** xuất sắc về kỷ luật — nhưng chưa phải **bộ não phân tích kinh tế**. Khoảng cách nằm ở 3 thiếu sót P0 dưới đây, đều修 được theo lộ trình không phá kiến trúc.

---

## 2. Findings theo mức nghiêm trọng

### 🔴 P0 — nghẽn trực tiếp con đường tới mục tiêu

**P0-1 · KHÔNG có pipeline dữ liệu vĩ mô.**
Bằng chứng: `featureAt()` (src/lib/ml/features.ts:365) — đủ 16 đặc trưng MLP đều là kỹ thuật giá thuần (RSI, MACD hist, logret5/10, SMA20/50, volz20, std20ret, close/max60, ret1+3 lag, ΔRSI, Δvolz, ΔSMA). Không một đặc trưng lãi suất, CPI, GDP, tín dụng, tỷ giá, yield. → Không thể "phán đoán nền kinh tế" khi não chưa từng nhìn biến kinh tế nào.

**P0-2 · Dữ liệu phi-giá đã thu nhưng KHÔNG chảy vào não (silo).**
- `ForeignFlow` 754 bản ghi — chỉ vào prompt agent, không vào feature.
- Sentiment lexicon tin tức — chỉ dùng trong XREL event-study, không vào MLP.
- `FinancialFundamental` **0 bản ghi** — bảng dựng sẵn, `agent-context.ts` có nhánh đọc, nhưng không job nào populate.
- `CorporateEvent` **2 bản ghi** — lịch sự kiện gần như trống (cổ tức, phái sinh, công bố kết quả).
→ Ngay cả dữ liệu đã có trong tay, vòng học cũng không dùng.

**P0-3 · Trọng số ensemble hardcoded — mùtiết học.**
`ENSEMBLE_WEIGHTS = {mlp: 0,7, linreg: 0,3}` (hoặc 0,5/0,2/0,3 khi GRU bật) cố định tay. Nghịch lý: Bandit học uy tín 6 cử tri, nhưng bên TRONG tiếng nói ml-forecast, tỉ lệ MLP:linreg:GRU không bao giờ được học lại từ bằng chứng. Ngoại lệ duy nhất là cổng Brier cho GRU lên giọng — đúng hướng nhưng chưa đủ.

### 🟠 P1 — chất lượng dự báo

| # | Finding | Bằng chứng | Rủi ro |
|---|---|---|---|
| P1-1 | Cạnh biên mỏng, chưa có báo cáo hiệu chuẩn (calibration) xác suất | valAcc 39,4% (v8), 3 lớp — chưa log per-class acc/Brier cho MLP serving | Điểm số ensemble `pUp−pDown` có thể tự tin sai |
| P1-2 | Một chân trời duy nhất (5 phiên), chỉ phân loại hướng | `ML_HORIZON_DAYS=5`, labelAt chỉ ra nhãn 0/1/2 | Không đo độ lớn biến động, không có dự báo biến động (volatility) |
| P1-3 | XREL chỉ trong nước | quan hệ lead-lag tính giữa VN30/VN100 + 10 ngành HOSE; data US (10 mã) + HK (4 mã) sync 06:15 mỗi ngày nhưng không vào học quan hệ | Bỏ mất kênh truyền lân cận mạnh nhất: US → VN (đêm Mỹ → sáng VN) |
| P1-4 | Sức mạnh thống kê Bandit thấp | 28 pulls/arm; `SETTLE_SCAN_LIMIT=30` — phiếu cũ hơn bị "quên" | Chưa đủ mẫu để tin khoảng cách 0,657 vs 0,443 là bền |
| P1-5 | RAG thuần từ khoá (BM25) | tokenizer tiếng Việt bỏ dấu + tách khoảng trắng, không embedding | "lạm phát" không trúng "CPI"; bỏ ngữ nghĩa |
| P1-6 | Bias sống sót tiềm ẩn trong tập train | rổ top-10 thanh khoản — universe chọn theo hiện tại hay point-in-time? | Nếu chọn nhìn-lùi, backtest đẹp hơn thực tế |
| P1-7 | Q-table thô | 48 trạng thái × 3 hành động (±0,5 exposure) | Chính sách RL chỉ mang tính tham chiếu |

### 🟡 P2 — vận hành

- IntradayBar 5.032 mẫu — chưa đủ cho mô hình intraday.
- Nhịp chu kỳ 240 phút mập hơn nhịp tick 10 giây (chấp nhận được cho chiến lược multi-day).
- 21 AgentRun FAILED lịch sử (transient mạng — đã fail-soft, không mất dữ liệu).
- Chống bịa số liệu của LLM đang chỉ ở mức prompt ("KHÔNG bịa số liệu") — phiếu bầu có parse có cấu trúc nên rủi ro trung bình.
- Không có bộ nhớ episodic từng agent (chỉ ký ức chung qua broadcast RAG).

---

## 3. Những gì KHÔNG phải sửa (đang đúng — giữ nguyên)

1. Tách 3 kênh học (giá→MLP · uy tín→Bandit · ký ức→RAG) — đúng triết lý, tránh ô nhiễm chéo.
2. D-LEDGER đánh giá CẢ tín hiệu bị cổng bác — phản thực (counterfactual) trung thực, hiếm gặp.
3. GRU shadow 60 phiên + cổng Brier trước khi lên cử tri — không nhận máy mù.
4. Registry model versioned + seed cố định + PSI drift + sweep 12 ứng viên Chủ nhật.
5. Trung thực số liệu: 39,4% được báo đúng, không tô hồng; 98,3% hoàn thành (21 FAILED khai rõ).

---

## 4. Lộ trình đề xuất (không phá kiến trúc)

**Giai đoạn 1 — "Cho não nhìn kinh tế" (đường dữ liệu, ~2-3 tuần)**
- Job vĩ mô mới: lãi suất SBV/SWF, CPI/GDP (TCTK), tín dụng, tỷ giá USD/VND lịch sử, yield Mỹ (10Y/2Y), Fed rate — nguồn công khai World Bank/FRED/GSO.
- Populate `FinancialFundamental` + `CorporateEvent` (lịch cổ tức/kết quả) — bảng đã sẵn.
- Feature set **v3-macro**: 16 → ~24 chiều (thêm Δrate, ΔCPI yoy, slope yield, FX momentum, sentiment tin tức tổng hợp) — kèm gate A/B so v2-lag16 qua sweep, không thay mù.
- Universe point-in-time: chốt rổ theo thanh khoản TẠI thời điểm lấy mẫu.

**Giai đoạn 2 — "Não mạnh hơn" (~3-4 tuần)**
- Đầu ra đa nhiệm: hướng + biên độ + biến động (3 đầu ra chung backbone).
- Hiệu chuẩn xác suất (Platt/isotonic) trước khi vào điểm ensemble.
- **Học trọng số ensemble** thay hardcode — meta-learner tuyến tính nhỏ, train bằng D-LEDGER lịch sử.
- XREL mở rộng quốc tế: lead-lag US/HK → VN (kênh truyền đêm Mỹ).
- RAG hybrid: BM25 + embedding đa ngữ chạy local.

**Giai đoạn 3 — "Vòng phản hồi chặt hơn" (~liên tục)**
- Bandit ngữ cảnh (contextual) — reward theo chế độ thị trường.
- Trình dò chế độ (regime: tăng/giảm/đi ngang) làm state cho Q-learning & ensemble.
- Kịch bản/Monte Carlo VaR cho hội đồng rủi ro.
- Tích luỹ mẫu Bandit ≥ 100 pulls/arm trước khi tin khoảng cách uy tín.

---

## 5. Lời trung thực kết review

Dù làm hết lộ trình, dự báo kinh tế vẫn có trần — thị trường hiệu quả ở mức cao, nhiễu chiếm ưu thế ở chân trời ngắn. Mục tiêu thực tế không phải "prophet" mà là: **cạnh biên đo được + bất định định lượng được + tự thừa nhận khi sai**. Hệ thống hiện tại đã có hạt nhân của ba điều đó — chỉ cần cho nó nhìn nhiều loại dữ liệu hơn và học trọng số đến cùng triết lý đã chọn.

# AUTONOMY BLUEPRINT — 4 KẾ HOẠCH K1–K4: TIỀN ẢO THỬ NGHIỆM · CHẾ ĐỘ CHẠY LIÊN TỤC · NHIỆM VỤ ĐỊNH KỲ · BAN ĐIỀU HÀNH GIAO VIỆC

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/AUTONOMY_BLUEPRINT.md` · **Version:** 1.3 · **Created:** 2026-10-11 (phiên #85) · **Updated:** 2026-10-11 (phiên #88 — **bản đồ hiển thị K1 + 3 sửa số học "về 0 từ đầu"** theo 2 yêu cầu trader: reset-toàn-bộ/vốn-tự-quyết-định + "thông tin ở module/tab nào" — xem §5.6a/§5.6b)
> **Status:** **K2 ✅ xong #86 · K1 ✅ xong #87 (+ củng cố #88) — K3 là bậc kế tiếp** · K3/K4 xếp hàng theo thứ tự đã duyệt §3
> **Nguồn gốc:** trader tiết lộ 4 kế hoạch tương lai tại §8 [ML_OPS_BLUEPRINT.md](./ML_OPS_BLUEPRINT.md) v1.1 (phiên #79) kèm ghi chú kiến trúc; hiệu lệnh soạn blueprint này: *"Trước hết viết Blueprint triển khai K1-K4 cho tôi"* (phiên #85).
> **Cross-refs:** [ML_OPS_BLUEPRINT.md](./ML_OPS_BLUEPRINT.md) (§8 — 5/5 DUYỆT nền tảng) · [ML_LEARNING_BLUEPRINT.md](./ML_LEARNING_BLUEPRINT.md) (cổng L1–L5 — K1 cấp dữ liệu cho L5/GRU) · [EXECUTION_OPS_BLUEPRINT.md](./EXECUTION_OPS_BLUEPRINT.md) (TWAP E-P1-2 · ExecutionPlan · committed view) · [PHASE3_BLUEPRINT.md](./PHASE3_BLUEPRINT.md) (§4.5/§4.9 — chu kỳ KHÔNG tự tạo lệnh) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [Fixbug.md](../Fixbug.md)

---

## §0. Bối cảnh — 4 kế hoạch của trader (trích nguyên văn §8 ML_OPS_BLUEPRINT v1.1)

| Kế hoạch | Nguyên văn trader | Đọc đúng ý |
|---|---|---|
| **K1 — Cơ chế thử nghiệm** | *"module Cài đặt: nhập số tiền ảo → bấm kích hoạt → tiền mặc định cấp cho hệ agents thực hiện các giao dịch thử nghiệm; sự tăng/giảm của số tiền theo thời gian chính là quá trình học phân tích thị trường & đầu tư của agents"* | Tài khoản **sandbox** riêng; agents **tự giao dịch** trên tín hiệu của chính mình (không chờ trader duyệt); đường cong tiền theo thời gian = tín hiệu học trung tâm |
| **K2 — Chạy agent = chế độ liên tục** | *"một khi bấm, các agent/nhóm tự động bắt đầu công việc; chỉ ngừng khi trader tự tay bấm tắt"* | Chu kỳ 23 agents chuyển từ nhịp env (240ph) sang **toggle UI + AppSetting** — bấm bật chạy mãi, bấm tắt dừng hẳn |
| **K3 — Nhiệm vụ (module Đội agents)** | *"phần nhiệm vụ từng agent sẽ là nơi thiết lập công việc hàng ngày/hàng tuần cho agents"* | `AgentTask` hiện là danh sách tĩnh — nâng cấp thành **nhiệm vụ định kỳ có lịch**, engine tự đôn đốc đúng giờ |
| **K4 — Ban Điều hành & Thực thi** | *"sau này được xây khả năng thiết lập Nhiệm vụ cho agents thuộc các nhóm khác"* | Chủ tịch (portfolio-strategist, nhóm executive) **giao việc** cho agents nhóm research/control/platform/ml — nhiệm vụ do agent tạo, chạy trên đúng hạ tầng K3 |

**Ghi chú kiến trúc đã ghi tại §8 v1.1 (đối chiếu khi triển khai):** *"K2/K3/K4 đều cần một 'chủ lịch' chung — engine scheduler (mini-service :3003) là ứng viên tự nhiên (đã có pattern kiểm 60s + state P0-5 + fail-soft, sẽ được mở rộng qua A1/A4); model `AgentTask` có sẵn trong schema là nền cho K3/K4; cơ chế tiền ảo K1 nên dùng `BrokerAccount` loại sandbox + AuditLog faucet để tách bạch khỏi paper account hiện tại."* → Blueprint này hoá đúng 3 quyết định đó thành kế hoạch chi tiết.

### §0.5 Hiện trạng nền — đo trực tiếp mã nguồn ngày 2026-10-11 (sau #84)

| Mảnh nền | Hiện trạng (bằng chứng file) | Khoảng cách tới K1–K4 |
|---|---|---|
| Chủ lịch | engine :3003 — scheduler tick 60s, 7 lịch sống (tick 10s · news 15ph · eod 15:45 · intl 06:15 · reprobe SUN:04:00 · settle 16:15 · ml-train SUN:04:00) + `AGENT_CYCLE_MINUTES=240` đọc env lúc boot (`index.ts:74-77`) — state P0-5 qua `/api/market/engine-state` | Đủ nền: thêm due-check k-run (K2) · task-due (K3) · sandbox-equity (K1); env → AppSetting |
| Nút "Chạy agent" | Header — 1 click = 1 chu kỳ (`header.tsx:302-317`, POST `/api/agents/run`, cooldown 60s `route.ts:88`) | K2: thêm toggle "Liên tục" cạnh nút (giữ nút chạy-ngay như cũ) |
| Chu kỳ 23 agents | POST `/api/agents/run` — 23 agents ~43s (#83 đo), RAG L1 tiêm prompt, **KHÔNG tự tạo Order** — tín hiệu chờ trader duyệt (`route.ts:1078` §4.5/§4.9 PHASE3) | K1 cần đường auto-convert vào sandbox — **không đụng** đường duyệt paper |
| Tạo lệnh từ tín hiệu | một nguồn duy nhất `signal-execution.ts` (guard vòng đời · gate LIVE · clamp dải + bội 100 · phí 0,15% · TWAP N-con E-P1-2 · audit ORDER_CREATED) — gọi bởi `signals/[id]/convert` + `decision` | K1 tái dùng nguyên vẹn với tham số tài khoản đích + sizing riêng |
| Tài khoản | 1 `BrokerAccount` paper duy nhất (VD0029961828, margin, cash 452.177.765 ₫); `accountType` là **String** (`schema.prisma:151`) — mở giá trị `"sandbox"` **0 migrate** | K1: tài khoản sandbox thứ hai; **7 file** có query `brokerAccount.findFirst/findMany` (`portfolio · tick · exec/kpi · agent-context ×2 · agent-service-runs ×2 · reconciliation · signal-execution`) phải lọc `accountType` |
| Nhiệm vụ agent | `AgentTask` (agentId/title/description/status/priority/result) — 9 dòng seed tĩnh, **0 trường lịch** (`schema.prisma:337-351`) | K3: thêm `schedule/nextDueAt/lastRunAt/paused/runCount/failStreak` (additive) |
| Vòng học | settle 16:15 hằng ngày (bandit Thompson theo realized rổ ±0,5%) · retrain CN 04:00 skip-guard · A13 RAG L1 + `RetrievalLog` (#83) · B2 cổng verdict FAIL — GRU khoá | K1: P&L sandbox = nguồn tín hiệu **bổ sung** cho GRU kill-switch (điểm tích hợp đã duyệt §8 ML_OPS) + dữ liệu cổng L5 |
| Đồng hồ tiền theo thời gian | `CashSnapshot` (E-P1-3 — 1 dòng/chu kỳ, prune 90 ngày) đã có sẵn cho mọi `brokerAccountId` | K1: route settle-equity ghi snapshot cho sandbox 16:30 hằng ngày → equity curve 0 model mới |
| UI | Settings workspace (VNDIRECT · market-data · risk · notify · calendar) — chưa có khối thử nghiệm; Agents workspace có panel chi tiết + scorecard B8 + khối RAG #83; executive workspace có chairman-scorecard E-P1-4 | K1: khối Settings + bộ lọc tài khoản Danh mục; K3: tab Nhiệm vụ panel agent; K4: khối "Nhiệm vụ đã giao" tab Ban ĐH |

---

## §1. Nguyên tắc nền tảng (xuyên suốt 4 kế hoạch)

1. **$0 chi phí vận hành thêm** — mọi vòng mới chạy trên hạ tầng sẵn có: LLM free-tier (đã đo 23 agents ~4,5k token/chu kỳ), thuật toán viết tay TS, Supabase Postgres hiện tại. Không thêm dịch vụ trả phí.
2. **Schema additive** — không đổi/toString cột hiện có; chỉ thêm cột optional + model mới khi thật cần. **K1 & K2: 0 model mới** (tận dụng `BrokerAccount.accountType` String + `AppSetting` + `CashSnapshot`); K3/K4: mở rộng `AgentTask` + 1 cột `AgentRun.taskId`.
3. **Ba thế giới tiền tách bạch tuyệt đối** — real (tương lai) / **paper** (hiện tại — trader duyệt từng lệnh) / **sandbox** (K1 — agents tự giao dịch). Mọi query tiền mặt · vị thế · lệnh · KPI · reconciliation phải quy về đúng tài khoản; bằng chứng tách bạch là điều kiện nghiệm thu số 1 của K1.
4. **Chủ lịch duy nhất** — engine :3003 là nơi duy nhất đôn đốc mọi thứ định kỳ (K1/K2/K3); API route chỉ phục vụ yêu cầu tức thời và phải **idempotent + due-guard**. Không bao giờ thêm `setInterval` thứ hai cạnh engine (tránh 2 nguồn sự thật về "đã chạy chưa").
5. **AppSetting là nguồn sự thật điều khiển** — mọi toggle (K2 bật/tắt + nhịp, K1 bật/tắt, K4 bật/tắt + giới hạn) lưu `AppSetting`; env `AGENT_CYCLE_MINUTES` chỉ còn hiệu lực khi trader **chưa từng** set k-run (mặc định hậu phương) — đúng cam kết §8 v1.1: *"quyền kiểm soát chuyển về AppSetting + nút UI (env thành mặc định hậu phương)"*.
6. **Fail-soft mọi scheduler callback** — try/catch từng due-check; lỗi một lịch không giết các lịch khác; log + thử lại tick sau (pattern settle `ML_OPS §3 A1`, nguyên tắc vàng Fixbug #2/#3: log phải chảy đúng chu kỳ).
7. **PIT & audit trail** — mọi thay đổi tiền sandbox (faucet/topup/reset/auto-convert/settle) ghi `AuditLog` action `K1_*`; mọi lần chạy nhiệm vụ ghi `AgentRun` (kèm taskId mới); mọi bật/tắt K2 ghi `K2_*`. Restart phải sống sót nhờ state DB (pattern P0-5).
8. **Không bịa dữ liệu** — lệnh sandbox khớp theo `Quote.last` thật cùng cơ chế paper; sandbox chưa có tín hiệu nào thì đường cong phẳng — hiển thị trung thực.
9. **Idempotency + vận hành sandbox** — chạy 2 lần không tạo trùng (trừ dữ liệu mới hợp lệ); tiến trình nền double-fork `(env -u DATABASE_URL setsid nohup … &)`; mọi truy vấn shell dùng `env -u DATABASE_URL`.
10. **Kill-switch 2 tầng cho từng K** — tầng 1: AppSetting (route đọc mỗi lần); tầng 2: nút UI tức thời. K2 tắt có hiệu lực **từ chu kỳ kế tiếp** (không giết giữa dòng — chống AgentRun kẹt RUNNING); K1 tắt = ngừng auto-convert mới (giữ vị thế đang mở); K4 tắt = ngừng sinh nhiệm vụ mới (nhiệm vụ cũ trader quyết).

---

## §2. Kiến trúc đích — một biểu đồ cho cả 4 kế hoạch

```
TRADER (UI)
├─ Header:  [Chạy agent] (1 lần — như cũ)   [⬤ Liên tục ▾ nhịp]   ← K2
├─ Settings: khối "Cơ chế thử nghiệm (tiền ảo)"                    ← K1
│    nhập số tiền → Kích hoạt / Nạp thêm / Đặt lại / Tạm dừng
├─ Đội agents: panel chi tiết agent → tab Nhiệm vụ định kỳ          ← K3
└─ Ban Điều hành: khối "Nhiệm vụ đã giao" + cấu hình giao việc      ← K4
        │  (mọi thao tác → API → AppSetting `k-run`/`k-sandbox`/`k4` + AuditLog)
        ▼
ENGINE :3003 — CHỦ LỊCH (tick 60s, fail-soft, state DB P0-5)
├─ k2-due      : k-run.enabled && now−lastCycleAt ≥ nhịp → POST /api/agents/run
├─ k3-due      : AgentTask where schedule≠null, !paused, nextDueAt ≤ now
│                → POST /api/agents/[id]/run {taskId} (defer 5ph nếu agent RUNNING)
├─ k1-equity   : 16:30 ICT hằng ngày (sau settle 16:15)
│                → POST /api/k/sandbox/settle-equity (CashSnapshot cho sandbox)
└─ (giữ nguyên 7 lịch cũ; AGENT_CYCLE_MINUTES env = mặc định hậu phương)
        ▼
API ROUTES (idempotent, due-guard)
├─ /api/k/run            start/stop/cycle-now   (K2)
├─ /api/k/sandbox/*      activate/topup/reset/settle-equity   (K1)
├─ /api/agents/[id]/run  nâng cấp: nhận taskId → tiêm prompt + cập nhật AgentTask (K3)
├─ /api/agents/run       chu kỳ 23 agents — CUỐI chu kỳ gọi auto-convert sandbox (K1)
└─ /api/settings         GET/PUT mở rộng payload kRun + kSandbox + k4
        ▼
PRISMA / SUPABASE
├─ BrokerAccount (accountType "sandbox" — 0 migrate)
├─ AppSetting: k-run · k-sandbox · k4 (JSON)
├─ AgentTask + schedule/nextDueAt/paused/runCount/failStreak/createdByAgentId (K3/K4)
├─ AgentRun + taskId (liên kết lịch sử nhiệm vụ)
├─ CashSnapshot (equity curve sandbox — 0 model mới)
└─ AuditLog: K1_SANDBOX_FUNDED · K1_SANDBOX_TOPUP · K1_SANDBOX_RESET ·
             K1_SANDBOX_AUTO_ORDER · K2_RUN_STARTED · K2_RUN_STOPPED ·
             K4_TASK_ASSIGNED · K3_TASK_* · ORDER_CREATED (có sẵn)
```

**Luồng K1 (tự học bằng tiền ảo) — trục của toàn blueprint:**

```
chu kỳ 23 agents (K2 duy trì nhịp liên tục)
  → Chủ tịch + 5 agent nghiên cứu ra tín hiệu (RAG L1 tiêm ngữ cảnh)
  → tín hiệu qua cổng đồng thuận B9 (consensusGate đã lưu trên Signal)
  → CUỐI chu kỳ: auto-convert vào TÀI KHOẢN SANDBOX (một nguồn signal-execution.ts,
    sizing theo % NAV sandbox, TWAP nếu lệnh lớn — tái dùng nguyên vẹn E-P1-2)
  → engine tick khớp lệnh sandbox → Position (giống paper, đúng tài khoản)
  → 16:30 ICT: settle-equity → CashSnapshot 1 dòng/ngày → ĐƯỜNG CONG TIỀN
  → đường cong = "quá trình học" hiển thị ở Settings;
    P&L theo tín hiệu = dữ liệu cổng L5 (AgentLesson) + tín hiệu GRU kill-switch
```

---

## §3. Thứ tự triển khai đề xuất: **K2 → K1 → K3 → K4**

| Bậc | Giai đoạn | Lý do vị trí | Phụ thuộc kỹ thuật |
|---|---|---|---|
| 1 | **K2 — Chế độ chạy liên tục** (~1 ngày) ✅ **XONG #86** | Nhỏ nhất, giải phóng sớm quyền điều khiển; từ đó mọi dữ liệu học (đồng hồ 30 ngày L3 · shadow 60 phiên GRU · equity curve K1) **trôi liên tục không cần đợi trader bấm nút từng lần** | Không phụ thuộc ai — dùng scheduler + AppSetting sẵn |
| 2 | **K1 — Tiền ảo thử nghiệm** (~2–2,5 ngày) ✅ **XONG #87** (triển khai TRƯỚC K3 theo hiệu lệnh riêng của trader) | Trung tâm tầm nhìn trader ("sự tăng/giảm của số tiền = quá trình học"); triển khai sớm để đồng hồ học bắt đầu trôi sớm nhất | Không phụ thuộc cứng K2 (chạy được trên nhịp env 240ph hiện có) — nhưng giá trị tối đa khi K2 đã bật |
| 3 | **K3 — Nhiệm vụ định kỳ** (~1,5–2 ngày) | Nâng cấp AgentTask + due-check engine — vừa là nền bắt buộc của K4 | Dùng scheduler + single-run route `[id]/run` sẵn (#83) |
| 4 | **K4 — Ban ĐH giao việc** (~1–1,5 ngày) | Dựng trên hạ tầng nhiệm vụ K3; chỉ thêm lớp "người tạo là Chủ tịch" + validate + UI | **Phụ thuộc K3** (bắt buộc) |

**Thứ tự K2 → K1 → K3 → K4: ĐÃ DUYỆT (§8-Q7).** **Tổng: ~6–7 ngày công · 0 ₫ chi phí vận hành thêm.** Mỗi giai đoạn hoàn tất → chạy **Fixbug giao thức** (Fixbug.md) trên đúng scope rồi mới sang giai đoạn sau — như mọi blueprint trước.

---

## §4. K2 — Chế độ chạy liên tục (bậc 1)

### 4.1 Hợp đồng dữ liệu

`AppSetting` key **`k-run`** (JSON):
```jsonc
{
  "enabled": false,          // trader bấm Bật/Tắt
  "intervalMinutes": 240,    // nhịp ∈ {60, 120, 240, 480} — mặc định 240
  "startedAt": "…",          // lần bật gần nhất (audit + UI)
  "lastCycleAt": "…",        // engine ghi sau MỖI chu kỳ (kể cả tay) — due-check
  "cyclesRun": 0             // đếm tích luỹ từ lần bật
}
```
Không tồn tại key → env `AGENT_CYCLE_MINUTES` hiệu lực như hiện tại (hậu phương). Tồn tại → AppSetting thắng tuyệt đối.

### 4.2 API

- `POST /api/k/run` — body `{action: "start"|"stop", intervalMinutes?}`:
  - `start`: validate nhịp ∈ bộ cho phép → upsert k-run `{enabled:true, startedAt:now}` (giữ lastCycleAt/cyclesRun cũ nếu có) + AuditLog `K2_RUN_STARTED`.
  - `stop`: upsert `{enabled:false}` + AuditLog `K2_RUN_STOPPED`. **Hiệu lực từ chu kỳ kế tiếp** — nếu chu kỳ đang chạy thì cho chạy hết (route hoàn tất tự nhiên). **Tắt khi key chưa từng tạo vẫn tạo key `enabled:false`** — AppSetting thắng tuyệt đối kể từ lúc tồn tại → env interval bị nhường quyền → chu kỳ dừng hẳn (đúng "chỉ ngừng khi trader tự tay bấm tắt").
  - Không cần `cycle-now`: nhịp due-check engine tự POST `/api/agents/run`; chạy ngay = nút "Chạy agent" sẵn (1 nguồn luồng).
- `GET /api/k/run` (v1.1 — **endpoint riêng**, không phình `/api/settings`): trả `KRunState {exists, enabled, intervalMinutes, startedAt, lastCycleAt, cyclesRun, nextCycleAt}` — engine due-check + Header query riêng refetch 60s. Key chưa từng tồn tại → `exists:false` + giá trị mặc định (env fallback hiệu lực).

### 4.3 Engine — due-check `k2` (thêm vào tick 60s, fail-soft)

```
mỗi tick 60s:
  GET /api/k/run (timeout 10s — 1 request/phút, nhẹ hơn tick giá 10s)
  kRunKeyExists = exists   ← flag module-scope: env interval callback đọc flag này
  nếu !exists → trả về (env fallback do interval cũ quản — KHÔNG đụng)
  nếu !enabled → trả về (key tồn tại → env ĐÃ bị nhường quyền → im lặng)
  nếu now < nextCycleAt → trả về
  nếu k2 chu kỳ đang in-flight (guard pattern #48) → trả về
  POST /api/agents/run (timeout 280s < maxDuration route 300s)
  → route TỰ cập nhật k-run.lastCycleAt + cyclesRun++ (mỗi chu kỳ, kể cả tay)
  → nextCycleAt tự dịch chuyển; broadcast WS "cycle" như sẵn có
```

**Nhường quyền env → AppSetting:** callback của `setInterval` env kiểm flag `kRunKeyExists` — key tồn tại thì **skip và log** (AppSetting thắng tuyệt đối, kể cả enabled=false). Race ≤ 60s giữa lúc tạo key và flag cập nhật được cooldown 60s + guard 409 single-run của route chặn thực tế (không xảy ra chu kỳ kép).

### 4.4a Nút "Chạy agent" khi có K2 — GIỮ (quyết định #87)

> Trader (nguyên văn #87): *"Nếu có chế độ K2 bật tắt việc chạy liên tục thì nút Chạy agent còn có tác dụng gì nữa vậy, nếu còn tác dụng thì giữ lại và giải thích cho tôi tác dụng, nếu không thì loại bỏ"*

**Quyết định: GIỮ NGUYÊN.** Nút "Chạy agent" (1 click = 1 chu kỳ) và toggle "Liên tục" (K2) KHÔNG trùng chức năng — chúng là 2 tầng điều khiển khác nhau:

1. **Chạy ngay không đợi nhịp** — K2 chạy theo nhịp 60–480ph; khi thị trường đang biến động (vd tin tức lớn giữa 2 nhịp), trader muốn chu kỳ NGAY: bấm nút. Chu kỳ tay cập nhật `lastCycleAt` → nhịp K2 tự ĐẨY lùi từ điểm đó (không chồng — in-flight guard + cooldown 60s chặn).
2. **Nguồn duy nhất khi K2 tắt** — kill-switch 2 tầng (§1.10): tắt "Liên tục" dừng chu kỳ tự động, nhưng trader vẫn có thể chủ động bấm chạy từng chu kỳ khi muốn (đúng hành vi gốc trước K2 — hồi quy bảo toàn).
3. **Kích hoạt vòng học K1 tức thì** — từ #87, mỗi chu kỳ (kể cả tay) là một lần agents "học": tín hiệu qua cổng → lệnh sandbox → đường cong tiền. Bấm nút = chủ động cho hệ thống một lần học ngay.
4. **Kiểm chứng sau thay đổi cấu hình** — đổi cấu hình/fix lỗi xong, bấm chạy 1 chu kỳ để xác nhận toàn đội khoẻ (~56s) mà không phải đợi hàng giờ tới nhịp kế.

### 4.4 UI (Header)

- Nút "Chạy agent" **giữ nguyên** (1 lần). Thêm cạnh đó: `Switch` nhãn **"Liên tục"** + chọn nhịp (60/120/240/480 phút — dropdown) hiện khi bật; badge trạng thái `⬤ Liên tục · 240ph · chu kỳ kế ≈ 2g15p nữa` (đếm ngược từ `nextCycleAt` — query riêng `GET /api/k/run` refetch 60s).
- Mobile 390px: Switch thu gọn còn biểu tượng + nhãn ngắn "Liên tục".

### 4.5 Nghiệm thu K2 (cổng kết thúc giai đoạn)

1. Bật nhịp 60ph (thử nghiệm nhanh) → k-run xuất hiện trong DB; chu kỳ đầu chạy trong ≤ 60ph; `cyclesRun` tăng.
2. Bấm Tắt **đang giữa chu kỳ** → chu kỳ đó hoàn tất (AgentRun COMPLETED đủ 23), sau đó đợi > 1 nhịp → **0 chu kỳ mới**; audit K2_RUN_STOPPED.
3. Restart engine (double-fork) → k-run đọc lại từ DB; lastCycleAt sống sót → **không chạy bù dồn** (nhiều chu kỳ chồng).
4. Xoá k-run (chưa từng set) + `AGENT_CYCLE_MINUTES=0` → chu kỳ tắt — hành vi cũ bảo toàn (hồi quy).
5. Hai chu kỳ không chồng nhau (in-flight guard tái lập pattern #48 — test bằng POST kéo dài).
6. E2E desktop + mobile 390px: 0 console error; badge đếm ngược đúng.

---

## §5. K1 — Cơ chế thử nghiệm tiền ảo (bậc 2 — trung tâm)

### 5.1 Tài khoản sandbox (tận dụng schema — 0 model mới)

- `BrokerAccount` thứ hai: `broker "VNDIRECT"`, `accountNumber "SANDBOX-K1"` (định danh hiển thị — không phải số thật), **`accountType "sandbox"`** (cột String sẵn `schema.prisma:151` — mở giá trị, 0 migrate), `currency VND`, status ACTIVE.
- **Quarantine 7 file query** (`portfolio/route.ts` · `market/tick/route.ts` · `exec/kpi/route.ts` · `agent-context.ts` ×2 · `agent-service-runs.ts` ×2 · `exec/reconciliation.ts` · `signal-execution.ts`): mọi `findFirst/findMany` brokerAccount thêm lọc `accountType: { not: "sandbox" }` cho đường paper — K1 route luôn truy vấn ngược `accountType: "sandbox"`. Đây là việc **bắt buộc làm trước** bất kỳ dòng K1 nào khác (P0 tách bạch).
- `CashSnapshot` ghi cho sandbox (`brokerAccountId` sẵn) → equity curve 0 model mới. `CommittedCashView`/KPI/TWAP/reconciliation đều đã tham số hoá theo `brokerAccountId` → tự đúng khi truyền tài khoản sandbox.

### 5.2 Faucet & vòng đời tiền (API `/api/k/sandbox/*`)

| Route | Hành vi | Guard | Audit |
|---|---|---|---|
| `POST activate` `{amount}` | tạo/tái bật sandbox; `cashBalance = amount` | amount ≥ 10.000.000 ₫, bội 100.000 ₫; nếu đã bật → 409 yêu cầu reset trước | `K1_SANDBOX_FUNDED` {before, after} |
| `POST topup` `{amount}` | cộng tiền vào tài khoản đang bật | amount ≥ 1.000.000 ₫; đang tắt → 409 | `K1_SANDBOX_TOPUP` |
| `POST reset` | xoá toàn bộ Order/Trade/Position/CashSnapshot sandbox + cash về 0 + `enabled:false` | xác nhận UI 2 bước; ghi snapshot tổng kết vào AuditLog trước khi xoá | `K1_SANDBOX_RESET` {equity cuối, realisedPnl tổng} |
| `POST pause` / `resume` | tắt/bật auto-convert (giữ vị thế) | — | `K1_SANDBOX_PAUSED/RESUMED` |

`AppSetting` key **`k-sandbox`**: `{enabled, activatedAt, initialAmount, sizePct (mặc định 5 = % NAV/lệnh theo POSITION_SIZE_PCT pattern), maxOrdersPerCycle (5), maxBudgetPctPerCycle (10)}`.

### 5.3 Auto-execution — tái dùng MỘT nguồn `signal-execution.ts`

- **Điểm ghép duy nhất: CUỐI chu kỳ** (`agents/run` route, sau khi mọi tín hiệu đã lưu + broadcast xong): nếu `k-sandbox.enabled` → quét tín hiệu chu kỳ vừa sinh **đã qua cổng đồng thuận** (Signal.consensusGate sẵn từ B9) & ACTIVE → với mỗi tín hiệu (đến hạn mức `maxOrdersPerCycle`/`maxBudgetPctPerCycle`):
  - gọi đúng thư viện `signal-execution.ts` với **tham số hoá mới**: `targetAccountId = sandbox`, sizing `sandbox` (% NAV sandbox), TWAP quyết định như thường (E-P1-2 nguyên vẹn), khớp theo tick engine như paper.
  - **KHÔNG đổi `Signal.status`** trên đường sandbox (giữ vòng đời "chờ trader duyệt paper" nguyên vẹn) — dấu "đã auto-convert" nằm riêng: AuditLog `K1_SANDBOX_AUTO_ORDER` {signalId, orderId} + tra cứu trùng bằng audit trước khi convert (idempotent: 1 tín hiệu → tối đa 1 lệnh sandbox).
  - trader vẫn duyệt lệnh paper từ cùng tín hiệu như cũ → **2 thế giới độc lập** (§8-Q1 xác nhận phương án này).
- Guard an toàn: chỉ khi chu kỳ kết thúc sạch (không crash giữa); lệnh sandbox tuân thủ clamp trần/sàn + bội 100 + phí 0,15% như paper (không ưu đãi — học phải gặp phí thật).

### 5.4 Settle-equity 16:30 ICT (engine lịch mới `K1_EQUITY_AT`, sau settle 16:15)

- `POST /api/k/sandbox/settle-equity` (due-guard idempotent theo ngày — pattern eodSyncDate): tính equity sandbox = cash + Σ(position × Quote.last thật) → `CashSnapshot` 1 dòng (`source "k1-daily"`); AuditLog `K1_SANDBOX_SETTLED` {cash, equity, unrealisedPnl, realisedPnlOfDay}.
- Cuối tuần/Lễ: guard theo vn-calendar overlay sẵn (chặn như settle A1 — không có EOD mới).
- Prune snapshot > 365 ngày (K1 giữ dài hơn 90 ngày của paper — đường cong học dài hạn; dung lượng ~365 dòng/năm là không đáng kể).

### 5.5 Vòng học — **TRỘN 2 KÊNH REWARD theo quyết định trader (§8-Q2 v1.1)**

> Trader (nguyên văn): *"có trộn, mỗi lần chiến thắng, mỗi lựa chọn đúng từ sandbox dù sao cũng đồng nghĩa nếu là môi trường thực tế thì đấy là chiến thắng thật, tuy nhiên thất bại cũng là thất bại thật, riêng bài học thì lúc nào cũng là bài học thật"*

→ 2 kênh reward **cộng dồn vào CÙNG posterior Beta** của mỗi arm (thắng sandbox = thắng thật → α tăng thật; thua = thua thật → β tăng thật):

1. **Kênh 1 — dự đoán (giữ nguyên hoàn toàn):** settle 16:15 ICT theo realized rổ ±0,5% sau 5 phiên → `BanditEvent.reward` → α/β như hiện tại. Không đổi lịch, không đổi semantic.
2. **Kênh 2 — thực thi sandbox (MỚI, gộp vào job 16:30):** mọi **Position sandbox ĐÃ ĐÓNG** trong phiên (realisedPnl ròng đã trừ phí 0,15% + thuế bán) quy về **tín hiệu gốc → agent tạo tín hiệu** ("lựa chọn" của ai thì thắng/thua của người đó):
   - lãi > 0 → reward **1** · lỗ ≤ 0 → reward **0** (nhị phân hoá đúng thang Beta-Bernoulli)
   - cộng THÊM vào `BanditArm` của agent đó (α+1/β+0 hoặc ngược, pulls+1, wins tương ứng) → **posterior Thompson Sampling = trộn 2 kênh**: arm dự đoán chuẩn mà giao dịch lỗ bị kéo xuống, arm giao dịch thắng được kéo lên — đúng "chiến thắng thật / thất bại thật".
   - **Idempotent:** dedupe qua `AuditLog` action `K1_SANDBOX_EXEC_REWARD` (entity "Position", entityId = positionId) — chạy 2 lần không cộng kép.
   - **KHÔNG ghi BanditEvent** cho kênh 2 (bảng đó là "phiếu bầu theo assessment" — unique [assessmentId, agentCode], kênh thực thi không có assessment; ghi thêm sẽ phá ngữ nghĩa + ràng buộc unique).
3. **Phân tách phân tích (chống sai ngữ nghĩa khi trộn):** calibration/Brier/Wilson (B8) **chỉ tính trên BanditEvent** (kênh 1 — confidence là độ tự tin DỰ ĐOÁN, thực thi không có "confidence"); posterior trajectory hiển thị **3 đường**: dự đoán · thực thi · trộn (posterior arm thật). Header nhãn rõ từng đường.
4. **Bài học thật (cấp dữ liệu mọi tầng học):** telemetry exec (P&L theo agent/tín hiệu — từ AuditLog + Position sandbox) → dữ liệu cổng **L5 AgentLesson** ("tín hiệu X của agent Y qua cổng nhưng sandbox lỗ N/N lần gần nhất…") + tín hiệu **GRU kill-switch/thăng giọng** (điểm tích hợp §8 ML_OPS đã duyệt) + hiển thị trực tiếp cho trader.

**Thứ tự Job 16:30 (một route, bốn việc):** (a) settle-exec-reward kênh 2 như trên → (b) settle-equity CashSnapshot → (c) telemetry tổng hợp → (d) audit tổng kết. Chạy SAU settle 16:15 (kênh 1 xong trước, không tranh lock DB).

### 5.6 UI

- **Settings — khối "Cơ chế thử nghiệm (tiền ảo)"**: input số tiền (validate live), nút **Kích hoạt**; khi đang bật: số dư · equity hiện tại · lãi/lỗ từ lúc kích hoạt (₫ + %) · số phiên đã chạy · đồ thị equity mini (CashSnapshot, đường + tooltip ngày) · nút Nạp thêm / Tạm dừng / Đặt lại (reset 2 bước); trạng thái nguồn trung thực ("chưa có tín hiệu nào được thực thi" khi 0 lệnh).
- **Portfolio workspace — bộ lọc tài khoản**: dropdown "Tài khoản: Giấy (paper) / Thử nghiệm (sandbox)" → `portfolio` route nhận query `accountType` (mặc định paper — hành vi cũ bảo toàn); tab Danh mục hiển thị đúng vị thế sandbox do agents tự giữ.
- Header/Overview: không đổi (giữ tập trung — K1 chỉ sống ở Settings + Danh mục).

#### 5.6a Bản đồ hiển thị K1 — "thông tin nằm ở module nào, tab nào" (phiên #88)

> Trader hỏi: *"thông tin sử dụng số tiền này, các lượt giao dịch, quyết định được thể hiện ở
> module nào, tab nào… hay chỉ hiển thị ngắn gọn trong tab Cài đặt?"* — câu trả lời được
> khắc cứng vào UI (khối "3 nơi" trong Settings) thay vì chỉ lời giải thích:

| Thông tin | Nơi hiển thị | Chi tiết |
|---|---|---|
| **Tiền** (số dư, equity, P&L, đường cong, nạp/tạm dừng/đặt lại) | **Cài đặt → Cơ chế thử nghiệm** | 6 ô số liệu + đồ thị equity mini + vòng đời tiền (Nạp thêm/Tạm dừng/Đặt lại về 0) |
| **Lượt giao dịch** (lệnh, khớp lệnh, vị thế) | **Danh mục → Thử nghiệm** | Bộ lọc Giấy/Thử nghiệm → 3 tab con Vị thế / Lệnh / Giao dịch |
| **Quyết định** (tín hiệu agents) | **Tín hiệu** | Feed tín hiệu — tín hiệu được agents tự thực thi có badge **"Đã thực thi · thử nghiệm"** (`sandboxExecuted`) |

- **Điều hướng chéo #88**: Settings có 2 nút nhảy thẳng ("Lệnh & giao dịch" → Danh mục ở sẵn thế giới Thử nghiệm qua store `portfolioWorld`; "Quyết định (tín hiệu)" → workspace Tín hiệu); ngược lại Danh mục (đang xem Thử nghiệm) có link "quản lý vốn & đặt lại: Cài đặt → Cơ chế thử nghiệm".

#### 5.6b Ba sửa số học "về 0 từ đầu" (phiên #88 — trader: "phải có khả năng setup tất cả về 0 lại từ đầu")

1. **`autoOrderCount` đếm Order SỐNG** (`db.order.count` theo tài khoản sandbox) — trước đây đếm audit marker `K1_SANDBOX_AUTO_ORDER` mọi thời đại → sau Đặt lại vẫn hiển thị số lệnh vòng cũ (đo thật: hiển thị 1 khi 0 lệnh).
2. **`lastSettleAt` scoped `createdAt ≥ activatedAt`** — mốc settle của vòng hiện tại; marker settle vòng trước reset không lọt vào.
3. **P&L trừ tiền nạp**: `pnlSinceActivation = equity − (initialAmount + topupTotal)` — nạp thêm là TIỀN VÀO không phải lãi (trước đây equity 105tr − vốn 100tr = +5tr "lãi" giả từ chính khoản nạp test; `topupTotal` = tổng `K1_SANDBOX_TOPUP` từ activatedAt, expose ra state cho UI hint "Vốn X + nạp Y").

> Ngữ nghĩa reset giữ nguyên thiết kế §5.2 đã duyệt: xoá sạch Order/Trade/Position/CashSnapshot +
> cash về 0 + `enabled:false`; **AuditLog K1_\* giữ vĩnh viễn** (truy vết — tổng kết vòng cũ được
> lưu TRƯỚC khi xoá) và **posterior BanditArm KHÔNG hoàn tác** (thắng/thua thật đã trộn vào vòng
> học theo Q2 — kinh nghiệm là của agents, tiền mới về 0 chứ trí nhớ không). Muốn xoá cả vòng học
> thì dùng nút Bandit riêng trong Cài đặt ML.

### 5.7 Nghiệm thu K1

1. Kích hoạt 100.000.000 ₫ → sandbox account xuất hiện đúng `accountType` + cash + AuditLog; **portfolio paper KHÔNG đổi một đồng** (số dư/equity/vị thế so ảnh chụp trước — bằng chứng tách bạch P0).
2. Chu kỳ kế sinh tín hiệu qua cổng → Order auto trên sandbox (đúng tài khoản, TWAP nếu thoả, phí 0,15%), tín hiệu KHÔNG sinh lệnh paper; chạy lại convert → **idempotent** (không lệnh kép).
3. Tick engine khớp lệnh → Position sandbox; Danh mục (bộ lọc Thử nghiệm) hiển thị vị thế + P&L.
4. 16:30 (giả lập bằng force do route hỗ trợ `?force=1` nội bộ test) → CashSnapshot 1 dòng/ngày, chạy 2 lần idempotent; cuối tuần bị chặn.
5. Tạm dừng → chu kỳ sau **0 lệnh mới**, vị thế cũ giữ; Đặt lại → xoá sạch + audit tổng kết.
6. Restart engine + app → toàn bộ trạng thái sống sót (k-sandbox + vị thế + đường cong).
7. E2E desktop + mobile 390px: 0 console error.

### 5.8 Chuyển thế giới khi kết nối VNDIRECT thật + Giấy về 0 (phiên #91)

**Trả lời câu hỏi trader #91** — *"khi kết nối thành công VNDIRECT thì agent có thể gửi đề xuất/dùng tiền thật giao dịch thật chứ?"*: **ĐÚNG, theo đúng kiến trúc S3/LIVE gate có sẵn** — agents vẫn chỉ GỬI ĐỀ XUẤT (tín hiệu + plan), lệnh THẬT chỉ đi khi `LIVE_TRADING=true` + creds VNDIRECT đầy đủ (`liveTradingGate()` chặn 2 lớp) và vẫn qua duyệt từng lệnh của trader. Việc kết nối VNDIRECT thật KHÔNG tự động bật gửi lệnh thật — đó là quyết định tường minh thứ hai của trader.

Cơ chế tự động khi **Lưu cấu hình VNDIRECT thật** (PUT `/api/settings` phát hiện chuyển `chưa configured → configured`):

1. **Cơ chế Thử nghiệm TỰ ĐỘNG TẠM DỪNG** — `pauseSandboxForRealTrading()` (pause §5.2: dừng lệnh MỚI, vị thế cũ giữ + vẫn kết toán equity; KHÔNG reset — lịch sử & bài học giữ nguyên). Audit riêng `K1_SANDBOX_AUTO_PAUSED_FOR_REAL` phân biệt pause tay. Fail-soft tuyệt đối (lỗi DB sandbox không làm hỏng luồng lưu Settings). Response PUT trả field transient `sandboxAutoPaused` để UI toast đúng sự thật. Lưu lại creds khi đã configured từ trước → KHÔNG pause thêm; đã pause → không đụng.
2. **"Giấy" đổi tên "THỰC TẾ"** — `usePortfolioWorld` đọc `settings.vndirect.configured` (query `["settings"]` dùng chung cache Settings workspace): `paperLabel = configured ? "Thực tế" : "Giấy"` áp cho segmented control Danh mục + chip tài khoản Header + mọi tooltip. Luật auto-view #90 siết thêm: VNDIRECT đã configured → mặc định xem **THỰC TẾ** (tiền chính quay về thế giới thật), kể cả khi Thử nghiệm còn bật.
3. **Bài học có giá trị như nhau** — hai kênh reward §5.5 (kênh-1 duyệt tay Giấy/Thực tế, kênh-2 thực thi Thử nghiệm) cùng cộng dồn posterior Beta: khi Giấy trở thành Thực tế, kênh-1 tự trở thành reward từ lệnh thật — vòng học không cần đổi gì.
4. **Đặt lại thế giới Giấy về 0** (việc 1 — "xoá toàn bộ dữ liệu demo cũ, giá trị về đúng 0 tròn trĩnh"): `lib/paper-world.ts` `resetPaperWorld()` xoá Trade→Order→Position→CashSnapshot **mọi tài khoản giấy** (accountType ≠ sandbox — đúng filter P0 §5.1) + cash/equity/margin = 0 + audit `PAPER_WORLD_RESET` snapshot tổng kết TRƯỚC khi xoá. Route POST `/api/portfolio/reset-paper`; UI nút "Đặt lại dữ liệu" cạnh segmented control Danh mục (chỉ khi xem Giấy) + Dialog xác nhận 2 bước (pattern #90). KHÔNG chạm sandbox K1 / Signal / BanditArm / bài học agents. Idempotent (chạy trên thế giới sạch → counts 0 + audit bằng chứng thao tác).

**Nghiệm thu #91** (đo trực tiếp trên DB): reset-paper trên thế giới trống → 200 + summary 0 trung thực · activate 100tr → lưu VNDIRECT thật (4 trường) → `configured:true` + `sandboxAutoPaused:true` + k-sandbox `paused:true` cash 100tr giữ nguyên + audit `K1_SANDBOX_AUTO_PAUSED_FOR_REAL` · lưu creds lần 2 khi đã configured → `sandboxAutoPaused:false` (không pause lại) · xoá cấu hình → `configured:false` · resume → sandbox bật lại như bàn giao.

---

## §6. K3 — Nhiệm vụ định kỳ (module Đội agents) (bậc 3)

### 6.1 Schema — mở rộng `AgentTask` (additive) + `AgentRun.taskId`

```prisma
model AgentTask {
  // … giữ nguyên mọi cột hiện tại …
  schedule    String?    // null = nhiệm vụ tay 1 lần (như cũ) | "HH:MM" hằng ngày | "DOW:HH:MM" hằng tuần
  nextDueAt   DateTime?  // engine due-check (index @@index([nextDueAt]) where schedule != null → Prisma: @@index([nextDueAt]) đủ)
  lastRunAt   DateTime?
  runCount    Int        @default(0)
  failStreak  Int        @default(0)   // kill-switch nhiệm vụ: 5 lỗi liên tiếp → paused
  paused      Boolean    @default(false)
  createdByAgentId String? // K4: null = trader tạo (mặc định)
}
model AgentRun { // additive 1 cột:
  taskId String? // liên kết lịch sử chạy nhiệm vụ
}
```
**Cú pháp lịch = grammar engine sẵn có** (`parseHhMm`/`parseWeekly` `index.ts:96-135`) — không phát minh cron mới; tái dùng + xuất sang module chung `src/lib/schedule.ts` (engine + API cùng 1 parser — 1 nguồn sự thật).

### 6.2 API

- `POST /api/agents/[id]/tasks` (route mới) `{title, description, schedule?, priority}`: validate schedule bằng parser chung; server tính `nextDueAt` theo ICT (quá hôm nay → ngày kế có nghĩa; client không tự tính — chống lệch múi giờ).
- `PATCH /api/agents/[id]/tasks/[taskId]` — sửa/pause/resume/xoá (xoá chỉ khi chưa due; nhiệm vụ định kỳ đang RUNNING → 409).
- Single-run `POST /api/agents/[id]/run` nâng cấp: nhận thêm `{taskId}` → nạp title/description vào context prompt (đúng chỗ context agent hiện có) + AgentRun ghi taskId + khi xong cập nhật AgentTask (`lastRunAt`, `runCount++`, `result` = output mới nhất, `failStreak` reset/tăng, `nextDueAt` = +schedule; nhiệm vụ tay 1 lần → status COMPLETED/FAILED như semantics cũ).

### 6.3 Engine — due-check `k3TaskDue` (tick 60s, fail-soft)

```
mỗi tick 60s:
  tasks = query AgentTask where schedule≠null && !paused && nextDueAt ≤ now (take 10)
  với mỗi task:
    agent đang RUNNING (hoặc trong chu kỳ 23) → nextDueAt += 5 phút (defer — KHÔNG chồng run)
    ngược lại → POST /api/agents/[id]/run {taskId} (route cooldown có sẵn)
  lỗi route → failStreak do route cập nhật; engine chỉ đôn đốc, không tự viết kết quả
```
Kill-switch nhiệm vụ: `failStreak ≥ 5` → route tự `paused = true` + RiskAlert (severity WARNING, code `K3_TASK_AUTOPAUSED`) + notification-officer (S1 sẵn) báo trader.

### 6.4 UI (panel chi tiết agent — tab Nhiệm vụ)

- Nút "Tạo nhiệm vụ định kỳ": title · mô tả · lịch (hằng ngày HH:MM / hằng tuần chọn thứ + HH:MM — popover 2 bước) · priority.
- Danh sách nhiệm vụ: badge **Định kỳ** (schedule) / Tay (như cũ) · `nextDueAt` · `lastRunAt` · `runCount` · `failStreak` cảnh báo khi ≥ 3 · Switch tạm dừng từng nhiệm vụ.
- Tổng quan nhóm: 1 dòng "Lịch tuần" gom nhiệm vụ định kỳ cả nhóm theo thứ tự giờ (nhìn 1 cái thấy toàn bộ nhịp).

### 6.5 Nghiệm thu K3

1. Tạo daily 09:30 cho market-analyst → nextDueAt đúng (server tính, ICT).
2. Force due (test nội bộ `?force` hoặc đợi) → AgentRun mới có taskId; AgentTask runCount+1; nextDueAt lùi đúng 24h; chu kỳ 23 agents không bị ảnh hưởng.
3. Agent RUNNING khi due → defer 5 phút, không 2 run chồng (so AgentRun khoảng thời gian).
4. Simulate lỗi 5 lần liên tiếp (route lỗi cưỡng bức nội bộ test) → tự paused + RiskAlert + notify.
5. Pause → due bỏ qua; resume → nextDueAt tính lại.
6. Restart engine → nextDueAt sống sót DB, không chạy bù dồn.
7. E2E 0 console error; nhiệm vụ tay (seed 9 dòng) hiển thị đúng như cũ (hồi quy).

---

## §7. K4 — Ban Điều hành giao việc (bậc 4)

### 7.1 Cơ chế "Chủ tịch giao việc"

- **Ai được giao:** chỉ **Chủ tịch** (portfolio-strategist — mã đã dùng làm mốc chairman-scorecard E-P1-4). Các executive khác (execution-manager/settlement/cash-management) KHÔNG giao việc v1 (1 nguồn giao việc — đo được, chịu trách nhiệm được).
- **Giao cho ai:** agents nhóm **research/control/platform/ml** — quy tắc cấm: không giao cho nhóm executive (chống vòng lặp tự giao; đồ thị nhiệm vụ 2 cấp, không đệ quy) và không giao "nhiệm vụ tạo nhiệm vụ" (nhiệm vụ do agent tạo là công việc thật — phân tích/kiểm tra/báo cáo).
- **Khi nào:** trong chu kỳ 23 agents, sau bước Chủ tịch tổng hợp (prompt Chủ tịch được bổ sung khối `GIAO VIỆC` **chỉ khi k4.enabled** — đúng chỗ prompt Chủ tịch hiện có, sau RAG block #83).
- **Định dạng xuất:** Chủ tịch xuất JSON có cấu trúc (schema prompt chặt):
```jsonc
{"assignTasks": [
  {"agentCode": "liquidity", "title": "≤120 ký tự", "description": "≤600 ký tự",
   "schedule": "14:00" | "MON:09:30" | null,  // null = nhiệm vụ 1 lần
   "priority": "low|medium|high"}
]}
```
- **Validate route (fail-soft tuyệt đối):** agentCode tồn tại + đúng nhóm cho phép · title/description độ dài hợp lệ · schedule qua parser chung · `maxOpenTasksPerAgent` (mặc định 3 — đếm PENDING+RUNNING của agent đích) · lịch tối thiểu +4h từ giờ giao (không chồng chu kỳ đang chạy). Mọi vi phạm → **bỏ qua nhiệm vụ đó + log nguyên nhân** (KHÔNG crash chu kỳ — JSON rác là dữ liệu đầu vào phải chịu được).
- Tạo xong: AuditLog `K4_TASK_ASSIGNED` {agentCode đích, schedule, cycleAt}.

### 7.2 AppSetting + kill-switch

`AppSetting` key **`k4`**: `{enabled: false, maxOpenTasksPerAgent: 3, maxTasksPerCycle: 5}`. Tắt → prompt khối GIAO VIỆC biến mất (0 token thêm) + nhiệm vụ cũ **vẫn chạy đúng lịch K3** (trader tự xoá nếu muốn — không tự huỷ việc đang treo).

### 7.3 UI (tab Ban Điều hành — executive workspace)

- Khối **"Nhiệm vụ đã giao"**: bảng AgentTask `createdByAgentId ≠ null` (agent nhận · title · lịch · trạng thái · runCount · lần chạy cuối) + badge "Chủ tịch giao" + nút xoá/sửa như nhiệm vụ thường (quyền trader).
- Khối cấu hình: Switch bật/tắt + 2 giới hạn + dòng giải thích quy tắc (chỉ Chủ tịch · chỉ nhóm ngoài executive).
- Panel chi tiết agent (K3 UI): nhiệm vụ có `createdByAgentId` hiển thị badge nguồn tương ứng.

### 7.4 Nghiệm thu K4

1. Bật k4 → chu kỳ kế: Chủ tịch xuất JSON hợp lệ → AgentTask tạo đúng `createdByAgentId` = Chủ tịch; lịch +4h; agent đích chạy đúng giờ (hạ tầng K3).
2. Chủ tịch xuất JSON rác/thiếu trường/vượt giới hạn → nhiệm vụ rác bị bỏ + log nguyên nhân; **chu kỳ vẫn COMPLETED** (fail-soft chứng minh).
3. Giao cho executive → bị từ chối đúng quy tắc.
4. maxOpenTasksPerAgent chặn đúng (tạo đến hạn mức → nhiệm vụ thừa bị từ chối).
5. Tắt k4 → chu kỳ sau 0 nhiệm vụ mới sinh; nhiệm vụ đang treo vẫn due đúng; token prompt Chủ tịch **không tăng** (so sánh tokensIn trước/sau tắt).
6. E2E 0 console error; audit đầy đủ.

---

## §8. Câu hỏi mở — **ĐÃ TRẢ LỜI 8/8 (phiên #86)**

| # | Câu hỏi | Quyết định trader (2026-10-11) | Áp vào thiết kế |
|---|---|---|---|
| Q1 | K1 phạm vi auto-convert | **Theo đề xuất** — mọi tín hiệu qua cổng B9 | §5.3 giữ nguyên |
| Q2 | K1 trộn P&L sandbox vào vòng học? | **CÓ TRỘN** — *"mỗi lần chiến thắng, mỗi lựa chọn đúng từ sandbox dù sao cũng đồng nghĩa nếu là môi trường thực tế thì đấy là chiến thắng thật, thất bại cũng là thất bại thật, riêng bài học thì lúc nào cũng là bài học thật"* | **§5.5 thiết kế lại hoàn toàn** (v1.0 "không trộn" bãi bỏ): 2 kênh reward cộng dồn cùng posterior Beta · kênh thực thi nhị phân hoá theo realisedPnl ròng · quy về agent tạo tín hiệu · idempotent qua AuditLog · calibration tách kênh dự đoán |
| Q3 | K1 xem danh mục sandbox | **Có** — bộ lọc tài khoản | §5.6 giữ nguyên |
| Q4 | K2 bộ nhịp | **Theo đề xuất** — {60·120·240·480}ph, mặc định 240 | §4.1 giữ nguyên |
| Q5 | K3 AgentRun.taskId | **Theo đề xuất** — có | §6.2 giữ nguyên |
| Q6 | K4 tự chủ giao việc | **Theo đề xuất** — không duyệt từng nhiệm vụ | §7.2 giữ nguyên |
| Q7 | Thứ tự triển khai | **Theo đề xuất — K2 → K1 → K3 → K4** | §3 cập nhật: Bậc 1 K2 triển khai ngay phiên #86 |
| Q8 | K1 tiền mặc định | **Tự nhập** mỗi lần kích hoạt | §5.2 giữ nguyên (placeholder 100.000.000 ₫) |

> ~~Trả lời §8…~~ **ĐÃ DUYỆT ĐẦY ĐỦ — chốt v1.1, triển khai Bậc 1 (K2) ngay phiên #86 + Fixbug giao thức, sau đó lần lượt K1 → K3 → K4.**

---

## §9. Rủi ro & giảm nhẹ

| Rủi ro | Mức | Giảm nhẹ (đã cài vào thiết kế) |
|---|---|---|
| K1 lẫn tiền sandbox ↔ paper (sai số tiền — nghiêm nhất) | P0 | Quarantine 7 file query trước dòng K1 nào khác + nghiệm thu "paper không đổi một đồng" (§5.7-1) là cổng P0 của cả giai đoạn |
| Auto-convert xung đột vòng đời tín hiệu (đường paper duyệt tay) | P0 | Không đổi `Signal.status` trên đường sandbox; dấu "đã convert" nằm AuditLog + tra cứu trùng trước khi convert (idempotent) |
| K2 chu kỳ chồng/429 free-tier | P1 | In-flight guard (pattern #48) + cooldown route 60s sẵn + nhịp tối thiểu 60ph |
| K3 nhiệm vụ lỗi vô hạn tiêu token | P1 | failStreak ≥ 5 → tự paused + RiskAlert + notify S1 |
| K4 Chủ tịch xuất JSON rác phá chu kỳ | P1 | Validate fail-soft từng nhiệm vụ — rác bị bỏ, chu kỳ vẫn COMPLETED |
| Engine chết lặng (bài học #42/#84-F-841-01) | P0 | Try/catch từng due-check mới + log chảy theo chu kỳ là điều kiện kiểm mỗi Fixbug + double-fork restart |
| Token prompt phình (K3 mô tả dài · K4 khối giao việc) | P2 | Cap mô tả ≤ 600 ký tự · khối GIAO VIỆC biến mất khi k4 tắt (đo tokensIn so sánh — nghiệm thu K4-5) |
| Đồng hồ/múi giờ lệch (nhiệm vụ chạy sai giờ) | P1 | Server tính nextDueAt theo ICT duy nhất; parser chung 1 nguồn (`src/lib/schedule.ts`); client chỉ hiển thị |
| Sandbox reset mất dữ liệu học | P2 | Audit `K1_SANDBOX_RESET` lưu tổng kết {equity cuối, realisedPnl} — đường cong cũ mất nhưng số liệu tổng sống trong audit |

---

## §10. Công sức, cổng & quy trình

| Giai đoạn | Công sức | Model mới | Cột mới | Nghiệm thu | Fixbug scope |
|---|---|---|---|---|---|
| K2 | ~1 ngày | 0 | 0 | §4.5 (6 phép) | `api` + `market-engine` + `frontend` |
| K1 | ~2–2,5 ngày | 0 | 0 | §5.7 (7 phép) | `api` + `market-engine` + `frontend` + `database` (quarantine) |
| K3 | ~1,5–2 ngày | 0 | AgentTask +6 cột · AgentRun +1 | §6.5 (7 phép) | `database` + `api` + `market-engine` + `frontend` |
| K4 | ~1–1,5 ngày | 0 | 0 (tái dùng createdByAgentId của K3) | §7.4 (6 phép) | `api` + `agents` + `frontend` |

- **Tổng ~6–7 ngày công · 0 ₫/tháng chi phí vận hành thêm** (LLM free-tier; snapshot/audit vài nghìn dòng/năm).
- Mỗi giai đoạn: triển khai → tự nghiệm thu (ép tái hiện từng phép) → **Fixbug giao thức đủ 4 lớp** (Fixbug.md §4) → worklog + commit `phiên #NN: …` + push → báo cáo tiếng Việt → đợi hiệu lệnh giai đoạn kế (hoặc trader duyệt gộp).
- Tài liệu đồng bộ sau mỗi giai đoạn: `TECHNICAL_BLUEPRINT` (API mới) · `DB_SCHEMA` (số model/cột) · `README` · `ML_OPS_BLUEPRINT` §8 (cột trạng thái K1-K4) · `Fixbug.md` scope nếu phát sinh scope mới.

---

## §11. Mapping ngược — các nền đã triển khai thành tài sản cho K1–K4

| Nền (đã duyệt §8 ML_OPS v1.1) | Sống ở K nào | Cách dùng lại |
|---|---|---|
| A1 — settle 16:15 hằng ngày | K1 | "chấm bài" phiếu bầu giữ nguyên; K1 settle-equity chạy SAU 16:15 (16:30) ăn theo bar EOD đã vào |
| A4 — retrain CN 04:00 skip-guard | K1 | mô hình hoán đổi theo P&L sandbox tương lai dùng đúng pattern train→shadow→gate→swap→kill |
| Chu kỳ 23 agents 240ph (Q3 cầu nối) | K2 | chuyển quyền điều khiển env → AppSetting + nút UI (env thành hậu phương — đúng cam kết) |
| B1 — versioning v8/v9 + promotion guard | K1 | chuẩn dùng lại cho mọi lần swap mô hình theo học sandbox |
| B3 — GRU gated + shadow + kill-switch | K1 | P&L sandbox = tín hiệu bổ sung cho kill-switch/thăng giọng (điểm tích hợp đã duyệt) |
| E-P1-2 TWAP + ExecutionPlan + committed view | K1 | sandbox auto-convert gọi đúng thư viện — TWAP/KPI/reconciliation tự đúng theo brokerAccountId |
| A13 RAG L1 + RetrievalLog (#83) | K1/K3 | ngữ cảnh truy hồi cho cả nhiệm vụ định kỳ (single-run đã có RAG #83) |
| CashSnapshot E-P1-3 | K1 | equity curve — 0 model mới |
| P0-5 engine-state + fail-soft | cả 4 | mọi due-check mới theo đúng pattern |
| RiskAlert + notification S1 | K3/K4 | cảnh báo tự paused nhiệm vụ + báo giao việc mới |

---

## Changelog

| Version | Ngày | Thay đổi |
|---|---|---|
| 1.4 | 2026-10-11 (phiên #91) | **#91 — 3 việc trader sau sandbox reset**: (1) *"xoá toàn bộ dữ liệu demo cũ, giá trị về 0 tròn trĩnh"* → §5.8-4 `resetPaperWorld()` + route POST `/api/portfolio/reset-paper` + nút "Đặt lại dữ liệu" (Dialog 2 bước) trong Danh mục; (2) *"khi Lưu cấu hình VNDIRECT thật → Thử nghiệm tự động dừng, Giấy → Thực tế"* → §5.8-1/2/3 `pauseSandboxForRealTrading()` + audit `K1_SANDBOX_AUTO_PAUSED_FOR_REAL` + `paperLabel` Thực tế động (segmented control + Header chip + tooltip) + auto-view mặc định Thực tế khi configured + trả lời câu hỏi đề xuất/dùng tiền thật; (3) nghiên cứu Opencode Zen (X. tài liệu DATA_SOURCES §LLM) — Space Bunny Free KHÔNG dùng được qua API bên ngoài (FreeTierError đo trực tiếp), tích hợp `opencode run --format json` khả thi khi có OpenCode account. Kèm: khôi phục môi trường sau reset (code febdb65 từ GitHub + PGlite mini-service :5432 + seed-core "về 0" + EOD thật 30 mã × 2013→nay 90.875 bar). |
| 1.3 | 2026-10-11 (phiên #88) | **#88 — 2 yêu cầu trader**: (1) *"setup tất cả về 0 lại từ đầu + tôi quyết định số tiền"* → xác nhận cơ chế sẵn có (Đặt lại 2 bước xoá sạch + kích hoạt vốn tuỳ ý ≥10tr bội 100k) + **3 sửa số học** §5.6b (autoOrderCount đếm Order sống · lastSettleAt scoped activatedAt · P&L trừ topupTotal — cả 3 lỗi đo thật trên dữ liệu sống) + copy UI "Đặt lại về 0"/"Bạn quyết định số vốn" rõ nghĩa; (2) *"thông tin ở module/tab nào?"* → §5.6a bản đồ hiển thị 3 nơi + điều hướng chéo 2 chiều (nút Settings→Danh mục/Thử nghiệm qua store portfolioWorld, link Danh mục→Cài đặt) + badge **"Đã thực thi · thử nghiệm"** trên tín hiệu (`sandboxExecuted` từ Order sandbox neo signalId — nguồn sự thật là lệnh sống nên reset xoá badge theo). E2E: API (reset→50tr→nạp 2tr P&L vẫn 0→reset→kích hoạt) + browser desktop/mobile 390px + mock-render badge (route browser-only) + 0 console error. Bàn giao: sandbox BẬT 120tr (vốn do UI nhập trong nghiệm thu — trader đổi bất cứ lúc nào). |
| 1.2 | 2026-10-11 (phiên #87) | **K1 TRIỂN KHAI XONG** theo hiệu lệnh trader đổi ưu tiên (K1 triển khai ngay sau câu hỏi nút "Chạy agent" — không đợi thứ tự §3 cũ): §4.4a mới ghi quyết định **GIỮ nút "Chạy agent"** (4 vai trò: chạy-ngay không đợi nhịp · nguồn duy nhất khi K2 tắt · kích hoạt vòng học K1 tức thì · kiểm chứng sau thay đổi); §3/§0 cập nhật trạng thái K1 ✅ #87; nghiệm thu §5.7 đạt 28/28 phép hermetic (`scripts/k1-verify.ts` — gồm fix F-871-02 marker idempotent kênh-2 reward + F-871-03 hermetic BanditArm restore); chu kỳ thật qua route 23/23 COMPLETED với hook auto-convert chạy đúng (audit `AGENT_RUN_COMPLETED.k1Sandbox`). Lộ trình còn: K3 → K4. |
| 1.1 | 2026-10-11 (phiên #86) | Trader trả lời §8 **8/8 DUYỆT**: Q2 **CÓ TRỘN** → §5.5 thiết kế lại hoàn toàn (2 kênh reward cộng dồn cùng posterior Beta — kênh thực thi nhị phân hoá realisedPnl ròng, quy agent tạo tín hiệu, idempotent AuditLog, calibration tách kênh dự đoán, job 16:30 gộp 4 việc); Q7 chốt thứ tự K2→K1→K3→K4 — triển khai Bậc 1 (K2) ngay phiên #86; §4.2 tinh chỉnh API (GET riêng `/api/k/run`, bỏ `cycle-now` thừa — nút "Chạy agent" sẵn là 1 nguồn); §4.3 bổ sung cơ chế nhường quyền env→AppSetting qua flag + race-window ≤60s được cooldown route chặn. |
| 1.0 | 2026-10-11 (phiên #85) | Soạn bản đầu — hoá 4 kế hoạch tương lai trader mô tả tại §8 ML_OPS_BLUEPRINT v1.1 thành lộ trình 4 bậc K2→K1→K3→K4 (đề xuất, §8-Q7): K1 tài khoản sandbox 0-migrate (BrokerAccount.accountType String) + faucet + auto-convert một-nguồn + settle-equity 16:30 + vòng học ranh giới rõ; K2 k-run AppSetting + due-check engine + toggle Header; K3 AgentTask schedule (grammar parseHhMm/parseWeekly tái dùng) + AgentRun.taskId + kill-switch failStreak; K4 Chủ tịch xuất JSON giao việc + validate fail-soft + 2 cấp đồ thị nhiệm vụ. Kèm hiện trạng nền đo trực tiếp §0.5 (7 file query brokerAccount cần quarantine) · 8 câu hỏi mở §8 chờ trader duyệt. |

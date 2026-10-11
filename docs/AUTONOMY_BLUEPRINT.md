# AUTONOMY BLUEPRINT — 4 KẾ HOẠCH K1–K4: TIỀN ẢO THỬ NGHIỆM · CHẾ ĐỘ CHẠY LIÊN TỤC · NHIỆM VỤ ĐỊNH KỲ · BAN ĐIỀU HÀNH GIAO VIỆC

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/AUTONOMY_BLUEPRINT.md` · **Version:** 1.0 · **Created:** 2026-10-11 (phiên #85)
> **Status:** **SOẠN XONG — CHỜ TRADER DUYỆT §8** (trả lời các câu hỏi mở → chốt thứ tự → triển khai từng giai đoạn + Fixbug giao thức như mọi blueprint)
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
| 1 | **K2 — Chế độ chạy liên tục** (~1 ngày) | Nhỏ nhất, giải phóng sớm quyền điều khiển; từ đó mọi dữ liệu học (đồng hồ 30 ngày L3 · shadow 60 phiên GRU · equity curve K1) **trôi liên tục không cần đợi trader bấm nút từng lần** | Không phụ thuộc ai — dùng scheduler + AppSetting sẵn |
| 2 | **K1 — Tiền ảo thử nghiệm** (~2–2,5 ngày) | Trung tâm tầm nhìn trader ("sự tăng/giảm của số tiền = quá trình học"); triển khai sớm để đồng hồ học bắt đầu trôi sớm nhất | Không phụ thuộc cứng K2 (chạy được trên nhịp env 240ph hiện có) — nhưng giá trị tối đa khi K2 đã bật |
| 3 | **K3 — Nhiệm vụ định kỳ** (~1,5–2 ngày) | Nâng cấp AgentTask + due-check engine — vừa là nền bắt buộc của K4 | Dùng scheduler + single-run route `[id]/run` sẵn (#83) |
| 4 | **K4 — Ban ĐH giao việc** (~1–1,5 ngày) | Dựng trên hạ tầng nhiệm vụ K3; chỉ thêm lớp "người tạo là Chủ tịch" + validate + UI | **Phụ thuộc K3** (bắt buộc) |

**Phương án B** (theo thứ tự số K1→K2→K3→K4): khả thi — K1 không phụ thuộc K2; chấp nhận mất vài ngày "chạy liên tục" trước khi K1 tích luỹ đều. Chọn B nếu trader muốn thấy module Cài đặt tiền ảo trước tiên (§8-Q7).

**Tổng: ~6–7 ngày công · 0 ₫ chi phí vận hành thêm.** Mỗi giai đoạn hoàn tất → chạy **Fixbug giao thức** (Fixbug.md) trên đúng scope rồi mới sang giai đoạn sau — như mọi blueprint trước.

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

- `POST /api/k/run` — body `{action: "start"|"stop"|"cycle-now", intervalMinutes?}`:
  - `start`: validate nhịp ∈ bộ cho phép → upsert k-run `{enabled:true, startedAt:now}` (giữ lastCycleAt cũ nếu có) + AuditLog `K2_RUN_STARTED`.
  - `stop`: `enabled:false` + AuditLog `K2_RUN_STOPPED`. **Hiệu lực từ chu kỳ kế tiếp** — nếu chu kỳ đang chạy thì cho chạy hết (route hoàn tất tự nhiên).
  - `cycle-now`: gọi nội bộ đúng luồng nút "Chạy agent" (không nhân đôi code — tôn trọng cooldown 60s của route).
- GET: gộp vào `/api/settings` payload `kRun` (enabled · nhịp · nextCycleAt dự kiến · cyclesRun).

### 4.3 Engine — due-check `k2RunDue` (thêm vào tick 60s, fail-soft)

```
mỗi tick 60s:
  k = đọc AppSetting k-run (1 query/60s — nhẹ; cache TTL 60s nếu đo thấy cần)
  nếu !k?.enabled → trả về (env fallback do interval cũ quản — KHÔNG đụng)
  nếu now − max(k.lastCycleAt, k.startedAt) ≥ k.intervalMinutes:
    nếu chu kỳ đang in-flight (guard pattern intl #48 — biến module-scope) → skip
    POST /api/agents/run (route tự có cooldown 60s + full guard sẵn)
    xong (dù ok/lỗi) → cập nhật k-run.lastCycleAt = giờ chu kỳ bắt đầu, cyclesRun++
```
Engine broadcast WS `cycle` như sẵn có + thêm sự kiện `k-run-state` khi đọc thấy enabled đổi so với tick trước (UI nhiều tab đồng bộ).

### 4.4 UI (Header)

- Nút "Chạy agent" **giữ nguyên** (1 lần). Thêm cạnh đó: `Switch` nhãn **"Liên tục"** + `Select` nhịp (60/120/240/480 phút) hiện khi bật; badge trạng thái `⬤ Liên tục · 240ph · chu kỳ kế ≈ 2g15p nữa` (đếm ngược từ kRun.nextCycleAt — refetch qua `/api/settings` polling 60s đã có hoặc WS).
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

### 5.5 Vòng học — ranh giới rõ (chống 2 nguồn reward xung đột)

- Bandit settle (16:15) **giữ nguyên như hiện tại** — reward theo realized rổ, không trộn P&L sandbox (tránh 2 nguồn sự thật về "đúng/sai").
- P&L sandbox là **tầng tín hiệu bổ sung**: (a) hiển thị trực tiếp cho trader; (b) ghi vào telemetry k-sandbox (P&L theo tín hiệu/source agent) — đầu vào tương lai cho GRU kill-switch (điểm tích hợp đã duyệt §8 ML_OPS dòng 5) và cổng L5 AgentLesson ("tín hiệu Chairman qua cổng nhưng sandbox lỗ N/N lần gần nhất…"). Không tự đổi giọng bandit/ensemble vì P&L sandbox ở v1 (§8-Q2).

### 5.6 UI

- **Settings — khối "Cơ chế thử nghiệm (tiền ảo)"**: input số tiền (validate live), nút **Kích hoạt**; khi đang bật: số dư · equity hiện tại · lãi/lỗ từ lúc kích hoạt (₫ + %) · số phiên đã chạy · đồ thị equity mini (CashSnapshot, đường + tooltip ngày) · nút Nạp thêm / Tạm dừng / Đặt lại (reset 2 bước); trạng thái nguồn trung thực ("chưa có tín hiệu nào được thực thi" khi 0 lệnh).
- **Portfolio workspace — bộ lọc tài khoản**: dropdown "Tài khoản: Giấy (paper) / Thử nghiệm (sandbox)" → `portfolio` route nhận query `accountType` (mặc định paper — hành vi cũ bảo toàn); tab Danh mục hiển thị đúng vị thế sandbox do agents tự giữ.
- Header/Overview: không đổi (giữ tập trung — K1 chỉ sống ở Settings + Danh mục).

### 5.7 Nghiệm thu K1

1. Kích hoạt 100.000.000 ₫ → sandbox account xuất hiện đúng `accountType` + cash + AuditLog; **portfolio paper KHÔNG đổi một đồng** (số dư/equity/vị thế so ảnh chụp trước — bằng chứng tách bạch P0).
2. Chu kỳ kế sinh tín hiệu qua cổng → Order auto trên sandbox (đúng tài khoản, TWAP nếu thoả, phí 0,15%), tín hiệu KHÔNG sinh lệnh paper; chạy lại convert → **idempotent** (không lệnh kép).
3. Tick engine khớp lệnh → Position sandbox; Danh mục (bộ lọc Thử nghiệm) hiển thị vị thế + P&L.
4. 16:30 (giả lập bằng force do route hỗ trợ `?force=1` nội bộ test) → CashSnapshot 1 dòng/ngày, chạy 2 lần idempotent; cuối tuần bị chặn.
5. Tạm dừng → chu kỳ sau **0 lệnh mới**, vị thế cũ giữ; Đặt lại → xoá sạch + audit tổng kết.
6. Restart engine + app → toàn bộ trạng thái sống sót (k-sandbox + vị thế + đường cong).
7. E2E desktop + mobile 390px: 0 console error.

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

## §8. Câu hỏi mở — CHỜ TRADER DUYỆT TRƯỚC KHI TRIỂN KHAI

| # | Câu hỏi | Đề xuất kèm lý do |
|---|---|---|
| Q1 | **K1 phạm vi auto-convert:** mọi tín hiệu chu kỳ qua cổng đồng thuận B9 đều tự thực thi vào sandbox (trader vẫn duyệt lệnh paper từ cùng tín hiệu như cũ — 2 thế giới độc lập), hay chỉ tín hiệu điểm/độ tin cao nhất mỗi chu kỳ? | **Mọi tín hiệu qua cổng** — đơn giản, đo được, đủ nhanh tích luỹ P&L theo nguồn |
| Q2 | **K1 vòng học:** P&L sandbox v1 chỉ hiển thị + làm dữ liệu cho cổng L5 & GRU kill-switch tương lai — KHÔNG tự đổi reward bandit/ensemble (tránh 2 nguồn sự thật "đúng/sai") | **Không trộn** — bandit giữ nguyên semantic realized rổ |
| Q3 | **K1 xem danh mục:** thêm bộ lọc tài khoản (Giấy/Thử nghiệm) trên workspace Danh mục như §5.6, hay chỉ khối trong Cài đặt là đủ? | **Bộ lọc Danh mục** — trader cần thấy agents đang giữ gì |
| Q4 | **K2 bộ nhịp:** {60 · 120 · 240 · 480} phút, mặc định 240 — chấp nhận? (giới hạn để bảo vệ quota free-tier Zen; chu kỳ ngắn hơn 60ph rủi ro 429) | **Duyệt bộ 4 nhịp** |
| Q5 | **K3 schema:** `AgentRun.taskId` (additive) để lịch sử chạy nhiệm vụ truy vấn được — OK? | **Có** — 1 cột optional, 0 rủi ro |
| Q6 | **K4 mức tự chủ:** nhiệm vụ Ban ĐH giao **tự động thực thi không cần trader duyệt từng nhiệm vụ** (chỉ giới hạn §7.2 + kill-switch tổng) — đúng ý "ban điều hành giao việc"? Hay cần hàng duyệt? | **Không duyệt từng nhiệm vụ** — đúng tinh thần uỷ quyền; trader luôn xoá/sửa được sau |
| Q7 | **Thứ tự triển khai:** K2 → K1 → K3 → K4 (đề xuất §3) hay theo thứ tự số K1 → K2 → K3 → K4? | **K2 trước** — nhỏ, giải phóng sớm chế độ liên tục cho đồng hồ học |
| Q8 | **K1 tiền mặc định:** trader tự nhập mỗi lần kích hoạt (không mặc định cứng) — đúng? | **Tự nhập** (gợi ý hiển thị 100.000.000 ₫ làm placeholder) |

> Trả lời §8 (có thể ngắn gọn "Q1: theo đề xuất, Q2: …") → chốt version 1.1 → triển khai bậc 1 + Fixbug → báo cáo → bậc tiếp theo.

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
| 1.0 | 2026-10-11 (phiên #85) | Soạn bản đầu — hoá 4 kế hoạch tương lai trader mô tả tại §8 ML_OPS_BLUEPRINT v1.1 thành lộ trình 4 bậc K2→K1→K3→K4 (đề xuất, §8-Q7): K1 tài khoản sandbox 0-migrate (BrokerAccount.accountType String) + faucet + auto-convert một-nguồn + settle-equity 16:30 + vòng học ranh giới rõ; K2 k-run AppSetting + due-check engine + toggle Header; K3 AgentTask schedule (grammar parseHhMm/parseWeekly tái dùng) + AgentRun.taskId + kill-switch failStreak; K4 Chủ tịch xuất JSON giao việc + validate fail-soft + 2 cấp đồ thị nhiệm vụ. Kèm hiện trạng nền đo trực tiếp §0.5 (7 file query brokerAccount cần quarantine) · 8 câu hỏi mở §8 chờ trader duyệt. |

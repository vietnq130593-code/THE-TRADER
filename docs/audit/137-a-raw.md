# AUDIT 137-a — Đội agent & Hội đồng (agents + council + mini-engine)

- Phạm vi: `src/lib/agent-roster.ts` · `consensus.ts` · `council/{decision-eval,vision,baskets}.ts` · `agent-service-runs.ts` · `agent-ratelimit.ts` · `agent-context.ts` · `src/app/api/agents/**` · `src/app/api/council/**` · `src/app/api/assessment/**` · `api/k/run` + `lib/k-run.ts` + `lib/k4.ts` · `mini-services/market-engine/index.ts` (pg-service đọc nhanh) · `prisma/schema.prisma` (đối chiếu model Agent/AgentTask/AgentMessage/AgentRun/Signal/AuditLog/MlModel/SweepRun/AppSetting/BanditArm/BanditEvent/MarketAssessment/DecisionEvaluation).
- Phương pháp: đọc toàn bộ file trong phạm vi (kể cả 1547 dòng `agents/run/route.ts`, 1357 dòng `agent-service-runs.ts`, 1363 dòng `agent-context.ts`, 1429 dòng engine); với mỗi nghi vấn đọc ≥30 dòng ngữ cảnh + grep call-site trước khi kết luận. Đã thử truy vấn DB trực tiếp (tools/db-console.mjs) để đối chứng số liệu runtime — token Supabase trong .env hết hạn (HTTP 401) nên mọi kết luận chỉ dựa trên code + worklog.
- Ghi chú schema: **không tồn tại model `CouncilVote`** trong `prisma/schema.prisma` (đề bài nhắc tên này). Phiếu bầu cử tri nằm ở `MarketAssessment.detail.agentVotes` (JSON, persist.ts:131) + `BanditEvent` (unique `assessmentId+agentCode`) — hợp đồng này nhất quán xuyên suốt code, không phải lệch schema.

---

## FINDINGS (lỗi thật, theo thứ tự severity)

### A1 — MEDIUM · Đếm kép episodes của bản serving trong RL Gym (so sánh object identity thay vì id)

- **File:dòng**: `src/lib/agent-service-runs.ts:1087-1091` (hàm `runRlGym`)
- **Bằng chứng**:
```ts
const metrics = parseModelMetrics(model.metrics);           // object A
const allVersions = await db.mlModel.findMany({
  where: { kind: "rl-q" },
  select: { metrics: true },                                 // gồm CẢ row serving
});
let episodesTotal = typeof metrics?.episodes === "number" ? (metrics.episodes as number) : 0;
for (const v of allVersions) {
  const m = parseModelMetrics(v.metrics);                    // parse LẠI → object MỚI
  if (m !== metrics && typeof m?.episodes === "number") episodesTotal += m.episodes as number;
}
```
- **Vì sao sai**: `parseModelMetrics` (dòng 909-916) `JSON.parse` mỗi lần gọi → trả object mới. Khi vòng lặp tới đúng row serving, `m !== metrics` luôn **true** (khác identity dù cùng nội dung), nên `metrics.episodes` của bản serving bị cộng **hai lần**. `ml/rl.ts:249` trả `episodes: RL_EPISODES` = số episode của **riêng lần train đó** (không lũy kế), nên chủ đích "tổng = mọi phiên bản" chỉ đúng khi bỏ đúng 1 lần serving. Với worklog #129 (rl-q v14, 96-state, các bản trước v1..v13), tổng hiển thị sai đúng `episodes` của bản serving (vd 14 bản × 2000 → báo 30.000 thay vì 28.000).
- **Hành vi sai cụ thể**: tin broadcast A16 "Gym Q-learning … đã chạy tổng cộng X episode qua N phiên bản" + `AgentRun.output.episodesTotal` bị thổi phồng; số này đi thẳng vào feed đội agent mỗi chu kỳ.
- **Gợi ý fix**: đổi điều kiện skip sang `if (v.id !== model.id && ...)` (cần thêm `id` vào select), hoặc khởi tạo `episodesTotal = 0` và cộng mọi phiên bản một lần.
- **Tự tin**: 95% (chỉ cần đọc `parseModelMetrics` là loại trừ false positive — nó không memo hoá gì).

### A2 — MEDIUM · Bandit settle đo cửa sổ reward lệch 1 phiên cho chu kỳ chạy sau giờ chốt (Bar.date = 15:00 UTC ≠ giờ chốt thật 08:00 UTC)

- **File:dòng**: `src/lib/ml/bandit.ts:333-336` + gốc rễ quy ước `src/lib/eod-sync.ts:350-353`
- **Bằng chứng** (bandit.ts):
```ts
// Đủ 5 phiên giao dịch sau createdAt chưa?
const after = futureDates.filter((f) => f.date >= a.createdAt).slice(0, SETTLE_SESSIONS);
const castDate = pastDates.find((d) => d.date <= a.createdAt)?.date;
if (after.length < SETTLE_SESSIONS || castDate == null) continue;
const realizedDate = after[SETTLE_SESSIONS - 1].date;
```
(eod-sync.ts):
```ts
// Bar.date = 15:00 UTC của ngày giao dịch (convention tick route EOD rollover)
const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0));
```
- **Vì sao sai**: phiên D chốt thật 15:00 ICT = **08:00 UTC**, nhưng `Bar.date` của D là **15:00 UTC** (= 22:00 ICT). Chu kỳ chạy sau eod-sync 15:45 ICT (createdAt ~09:00 UTC) **đã thấy bar D trong prompt** (buildMarketBlock đọc bar mới nhất) — tức D là "phiên cuối tại/trước khi bầu" đúng nghĩa comment dòng 269-270 — nhưng vì `Bar.date(D) = 15:00 UTC > createdAt(09:00 UTC)`, mã tính `castDate = D-1` và gộp D vào "5 phiên tương lai" (`after[0] = D`, `realizedDate = D+4`). Kết quả: cửa sổ reward đo là `[D-1 → D+4]` thay vì `[D → D+5]` — **1 trong 5 "phiên tương lai" (phiên D) là thông tin đã biết trước lúc bầu**, và mất luôn phiên thứ 5 thật.
- **Hành vi sai cụ thể**: reward Thompson sampling (và posterior Beta → trọng số cử tri cổng 80% `w = health/100 × posteriorMean`, → cả `alignedCouncilP` của Kelly CRB-9) bị hiệu "tiếp diễn động lượng đã biết" cho các phiếu bầu sau 15:45 ICT. Với k2 nhịp 240 phút, ~1/6 chu kỳ/ngày rơi vào khung này. Vì mọi arm cùng chịu lệch nên so sánh arm-vs-arm vẫn tương đối công bằng, nhưng **mức posterior tuyệt đối bị thổi lên** và horizon đánh giá không còn là "5 phiên tới" như đặc tả. (Lưu ý: chu kỳ chạy INTRADAY thì hành vi hiện tại là đúng — D chưa đóng cửa lúc bầu.)
- **Gợi ý fix**: quy về một mốc khi so sánh — ví dụ `const castTs = f.date.getTime() - 7*3600_000` (đưa Bar.date về giờ chốt ICT) rồi lọc `futureDates` theo `> castDate` và tính `realized = futureDates sau castDate thứ 5`; hoặc lưu `lastBarDate` lúc cast vào `detail.agentVotes` để settle dùng đúng mốc.
- **Tự tin**: 75% (cơ chế đã soát kỹ 30+ dòng ngữ cảnh + quy ước Bar 15:00 UTC xác nhận ở eod-sync.ts:350 và comment baskets.ts:164; không đối chứng được timestamp assessment thật trong DB vì token hết hạn; có khả năng đội dev chấp nhận mốc D-1 như "phiên cast" cho MỌI chu kỳ — nhưng comment của chính hàm nói "phiên giao dịch cuối **tại/trước khi bầu**", với chu kỳ sau-chốt thì đó là D chứ không phải D-1).

### A3 — MEDIUM · VETO Ủy ban Kiểm soát FAIL-OPEN khi agent service A7/A8 crash giữa chu kỳ

- **File:dòng**: `src/app/api/agents/run/route.ts:835-850` (nhận diện veto) + `runOneServiceAgent` catch tại `route.ts:532-545` + `agent-service-runs.ts:662-674` (`runExposure` không guard DB lỗi).
- **Bằng chứng** (route.ts):
```ts
const vetoExposure = controlOutputs.some(
  (c) =>
    c.code === "exposure" &&
    typeof c.result?.output?.verdict === "string" &&
    (c.result.output.verdict as string).startsWith("VETO")
);
```
(runOneServiceAgent catch):
```ts
} catch (err) {
  failures.push(code);
  console.error(`[api/agents/run] service agent ${code} failed:`, err);
  await persistRun(agent.id, false, ...).catch(() => undefined);
  return null;   // ← result = null
}
```
- **Vì sao sai**: `runExposure` gọi `portfolioSnapshot()` mà trong đó `db.brokerAccount.findFirst` / `db.position.findMany` **không** bọc `.catch` (chỉ quote/bars có `.catch(() => [])`, agent-service-runs.ts:110-121) — lỗi DB/network làm hàm ném → `runOneServiceAgent` trả `null` → `vetoExposure/vetoCompliance = false`. Khi đó: (1) **không có ràng buộc cứng** nào hạ tín hiệu MUA; (2) agent lỗi **không xuất hiện** trong `digestLines` (chỉ gồm `analyses.has`) nên Chủ tịch không hề biết phơi nhiễm chưa được kiểm định. Điều này ngược nguyên tắc ghi ngay đầu blueprint CRB/engine: "engine lỗi/thiếu → fallback tĩnh (fail-safe **VETO-cứng**)" — fallback đó chỉ áp cho *hạn mức động*, còn crash cả agent kiểm soát thì lại mở cửa hoàn toàn (fail-open).
- **Hành vi sai cụ thể**: đúng lúc DB kém ổn định (cũng là lúc rủi ro cao nhất), tín hiệu MUA đi thẳng tới `Signal.create` + K1 auto-convert (nếu gate CONSENSUS) mà không qua kiểm tra phơi nhiễm/tuân thủ nào.
- **Gợi ý fix**: trong route, nếu `c.code ∈ {exposure, compliance}` mà `c.result == null` → coi như veto tạm ("A7/A8 lỗi — chưa kiểm định được") hoặc tối thiểu tiêm dòng cảnh báo vào prompt Chủ tịch và hạ mọi tín hiệu BUY→HOLD cho chu kỳ đó.
- **Tự tin**: 70% (luồng dữ liệu xác định 100%; mức "sai" phụ thuộc việc dịch đúng ý đồ "VETO vẫn luật cứng" — nếu chủ hệ thống chủ ý chấp nhận fail-open cho lỗi hiếm thì đây là quyết định thiết kế, nhưng không thấy tài liệu nào nói vậy).

### A4 — MEDIUM · Chu kỳ >5 phút làm watchdog reset Agent RUNNING giữa chừng → 2 chu kỳ/single-run chồng nhau (giả định maxDuration=300s không được enforce khi self-host)

- **File:dòng**: `src/lib/agent-ratelimit.ts:15` + `:35-37` (giả định chu kỳ ≤5 phút), `src/app/api/agents/run/route.ts:412-450` (reap TRƯỚC khi load + 409), `src/lib/llm.ts:452-453` + `:827-857` (45s/call × tối đa 4 lần thử + backoff).
- **Bằng chứng** (agent-ratelimit.ts):
```ts
const STALE_RUNNING_MS = 5 * 60_000;
// ... Ranh giới 5 phút không đụng agent đang chạy THẬT: run đơn tối đa ~2 phút
// (LLM 45s × retry); chu kỳ 23 agents claim RUNNING lúc khởi động và trả từng
// agent khi xong — chu kỳ dài nhất 5 phút (maxDuration route) nên agent đang
// xếp hàng giữa chu kỳ luôn có updatedAt (mốc claim) tươi hơn 5 phút.
```
(route.ts):
```ts
await reapStaleAgentRuns();                 // ← reset RUNNING>5' → IDLE TRƯỚC
agents = await db.agent.findMany(...);       // ← rồi MỚI đọc status cho guard 409
const runningAgents = agents.filter((a) => a.status === "RUNNING");
```
(llm.ts): `ZEN_TIMEOUT_MS = 45_000`; `RETRY_BACKOFF_MS = [2_000, 6_000, 15_000]` (tối đa 4 lần thử) → 1 agent LLM xấu nhất ~200s; chu kỳ có 6 LLM nghiên cứu + risk-manager + Chủ tịch = 8 cuộc gọi tuần tự → xấu nhất **>5 phút dễ dàng**.
- **Vì sao sai**: `maxDuration` của Next.js chỉ là metadata giới hạn của nền tảng serverless (Vercel) — hệ thống chạy `pm2 + bun run dev` (ecosystem.config.js) nên **không ai kill chu kỳ ở 300s**. Khi chu kỳ A kéo >5 phút: các agent còn đang "xếp hàng" (đã bị đánh RUNNING từ đầu chu kỳ, không có AgentRun RUNNING nào tồn tại — mọi persistRun ghi status cuối) có `updatedAt` cũ hơn 5 phút → `releaseStuckRunningAgents` (được gọi từ chu kỳ B, single-run, hoặc `checkAgentRateLimit` của chat) reset chúng về IDLE → guard 409 của chu kỳ B pass → **B chạy đè lên A đang chạy**. Hệ quả: nhân đôi chi phí LLM, nhân đôi AgentRun/AgentMessage, và **2 tín hiệu** (Chairman của A và của B mỗi bên tạo 1 Signal + K1 auto-convert riêng). Tương tự, single-run/k3-dispatch claim được agent đang nằm trong chu kỳ.
- **Hành vi sai cụ thể**: kịch bản lỗi gateway LLM kéo dài (chính là lúc retry nhiều nhất) + 1 click tay chu kỳ (cooldown 60s đã hết từ lâu) → chồng chu kỳ. Không hỏng bất biến dữ liệu (claim Signal atomic, K1 marker idempotent theo signalId) nhưng double-spend token và sinh tín hiệu trùng thời điểm.
- **Gợi ý fix**: (1) touch `updatedAt` (heartbeat) cho các agent RUNNING theo từng wave; hoặc (2) nâng `STALE_RUNNING_MS` trên mức xấu nhất của chu kỳ (≥ 20 phút); hoặc (3) khóa chu kỳ bằng AppSetting/row lock thay vì chỉ dựa status.
- **Tự tin**: 65% (toàn bộ chuỗi điều kiện đã kiểm chứng code; chưa thấy xảy ra trong dev.log — cần sự cố LLM kéo dài + thao tác tay đúng thời điểm; đây là race hiếm nhưng hệ quả thật).

### A5 — LOW · Chu kỳ agent broadcast thông tin SAI về mô hình đang serving (arch/state/arm hardcode cũ)

- **File:dòng**: `src/lib/agent-service-runs.ts:1181` + `:1201` ("MLP 10→16→8→3"), `:1075/1078/1106` ("48 trạng thái"), `:1315` ("Bandit … 5 arm"), `:622` ("cử tri thứ 6").
- **Bằng chứng** (1181):
```ts
content = `Mạng MLP 10→16→8→3 v${model.version} đang phục vụ (train ${hoursAgo(model.trainedAt)}): ...`
```
(1096): `content = \`Gym Q-learning 48 trạng thái × 3 hành động: ...\``
- **Vì sao sai**: sau F-18/F-19 (worklog #131-#133), serving dl-mlp là **v61 arch 24-48-24-12-3** (C5 đã swap, `ml-tuning` đã NAS-sync); sau F-13 (#129) serving rl-q là **v14 96-state** (`RL_STATES_V2 = 96`, rl.ts:46); `BANDIT_ARM_CODES` (bandit.ts:27-35) có **7 arm** (đã thêm macro-economist #126 + ml-forecast). Các chuỗi hardcode không được cập nhật → mỗi chu kỳ, A17 nói "MLP 10→16→8→3 v61", A16/S3 nói "48 trạng thái", A19 nói "5 arm" — tức **feed Hội đồng và AgentRun.output chứa số liệu mô hình sai sự thật** dù version đúng.
- **Hành vi sai cụ thể**: Chủ tịch (đọc digest 160 ký tự mỗi agent) + trader đọc feed bị误导 về kiến trúc đang dự báo; không ảnh hưởng giao dịch (chỉ narrative/output).
- **Gợi ý fix**: rút arch từ `MlModel.meta`/`weights` (đã có sẵn `parseMlpArch` dùng cho `/api/ml/status` theo #132) và số state từ `qTable.length`; số arm từ `BANDIT_ARM_CODES.length`.
- **Tự tin**: 90% (worklog #133 xác nhận serving v61 = 24-48-24-12-3; rl.ts:46 xác nhận 96; bandit.ts:27-35 xác nhận 7 arm).

### A6 — LOW · `portfolioSnapshot` mất kiểm dịch K1 khi không còn tài khoản paper — vị thế sandbox lọt vào NAV của A7/A8/A12

- **File:dòng**: `src/lib/agent-service-runs.ts:160-185`
- **Bằng chứng**:
```ts
db.brokerAccount.findFirst({
  where: { deletedAt: null, accountType: { not: "sandbox" } },   // PAPER only
  ...
}),
db.position.findMany({ where: { status: "OPEN" }, ... }),         // MỌI tài khoản
...
// F-73R2-03: lọc positions theo tài khoản sống ...
const positions = account
  ? positionsAll.filter((p) => p.brokerAccountId === account.id)
  : positionsAll;      // ← account==null → lấy TOÀN BỘ (gồm sandbox)
```
- **Vì sao sai**: nhánh fallback `: positionsAll` phá đúng cam kết dòng 161-162 ("A12 portfolioSnapshot là bối cảnh PAPER — loại trừ tài khoản sandbox"). Khi tài khoản paper bị soft-delete hết (hoặc DB mới chỉ có sandbox), `equity/sectorWeights/positions` của A7 Exposure, A8 Compliance, A12 Cash Management được tính **bao gồm vị thế sandbox K1** → VETO phơi nhiễm đánh giá sai thế giới. (A12 ghi snapshot có guard `if (account)` nên không ghi — chỉ A7/A8 dùng snapshot này.)
- **Hành vi sai cụ thể**:_corner-case — hệ thống không còn tài khoản paper thì mọi kết luận exposure/compliance đều đo trên sandbox; ngưỡng 40%/25% có thể chặn/cho sai.
- **Gợi ý fix**: fallback nên là mảng rỗng: `const positions = account ? positionsAll.filter(...) : [];` (NAV=0 → compliance marginRoom=0 không âm → không veto bừa; trung thực "không có tài khoản paper").
- **Tự tin**: 85% (code rõ; chỉ xảy ra khi không tồn tại tài khoản sống nào).

### A7 — LOW · `maybeAutoEnableConsensus` tính `wouldBlockRate` sai mẫu (tử số ≤200, mẫu số vô hạn)

- **File:dòng**: `src/lib/consensus.ts:143-158`
- **Bằng chứng**:
```ts
const rows = await db.marketAssessment.findMany({
  where: { detail: { contains: `"consensus":{` } },
  ...
  take: 200,
  orderBy: { createdAt: "desc" },
});
for (const r of rows) { ... if (parsed.consensus?.wouldBlock === true) wouldBlock++; }
...
const wouldBlockRate = shadowCycles > 0 ? wouldBlock / shadowCycles : 0;
```
- **Vì sao sai**: `shadowCycles` đếm **toàn bộ** bảng (không cap), `wouldBlock` chỉ quét **200 bản mới nhất** → khi tổng chu kỳ >200, tỉ lệ bị chặn ceiling 200/total (ví dụ 400 chu kỳ, 100% chặn → báo 50%). Thêm: đếm gộp cả assessment `source:"manual"` (POST /api/assessment/synthesize cũng ghi detail.consensus) nên "chu kỳ shadow" pha trộn với tổng hợp tay.
- **Hành vi sai cụ thể**: chỉ là **thống kê log** khi auto bật enforcement ("Tỉ lệ tín hiệu đã-sẽ-chặn…") — không đổi hành vi chặn; nhưng con số trader đọc để review có thể thấp hơn thật.
- **Gợi ý fix**: lấy `wouldBlock` bằng aggregate trên cùng window với mẫu số (hoặc chia theo số rows thực sự quét), và lọc `source: "cycle"` cho cả hai.
- **Tự tin**: 90% (số học thuần).

### A8 — LOW · Cửa sổ TOCTOU giữa guard 409 và updateMany RUNNING của chu kỳ (đối chiếu single-run)

- **File:dòng**: `src/app/api/agents/run/route.ts:417-476` (khoảng cách findMany → updateMany đi qua 3 await: `expireDueSignals`, `markKRunCycle`, `getK4`); single-run claim atomic tại `src/app/api/agents/[id]/run/route.ts:379-388`.
- **Bằng chứng** (route.ts):
```ts
agents = await db.agent.findMany(...);            // đọc status (chưa có ai RUNNING)
...
await expireDueSignals();
await markKRunCycle();
k4 = await getK4();
await db.agent.updateMany({ where: { id: { in: ... } }, data: { status: "RUNNING" } });  // ← đè vô điều kiện
```
- **Vì sao sai**: single-run request đến trong khe ~50-300ms này claim được agent X (vẫn IDLE lúc đó) và bắt đầu chạy LLM; chu kỳ sau đó `updateMany` **vô điều kiện** đè RUNNING và cũng chạy X → 2 AgentRun + 2 tin broadcast + 2 lần update health của cùng agent trong ~1 phút. Chu kỳ không hề kiểm `checkAgentRateLimit` từng agent nên không lớp chặn nào khác. Không đụng Signal (chỉ Chủ tịch chu kỳ tạo).
- **Hành vi sai cụ thể**: nhân đôi chi phí 1 agent, tin feed trùng; hiếm (cửa sổ mili-giây + cần thao tác tay trúng).
- **Gợi ý fix**: đánh dấu RUNNING bằng `updateMany({ where: { id: in, status: { not: "RUNNING" } } })` rồi đối chiếu `count !== agents.length` → 409.
- **Tự tin**: 70% (luồng đã kiểm chứng; tần suất rất thấp nên có thể xếp nợ kỹ thuật nếu muốn).

---

## NỢ KỸ THUẬT (code xấu / mâu thuẫn ngữ nghĩa — KHÔNG phải bug-breaking)

1. **Máy mók shadow/enforce của B9 giờ gần như vestigial sau #91**: `autoDecideSignalByConsensus` (signal-execution.ts:874+) quyết mọi tín hiệu chu kỳ theo gate snapshot **vô điều kiện** (duyệt ≥80% / từ chối <80%), còn `consensus.enforce` chỉ còn tác dụng trên đường convert tay (signal-execution.ts:261-275) — tín hiệu ACTIVE ngoài chu kỳ gần như không còn tồn tại. Hai ngữ nghĩa "enforcement" chồng nhau dễ gây hiểu nhầm khi đọc code; `maybeAutoEnableConsensus` vẫn log mỗi chu kỳ dù kết quả không còn thay đổi hành vi chính.
2. **Fallback trọng số cử tri không đối xứng** — evidence.ts:254 `posteriorByCode.get(v.code) ?? 1` (LLM) vs :292 `?? 0.5` (ml-forecast). Lý do ml=0.5 được comment (Beta(1,1)), còn LLM=1 không — vi phạm cùng công thức clamp(health×posterior). Thực tế `ensureArms` đã seed đủ arm nên hiếm khi rơi vào; nên thống nhất 0.5.
3. **Chat 1-1 không kiểm `Agent.status`** (chat/route.ts chỉ rate-limit theo AgentRun — chu kỳ không bao giờ tạo AgentRun RUNNING) → chat có thể chạy đồng thời với agent đang chạy giữa chu kỳ: tốn thêm 1 cuộc gọi LLM, không hỏng dữ liệu (comment route tự khai báo "chat không đặt RUNNING" — chủ ý).
4. **`parseJsonBlock` greedy brace `\{[\s\S]*\}`** (run route + single-run): với output 2 khối JSON (tín hiệu + assignTasks khi k4 bật), nếu model đặt khối giao việc TRƯỚC khối tín hiệu thì parse tín hiệu nhặt nhầm object → signal null (fail-soft, mất tín hiệu chu kỳ đó). `extractAssignTasks` đã chống echo F-K4-05 nhưng parse tín hiệu thì không cùng cơ chế quét-many-blocks.
5. **Số liệu hiển thị thiếu đồng bộ với config roster**: `runMlForecast` gọi "cử tri thứ 6" (giờ là 7), `runModelRegistry` "5 arm" (7), nhiều comment "6 arm" — loạt nhãn văn bản trễ sau #126.
6. **`agent-service-runs.ts` topLiquid/portfolioSnapshot kéo TOÀN BỘ bar** của top-10 (không `take`) — tải DB lớn dần theo lịch sử; chỉ là hiệu năng.
7. **engine `reprobeDue` không có catch-up 24h** (index.ts:1339-1348) khác `mlTrainDue/mlSweepDue` — chủ ý không rõ ràng; engine chết qua Chủ nhật thì mất slot reprobe tuần đó.
8. **`WAVE_A_CODES` gồm cả notification-officer** nhưng nhịp thực tế chạy S1 riêng sau A9 (route.ts:592-597) — hằng chỉ dùng đếm hiển thị `platform: 4`; dễ hiểu nhầm khi đọc.
9. **`runNotificationOfficer` sentiment mặc định "bullish"** khi không có mục cần chú ý — ngữ nghĩa sentiment lỏng, feed có màu sắc tích cực vô cớ.
10. **Engine bun --hot re-evaluate cảnh báo** (F-861-01) — đã có cảnh báo ầm ĩ nhưng scheduler trùng vẫn chạy cho tới khi operator restart thủ công.

---

## ĐÃ KIỂM TRA VÀ SẠCH (nghi nhưng đã loại trừ)

1. **Toán cổng đồng thuận 80%** (synthesis.ts:198-261): `wᵢ = clamp(health/100 × posteriorMean, 0.3, 1)` (điền tại evidence.ts:252-255/290-293); `ratio = S(dominant)/Σw`; so ngưỡng đóng `ratio ≥ 0.8 − 1e-9`; dải WEAK `[0.5−ε, 0.8−ε)`; `present < 4 → NO_CONSENSUS` fail-safe; dominant tie-break UP > DOWN > FLAT hợp lý; VETO không bị cổng vượt. Khớp đặc tả §3.5. Pool 7 cử tri = 6 LLM (5 nghiên cứu + risk-manager) + ml-forecast — đúng #126.
2. **TOCTOU cooldown chu kỳ** (run/route.ts:366-394): check→claim hoàn toàn đồng bộ (không await xen giữa) — fix F-1091-02 thật sự có hiệu lực; fail sớm trả lại mốc cũ.
3. **Claim atomic single-run** (`[id]/run`:379-388 `updateMany where status != RUNNING`) — đúng, một request thắng.
4. **Auto-decision #91** (signal-execution.ts:874-1065): idempotent (chỉ ACTIVE), claim atomic trước REJECT/ACTED, nhường quyền khi 409 đồng thời, đủ ổn định với đường trader bấm tay; bind gate theo snapshot lúc sinh (đúng thiết kế B9 "gate bind").
5. **K1 auto-convert cuối chu kỳ** (k-sandbox.ts:637-719): điều kiện đủ (enabled, ACTIVE, gate CONSENSUS, budget), idempotent bằng audit marker + F-207 world-scoped + `$transaction` claim/tạo-lệnh/marker (signal-execution.ts:587-609) — không double-spend order.
6. **K4 giao việc** (k4.ts:436-549): parse 3 tầng chống echo (F-K4-01/05), validate thuần đầy đủ (cấm executive, +4h, cap/cycle, cap/agent), `$transaction` nguyên lô, audit sau commit fail-soft.
7. **`computeNextDueAt` ICT** (schedule.ts:105-122): trục +7h, floor 86400ms, weekly `(dow-dowNow+7)%7`, cùng-ngày-đã-qua → +7 ngày — đúng; `lastSundaySlot` catch-up 24h cho ml-train/sweep tính đúng ngày slot.
8. **Engine lịch** (market-engine/index.ts): các gate `lastEodSyncDate===ict.date` cho settle/k1/council-eval/flow-sync, `lastIntlSyncDate` cho macro-vn, chặn T7/CN (F-801-01), in-flight guards từng job, backoff nhân đôi intl + không đếm 429 là fail (F-481-01), try/catch quanh callback 60s (bài học #42), timeout POST 280s < maxDuration, kill-switch sweep đọc config TRƯỚC POST. Nhịp k2/k3 defer 5 phút khi agent RUNNING (F-K3-03 hoãn after in-flight) — đúng.
9. **persistRun/persistMessage/updateAgentHealth**: mọi đường await nằm trong try/catch tương ứng; đường lỗi `.catch(() => undefined)`; health excludeRunId loại run vừa tạo khỏi P50 (F-113).
10. **VETO hard-enforce trong chu kỳ** (route.ts:1240-1252): exposure chỉ chặn MUA (SELL giảm phơi nhiễm được phép), compliance chặn mọi hướng — nhánh if/else và thông điệp rationale đúng thiết kế AUD-CODE #6.
11. **`consensusGate` snapshot gắn vào Signal lúc tạo** (route.ts:1271-1272) + auto-decision không đánh giá lại bằng cổng mới — đúng ngữ nghĩa bind, chống "gate lướt theo chu kỳ sau".
12. **Tasks API** (POST/PATCH/DELETE + due): validate 422 fields[] đầy đủ (title/description/schedule/priority/deferMinutes 1..120), PATCH defer `max(nextDueAt, now)+phút`, resume reset failStreak, DELETE 409 theo Agent.status (F-K3-02), chặn execution-manager nhận nhiệm vụ (F-K3-05). `due` route: take clamp 1..20, lọc schedule≠null && !paused && nextDueAt≤now.
13. **Messages route**: validate ngày ICT qua `isValidIctDay` round-trip (F-1091-01) + `from<=to` lexicographic hợp lệ với YYYY-MM-DD; feed chỉ broadcast (AUD-CODE #23).
14. **serialize.toPlain**: BigInt→Number, Date→ISO, Map/Set, guard circular (F-114) — không crash JSON.
15. **Cache in-process 60s** (vision.ts:218-223, baskets.ts:385-390, xrel, macro): kết quả null KHÔNG được cache (điều kiện `cache.block &&`) → lỗi tạm không dính bẫy 60s.
16. **bandit settleChain** (F-801-04) xếp tuần tự in-process chống double-settle; voteMemo clear-at-128 chạy TRƯỚC tính missing (F-65A-01) — đúng thứ tự đã fix.
17. **k-run/k4/k-sandbox AppSetting parse khoan dung** — mọi field sai kiểu rơi về mặc định an toàn; `markKRunCycle` no-op khi key chưa tạo (env fallback nguyên vẹn); AWAIT markKRunCycle đóng window 100ms (comment đúng).
18. **Không có setInterval/timeout rò rĩ server-side** trong `src/lib` (grep toàn bộ — chỉ client components có timer và đều có cleanup pattern); engine có `setInterval` thường trực nhưng đó là thiết kế của service dài hạn.
19. **Timezone**: mọi mốc ICT dùng offset cố định +7h (không DST) thống nhất ở schedule.ts, market-engine ictNow, market-session vnShift, k-sandbox ictDayWindow, api-dates — không thấy chỗ nào dùng `Asia/Shanghai` hay múi máy.
20. **agents/route.ts + [id]/route.ts**: trần 250 run (F-1091-05) chống eviction "lần chạy cuối"; stats groupBy đúng công thức successRate = COMPLETED/tổng; chat thread take-200 reverse (F-1091-04).
21. **council/overview**: F-1112-01 equity live-mark qua `computeSandboxEquity` + trừ topupTotal (K1_SANDBOX_TOPUP) — đồng nhất công thức với /api/k/sandbox; validate from/to 422.
22. **decision-eval**: idempotent upsert theo signalId; verdict ±0.5% khớp bandit; guard NaN/BigInt chuỗi phi-VN đầy đủ; branch SELL-đã-thực-thì đánh giá VWAP vs giá quyết định đúng thiết kế (không gộp chi phí vốn); `Number(cashPnlVND)` chỉ chạy trong nhánh cashPnlVND chắc chắn != null.

## KẾT LUẬN

Hội đồng/đội agent được xây rất kỷ luật (nhờ chu trình audit/fixbug nhiều vòng): các lớp TOCTOU, idempotency, fail-soft, claim-atomic ở luồng tín hiệu/lệnh đều có và đúng. Lỗi thật còn lại tập trung ở **(1) thống kê mô hình hiển thị** (A1, A5), **(2) chuẩn hoá thời gian cửa sổ reward bandit** (A2), **(3) tính fail-open của cơ chế VETO khi agent kiểm soát crash** (A3), và **(4) giả định "chu kỳ ≤5 phút" của watchdog khi maxDuration không được enforce self-host** (A4, kèm A8 nhỏ hơn). Không có lỗi nào trực tiếp phá bất biến tiền/lệnh; A2 là cái ảnh hưởng sâu nhất đến chất lượng "học" của hội đồng (trọng số cử tri), A3/A4 là rủi ro vận hành hiếm nhưng thật.

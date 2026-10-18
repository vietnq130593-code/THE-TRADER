# AUDIT 137-d — Frontend & Data Layer (THE TRADER)

- **Agent:** sub-agent audit (read-only, không sửa file dự án)
- **Ngày:** 2026-10-18
- **Phạm vi:** `src/hooks/` (12 hook) · `src/lib/` (store, db, api, serialize, api-dates, dated-series, market-session, vn-calendar, schedule, feature-cache, settings) · `src/app/{page,layout}.tsx` + `src/components/providers.tsx` · dashboard components (nav, header, footer, agents/overview/synthesis-workspace + sweep/nn/tuning/agent-chat/quotes/price-chart/todo/portfolio… lifecycle) · `next.config.ts` · gateway (Caddy/XTransformPort — ngoài repo) · `mini-services/market-engine/index.ts` (1.429 dòng, đọc toàn bộ)
- **Phương pháp:** đọc toàn văn từng file mục tiêu; grep cross-check mọi nghi vấn với 30+ dòng ngữ cảnh; xác thực bằng chứng thực nghiệm (repro Node cho serialize; probe curl 308/404 vào dev server đang chạy; đọc source engine.io-client 6.6.7 + engine.io server 6.6.11 trong node_modules; đối chiếu dev.log 760 mẫu 404 + worklog #64/#129 dòng 744-745, 2026).

---

## TÓM TẮT EXECUTIVE

Hạ tầng frontend rất lành mạnh về kỷ luật: cleanup đầy đủ, selector Zustand nguyên tử, query key ổn định, `res.ok` xử lý ở 100% client fetch, hydration-safe pattern `useSyncExternalStore` chuẩn React 19 ở mọi đồng hồ, date ICT thống nhất một quy ước (+7h trục UTC). **Không tìm thấy memory leak thật, không có race condition async ghi đè dữ liệu cũ, không có vòng lặp refetch vô hạn.** 7 finding còn lại chủ yếu là khoảng trống khả năng chịu lỗi (single-point-of-failure WebSocket không có polling fallback; thiếu Error Boundary tầng app) và các lỗi tiềm ẩn nhẹ (serialize DAG, double-fetch lúc cold-load, 9/14 sự kiện WS phát vào khoảng không).

---

## FINDINGS CHI TIẾT

### D1 — MEDIUM · Realtime là điểm hỏng đơn: WS chết ⇒ bảng giá đóng băng vĩnh viễn (không có polling fallback), tooltip khai sai cơ chế, và vòng reconnect 404 vô hạn câm lặng khi truy cập origin trực tiếp

**File:dòng:**
- `src/hooks/use-realtime.ts:33-39` (options reconnect vô hạn, không có `reconnectionAttempts`)
- `src/components/dashboard/footer.tsx:130` (tooltip khai "đang dùng polling TanStack Query" — không tồn tại cho quotes)
- `src/components/dashboard/quotes-table.tsx:103-107`, `overview-workspace.tsx:91-95`, `market-summary.tsx:30-33`, `price-chart.tsx:138-142` (cùng `["quotes"]`, staleTime 30s, **0 refetchInterval**)
- `src/components/providers.tsx:20-24` (`staleTime: 30_000`, `refetchOnWindowFocus: false`)

**Bằng chứng (use-realtime.ts + footer.tsx):**
```ts
// use-realtime.ts:33-39 — reconnect vô hạn, không cap attempts
socket = io("/?XTransformPort=3003", {
  transports: ["polling", "websocket"],
  reconnection: true,
  reconnectionDelay: 3_000,
  reconnectionDelayMax: 15_000,
  timeout: 8_000,
});

// footer.tsx:127-131 — tooltip hứa polling fallback
title={
  realtimeConnected
    ? "Đang kết nối WebSocket market-engine (cổng 3003) — bảng giá cập nhật mỗi 10 giây"
    : "Chưa kết nối WebSocket — đang dùng polling TanStack Query"   // ← KHÔNG có polling nào cho ["quotes"]
}

// quotes-table.tsx:103-107 — không refetchInterval
const quotesQuery = useQuery({
  queryKey: ["quotes"],
  queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
  staleTime: 30_000,          // ← chỉ quyết định "remount có refetch không"
});
```

**Bằng chứng thực nghiệm (origin trực tiếp, bypass gateway):** `dev.log` chứa **760 dòng** `GET /socket.io?XTransformPort=3003&EIO=4&transport=polling 404`; trong lúc audit vẫn còn tab đang retry sống (probe curl xác nhận `→ 308` cho URL có trailing-slash, `→ 404` cho URL không slash — Next.js `trailingSlash:false` 308-redirect bỏ slash rồi app router 404). Chuỗi nhân quả: engine.io-client 6.6.7 mặc định `addTrailingSlash:true` → request `/socket.io/?…`; Next 308 → `/socket.io?…` → 404 → polling fail → socket.io reconnect mãi mãi (3-22.5s/lần, câm lặng — không console.error nào cho E2E "0 lỗi").

**Vì sao sai (kịch bản người dùng):**
1. *Origin trực tiếp* (E2E agent-browser `127.0.0.1:3000`, dev local, mọi deploy sau này không có gateway biến query): realtime không bao giờ nối được, badge "Realtime" xám, **bảng giá + pulse bar + biểu đồ đứng im** (query `["quotes"]` không interval, focus-refetch tắt) — chỉ đổi khi đổi workspace (remount) hoặc bấm nút Làm mới. Tooltip lại nói "đang dùng polling TanStack Query" — người dùng tin vậy và chờ vô ích.
2. *Qua gateway (đường chuẩn, đã verify trong-project handshake 200 + WS 101)*: engine crash/restart (pm2, `bun --hot`) trong lúc tab mở → disconnect → bảng giá đóng băng suốt thời gian engine chết — không tự回 phục network-fetch cho tới khi WS nối lại.

**Gợi ý fix (3 câu):** Thêm fallback `refetchInterval` cho `["quotes"]` bật khi `!realtimeConnected` (đọc `useUiStore((s) => s.realtimeConnected)` rồi truyền vào option — 1 dòng, tự tắt khi WS sống). Cap `reconnectionAttempts: 30` + `reconnectionDelayMax` để tắt vòng 404 spam ở origin trực tiếp. Sửa chữ tooltip footer thành "Chưa kết nối WebSocket — bảng giá có thể không tự cập nhật" cho trung thực.

**Tự tin:** 92% (760 mẫu log + repro 308/404 + đã đối chiếu worklog #64 xác nhận cùng chẩn đoán; phần "qua gateway hoạt động" dựa bằng chứng in-project có sẵn, không tự chạy được qua gateway từ sandbox audit).

---

### D2 — LOW · `toPlain` coi tham chiếu dùng chung (DAG) là "[Circular]" — occurrence thứ 2 của cùng object bị thay bằng chuỗi, mất dữ liệu âm thầm

**File:dòng:** `src/lib/serialize.ts:13-32` (nhất là 17-20)

**Bằng chứng:**
```ts
export function toPlain<T>(value: T, seen: WeakSet<object> = new WeakSet()): any {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  // Guard circular ở ĐẦU hàm — áp cho mọi object (kể cả mảng/Map/Set)
  if (typeof value === "object" && value !== null) {
    if (seen.has(value as object)) return "[Circular]";   // ← DAG cũng dính
    seen.add(value as object);                             // ← KHÔNG BAO GIỜ remove
  }
  if (value instanceof Map) return toPlain(Object.fromEntries(value), seen);
  ...
```

**Repro máy (đã chạy, Node 22):**
```js
const shared = { x: 1 };
toPlain({ a: shared, b: shared });
// → {"a":{"x":1},"b":"[Circular]"}     ← b KHÔNG phải circular!
toPlain({ first: arr, second: arr });   // cùng 1 array dùng 2 chỗ
// → {"first":[{"y":1}],"second":"[Circular]"}
```

**Vì sao sai:** `seen` là "visited set" toàn cục mà đúng chuẩn phải là "path stack" (thêm khi đi vào, **xóa khi rời nhánh**). Payload Prisma (mỗi row object riêng) hiếm dính, nhưng bất kỳ route nào tự build response chứa object/mảng dùng chung 2 chỗ (config chuẩn hoá, hằng số dùng lại, mảng rỗng singleton) sẽ trả `"[Circular]"` ở chỗ thứ hai — client render chuỗi lạ hoặc bỏ field, không crash, không log. Hiện chưa có consumer nào trong repo mắc (đã spot-check các route nặng: portfolio/orders/signals/agents dùng row Prisma + object mới mỗi lần build) → severity LOW nhưng là mìn chôn.

**Gợi ý fix:** Chuyển sang "xóa sau khi xử lý xong nhánh": gọi đệ quy xong thì `seen.delete(value)` ở cuối nhánh — 2 dòng sửa trong 1 hàm duy nhất, mọi route hưởng lợi. Giữ hành vi bắt circular thật (path xuống ancestor đang mở vẫn còn trong set khi đệ quy xuống sâu).

**Tự tin:** 95% (repro xác định 100%; phần "chưa có consumer thực tế mắc" là kết quả spot-check, không phủ 100% route).

---

### D3 — MEDIUM · Không tồn tại bất kỳ React Error Boundary nào: `src/app/` chỉ có `layout.tsx` + `page.tsx` (0 file `error.tsx`, `global-error.tsx`, `loading.tsx`, `not-found.tsx`)

**File:dòng:** `/home/z/my-project/src/app/` (ls thực tế: chỉ `api/`, `favicon.ico`, `globals.css`, `layout.tsx`, `page.tsx`); grep `ErrorBoundary|componentDidCatch|getDerivedStateFromError` trên toàn `src/components/` = 0 kết quả.

**Bằng chứng:**
```bash
$ ls src/app/
api  favicon.ico  globals.css  layout.tsx  page.tsx      # ← không error.tsx/global-error.tsx
$ rg "ErrorBoundary|componentDidCatch|getDerivedStateFromError" src/
# → No matches found
```

**Vì sao sai:** Toàn bộ 8 workspace (17.762 dòng component) treo trên MỘT cây client không lớp bảo vệ. Bất kỳ exception nào trong render — một field ngoài hợp đồng API (`res.foo.bar`), `JSON.parse` tại nhánh hiếm, recharts nhận NaN domain — sẽ thổi bay **cả trang** về màn hình lỗi mặc định của Next (hoặc trang trắng ở production), không có nút retry cục bộ, mất trạng thái workspace/panel đang mở. Codebase có giảm thiểu rủi ro rất tốt (types optional-tolerant, `isError` từng query, fail-soft khắp lib) nên xác suất thấp — nhưng blast radius khi xảy ra = 100% UI, và API contract là biên ngoài (backend sửa field là đủ kích hoạt).

**Gợi ý fix:** Thêm `src/app/error.tsx` + `src/app/global-error.tsx` (component client ~30 dòng: log error, nút "Tải lại" bằng `reset()`). Nếu muốn mịn hơn: bọc mỗi `<*Workspace />` trong 1 boundary nhỏ để lỗi module nào chết module đó.

**Tự tin:** 100% (fact về file system); ước lượng xác suất xảy ra thấp nhờ kỷ luật code hiện có.

---

### D4 — LOW-MEDIUM · Engine phát 14 loại sự kiện WS, client chỉ lắng nghe 5 — 9 sự kiện rơi vào khoảng không; tab mở lâu bị stale ở các module không có polling

**File:dòng:**
- Phát: `mini-services/market-engine/index.ts:518,531,563,610,662,692,762,911,945,1010,1072,1108,1139,1197` (`io.emit` — quotes/news/eod/intl/reprobe/cycle×2/settle/ml-train/ml-sweep/k1-settle/macro-vn/flow-sync/council-eval; `welcome` ở 326)
- Nghe: `src/hooks/use-realtime.ts:104-110` (chỉ `connect/disconnect/quotes/news/eod/cycle/ml-sweep`)

**Bằng chứng:**
```ts
// use-realtime.ts:104-110 — toàn bộ handler client
s.on("connect", onConnect);
s.on("disconnect", onDisconnect);
s.on("quotes", onQuotes);
s.on("news", onNews);
s.on("eod", onEod);
s.on("cycle", onCycle);
s.on("ml-sweep", onMlSweep);
// → KHÔNG có: settle · ml-train · k1-settle · council-eval · macro-vn · flow-sync · intl · reprobe
```

**Vì sao sai (kịch bản cụ thể):** Engine chạy đúng lịch hằng ngày nhưng tab người dùng đang mở không được báo:
- **16:30 (k1-settle):** `["portfolio", world]` không refetchInterval, staleTime 60s → tiles Tiền mặt/Tổng tài sản trên Header chip + Danh mục giữ số cũ tới khi người dùng đổi workspace hoặc bấm Làm mới.
- **16:45 (council-eval):** `["council-overview", rangeKey]` (staleTime 60s, không interval) → sổ đánh giá quyết định trên tab Hội đồng cũ ngày.
- **CN 04:00 (ml-train):** `["ml-tuning"]` không interval → tab Tinh chỉnh hiển thị `effective` cũ cho tới lần remount.
Các query khác tự lành nhờ interval riêng (`ml-status` 30s, `flows` 5 phút, `k-sandbox` 60s) nên thiệt hại giới hạn ở 3 nhóm trên.

**Gợi ý fix:** Thêm 3-4 handler 1 dòng trong `use-realtime.ts`: `s.on("k1-settle", () => invalidate ["portfolio"], ["orders"])`, `s.on("council-eval", () => invalidate ["council-overview"])`, `s.on("ml-train", () => invalidate ["ml-tuning"], ["ml-status"], ["ml-architecture"])`. Chi phí gần 0 — sự kiện đã được phát sẵn.

**Tự tin:** 88%.

---

### D5 — LOW · Cold-load double-fetch: hydrate `dateRange` từ sessionStorage chạy SAU mount → mọi range-query fetch 2 lần + flash dữ liệu "toàn bộ"; tương tự world paper→sandbox

**File:dòng:**
- `src/lib/store.ts:159-177` (`hydrateDateRangeFromSession` — thiết kế hydrate sau mount chống hydration mismatch) + `src/app/page.tsx:64-66` (gọi trong `useEffect`)
- `src/hooks/use-portfolio-world.ts:71-95` (k-sandbox resolve trễ → `viewAccountType` "paper" → "sandbox") + `src/components/dashboard/header.tsx:143-147` (`["portfolio", viewAccountType]`)

**Bằng chứng:**
```ts
// page.tsx:64-66 — hydrate SAU mount (đúng để tránh hydration mismatch…)
React.useEffect(() => {
  hydrateDateRangeFromSession();
}, []);

// overview-workspace.tsx:96-101 — query mount với rangeKey "all" TRƯỚC khi hydrate chạy
const signalsQuery = useQuery({
  queryKey: ["signals", rangeKey],        // rangeKey = "all" ở lần render đầu
  queryFn: () => apiGet<...>(`/api/signals${rangeQuery ? ...}`),
  staleTime: 60_000,
});
```

**Vì sao sai:** Effects chạy theo thứ tự con-trước-cha: các observer `useQuery` con mount và bắn fetch với `rangeKey="all"` **trước khi** `hydrateDateRangeFromSession()` setState đổi `rangeKey` thành `from~to` → thảm refetch toàn bộ (`signals`, `orders`, `agent-messages`, `council-overview`, `bars`, `news`…) và người dùng lướt thấy ~200ms dữ liệu chưa lọc trước khi nhảy sang dữ liệu đúng khoảng. Tái hiện 100% lần reload có khoảng đã lưu trong tab. Cùng lớp: `["portfolio","paper"]` fetch rồi bị bỏ khi `k-sandbox` về bật → chip Header nhấp nháy "VNDIRECT · —" rồi mới flipsang "THỬ NGHIỆM".

**Gợi ý fix:** Thêm cờ `dateRangeHydrated` trong store (set cùng hydrate) và gate `enabled: dateRangeHydrated` cho các range-query (hoặc khởi tạo `useQuery` sau một `useSyncExternalStore` đọc sessionStorage an toàn SSR). Giải pháp đơn giản nhất: giữ nguyên và chấp nhận 1 lần double-fetch — chấp nhận được về băng thông, chỉ cần awareness.

**Tự tin:** 80% (cơ chế effect-order chắc chắn; độ "đau" thực tế phụ thuộc số module đang mở).

---

### D6 — LOW · Socket.io engine mở CORS `origin: "*"` không auth — bất kỳ trang web nào biết URL gateway + `XTransformPort=3003` cũng nối được và nhận broadcast

**File:dòng:** `mini-services/market-engine/index.ts:320-322`

**Bằng chứng:**
```ts
const io = new Server(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
```

**Vì sao sai:** Broadcast chứa toàn bộ bảng giá + tin + kết quả chu kỳ agent; một trang web lạ nhúng script `io("https://<host-gateway>/?XTransformPort=3003")` sẽ nhận đủ luồng dữ liệu này vĩnh viễn (không token, không origin check). Trong ngữ cảnh sandbox demo (dữ liệu công khai/giả lập) chấp nhận được; nếu đưa ra internet công cộng thì là lỗ hổng rò dữ liệu + băng thông.

**Gợi ý fix:** Khi public: khóa `cors.origin` về domain app, hoặc thêm 1 handshake query token do app cấp. Sandbox hiện tại để nguyên không thiệt hại.

**Tự tin:** 100% fact; LOW theo ngữ cảnh triển khai hiện tại.

---

### D7 — LOW · `bun --hot` market-engine: scheduler đăng ký TRÙNG mỗi lần hot-reload — chỉ cảnh báo console, không tự vệ

**File:dòng:** `mini-services/market-engine/index.ts:82-88`

**Bằng chứng:**
```ts
const gEngine = globalThis as { __traderEngineEvalAt?: number };
if (gEngine.__traderEngineEvalAt) {
  console.error(
    `[...] [RELOAD] engine module vừa bị re-evaluate ... CÁC SCHEDULER CŨ VẪN CHẠY, scheduler mới ĐĂNG KÌ TRÙNG. RESTART engine ngay ...`
  );
}
gEngine.__traderEngineEvalAt = Date.now();
```

**Vì sao sai:** Đã từng đo thật (worklog #86): 3 lần re-evaluate trong 1 giây → news bắn ×3, tick ×3, hydrate ×3. Cơ chế hiện tại chỉ `console.error` nhắc operator restart tay — nếu quên, mọi interval chạy nhân bản (tick mutex làm giảm hậu quả mất-update nhưng số request lên app nhân đôi/ba, K2/K3 đôn đốc trùng). Nằm gọn trong "Nợ kỹ thuật" vì dev-workflow (`ecosystem.config.js` chạy `bun --hot`).

**Gợi ý fix:** Bọc toàn bộ khối `http.listen(...)` trong `if (!gEngine.__traderEngineBooted)` + lưu handle interval vào globalThis để re-evaluate mới `clearInterval` cái cũ trước khi đăng ký.

**Tự tin:** 100% (code tự nhận + đo thật trong worklog #86).

---

## NỢ KỸ THUẬT (không phải bug hôm nay, cần theo dõi)

1. **WS single-path (D1):** kiến trúc "realtime-first" không có degradation ladder (WS → polling → stale-cache). Thêm 1 nhánh polling fallback là nợ nhỏ nhất trả được.
2. **`toPlain` visited-set (D2):** mìn DAG — sẽ nổ ngày nào có route组装 payload có object dùng chung; fix 2 dòng.
3. **Error boundary (D3):** nợ lớn nhất về blast-radius/nỗ lực ratio — 2 file ~60 dòng tổng.
4. **9 sự kiện WS bỏ không (D4):** event bus nửa vời — đã trả chi phí phát, chưa thu hoạch bên nghe.
5. **`bun --hot` scheduler trùng (D7):** ràng buộc operator thủ công — tự động hoá được trong ~20 dòng.
6. **CORS engine mở (D6):** chấp nhận cho sandbox; phải khóa trước khi ra internet.
7. **GlobalDateRange `today` memo `[]`:** tab mở qua nửa đêm → preset "7 ngày" neo `to` = hôm qua (chỉ ảnh hưởng nhãn preset, không sai dữ liệu) — nit, chưa lên finding.
8. **`apiPost` (api.ts:12-19) trả `null as T`** nếu 200 + body rỗng/unparseable — consumer onSuccess có thể TypeError ở edge case hiếm (route luôn trả JSON nên chưa từng xảy ra) — nit.
9. **store.ts module-level `subscribe`:** HMR dev có thể đăng ký nhiều lần → ghi sessionStorage lặp (idempotent, vô hại); production 1 lần — nit dev-only.

## ĐÃ KIỂM TRA VÀ SẠCH (negative findings có bằng chứng)

1. **Memory leak hooks — SẠCH:** cả 12 hook không có interval/subscription nào thiếu cleanup. `use-realtime` cleanup `s.off` đủ 6 event + `s.disconnect()` (use-realtime.ts:112-121); `agents-workspace.tsx:185-200` countdown clearInterval; `agent-chat.tsx:54-61` idem; `header.tsx:91-98` + `footer.tsx:45-54` + `market-summary.tsx:184-193` dùng `useSyncExternalStore` (interval trả về hàm clear chuẩn); `nav.tsx:108-120` removeEventListener + restore body overflow; `settings-workspace.tsx:659-663` clearTimeout; `nn-viz.tsx:237-250` clearTimers qua effect-cleanup; `allocation-donut.tsx`/`nn-viz.tsx:424` mq removeEventListener. (Một mốc nhỏ: `nn-tab.tsx:246-250` auto-run `setTimeout(…, 450)` không clear khi unmount sớm — setSt sau unmount là no-op React 18+, timer tự chết ≤8s → không tính leak.)
2. **Race condition async / out-of-order — SẠCH:** mọi fetch client đi qua TanStack v5 (dedupe in-flight theo key, key đổi = cache entry riêng không ghi đè chéo) hoặc mutation user-initiated (last-click-wins). Không có useEffect nào `await` rồi `setState` không guard. Patch `["watchlist"]` trong onQuotes đọc-ghi tuần tự trong 1 macrotask, events socket serial. Không tìm thấy AbortController thiếu ở nơi nào cần (fetch REST ngắn; fetch engine-side đều có `AbortSignal.timeout`).
3. **Polling chồng / vòng refetch — SẠCH:** WS `setQueryData(["quotes"])` không đổi staleTime hành vi; `invalidateQueries` chỉ đánh stale — không feedback loop với `refetchInterval`. Các interval (k-sandbox 60s, ml-status 30s, ml-sweep 30s, system-status/agents 60s, k-run 60s, flows 5m) khóa đúng key tĩnh, không đổi theo render. Không có query key chứa object/array mới mỗi render.
4. **use-realtime reconnect/connection-state — SẠCH:** `connect`/`disconnect` cập nhật đủ 2 chiều (tự nhiên reconnect bắn `connect` lại); socket ref capture qua `const s = socket` + deps `[queryClient, setRealtimeConnected, setLastTickAt]` (setter Zustand stable) → effect chạy 1 lần; `useRealtimeMarket` gắn đúng 1 nơi cấp trang (page.tsx:51) — đổi workspace không đứt kết nối (thiết kế #34).
5. **Date/timezone ICT — SẠCH:** một quy ước duy nhất xuyên suốt: trục +7h rồi đọc trường UTC (`market-session.ts:13-20 vnShift`, `vn-calendar.ts:125-127`, `schedule.ts:105-122`, engine `ictNow()` index.ts:207-214). `api-dates.ts` round-trip UTC bắt roll-over "2026-02-30" → 400 thay vì lọc sai. `ictDayStart/End` `+07:00` tường minh. Hiển thị: `format.ts` mọi `Intl.DateTimeFormat` gắn `timeZone: "Asia/Ho_Chi_Minh"`. VN không DST nên các bước +86.400.000ms an toàn. `news-archive-dialog.tsx:67-74` chuyển bounds sang ngày ICT trước khi lọc — đúng hướng.
6. **Hydration mismatch — SẠCH:** đồng hồ dùng `useSyncExternalStore` với server-snapshot 0/null (header `useNow`/`useMounted`, footer `useCacheLastUpdatedMs`/`useNowMs15`, market-summary `useNowMs`) — pattern chuẩn React 19; `suppressHydrationWarning` đặt đúng chỗ (`layout.tsx:27` cho next-themes, header clock spans, footer relative label). sessionStorage chỉ đọc trong `useEffect` sau mount (`page.tsx:64-66`); state lazy initializer chỉ ở dialog client-only (news-archive). Không có `Math.random()`/`Date.now()` trong đường render SSR (grep toàn components — các hit đều trong handler/snapshot/derive-after-data).
7. **Zustand selector — SẠCH:** grep toàn repo `useUiStore((s) => ({` và `useUiStore()` không tham số = 0 kết quả; 100% selector nguyên tử trả primitive/hàm stable.
8. **serialize BigInt/Date — SẠCH (trừ D2):** BigInt → Number an toàn < 2^53 (9 tỷ tỷ VND — ngoài tầm domaine); Date → ISO chuẩn; đã áp dụng `toPlain` ở các route trả BigInt (portfolio, orders, signals, agents, assessment, data-quality, scorecard, bars…); route quotes không cần (builder tự map sang primitive/ISO).
9. **feature-cache TTL & collision — SẠCH:** L1 90s có expire-check + delete khi hết hạn; L2 đọc `row.expiresAt` so `Date.now()`; nạp lại L1 bị cap `min(expiresAt, now+90s)` (F-63A-01 chống stale-sau-invalidation) — logic đúng. Key `topByAdtv:${market}:${type}:${n}` — đủ chiều, không collision. `force` không ghi lại cache (đúng ngữ nghĩa đối chiếu). Invalidation prefix cả L1 lẫn L2.
10. **API client res.ok — SẠCH:** `api.ts` 6 helper đều `if (!res.ok)` + parse error VN; các hook tự viết fetch (use-ml, use-ml-sweep, use-assessment, use-agent-actions `postForRateLimit`, use-agent-tasks `postRunTask`, use-settings `apiPut`) đều check `!res.ok` + 429 nâng `RateLimitError`/`MlApiError` kèm `retryAfterSeconds`/`Retry-After` — nhất quán.
11. **Error state UI — SẠCH ở tầm query:** mọi component tiêu thụ query lớn đều có nhánh `isError` render thông báo (price-chart.tsx:384-387, agent-detail-panel.tsx:171-195, market-summary, agents-workspace, coverage-matrix, sandbox-card…) — không có spinner treo vĩnh viễn ở tầm module (Điều duy nhất thiếu là boundary toàn app = D3).
12. **Query key & invalidation mapping — SẠCH:** audit chéo mọi cặp queryKey↔invalidate: `["signals", rangeKey]` ↔ prefix `["signals"]` ✓; `["orders", viewAccountType, rangeKey]` ↔ `["orders"]` ✓; `["portfolio", world]` ↔ `["portfolio"]` ✓; `["agent", agentId]` (agent-detail-panel.tsx:126) ↔ cả literal lẫn predicate `q.queryKey[0] === "agent"` ✓; `["bars", symbol, rangeKey|days]` ↔ `["bars"]` từ WS "eod" ✓; `["council-overview", rangeKey]` ↔ `["council-overview"]` ✓; `["agent-tasks", agentId]` ↔ `AGENT_TASKS_QUERY_KEY` ✓.
13. **Gateway XTransformPort — ĐÚNG theo chuẩn sandbox:** client `io("/?XTransformPort=3003")` — query được merge vào mọi request engine.io (thấy trong dev.log: `?XTransformPort=3003&EIO=4&transport=polling`, XTransformPort đứng đầu); engine.io-client 6.6.7 + engine.io server 6.6.11 cùng default path `/socket.io/` (có slash) khớp nhau; in-project đã verify gateway :81 routing → handshake 200 + upgrade WS 101 (worklog #64). **Lưu ý: KHÔNG có Caddyfile trong repo** — gateway là hạ tầng sandbox ngoài repo, không audit được file config; mọi kết luận về gateway dựa bằng chứng hành vi + worklog. 404 trong dev.log = artifact origin trực tiếp (xem D1).
14. **next.config.ts — SẠCH:** duy nhất `allowedDevOrigins` (fix #57 cho 127.0.0.1 HMR) — không can thiệp runtime production.
15. **providers.tsx — SẠCH:** QueryClient tạo 1 lần trong `useState` initializer (không re-create mỗi render); defaults hợp lý (retry 1, staleTime 30s, gcTime 5m, focus-refetch tắt có chủ đích vì realtime-first).
16. **page.tsx / layout.tsx — SẠCH:** deep-link `?ws=` đọc 1 lần trong effect có deps setter stable; hydrate dateRange sau mount; layout chỉ bọc Providers + Toaster, metadata tĩnh (không generateFromView — không có nguy cơ động SSR/client).
17. **Engine lifecycle — SẠCH (trừ D7):** tick mutex chuỗi Promise chống lost-update (index.ts:505-510); guard in-flight từng job (eod/intl/reprobe/settle/ml-train/sweep/k1/council/macro/flow); P0-5 state sống sót restart qua DB; try/catch bao khối due-check 60s (bài học #42); backoff intl nhân đôi có cap; k3 in-flight theo taskId + defer trước dispatch đúng thứ tự (F-K3-03); `postJson` timeout 280s < maxDuration 300s route; SIGINT đóng `io` + `http`.

---

## PHỤ LỤC — Bằng chứng thực nghiệm audit

```
# 1) Số lượng 404 socket.io trong dev.log (origin trực tiếp)
$ rg -c "GET /socket.io.*404" dev.log
760

# 2) Probe trực tiếp dev server (chứng minh 308→404 của Next)
$ curl "http://127.0.0.1:3000/socket.io/?probe=slash"   → 308
$ curl "http://127.0.0.1:3000/socket.io?probe=noslash"  → 404
(log Next ghi: " GET /socket.io?probe=noslash 404 in 30ms")

# 3) engine.io-client URL thật (repro Node — có trailing slash)
$ node wsprobe2.mjs
URLs seen by server: [ "GET /socket.io/?XTransformPort=3003&EIO=4&transport=polling&t=..." ]

# 4) toPlain DAG (repro Node — xem D2)
$ node plainprobe.mjs
{"a":{"x":1},"b":"[Circular]"}
```

— Hết báo cáo audit 137-d —

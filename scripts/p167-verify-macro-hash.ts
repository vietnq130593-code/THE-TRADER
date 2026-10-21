/**
 * scripts/p167-verify-macro-hash.ts — KIỂM ĐỊNH F-166b-3 + F-166b-7 (vá #167).
 *
 * F-166b-3 (Fixbug #166 — user quyết định #167): windowHash chỉ hash bar giá
 * (symbol|date|close|volume) — 8 chiều MacroContext của v3-macro KHÔNG góp →
 * G4/A4 skip oan "no-new-window" khi chỉ dữ liệu vĩ mô restated. Vá: digest
 * hash THÊM macro tại đúng ngày lấy mẫu (macroByDate + sampleDates) —
 * digestVersion "sha256-bars+macro8-v2".
 *
 * F-166b-7: POST /api/ml/* không auth — vá guard same-origin
 * (guardSameOrigin trong src/lib/api-guards.ts).
 *
 * Phần A + B: THUẦN LOGIC (0 DB — chạy được không cần env).
 * Phần C: LIVE WIRING (đọc DB read-only — cần env -u DATABASE_URL đúng bẫy
 * sandbox): buildTrainingSet(v3-macro) TRẢ macroByDate + digest macro chảy
 * đúng qua 3 đường gọi (train-mlp/psi-retrain/A4 kiểm bằng chính lib).
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p167-verify-macro-hash.ts
 */
import { trainingWindowDigest, type SymbolSeries, type MacroContext } from "../src/lib/ml/features";
import { guardSameOrigin } from "../src/lib/api-guards";

console.log("== #167 — F-166b-3 macro-windowHash + F-166b-7 same-origin guard ==");

let fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} · ${name} — ${detail}`);
  if (!ok) fail++;
};

/* ═══ Phần A — F-166b-3: digest macro (hermetic 0 DB) ═══ */

const day = (i: number) => new Date(Date.UTC(2026, 8, 1 + i)); // 2026-09-01 + i
const mkSeries = (symbol: string): SymbolSeries => {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    date: day(i),
    close: 100 + i,
    volume: 1000 * (i + 1),
  }));
  return {
    symbol,
    instrumentId: `test-${symbol}`,
    bars,
    closes: bars.map((b) => b.close),
    volumes: bars.map((b) => b.volume),
  };
};
const series = [mkSeries("AAA"), mkSeries("BBB")];

const ctx = (v: number): MacroContext => ({
  dus10y20: v,
  slope10y5y: 0.1,
  dxyMom20: 0.2,
  vndMom20: -0.05,
  cmdtyMom20: 0.3,
  breadth20: 0.55,
  flow20: 0.4,
  sent7: -0.2,
  missing: 0,
});
const sampleDates = ["2026-09-05", "2026-09-10", "2026-09-20"]; // ⊆ 30 ngày bar
const macroMap = new Map<string, MacroContext>([
  ["2026-09-05", ctx(1)],
  ["2026-09-10", ctx(2)],
  ["2026-09-20", ctx(3)],
  ["2026-09-25", ctx(9)], // có trong map nhưng KHÔNG lấy mẫu
]);

// T1 — đường cũ (không macro) bất biến tuyệt đối.
const legacy1 = trainingWindowDigest(series, { samples: 100 });
const legacy2 = trainingWindowDigest(series, { samples: 100 });
check(
  "T1 đường legacy: không macro → hash deterministic + digestVersion v1 + KHÔNG macroRows",
  legacy1.windowHash === legacy2.windowHash &&
    legacy1.digestVersion === "sha256-symbol-date-close-volume-v1" &&
    legacy1.macroRows === undefined,
  `hash=${legacy1.windowHash.slice(0, 12)}… · v=${legacy1.digestVersion}`
);

// T2 — macro góp vào hash: khác legacy + đúng version + đúng số dòng.
const withMacro = trainingWindowDigest(series, {
  samples: 100,
  macroByDate: macroMap,
  sampleDates,
});
check(
  "T2 v3-macro: hash ≠ legacy + digestVersion bars+macro8-v2 + macroRows = số ngày lấy mẫu",
  withMacro.windowHash !== legacy1.windowHash &&
    withMacro.digestVersion === "sha256-bars+macro8-v2" &&
    withMacro.macroRows === 3,
  `macroRows=${withMacro.macroRows} · v=${withMacro.digestVersion}`
);

// T3 — LOÕI GỐC CỦA F-166b-3: macro restated → hash ĐỔI (trước vá: bất biến).
const restated = new Map(macroMap);
restated.set("2026-09-10", ctx(2.5)); // đổi MỘT giá trị MỘT ngày lấy mẫu
const withRestated = trainingWindowDigest(series, {
  samples: 100,
  macroByDate: restated,
  sampleDates,
});
check(
  "T3 (lõi F-166b-3) macro restated 1 ngày lấy mẫu → hash KHÁC (hết skip oan)",
  withRestated.windowHash !== withMacro.windowHash,
  `đổi dus10y20 @2026-09-10: ${withMacro.windowHash.slice(0, 10)}… → ${withRestated.windowHash.slice(0, 10)}…`
);

// T4 — precision: macro đổi NGOÀI ngày lấy mẫu → hash KHÔNG đổi.
const outside = new Map(macroMap);
outside.set("2026-09-25", ctx(-9)); // ngày có trong map, không lấy mẫu
const withOutside = trainingWindowDigest(series, {
  samples: 100,
  macroByDate: outside,
  sampleDates,
});
check(
  "T4 precision: macro đổi ngoài ngày lấy mẫu → hash GIỮ NGUYÊN",
  withOutside.windowHash === withMacro.windowHash,
  "hash bất biến — chỉ hash đúng thứ model tiêu thụ"
);

// T5 — determinism đường macro.
const again = trainingWindowDigest(series, {
  samples: 100,
  macroByDate: new Map(macroMap),
  sampleDates: [...sampleDates],
});
check(
  "T5 determinism: 2 lần cùng macro → hash BẰNG NHAU",
  again.windowHash === withMacro.windowHash,
  "SHA-256 deterministic qua sorted distinct dates"
);

// T6 — macroByDate null ≡ đường cũ (rl-q/GRU/MTL không đổi hành vi).
const nullMacro = trainingWindowDigest(series, {
  samples: 100,
  macroByDate: null,
  sampleDates,
});
check(
  "T6 macroByDate null ≡ legacy tuyệt đối (rl-q/GRU/MTL nguyên vẹn)",
  nullMacro.windowHash === legacy1.windowHash &&
    nullMacro.digestVersion === legacy1.digestVersion,
  "đường không macro giữ đúng hash + version cũ"
);

// T7 — ngày lấy mẫu thiếu trong map → dòng absent (không bịa số 0).
const withAbsent = trainingWindowDigest(series, {
  samples: 100,
  macroByDate: macroMap,
  sampleDates: ["2026-09-05", "2026-09-30"], // 09-30 KHÔNG có trong map
});
const withZero = trainingWindowDigest(series, {
  samples: 100,
  macroByDate: new Map([
    ["2026-09-05", ctx(1)],
    ["2026-09-30", ctx(0)], // có context = 0 hết
  ]),
  sampleDates: ["2026-09-05", "2026-09-30"],
});
check(
  "T7 thiếu macro ≠ macro-zeros: dòng absent phân biệt được (hash khác)",
  withAbsent.windowHash !== withZero.windowHash,
  "absent trung thực — không lẫn với context 0"
);

// T8 — bar giá restated vẫn phát hiện như trước (P1-2 không thoái hoá).
const seriesRestated = [mkSeries("AAA"), mkSeries("BBB")];
seriesRestated[1]!.bars[15]!.close = 999; // đổi 1 close
const barChanged = trainingWindowDigest(seriesRestated, {
  samples: 100,
  macroByDate: macroMap,
  sampleDates,
});
check(
  "T8 bar giá đổi → hash đổi (P1-2 PIT giữ nguyên trên đường macro)",
  barChanged.windowHash !== withMacro.windowHash,
  "bar + macro đều nằm trong cùng một hash cửa sổ"
);

/* ═══ Phần B — F-166b-7: guardSameOrigin (hermetic 0 DB) ═══ */

const mkReq = (headers: Record<string, string>) =>
  new Request("http://trader.local/api/ml/train", { method: "POST", headers });

// G1 — engine :3003 / curl: không Origin, không Sec-Fetch-Site → đi qua.
check(
  "G1 engine/curl (không Origin) → PASS — đường engine :3003 không gãy",
  guardSameOrigin(mkReq({})) === null,
  "client không-browser là caller chính (A4, psi-retrain, sweep)"
);

// G2 — FE same-origin: Origin trùng Host → đi qua.
check(
  "G2 FE same-origin (Origin = Host) → PASS — nút bấm không gãy",
  guardSameOrigin(mkReq({ origin: "http://trader.local", host: "trader.local" })) === null,
  "browser POST luôn gửi Origin, same-origin thì trùng Host"
);

// G3 — cross-site: Origin lệch Host → 403.
const g3 = guardSameOrigin(mkReq({ origin: "https://evil.example", host: "trader.local" }));
check(
  "G3 cross-site (Origin ≠ Host) → 403 — chặn vector CSRF/từ trang lạ",
  g3 !== null && g3.status === 403,
  g3 ? `status=${g3.status}` : "không chặn!"
);

// G4 — Origin "null" (opaque — iframe preview sandbox) → đi qua.
check(
  "G4 Origin \"null\" (opaque iframe preview) → PASS",
  guardSameOrigin(mkReq({ origin: "null", host: "trader.local" })) === null,
  "không cookie-auth → không có gì để CSRF; chặn sẽ gãy preview"
);

// G5 — Sec-Fetch-Site: cross-site → 403 (kể cả không Origin).
const g5 = guardSameOrigin(mkReq({ "sec-fetch-site": "cross-site" }));
check(
  "G5 Sec-Fetch-Site: cross-site → 403 (lớp Fetch Metadata)",
  g5 !== null && g5.status === 403,
  g5 ? `status=${g5.status}` : "không chặn!"
);

// G6 — Sec-Fetch-Site: same-origin + Origin trùng → đi qua.
check(
  "G6 Sec-Fetch-Site: same-origin + Origin trùng → PASS",
  guardSameOrigin(
    mkReq({ "sec-fetch-site": "same-origin", origin: "http://trader.local", host: "trader.local" })
  ) === null,
  "2 lớp cùng mở cho browser chính chủ"
);

// G7 — Origin hỏng (không giải mã được) → 403 (fail-safe chặt).
const g7 = guardSameOrigin(mkReq({ origin: "khong-phai-url", host: "trader.local" }));
check(
  "G7 Origin malformed → 403 (fail-safe chặt, không fail-open)",
  g7 !== null && g7.status === 403,
  g7 ? `status=${g7.status}` : "không chặn!"
);

// G8 — gateway nhiều Host (X-Forwarded-Host "a, b") + Origin a → đi qua.
check(
  "G8 X-Forwarded-Host chuỗi nhiều giá trị → so đúng host đầu → PASS",
  guardSameOrigin(
    mkReq({ origin: "http://gw.local", "x-forwarded-host": "gw.local, other.local" })
  ) === null,
  "tương thích proxy chuỗi forward (gateway/caddy)"
);

/* ═══ Phần C — LIVE WIRING (DB read-only): macro chảy từ build → digest ═══ */

const hasDbEnv = (process.env.DATABASE_URL ?? "").startsWith("postgresql");
if (!hasDbEnv) {
  console.log("  SKIP · Phần C (live wiring) — không có DATABASE_URL postgres (chạy hermetic");
  console.log("         với `env -u DATABASE_URL` đúng bẫy sandbox thì phần C tự bật)");
} else {
  const { buildTrainingSet } = await import("../src/lib/ml/features");
  const { readEffectiveMlTuning } = await import("../src/lib/ml/tuning");
  const { recentWindowHashesOf } = await import("../src/lib/ml/train-mlp");

  const effective = await readEffectiveMlTuning();
  const isV3 = effective.mlp.featureSet === "v3-macro";
  console.log(`  … featureSet hiệu lực: ${effective.mlp.featureSet}`);
  const set = await buildTrainingSet(20, {
    ...(isV3 ? { featureSet: "v3-macro" as const } : {}),
  });
  const meta = trainingWindowDigest(set.series, {
    samples: set.X.length,
    macroByDate: set.macroByDate ?? null,
    sampleDates: set.dates,
  });
  const recent = await recentWindowHashesOf("dl-mlp");

  check(
    "C1 buildTrainingSet trả macroByDate khi v3-macro (null khi v2 — wiring đúng)",
    isV3 ? set.macroByDate instanceof Map && (set.macroByDate?.size ?? 0) > 0
         : (set.macroByDate ?? null) === null,
    isV3
      ? `map ${(set.macroByDate?.size ?? 0)} ngày macro (v3-macro)`
      : "v2-lag16 → null đúng thiết kế"
  );
  check(
    "C2 digest macro Rows > 0 khi v3 (macro GÓP hash thật trên DB sống)",
    isV3 ? (meta.macroRows ?? 0) > 0 : true,
    `macroRows=${meta.macroRows ?? 0} · bars=${meta.bars} · samples=${meta.samples} · v=${meta.digestVersion}`
  );
  check(
    "C3 migration trung thực: hash mới ≠ hash serving đang lưu (train lại 1 lần rồi ổn định)",
    recent.serving == null || recent.serving !== meta.windowHash,
    `serving=${(recent.serving ?? "(chưa có)").slice(0, 10)}… · mới=${meta.windowHash.slice(0, 10)}…`
  );
}

console.log(
  fail === 0
    ? `\nKẾT LUẬN: ${hasDbEnv ? "11/11" : "8/8"} PASS — F-166b-3 macro-windowHash (macro restated = cửa sổ mới) + F-166b-7 same-origin guard (engine/curl/FE đi qua, cross-site 403).`
    : `\nKẾT LUẬN: ${fail} FAIL`
);
process.exit(fail === 0 ? 0 : 1);

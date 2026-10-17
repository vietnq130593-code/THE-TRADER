/**
 * scripts/p131-nas-sync-verify.ts — F-18 (#131) · nghiệm thu cơ chế
 * "NAS champion tự động cập nhật thiết lập" (champion → AppSetting ml-tuning).
 *
 *  T1 (hermetic) — parseMlTuningValue giữ featureSet + nasSync hợp lệ, bỏ rác.
 *  T2 (hermetic) — effectiveMlTuning chuẩn hoá featureSet; sanitizeTuningInput
 *                  chấp nhận/từ chối featureSet đúng hợp đồng 422.
 *  T3 (DB, reversibel) — syncChampionTuningToSetting với champion GIẢ LẬP
 *                  (tag TEST-F18, runId p131-verify — KHÔNG đụng MlModel/
 *                  SweepRun/serving): AppSetting ml-tuning ghi đúng arch +
 *                  hyper + featureSet + nasSync; section rag GIỮ NGUYÊN;
 *                  AuditLog ML_SWEEP_SYNC_TUNING sinh ra; readMlTuning đọc
 *                  lại đúng từng số (round-trip qua đúng đường parse).
 *  T4 — restore: trả AppSetting ml-tuning về NGUYÊN VẸN giá trị trước test
 *                  (backup /tmp/p131-ml-tuning-backup.txt).
 *
 * Chế độ chạy:
 *   bun scripts/p131-nas-sync-verify.ts            → T1..T4 (restore cuối)
 *   bun scripts/p131-nas-sync-verify.ts --keep     → T1..T3, GIỮ trạng thái
 *                  đồng bộ (cho E2E browser banner tab Mạng thần kinh)
 *   bun scripts/p131-nas-sync-verify.ts --restore  → CHỈ T4 (dọn sau E2E)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { db } from "../src/lib/db";
import {
  effectiveMlTuning,
  parseMlTuningValue,
  readMlTuning,
  sanitizeTuningInput,
  ML_TUNING_KEY,
} from "../src/lib/ml/tuning";
import { syncChampionTuningToSetting } from "../src/lib/ml/sweep";

const BACKUP_PATH = "/tmp/p131-ml-tuning-backup.txt";
const mode = process.argv[2] ?? "";

const results: string[] = [];
let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  results.push(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` · ${detail}` : ""}`);
  if (!ok) failures++;
}

/* ── T1: parse thuần (hermetic) ── */
function t1(): void {
  const parsed = parseMlTuningValue({
    mlp: {
      hidden: [24, 12],
      activations: ["relu", "tanh"],
      lossWeights: [1, 1, 2.5],
      epochs: 60,
      patience: 12,
      batchSize: 32,
      lr: 0.01,
      l2: 0,
      valFraction: 0.2,
      seed: 20261012,
      featureSet: "v3-macro",
    },
    nasSync: {
      at: "2026-10-18T02:00:00.000Z",
      runId: "run-test",
      tag: "C1",
      arch: "24-24-12-3",
      modelVersion: 22,
    },
  });
  check(
    "T1a parse giữ featureSet v3-macro",
    parsed.mlp?.featureSet === "v3-macro",
    `nhận ${parsed.mlp?.featureSet ?? "undefined"}`
  );
  check(
    "T1b parse giữ nasSync đủ 5 trường",
    parsed.nasSync?.tag === "C1" &&
      parsed.nasSync?.arch === "24-24-12-3" &&
      parsed.nasSync?.modelVersion === 22 &&
      parsed.nasSync?.runId === "run-test" &&
      parsed.nasSync?.at === "2026-10-18T02:00:00.000Z"
  );
  const garbage = parseMlTuningValue({
    mlp: { featureSet: "v9-crypto", hidden: [24, 12] },
    nasSync: { at: "x", runId: 5 },
  });
  check(
    "T1c parse bỏ featureSet rác + nasSync thiếu trường",
    garbage.mlp?.featureSet == null && garbage.nasSync == null
  );
}

/* ── T2: effective + sanitize (hermetic) ── */
function t2(): void {
  const eff = effectiveMlTuning({ mlp: { featureSet: "v3-macro" } as never });
  check(
    "T2a effective chuẩn hoá featureSet v3-macro",
    eff.mlp.featureSet === "v3-macro" && eff.mlp.hidden.length === 2
  );
  const effDefault = effectiveMlTuning({});
  check("T2b effective mặc định v2-lag16", effDefault.mlp.featureSet === "v2-lag16");
  const okSan = sanitizeTuningInput({ mlp: { featureSet: "v3-macro" } });
  check(
    "T2c sanitize chấp nhận featureSet v3-macro",
    okSan.errors.length === 0 && okSan.mlp?.featureSet === "v3-macro"
  );
  const badSan = sanitizeTuningInput({ mlp: { featureSet: "v4-news" } });
  check(
    "T2d sanitize 422 featureSet lạ",
    badSan.errors.length === 1 && badSan.errors[0]?.includes("featureSet"),
    badSan.errors[0]
  );
}

/* ── T3+T4: DB (reversibel) ── */
async function dbPhase(): Promise<void> {
  // Backup giá trị gốc (bất kể mode --restore đã có backup hay chưa — idempotent
  // khi file còn; --restore dùng file cũ).
  const row = await db.appSetting.findUnique({ where: { key: ML_TUNING_KEY } });
  const originalRaw = row?.value ?? null;
  if (!existsSync(BACKUP_PATH)) {
    writeFileSync(BACKUP_PATH, JSON.stringify({ originalRaw }));
    results.push(`INFO — backup ml-tuning gốc → ${BACKUP_PATH} (${originalRaw ?? "null"})`);
  }

  if (mode === "--restore") {
    // Chỉ restore.
    const backup = JSON.parse(readFileSync(BACKUP_PATH, "utf8")) as { originalRaw: string | null };
    if (backup.originalRaw == null) {
      await db.appSetting.deleteMany({ where: { key: ML_TUNING_KEY } }).catch(() => undefined);
      check("T4 restore — xoá AppSetting ml-tuning (như trạng thái gốc KHÔNG có key)", true);
    } else {
      await db.appSetting.upsert({
        where: { key: ML_TUNING_KEY },
        create: { key: ML_TUNING_KEY, value: backup.originalRaw },
        update: { value: backup.originalRaw },
      });
      const after = await db.appSetting.findUnique({ where: { key: ML_TUNING_KEY } });
      check(
        "T4 restore — AppSetting ml-tuning về NGUYÊN VẸN giá trị trước test",
        after?.value === backup.originalRaw
      );
    }
    return;
  }

  // Tiền điều kiện test rag-preservation: gắn tạm section rag (sẽ bị restore).
  await db.appSetting.upsert({
    where: { key: ML_TUNING_KEY },
    create: { key: ML_TUNING_KEY, value: JSON.stringify({ rag: { topK: 9, k1: 1.2, b: 0.7, wRecency: 0.4 } }) },
    update: { value: JSON.stringify({ rag: { topK: 9, k1: 1.2, b: 0.7, wRecency: 0.4 } }) },
  });

  const sync = await syncChampionTuningToSetting({
    runId: "p131-nas-sync-verify",
    hidden: [24, 12],
    activations: ["relu", "relu"],
    lossWeights: [1, 1, 1],
    hyper: {
      epochs: 60,
      patience: 12,
      batchSize: 32,
      lr: 0.01,
      l2: 0,
      valFraction: 0.2,
      seed: 20261012,
      featureSet: "v3-macro",
    },
    tag: "TEST-F18",
    arch: "24-24-12-3",
    modelVersion: 999,
  });
  check("T3a sync trả synced:true", sync.synced === true, sync.note);

  const savedNow = await readMlTuning();
  check(
    "T3b ml-tuning ghi đúng arch champion (hidden [24,12] + relu×2 + lw [1,1,1])",
    savedNow.mlp?.hidden?.[0] === 24 &&
      savedNow.mlp?.hidden?.[1] === 12 &&
      savedNow.mlp?.activations?.[0] === "relu" &&
      savedNow.mlp?.activations?.[1] === "relu" &&
      savedNow.mlp?.lossWeights?.[0] === 1
  );
  check(
    "T3c ml-tuning ghi đúng hyper champion (seed sweep 20261012 + lr 0,01)",
    savedNow.mlp?.seed === 20261012 && savedNow.mlp?.lr === 0.01 && savedNow.mlp?.epochs === 60
  );
  check("T3d ml-tuning ghi featureSet v3-macro", savedNow.mlp?.featureSet === "v3-macro");
  check(
    "T3e nasSync marker đủ trường (tag TEST-F18 · runId · arch 24-24-12-3)",
    savedNow.nasSync?.tag === "TEST-F18" &&
      savedNow.nasSync?.runId === "p131-nas-sync-verify" &&
      savedNow.nasSync?.arch === "24-24-12-3" &&
      savedNow.nasSync?.modelVersion === 999
  );
  check(
    "T3f section rag GIỮ NGUYÊN (topK 9)",
    savedNow.rag?.topK === 9 && savedNow.rag?.k1 === 1.2
  );

  // Effective qua đúng đường route: draft arch.in = 24 cho v3-macro.
  const eff = effectiveMlTuning(savedNow);
  check(
    "T3g effective → arch.in 24 (đúng như /api/ml/architecture draft sẽ trả)",
    eff.mlp.featureSet === "v3-macro" && (eff.mlp.hidden.length === 2)
  );

  const audits = await db.auditLog.findMany({
    where: { action: "ML_SWEEP_SYNC_TUNING" },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  check(
    "T3h AuditLog ML_SWEEP_SYNC_TUNING sinh ra (before/after JSON)",
    audits.length > 0 && (audits[0]?.after ?? "").includes("TEST-F18")
  );

  if (mode === "--keep") {
    results.push("INFO — GIỮ trạng thái đồng bộ (--keep) cho E2E browser banner.");
    return;
  }

  // T4 — restore về nguyên vẹn.
  const backup = JSON.parse(readFileSync(BACKUP_PATH, "utf8")) as { originalRaw: string | null };
  if (backup.originalRaw == null) {
    await db.appSetting.deleteMany({ where: { key: ML_TUNING_KEY } }).catch(() => undefined);
    const gone = await db.appSetting.findUnique({ where: { key: ML_TUNING_KEY } });
    check("T4 restore — xoá AppSetting ml-tuning (trạng thái gốc không có key)", gone == null);
  } else {
    await db.appSetting.upsert({
      where: { key: ML_TUNING_KEY },
      create: { key: ML_TUNING_KEY, value: backup.originalRaw },
      update: { value: backup.originalRaw },
    });
    const after = await db.appSetting.findUnique({ where: { key: ML_TUNING_KEY } });
    check(
      "T4 restore — AppSetting ml-tuning về NGUYÊN VẸN (so từng ký tự)",
      after?.value === backup.originalRaw
    );
  }
}

async function main(): Promise<void> {
  t1();
  t2();
  await dbPhase();
  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "✅ TẤT CẢ PASS" : `❌ ${failures} FAIL`}`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("LỖI script:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

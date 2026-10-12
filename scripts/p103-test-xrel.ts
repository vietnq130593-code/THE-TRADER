/**
 * scripts/p103-test-xrel.ts — smoke engine M2 (phiên #103):
 * chạy refreshRelations() thật trên DB + in kết quả + top quan hệ.
 */
import { refreshRelations, getRelations } from "../src/lib/ml/xrel";
import { db } from "../src/lib/db";

async function main() {
  const res = await refreshRelations();
  console.log("REFRESH:", JSON.stringify(res, null, 2));
  const rows = await getRelations(60);
  console.log(`\nTOP ${rows.length} QUAN HỆ (đã lưu):`);
  for (const r of rows.slice(0, 25)) {
    console.log(
      `${r.kind.padEnd(5)} ${r.sourceLabel} → ${r.targetLabel} · lag ${r.lag} · r=${r.corr.toFixed(3)} · P(↑|↑)=${r.condUp == null ? "—" : Math.round(r.condUp * 100) + "%"} · P(↓|↓)=${r.condDown == null ? "—" : Math.round(r.condDown * 100) + "%"} · n=${r.obs} · strength=${r.strength.toFixed(3)}`
    );
  }
}

main()
  .catch((err) => {
    console.error("LỖI:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

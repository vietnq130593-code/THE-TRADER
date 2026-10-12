import { buildXrelPromptBlock } from "../src/lib/ml/xrel";
import { db } from "../src/lib/db";
async function main() {
  const block = await buildXrelPromptBlock();
  console.log("BLOCK (null nếu không có quan hệ):");
  console.log(block ?? "(null)");
  console.log(`\nĐộ dài: ${block?.length ?? 0} ký tự (~${Math.round((block?.length ?? 0) / 2.5)} token)`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());

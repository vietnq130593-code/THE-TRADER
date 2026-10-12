import { buildSingleRunPrompt, buildChatUserPrompt } from "../src/lib/agent-context";
import { db } from "../src/lib/db";
async function main() {
  for (const code of ["market-analyst", "news-sentiment", "portfolio-strategist", "fair-value"]) {
    const { user } = await buildSingleRunPrompt(code);
    const has = user.includes("QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC");
    console.log(`${code.padEnd(22)} single-run XREL: ${has ? "CÓ ✓" : "không (đúng thiết kế)"}`);
  }
  const chat = await buildChatUserPrompt("market-analyst", "Quan hệ ngân hàng và VN30 thế nào?");
  console.log(`market-analyst chat   XREL: ${chat.includes("QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC") ? "CÓ ✓" : "KHÔNG ✗"}`);
  const chat4 = await buildChatUserPrompt("news-sentiment", "Tin vĩ mô ảnh hưởng thị trường ra sao?");
  console.log(`news-sentiment chat  XREL: ${chat4.includes("QUAN HỆ THỊ TRƯỜNG ĐÃ HỌC") ? "CÓ ✓" : "KHÔNG ✗"}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());

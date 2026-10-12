/** #106 — đối chứng C-VISION tiêm 3 đường: single-run + chat strategist. */
import { PrismaClient } from "@prisma/client";
import { buildSingleRunPrompt, buildChatUserPrompt } from "../src/lib/agent-context";

const db = new PrismaClient();

async function main() {
  const single = await buildSingleRunPrompt("portfolio-strategist");
  const hasVisionSingle = single.user.includes("TÀI KHOẢN HỘI ĐỒNG");
  console.log("single-run strategist:", hasVisionSingle ? "CÓ khối C-VISION ✓" : "THIẾU khối ✗", `· prompt ${single.user.length} ký tự`);
  const i = single.user.indexOf("═══ TÀI KHOẢN");
  if (i >= 0) console.log(single.user.slice(i, i + 500));

  const chat = await buildChatUserPrompt("portfolio-strategist", "Hội đồng đang quản lý tài khoản thế nào?");
  const hasVisionChat = chat.includes("TÀI KHOẢN HỘI ĐỒNG");
  console.log("\nchat strategist:", hasVisionChat ? "CÓ khối C-VISION ✓" : "THIẾU khối ✗");

  // Đối chứng âm tính: các vai KHÁC không nhận khối (đúng thiết kế)
  const analyst = await buildSingleRunPrompt("market-analyst");
  console.log("market-analyst (đối chứng):", analyst.user.includes("TÀI KHOẢN HỘI ĐỒNG") ? "CÓ (SAI thiết kế) ✗" : "KHÔNG có (đúng) ✓");
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

/** (Task 144 P2-b) — barrel: tách từ src/lib/agent-context.ts (pure move).
 *  Mọi triển khai nằm trong src/lib/context/* (12 module theo seam); file này
 *  GIỮ NGUYÊN PATH + ĐÚNG 13 export như trước khi tách để các importer hiện tại
 *  (src/lib/agents-run/* · src/app/api/agents/[id]/chat · [id]/run) không đổi.
 *
 * Khối ngữ cảnh + role-prompt DÙNG CHUNG cho single-run & chat
 * (PHASE3_BLUEPRINT §4.6) — trích xuất từ POST /api/agents/run.
 *
 * Các builder lấy dữ liệu thật từ DB (quotes/positions/account/news/flows);
 * không bao giờ bịa số liệu. equity = cash + Σ(qty×last) vị thế mở (F-102).
 *
 * Mở rộng 23 agents: thêm buildValuationBlock (A3 Fair Value) và
 * buildLiquidityBlock (A5 Liquidity); ROLE_PROMPTS đủ 23 agents
 * (LLM agents có system đầy đủ — service agents có identity prompt cho chat).
 */

export type { MarketSnapshot } from "./context/snapshot";
export { buildMarketBlock } from "./context/snapshot";
export { buildIntlReferenceBlock } from "./context/intl";
export { buildNewsBlock } from "./context/news";
export { buildFlowsBlock } from "./context/flows";
export { buildMacroBlock } from "./context/macro";
export { buildValuationBlock } from "./context/valuation";
export { buildLiquidityBlock } from "./context/liquidity";
export { buildOpenSignalsBlock } from "./context/open-signals";
export { buildPortfolioWeightsBlock } from "./context/portfolio-weights";
export { ROLE_PROMPTS } from "./context/prompts";
export { buildSingleRunPrompt } from "./context/single-run";
export { buildChatUserPrompt } from "./context/chat";

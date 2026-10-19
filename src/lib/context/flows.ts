/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  Khối dòng khối ngoại S6: buildFlowsBlock. */

import { getForeignFlows, flowsPromptBlock } from "@/lib/flows";

/** Dòng khối ngoại (S6) — nguồn không khả dụng thì khai báo rõ để agent bỏ metric. */
export async function buildFlowsBlock(): Promise<string> {
  const flows = await getForeignFlows().catch(() => null);
  return flows
    ? flowsPromptBlock(flows)
    : "DÒNG KHỐI NGOẠI: (nguồn không khả dụng — bỏ metric này khỏi phân tích)";
}

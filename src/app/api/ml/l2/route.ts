/**
 * src/app/api/ml/l2/route.ts (Task 142 · F-24 §6) — cổng vận hành lớp
 * L2 TRI THỨC DÀI HẠN (LightRAG-style viết tay — RAG_UPGRADE_ASSESSMENT §6).
 *
 *   GET  /api/ml/l2                — trạng thái kho (chunks/đồ thị/đo lường/
 *                                     pending) — dùng chung l2Stats().
 *   POST /api/ml/l2 {action}       — "index"   : index nốt corpus (tối đa
 *                                     limit, mặc định 5.000 = cả kho);
 *                                     "rebuild" : xoá 3 bảng + index lại từ
 *                                     đầu (khi đổi logic corpus/embed model).
 *
 * Nhịp bình thường KHÔNG cần gọi POST: retrieveForCycleL2 tự chữa ≤32 doc
 * mỗi chu kỳ (§6.3). POST dành cho bootstrap lại / chủ sở hữu muốn ép.
 *
 * Giống văn hoá route train/sweep (#138 A8): đang index → 409 (không xếp
 * hàng); audit log mọi hành động có chủ ý (L2_INDEX/L2_REBUILD).
 * NIM key đọc qua nim-embed shim (.env.local) — backend-only, không lộ.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { indexCorpus, isIndexing, l2Stats, relinkGraph } from "@/lib/ml/l2";

export async function GET() {
  try {
    const stats = await l2Stats();
    return NextResponse.json({
      ok: true,
      indexing: isIndexing(),
      stats,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { action?: string; limit?: number } = {};
  try {
    body = (await req.json()) as { action?: string; limit?: number };
  } catch {
    /* body rỗng — coi như index */
  }
  const action = body.action ?? "index";
  if (action !== "index" && action !== "rebuild" && action !== "relink") {
    return NextResponse.json(
      { error: `action "${action}" không hợp lệ — dùng "index" | "rebuild" | "relink"` },
      { status: 400 }
    );
  }
  if (isIndexing()) {
    return NextResponse.json(
      { error: "Đang có đợt index L2 chạy — thử lại sau", busy: true },
      { status: 409 }
    );
  }
  // relink: dựng lại đồ thị từ entityKeys đã lưu — 0 NIM call, sửa đường khi
  // flush đồ thị từng fail sau khi chunk đã ghi (xem relinkGraph).
  if (action === "relink") {
    try {
      const relink = await relinkGraph();
      try {
        await db.auditLog.create({
          data: { action: "L2_RELINK", entity: "KnowledgeEdge", after: JSON.stringify(relink) },
        });
      } catch {
        /* audit fail → không chặn */
      }
      return NextResponse.json({ ok: true, action, relink });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      );
    }
  }
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : 5_000;
  try {
    const summary = await indexCorpus({
      rebuild: action === "rebuild",
      maxDocs: limit,
      budgetMs: 600_000,
    });
    try {
      await db.auditLog.create({
        data: {
          action: action === "rebuild" ? "L2_REBUILD" : "L2_INDEX",
          entity: "KnowledgeChunk",
          after: JSON.stringify(summary),
        },
      });
    } catch {
      /* audit fail → không chặn kết quả trả về */
    }
    return NextResponse.json({ ok: true, action, summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

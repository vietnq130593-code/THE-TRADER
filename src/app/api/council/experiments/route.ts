import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { db } from "@/lib/db";
import { createExperiment, stopExperiment } from "@/lib/council/experiments";

export const dynamic = "force-dynamic";

/**
 * POST /api/council/experiments (#106 §5 — E-ALLOC).
 *
 * Body: { name, hypothesis, weights: [{basket, weight}], capitalVND?,
 * horizonDays? } — trader tạo tay thí nghiệm phân bổ (mặc định vốn 100 tr ₫ ·
 * horizon 30 ngày). Validate: tổng trọng số 95–105 → chuẩn hoá 100; rổ hợp lệ
 * trong 5 key; horizon 7..90. Trả 422 { fields[] } theo pattern API nhà.
 *
 * PUT ?id=... — dừng thí nghiệm đang chạy (tổng kết ngay với dữ liệu tới nay).
 */
export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Body JSON không hợp lệ." }, { status: 422 });
    }
    const result = await createExperiment({
      name: String(body.name ?? ""),
      hypothesis: String(body.hypothesis ?? ""),
      weights: Array.isArray(body.weights)
        ? (body.weights as Array<{ basket?: unknown; weight?: unknown }>).map((w) => ({
            basket: String(w?.basket ?? ""),
            weight: Number(w?.weight ?? 0),
          }))
        : [],
      capitalVND: Number(body.capitalVND ?? 100_000_000),
      horizonDays: Number(body.horizonDays ?? 30),
      createdBy: "trader",
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, fields: ["weights", "name", "hypothesis"] },
        { status: 422 }
      );
    }
    return NextResponse.json(toPlain(result), { status: 201 });
  } catch (err) {
    console.error("[api/council/experiments POST]", err);
    return NextResponse.json(
      { error: "Tạo thí nghiệm thất bại — xem log server." },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Thiếu ?id thí nghiệm." }, { status: 422 });
    }
    const exists = await db.allocationExperiment.findUnique({ where: { id } });
    if (!exists) {
      return NextResponse.json({ error: "Không tìm thấy thí nghiệm." }, { status: 404 });
    }
    const result = await stopExperiment(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/council/experiments PUT]", err);
    return NextResponse.json({ error: "Dừng thí nghiệm thất bại." }, { status: 500 });
  }
}

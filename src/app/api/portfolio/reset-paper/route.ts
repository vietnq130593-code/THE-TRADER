import { NextResponse } from "next/server";
import { resetPaperWorld } from "@/lib/paper-world";

export const dynamic = "force-dynamic";

/**
 * POST /api/portfolio/reset-paper — "Đặt lại thế giới Giấy về 0" (phiên #91
 * việc 1 — hiệu lệnh trader: "xoá toàn bộ dữ liệu demo cũ, giá trị về đúng 0
 * tròn trĩnh").
 *
 * Không nhận body — thao tác toàn cục trên MỌI tài khoản giấy (accountType ≠
 * sandbox). P0 quarantine §5.1: không bao giờ chạm tài khoản thử nghiệm K1
 * (xem lib/paper-world.ts — KHÔNG chạm sandbox / Signal / bài học agents).
 *
 * UI xác nhận 2 bước phía client (Dialog — pattern #90 sandbox-card) trước
 * khi gọi route này. Trả summary chi tiết đã xoá để toast minh bạch.
 */
export async function POST() {
  try {
    const res = await resetPaperWorld();
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: res.status });
    }
    return NextResponse.json({ ok: true, summary: res.summary });
  } catch (err) {
    console.error("[api/portfolio/reset-paper]", err);
    return NextResponse.json(
      { error: "Đặt lại thế giới Giấy thất bại." },
      { status: 500 }
    );
  }
}

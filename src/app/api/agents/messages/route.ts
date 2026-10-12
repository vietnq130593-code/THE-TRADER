import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày bắt đầu ICT (00:00 +07:00) của chuỗi "YYYY-MM-DD". */
function ictDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+07:00`);
}

/** Ngày kết thúc ICT (cuối ngày +07:00) của chuỗi "YYYY-MM-DD". */
function ictDayEnd(date: string): Date {
  return new Date(`${date}T23:59:59.999+07:00`);
}

/**
 * GET /api/agents/messages — recent 30 agent messages (newest first)
 * with sender identity for the chat-like timeline.
 * #105 — ?from=YYYY-MM-DD&to=YYYY-MM-DD (ngày ICT): lọc createdAt trong khoảng,
 * take nới 30 → 120 cho khoảng dài. Không có → hành vi cũ.
 */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const fromParam = sp.get("from");
    const toRaw = sp.get("to");
    const hasRange = Boolean(
      fromParam &&
        toRaw &&
        DATE_RE.test(fromParam) &&
        DATE_RE.test(toRaw) &&
        fromParam <= toRaw,
    );

    const messages = await db.agentMessage.findMany({
      // AUD-CODE #23: feed chung chỉ trả tin broadcast — chat riêng 1-1
      // (broadcast=false) chỉ hiển thị trong thread của agent đó
      where: hasRange
        ? {
            broadcast: true,
            createdAt: { gte: ictDayStart(fromParam!), lte: ictDayEnd(toRaw!) },
          }
        : { broadcast: true },
      orderBy: { createdAt: "desc" },
      take: hasRange ? 120 : 30,
      include: {
        fromAgent: { select: { code: true, name: true, role: true } },
        toAgent: { select: { code: true, name: true } },
      },
    });

    return NextResponse.json(
      toPlain({
        messages: messages.map((m) => ({
          id: m.id,
          fromAgent: m.fromAgent
            ? { code: m.fromAgent.code, name: m.fromAgent.name, role: m.fromAgent.role }
            : null,
          toAgent: m.toAgent ? { code: m.toAgent.code, name: m.toAgent.name } : null,
          broadcast: m.broadcast,
          // PHASE3 B2 §4.1 — AGENT | USER (chat 1-1 lưu fromAgentId = agent sở hữu thread)
          direction: m.direction as "AGENT" | "USER",
          content: m.content,
          reasoning: m.reasoning,
          sentiment: m.sentiment,
          createdAt: m.createdAt,
        })),
      })
    );
  } catch (err) {
    console.error("[api/agents/messages]", err);
    return NextResponse.json(
      { error: "Không tải được luồng tin nhắn agent." },
      { status: 500 }
    );
  }
}

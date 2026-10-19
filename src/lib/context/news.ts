/** (Task 144 P2-b) — tách từ src/lib/agent-context.ts (pure move)
 *  Khối tin tức S5: buildNewsBlock (10 tin RSS mới nhất). */

import { latestNewsForContext } from "@/lib/news";

/** 10 tin RSS mới nhất (S5 · latestNewsForContext) — định dạng như run route. */
export async function buildNewsBlock(): Promise<string> {
  const newsItems = await latestNewsForContext(10);
  const newsAge = (d: Date) => {
    const h = Math.max(0, Math.round((Date.now() - d.getTime()) / 3_600_000));
    return h <= 0 ? "vừa xong" : h < 24 ? `${h}h trước` : `${Math.round(h / 24)} ngày trước`;
  };
  return newsItems.length
    ? [
        `TIN TỨC THỊ TRƯỜNG MỚI NHẤT (S5 · RSS ${[...new Set(newsItems.map((n) => n.source))].join(", ")}):`,
        ...newsItems.map(
          (n) =>
            `- [${n.source} · ${newsAge(n.publishedAt)}] ${n.title}${n.summary ? ` — ${n.summary.slice(0, 140)}` : ""}`
        ),
      ].join("\n")
    : "TIN TỨC THỊ TRƯỜNG: (chưa nạp được tin mới — nếu dùng, khai báo rõ 'no new data' và không bịa tin)";
}

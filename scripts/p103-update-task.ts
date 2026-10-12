/**
 * scripts/p103-update-task.ts — cập nhật mô tả nhiệm vụ K3 "Làm mới ký ức RAG
 * tuần" (SUN:05:00) của learning-rag để phản ánh thêm phạm vi M2 #103: học
 * quan hệ liên thị trường + tổng hợp nhận định LLM. Idempotent theo nội dung.
 */
const API = "http://localhost:3000";

async function main(): Promise<void> {
  const res = await fetch(`${API}/api/agents`);
  if (!res.ok) throw new Error(`GET /api/agents → HTTP ${res.status}`);
  const { agents } = (await res.json()) as { agents: { id: string; code: string }[] };
  const a = agents.find((x) => x.code === "learning-rag");
  if (!a) throw new Error("Không tìm thấy learning-rag");
  const t = await fetch(`${API}/api/agents/${a.id}/tasks`);
  const { tasks } = (await t.json()) as { tasks: { id: string; title: string }[] };
  const task = tasks.find((x) => x.title === "Làm mới ký ức RAG tuần");
  if (!task) throw new Error("Không tìm thấy nhiệm vụ 'Làm mới ký ức RAG tuần'");

  const description =
    "Sau huấn luyện & sweep Chủ nhật: tổng hợp ký ức phân tích của đội tuần qua (corpus RAG, RetrievalLog) — báo cáo độ phủ ngữ cảnh truy hồi cho các chu kỳ của tuần mới (A13). Đồng thời HỌC QUAN HỆ LIÊN THỊ TRƯỜNG (M2 #103, cơ chế số 2): chạy lại engine quant trên 750 phiên gần nhất (12 phân đoạn: VN30/VN100 + 10 ngành HOSE) rồi tổng hợp nhận định LLM về mối quan hệ ảnh hưởng qua lại giữa các thị trường — 1 lần/tuần, lớp tin→giá tự mở khi kho tin đủ 15 ngày giao dịch có tin.";

  const r = await fetch(`${API}/api/agents/${a.id}/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!r.ok) throw new Error(`PATCH → HTTP ${r.status}: ${await r.text()}`);
  const body = (await r.json()) as { task?: { description?: string } };
  console.log("OK — mô tả mới:", (body.task?.description ?? "").slice(0, 120), "…");
}

main().catch((err) => {
  console.error("LỖI:", err);
  process.exitCode = 1;
});

export {};

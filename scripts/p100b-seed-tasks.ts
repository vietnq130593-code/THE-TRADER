/**
 * scripts/p100b-seed-tasks.ts — Task 100-B (phiên #100): thay trader lập lịch
 * NHIỆM VỤ ĐỊNH KỲ cho 22/23 agents qua API K3 chuẩn nhà
 * (POST /api/agents/[id]/tasks — server tự tính nextDueAt theo ICT).
 *
 * Thiết kế ma trận lịch (AUTONOMY_BLUEPRINT §6 — K3, grammar "HH:MM" hằng ngày
 * / "DOW:HH:MM" hằng tuần), căn theo nhịp sống thật của hệ thống:
 *   · intl-sync 06:15 · ATO 09:00 · mở 09:15 · trưa 11:30 · chiều 13:00
 *   · ATC 14:45 · đóng 15:00 · eod-sync 15:45 · settle 16:15 · k1-equity 16:30
 *   · SUN: A4 ml-train 04:00 · F3 ml-sweep 04:15
 *   · chu kỳ 23 agents mỗi 240 phút (AGENT_CYCLE_MINUTES) chạy nền mù thời gian —
 *     nhiệm vụ K3 bồi đắp GIÁ TRỊ THỜI ĐIỂM mà chu kỳ chung không có.
 *
 * 22/23 vì execution-manager bị route chặn THEO THIẾT KẾ (chỉ chạy trong chu kỳ
 * đầy đủ — cần Signal đầu vào, single-run 409; F-K3-05 FB-4A).
 *
 * Idempotent: nhiệm vụ trùng (agentCode, title) đã tồn tại → skip, không nhân đôi.
 * Chạy: bun scripts/p100b-seed-tasks.ts  (dev :3000 phải sống).
 */

interface TaskSpec {
  code: string;
  title: string;
  description: string;
  schedule: string; // "HH:MM" | "DOW:HH:MM"
  priority: "low" | "medium" | "high";
}

const TASKS: TaskSpec[] = [
  // ── NHÓM EXECUTIVE — Chuỗi mở phiên (trước ATO 09:00) ──
  {
    code: "portfolio-strategist",
    title: "Chỉ thị mở phiên của Chủ tịch",
    schedule: "08:40",
    priority: "high",
    description:
      "Tổng hợp bối cảnh đêm (thị trường thế giới sau đồng bộ quốc tế 06:15, tin tức mới nhất, trạng thái tín hiệu đang mở) thành chỉ thị ngắn gọn định hướng ưu tiên của Hội đồng 23 agents cho phiên giao dịch hôm nay. Ngoài ngày giao dịch (T7/CN/lễ): chỉ 3-5 dòng tóm tắt trạng thái chờ và việc cần theo dõi cho phiên kế tiếp.",
  },
  {
    code: "market-analyst",
    title: "Bản tin mở phiên",
    schedule: "08:45",
    priority: "medium",
    description:
      "Phân tích kỹ thuật VN30 trước giờ ATO 09:00: xu hướng ngắn hạn, vùng hỗ trợ/kháng cự đáng chú ý nhất, tương quan với thị trường thế giới đêm qua. Ngoài ngày giao dịch: tóm tắt ngắn tin thị trường quan trọng + trạng thái chờ phiên kế tiếp (không phân tích đầy đủ).",
  },
  {
    code: "ml-forecast",
    title: "Dự báo ML trước phiên",
    schedule: "08:50",
    priority: "medium",
    description:
      "Chạy dự báo ensemble 5 phiên (MLP serving + hồi quy tuyến tính) cho rổ thanh khoản cao ngay trước giờ mở cửa — làm cơ sở đối chiếu trong ngày và phiếu cử tri thứ 6 cho Bộ tổng hợp Bayes.",
  },
  {
    code: "risk-manager",
    title: "Rà soát rủi ro trước phiên",
    schedule: "08:55",
    priority: "high",
    description:
      "Kiểm tra trạng thái danh mục trước giờ ATO: giới hạn rủi ro đang sử dụng, tín hiệu đang mở chờ phê duyệt, mức tổn thất tích luỹ; nêu rõ 1-3 rủi ro cần chú ý đầu phiên. Ngoài ngày giao dịch: xác nhận trạng thái an toàn và việc cần theo dõi.",
  },

  // ── NHÓM RESEARCH — Giữa ngày ──
  {
    code: "news-sentiment",
    title: "Điểm tin trưa",
    schedule: "11:35",
    priority: "medium",
    description:
      "Tổng hợp tin tức buổi sáng + cảm xúc thị trường sau khi đóng phiên liên tục sáng (11:30): tin mới ảnh hưởng VN30, thay đổi sentiment so với bản tin mở phiên, cảnh báo tin cần theo dõi buổi chiều. Ngoài ngày giao dịch: bản tóm tắt tin trong 24h gần nhất.",
  },

  // ── NHÓM PLATFORM + RESEARCH — Chuỗi sau EOD 15:45 ──
  {
    code: "data-collector",
    title: "Kiểm thu thu thập dữ liệu đóng cửa",
    schedule: "15:48",
    priority: "medium",
    description:
      "Sau đồng bộ EOD 15:45: kiểm tra trạng thái thu thập các nguồn (báo giá, nến, tin tức, dòng khối ngoại), ghi nhận nguồn thiếu/lỗi cần theo dõi — không tự sync (engine làm), chỉ kiểm thu trung thực.",
  },
  {
    code: "liquidity",
    title: "Phân tích thanh khoản cuối ngày",
    schedule: "15:52",
    priority: "medium",
    description:
      "Phân tích thanh khoản phiên vừa đóng (dữ liệu EOD đã đủ): giá trị giao dịch, thanh khoản tập trung/loãng theo mã, hệ quả cho việc vào/ra vị thế phiên kế tiếp. Ngoài ngày giao dịch: xác nhận không có dữ liệu mới + tóm tắt thanh khoản phiên gần nhất.",
  },
  {
    code: "feature-store",
    title: "Chốt đặc trưng sau đóng cửa",
    schedule: "15:55",
    priority: "medium",
    description:
      "Tính & đối chiếu snapshot đặc trưng đầy đủ của phiên vừa đóng (SMA20/50, RSI14, KL/TL20, động lượng 5 phiên) — nền cho huấn luyện ML và phân tích phiên kế tiếp.",
  },
  {
    code: "data-integrity",
    title: "Kiểm định chất lượng dữ liệu cuối ngày",
    schedule: "16:05",
    priority: "medium",
    description:
      "Sau khi đặc trưng đã chốt: kiểm định độ tươi báo giá, độ phủ nến theo mã, độ trễ tin tức; cảnh báo stale trước khi các chu kỳ phân tích cuối ngày dùng dữ liệu.",
  },

  // ── NHÓM CONTROL/EXECUTIVE — Chuỗi sau settle 16:15 ──
  {
    code: "settlement",
    title: "Đối soát thanh toán cuối ngày",
    schedule: "16:18",
    priority: "high",
    description:
      "Ngay sau settle 16:15: đối chiếu khớp lệnh, phí môi giới và thuế TNCN 0,1% trên giao dịch bán của phiên hôm nay (A11 reconciliation) — xác nhận không lệch giữa sổ lệnh và dòng tiền.",
  },
  {
    code: "exposure",
    title: "Báo cáo phơi nhiễm cuối ngày",
    schedule: "16:22",
    priority: "high",
    description:
      "Sau thanh toán: chốt trạng thái phơi nhiễm danh mục (tỷ trọng ngành so trần 40% NAV, vị thế đơn so trần 25% NAV); nêu các vị trí sắp chạm giới hạn cần hành động phiên kế tiếp.",
  },
  {
    code: "compliance",
    title: "Quét tuân thủ cuối ngày",
    schedule: "16:26",
    priority: "high",
    description:
      "Kiểm tra cuối ngày: chế độ giao dịch đang bật, trạng thái phiên, biên margin sau mọi biến động trong ngày — xác nhận không có vi phạm treo trước khi sang ngày mới.",
  },
  {
    code: "cash-management",
    title: "Dự báo dòng tiền cuối ngày",
    schedule: "16:35",
    priority: "medium",
    description:
      "Sau đồng hồ học k1-equity 16:30: chốt số dư tiền mặt, sức mua ước tính, kịch bản dòng tiền ngày mai (A12); đề xuất hạn mức cho lệnh kế tiếp.",
  },

  // ── NHÓM ML — Cuối ngày sau mọi pipeline ──
  {
    code: "rl-gym",
    title: "Buổi tập RL cuối ngày",
    schedule: "16:45",
    priority: "medium",
    description:
      "Chạy môi trường giả lập trên dữ liệu phiên vừa đầy đủ — bước tổng kết cuối ngày sau khi mọi pipeline đóng cửa hoàn tất (settle + k1 + đặc trưng).",
  },
  {
    code: "rl-policy",
    title: "Tư thế chính sách RL cuối ngày",
    schedule: "16:50",
    priority: "medium",
    description:
      "Đọc trạng thái chính sách RL đang phục vụ sau buổi tập cuối ngày: epsilon khám phá, phiên bản chính sách, mức sẵn sàng triển khai tín hiệu.",
  },

  // ── NHÓM PLATFORM — Đóng ngày ──
  {
    code: "notification-officer",
    title: "Bản tóm tắt cuối ngày",
    schedule: "17:00",
    priority: "medium",
    description:
      "Tổng hợp cuối ngày cho trader: tín hiệu chờ phê duyệt, cảnh báo rủi ro chưa xử lý, lỗi agents trong ngày — kèm retry các thông báo outbox còn treo (S1).",
  },

  // ── NHÓM ML — Chuỗi Chủ nhật sau A4 ml-train 04:00 + F3 ml-sweep 04:15 ──
  {
    code: "learning-rag",
    title: "Làm mới ký ức RAG tuần",
    schedule: "SUN:05:00",
    priority: "medium",
    description:
      "Sau huấn luyện & sweep Chủ nhật: tổng hợp ký ức phân tích của đội tuần qua (corpus RAG, RetrievalLog) — báo cáo độ phủ ngữ cảnh truy hồi cho các chu kỳ của tuần mới (A13).",
  },
  {
    code: "dl-trainer",
    title: "Báo cáo huấn luyện học sâu tuần",
    schedule: "SUN:05:10",
    priority: "medium",
    description:
      "Sau A4 train + F3 sweep Chủ nhật: báo cáo trạng thái huấn luyện học sâu — bản serving (valAcc/Brier), champion mới nếu sweep đã đổi, kiến trúc và kế hoạch tuần tới (A17).",
  },
  {
    code: "rl-trainer",
    title: "Báo cáo vòng huấn luyện RL tuần",
    schedule: "SUN:05:20",
    priority: "medium",
    description:
      "Tổng kết các vòng huấn luyện RL trong tuần: phần thưởng tích luỹ, tiến bộ so với tuần trước, mức sẵn sàng lên bệ kiểm định (A18).",
  },
  {
    code: "backtest",
    title: "Kiểm định chiến lược tuần",
    schedule: "SUN:05:30",
    priority: "medium",
    description:
      "Sau sweep Chủ nhật: kiểm định chiến lược tham chiếu equal-weight 90 phiên — lợi nhuận, biến động năm hoá, drawdown tối đa (A14); đối chiếu champion ML mới nếu sweep đã đổi serving.",
  },
  {
    code: "model-registry",
    title: "Kiểm toán sổ đăng ký mô hình tuần",
    schedule: "SUN:05:40",
    priority: "medium",
    description:
      "Kiểm toán sổ đăng ký mô hình sau tuần: các bản đang phục vụ (LLM backbone, champion ML, chỉ báo kỹ thuật), thay đổi phiên bản trong tuần, tính nhất quán registry (A19).",
  },

  // ── NHÓM RESEARCH — Đầu tuần ──
  {
    code: "fair-value",
    title: "Rà soát định giá tuần",
    schedule: "MON:07:00",
    priority: "medium",
    description:
      "Đầu tuần sau đồng bộ quốc tế sáng thứ Hai: rà dải định giá hợp lý 90 phiên — các mã sát biên trên/dưới của dải, thay đổi dải so với tuần trước (A3).",
  },
];

const API = "http://localhost:3000";

async function main(): Promise<void> {
  // 1) Lấy toàn bộ agents (id + code) — qua API công khai
  const res = await fetch(`${API}/api/agents`);
  if (!res.ok) throw new Error(`GET /api/agents → HTTP ${res.status}`);
  const payload = (await res.json()) as { agents?: { id: string; code: string }[] };
  const agents = payload.agents ?? [];
  if (agents.length === 0) throw new Error("GET /api/agents trả 0 agents — kiểm tra DB.");
  const idByCode = new Map(agents.map((a) => [a.code, a.id]));
  console.log(`Agents: ${agents.length}`);

  // 2) Nhiệm vụ đã có theo (agentId, title) — chống nhân đôi khi chạy lại
  const existing = new Set<string>();
  for (const a of agents) {
    const r = await fetch(`${API}/api/agents/${a.id}/tasks`);
    if (!r.ok) continue;
    const t = (await r.json()) as { tasks?: { title: string }[] };
    for (const task of t.tasks ?? []) existing.add(`${a.id}|${task.title}`);
  }
  console.log(`Nhiệm vụ đã có sẵn: ${existing.size}`);

  // 3) Tạo từng nhiệm vụ qua API K3 (server tính nextDueAt ICT)
  let created = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const spec of TASKS) {
    const agentId = idByCode.get(spec.code);
    if (!agentId) {
      failures.push(`${spec.code}: không tìm thấy agent`);
      continue;
    }
    if (existing.has(`${agentId}|${spec.title}`)) {
      skipped++;
      console.log(`  SKIP (đã có)  ${spec.code.padEnd(22)} "${spec.title}"`);
      continue;
    }
    const r = await fetch(`${API}/api/agents/${agentId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: spec.title,
        description: spec.description,
        schedule: spec.schedule,
        priority: spec.priority,
      }),
    });
    if (r.status !== 201) {
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      failures.push(`${spec.code} "${spec.title}": HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
      console.log(`  FAIL HTTP ${r.status} ${spec.code} "${spec.title}"`);
      continue;
    }
    const body = (await r.json()) as { task?: { nextDueAt?: string; schedule?: string } };
    created++;
    console.log(
      `  TẠO  ${spec.code.padEnd(22)} ${String(body.task?.schedule ?? spec.schedule).padEnd(10)} "${spec.title}" → due ${body.task?.nextDueAt ?? "?"}`
    );
  }

  console.log(`\nKết quả: tạo mới ${created} · skip ${skipped} · thất bại ${failures.length}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ! ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("LỖI:", err);
  process.exitCode = 1;
});

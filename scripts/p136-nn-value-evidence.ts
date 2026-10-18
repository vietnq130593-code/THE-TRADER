/**
 * scripts/p136-nn-value-evidence.ts (Task 136 · F-22) — CHỈ ĐỌC DB, không ghi.
 * Thu thập bằng chứng vận hành để trả lời chủ sở hữu:
 * "Các mạng thần kinh có lợi ích/giá trị gì đối với đội agent và toàn hệ thống?"
 *
 *  A — Bandit 7 cử tri: posterior + pulls/wins (track record bầu phiếu thật)
 *  B — BanditEvent settled: độ chính xác từng cử tri sau 5 phiên
 *  C — AgentRun: sản lượng chu kỳ của các agent ML (A15-A18) + Chủ tịch
 *  D — MlModel: số thế hệ train + serving + quỹ đạo valAcc + macro-mlp
 *  E — MarketAssessment: phiếu ml-forecast trong tally + trọng số
 *  F — Signal: cổng đồng thuận trên tín hiệu thật
 *  G — AppSetting: cấu hình ML hiệu lực
 *  H — AuditLog: sự kiện ML đã ghi
 *  I — DecisionEvaluation: kết quả tín hiệu
 */
import { db } from "../src/lib/db";

type Rec = Record<string, unknown>;

const getRec = (x: unknown): Rec | null =>
  x != null && typeof x === "object" && !Array.isArray(x) ? (x as Rec) : null;
const getArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const getNum = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;
const getStr = (x: unknown): string => (typeof x === "string" ? x : "");
const pick = (s: string | null | undefined): Rec | null => {
  try {
    return getRec(s ? JSON.parse(s) : null);
  } catch {
    return null;
  }
};

function pct(x: number | null | undefined, d = 1): string {
  return x == null || !Number.isFinite(x) ? "—" : `${(100 * x).toFixed(d).replace(".", ",")}%`;
}
function ci95(a: number, b: number): string {
  const m = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) * (a + b) * (a + b + 1)));
  return `[${(100 * Math.max(0, m - 1.96 * sd)).toFixed(1)}%, ${(100 * Math.min(1, m + 1.96 * sd)).toFixed(1)}%]`;
}
const dirOf = (x: unknown): string => {
  const r = getRec(x);
  const v = getStr(r?.direction) || getStr(r?.vote) || getStr(r?.stance);
  return ["UP", "DOWN", "FLAT"].includes(v) ? v : "";
};

async function main() {
  console.log("════ A. BANDIT 7 CỬ TRI — track record thật (Beta posterior) ════");
  const arms = await db.banditArm.findMany({ orderBy: { pulls: "desc" } });
  for (const a of arms) {
    console.log(
      `  ${a.agentCode.padEnd(18)} pulls=${String(a.pulls).padStart(4)}  wins=${a.wins.toFixed(1).padStart(6)}  posterior=${pct(a.alpha / (a.alpha + a.beta))}  CI95=${ci95(a.alpha, a.beta)}  lastReward=${a.lastRewardAt?.toISOString().slice(0, 16) ?? "—"}`
    );
  }

  console.log("\n════ B. BANDIT EVENT — độ chính xác từng cử tri sau settle 5 phiên ════");
  const evs = await db.banditEvent.findMany({
    where: { settledAt: { not: null } },
    select: { agentCode: true, reward: true, direction: true, castAt: true, confidence: true },
    orderBy: { castAt: "desc" },
    take: 3000,
  });
  const byAgent = new Map<string, { n: number; r: number; brier: number; nb: number; last: Date | null }>();
  for (const e of evs) {
    const s = byAgent.get(e.agentCode) ?? { n: 0, r: 0, brier: 0, nb: 0, last: null };
    s.n++;
    s.r += e.reward ?? 0;
    const conf = getNum(e.confidence);
    if (conf != null) {
      s.brier += (e.reward ?? 0) > 0 ? 1 - conf : conf;
      s.nb++;
    }
    if (!s.last || e.castAt > s.last) s.last = e.castAt;
    byAgent.set(e.agentCode, s);
  }
  for (const [code, s] of [...byAgent.entries()].sort((x, y) => y[1].n - x[1].n)) {
    console.log(
      `  ${code.padEnd(18)} settled=${String(s.n).padStart(4)}  acc=${pct(s.r / s.n)}  avgConfWrong=${s.nb ? (s.brier / s.nb).toFixed(2) : "—"}  last=${s.last?.toISOString().slice(0, 10) ?? "—"}`
    );
  }
  const mlEvs = evs.filter((e) => e.agentCode === "ml-forecast").slice(0, 12);
  console.log(
    "  ml-forecast 12 phiếu gần nhất:",
    mlEvs.map((e) => `${e.direction}${e.reward == null ? "?" : e.reward > 0 ? "✓" : "✗"}`).join(" ")
  );

  console.log("\n════ C. SẢN LƯỢNG VẬN HÀNH — AgentRun theo agent ML + Chủ tịch ════");
  const agents = await db.agent.findMany({ select: { id: true, code: true, name: true } });
  const focusCodes = [
    "ml-forecast",
    "rl-policy",
    "dl-trainer",
    "rl-trainer",
    "model-registry",
    "portfolio-strategist",
    "risk-manager",
    "market-analyst",
  ];
  for (const code of focusCodes) {
    const ag = agents.find((a) => a.code === code);
    if (!ag) {
      console.log(`  ${code}: (không có trong roster)`);
      continue;
    }
    const [total, done] = await Promise.all([
      db.agentRun.count({ where: { agentId: ag.id } }),
      db.agentRun.count({ where: { agentId: ag.id, taskStatus: "COMPLETED" } }),
    ]);
    const last = await db.agentRun.findFirst({
      where: { agentId: ag.id, taskStatus: "COMPLETED" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, output: true },
    });
    console.log(
      `  ${code.padEnd(20)} (${ag.name}) runs=${String(total).padStart(4)} hoàn tất=${done}  lần cuối=${last?.startedAt.toISOString().slice(0, 16) ?? "—"}`
    );
    if ((code === "rl-policy" || code === "ml-forecast") && last?.output) {
      console.log(`    → output cuối: ${last.output.slice(0, 360)}`);
    }
  }

  console.log("\n════ D. MÔ HÌNH ML — phiên bản đã train + serving ════");
  const models = await db.mlModel.findMany({
    select: { kind: true, version: true, status: true, metrics: true, trainedAt: true, meta: true },
    orderBy: { version: "desc" },
  });
  const byKind = new Map<string, { n: number; serving?: (typeof models)[number] }>();
  for (const m of models) {
    const s = byKind.get(m.kind) ?? { n: 0 };
    s.n++;
    if (m.status === "serving") s.serving = m;
    byKind.set(m.kind, s);
  }
  for (const [kind, s] of byKind) {
    const met = pick(s.serving?.metrics) ?? {};
    const meta = pick(s.serving?.meta) ?? {};
    console.log(
      `  ${kind.padEnd(10)} đã train ${s.n} phiên bản` +
        (s.serving
          ? ` · SERVING v${s.serving.version}: valAcc=${pct(getNum(met.valAcc))} arch=${getStr(met.archString) || getStr(meta.archString) || "?"} trained=${s.serving.trainedAt.toISOString().slice(0, 16)}`
          : " · (không có serving)")
    );
  }
  const mlpAll = models.filter((m) => m.kind === "dl-mlp").sort((a, b) => a.version - b.version);
  const accOf = (m: (typeof models)[number]): number => getNum(pick(m.metrics)?.valAcc) ?? 0;
  if (mlpAll.length > 1) {
    const first = accOf(mlpAll[0]);
    const last = accOf(mlpAll[mlpAll.length - 1]);
    console.log(
      `  dl-mlp quỹ đạo valAcc: v${mlpAll[0].version}=${pct(first)} → serving v${mlpAll[mlpAll.length - 1].version}=${pct(last)} (tăng ${(100 * (last - first)).toFixed(1).replace(".", ",")} điểm %)`
    );
  }
  const macroModels = await db.mlModel.findMany({
    where: { kind: "macro-mlp" },
    orderBy: { version: "desc" },
    select: { version: true, status: true, metrics: true, trainedAt: true },
    take: 8,
  });
  for (const m of macroModels) {
    const met = pick(m.metrics) ?? {};
    console.log(
      `    macro-mlp v${m.version} [${m.status}] ${m.trainedAt.toISOString().slice(0, 10)}: asset=${getStr(met.assetSymbol) || "?"} valAcc=${pct(getNum(met.valAcc))} samples=${getNum(met.samples) ?? "—"}`
    );
  }
  const sweeps = await db.sweepRun.count();
  const lastSweep = await db.sweepRun.findFirst({ orderBy: { startedAt: "desc" } });
  console.log(`  SweepRun: ${sweeps} đợt · gần nhất ${lastSweep?.startedAt.toISOString().slice(0, 16) ?? "—"}`);

  console.log("\n════ E. MARKET ASSESSMENT — phiếu ML trong bản tổng hợp ════");
  const [nAss, lastAss] = await Promise.all([
    db.marketAssessment.count(),
    db.marketAssessment.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);
  console.log(`  Tổng assessment: ${nAss} · bản cuối ${lastAss?.createdAt.toISOString().slice(0, 16)}`);
  if (lastAss) {
    const d = pick(lastAss.detail);
    console.log(
      `  Bản cuối: pUp=${pct(lastAss.pUp)} pFlat=${pct(lastAss.pFlat)} pDown=${pct(lastAss.pDown)} · dir=${lastAss.marketDirection} · conf=${(lastAss.confidence ?? 0).toFixed(2)} · evidence=${lastAss.evidenceCount}`
    );
    const cons = getRec(d?.consensus);
    console.log(`  consensus: gate=${getStr(cons?.gate)} ratio=${getNum(cons?.ratio)?.toFixed(3) ?? "?"}`);
    const tally = getArr(cons?.tally);
    for (const t of tally) {
      const r = getRec(t);
      console.log(
        `    ${getStr(r?.code).padEnd(16)} dir=${getStr(r?.direction).padEnd(5)} w=${getNum(r?.weight)?.toFixed(4) ?? "?"} model=${getStr(r?.model)}`
      );
    }
    const mlDrv = getArr(d?.drivers).filter(
      (x) => getStr(getRec(x)?.source).startsWith("ml-forecast")
    );
    console.log(
      `  drivers nguồn ml-forecast: ${mlDrv.length} — ${mlDrv
        .map((x) => {
          const r = getRec(x);
          return `${getStr(r?.source)}:${getStr(r?.direction)}:LR${getNum(r?.likelihoodRatio)?.toFixed(2) ?? "?"}`;
        })
        .join(" | ")}`
    );
  }
  // 20 bản gần nhất: ml-forecast có mặt + đi cùng/khác đa số + trọng số
  const ass20 = await db.marketAssessment.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  let withMl = 0;
  let withF5 = 0;
  let mlMajority = 0;
  let mlCount = 0;
  let sumMlW = 0;
  let nMlW = 0;
  let sumOtherW = 0;
  let nOtherW = 0;
  const mlVoteDist: Record<string, number> = {};
  const gateDist: Record<string, number> = {};
  for (const a of ass20) {
    const d = pick(a.detail);
    if (getRec(d?.forecast5d) || d?.forecast5d != null) withF5++;
    const cons = getRec(d?.consensus);
    const gate = getStr(cons?.gate);
    if (gate) gateDist[gate] = (gateDist[gate] ?? 0) + 1;
    const votes = getArr(cons?.tally)
      .map((x) => getRec(x))
      .filter((r): r is Rec => r != null)
      .map((r) => ({ code: getStr(r.code), dir: dirOf(r), w: getNum(r.weight) }))
      .filter((v) => v.dir !== "");
    const ml = votes.find((v) => v.code === "ml-forecast");
    for (const v of votes) {
      if (v.code === "ml-forecast") {
        sumMlW += v.w ?? 0;
        nMlW++;
      } else {
        sumOtherW += v.w ?? 0;
        nOtherW++;
      }
    }
    if (ml) {
      withMl++;
      mlCount++;
      mlVoteDist[ml.dir] = (mlVoteDist[ml.dir] ?? 0) + 1;
      const cnt: Record<string, number> = {};
      for (const v of votes) cnt[v.dir] = (cnt[v.dir] ?? 0) + 1;
      const majDir = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (majDir && ml.dir === majDir) mlMajority++;
    }
  }
  console.log(
    `  20 bản gần nhất: phiếu ml-forecast ${withMl}/20 · forecast5d ${withF5}/20 · ml cùng đa số ${mlMajority}/${mlCount || 0} · phiếu ml: ${JSON.stringify(mlVoteDist)} · gate: ${JSON.stringify(gateDist)}`
  );
  console.log(
    `  trọng số phiếu: ml-forecast TB=${(sumMlW / (nMlW || 1)).toFixed(3)} vs khác TB=${(sumOtherW / (nOtherW || 1)).toFixed(3)}`
  );

  console.log("\n════ F. SIGNAL — cổng đồng thuận + quyết định thật ════");
  const sigs = await db.signal.findMany({
    orderBy: { createdAt: "desc" },
    take: 12,
    select: {
      direction: true,
      status: true,
      createdAt: true,
      instrumentId: true,
      consensusGate: true,
      consensusRatio: true,
    },
  });
  for (const s of sigs) {
    console.log(
      `  ${s.createdAt.toISOString().slice(0, 16)} ${s.instrumentId.padEnd(10)} ${s.direction.padEnd(5)} ${s.status.padEnd(10)} gate=${s.consensusGate ?? "?"} ratio=${s.consensusRatio?.toFixed(2) ?? "?"}`
    );
  }
  const [nSig, nEval] = await Promise.all([db.signal.count(), db.decisionEvaluation.count()]);
  console.log(`  Tổng Signal: ${nSig} · DecisionEvaluation: ${nEval}`);

  console.log("\n════ G. APPSETTING — cấu hình ML đang hiệu lực ════");
  const keys = ["ml-ensemble-weights", "ml-gate", "ml-gru", "ml-sweep", "ml-tuning", "k-run"];
  for (const k of keys) {
    const s = await db.appSetting.findUnique({ where: { key: k } });
    console.log(`  ${k}: ${s ? String(s.value).slice(0, 300) : "(chưa có)"}`);
  }

  console.log("\n════ H. AUDIT — sự kiện ML đã ghi ════");
  const mlActions = await db.auditLog.groupBy({
    by: ["action"],
    _count: true,
    where: { action: { startsWith: "ML_" } },
  });
  for (const g of mlActions) console.log(`  ${g.action.padEnd(28)} ×${g._count}`);

  console.log("\n════ I. DECISION EVALUATION — tín hiệu từ hệ thống ra sao ════");
  const evals = await db.decisionEvaluation.findMany({
    orderBy: { decidedAt: "desc" },
    take: 60,
    select: { verdict: true, markPnlPct: true },
  });
  const vcnt: Record<string, number> = {};
  for (const e of evals) vcnt[e.verdict] = (vcnt[e.verdict] ?? 0) + 1;
  console.log(
    `  60 tín hiệu gần nhất: ${JSON.stringify(vcnt)} · trung bình markPnlPct=${(evals.reduce((s, e) => s + (e.markPnlPct ?? 0), 0) / (evals.length || 1)).toFixed(2)}%`
  );
}

main()
  .catch((e: unknown) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => {
    void db.$disconnect();
  });

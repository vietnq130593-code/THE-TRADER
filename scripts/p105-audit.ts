/**
 * AUDIT #105 — A1+A2: rà soát AgentTask K3 + điều tra phạm vi/hành vi đầu tư agents
 * Read-only, in against Postgres via Prisma.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const fmtTime = (d: Date | null) =>
  d ? new Date(d).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : 'null'

async function main() {
  console.log('========== A1. AGENT TASKS (K3) ==========')
  const tasks = await db.agentTask.findMany({
    orderBy: [{ agentId: 'asc' }, { createdAt: 'asc' }],
    include: { agent: { select: { code: true, name: true } } },
  })
  console.log(`Tổng nhiệm vụ: ${tasks.length}`)
  for (const t of tasks) {
    console.log(
      [
        `[${t.id.slice(0, 8)}]`,
        `${t.agent.code}`.padEnd(22),
        `paused=${t.paused ? 'YES' : 'no '}`,
        `failStreak=${t.failStreak}`,
        `runCount=${t.runCount}`,
        `sched="${t.schedule}"`,
        `next=${fmtTime(t.nextDueAt)}`,
        `last=${fmtTime(t.lastRunAt)}`,
        `title="${t.title}"`,
      ].join(' | '),
    )
  }

  console.log('\n========== A2a. AGENT ROSTER + TRẠNG THÁI ==========')
  const agents = await db.agent.findMany({ orderBy: { code: 'asc' } })
  for (const a of agents) {
    console.log(
      `${(a.code || '').padEnd(22)} status=${(a.status || '').padEnd(9)} health=${a.healthScore ?? '-'} group=${a.group}`,
    )
  }

  console.log('\n========== A2b. AGENT RUN 7 NGÀY QUA (theo loại) ==========')
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  const runs = await db.agentRun.findMany({
    where: { startedAt: { gte: since } },
    orderBy: { startedAt: 'desc' },
    take: 2000,
  })
  const byStatus: Record<string, number> = {}
  for (const r of runs) byStatus[r.taskStatus] = (byStatus[r.taskStatus] || 0) + 1
  console.log(`Tổng run 7 ngày: ${runs.length}`, JSON.stringify(byStatus))
  const byAgent: Record<string, number> = {}
  for (const r of runs) byAgent[r.agentId] = (byAgent[r.agentId] || 0) + 1
  const agentName = new Map(agents.map((a) => [a.id, a.code || a.name]))
  const sorted = Object.entries(byAgent).sort((a, b) => b[1] - a[1])
  console.log('Top run theo agent:', sorted.slice(0, 12).map(([id, n]) => `${agentName.get(id)}=${n}`).join(', '))
  const withTask = runs.filter((r) => r.taskId).length
  console.log(`Run có taskId (K3): ${withTask}/${runs.length}`)

  console.log('\n========== A2c. TÍN HIỆU (Signal) 14 NGÀY ==========')
  const signals = await db.signal.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 14 * 24 * 3600 * 1000) } },
    orderBy: { createdAt: 'desc' },
    take: 60,
    include: { instrument: { select: { symbol: true } }, agent: { select: { code: true } } },
  })
  console.log(`Tín hiệu 14 ngày: ${signals.length}`)
  const byDir: Record<string, number> = {}
  for (const s of signals) byDir[s.direction] = (byDir[s.direction] || 0) + 1
  console.log('Theo hướng:', JSON.stringify(byDir))
  for (const s of signals.slice(0, 15)) {
    console.log(
      `- ${fmtTime(s.createdAt)} ${s.agent?.code || '?'} ${s.instrument?.symbol || '?'} ${s.direction} score=${s.score} conf=${s.confidence} acted=${s.actedAt ? 'YES' : 'no'}`,
    )
  }

  console.log('\n========== A2d. LỆNH + GIAO DỊCH 14 NGÀY ==========')
  const orders = await db.order.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
    include: { instrument: { select: { symbol: true } }, brokerAccount: { select: { accountNumber: true, accountType: true } } },
  })
  console.log(`Tổng lệnh (mới nhất trước): ${orders.length}`)
  for (const o of orders.slice(0, 15)) {
    console.log(
      `- ${fmtTime(o.createdAt)} ${o.brokerAccount?.accountType}:${o.brokerAccount?.accountNumber} ${o.instrument?.symbol} ${o.side} qty=${o.quantity} px=${o.price} status=${o.status} note="${(o.note || '').slice(0, 90)}"`,
    )
  }
  const trades = await db.trade.findMany({ orderBy: { executedAt: 'desc' }, take: 12, include: { instrument: { select: { symbol: true } } } })
  console.log(`\nGiao dịch gần nhất: ${trades.length}`)
  for (const t of trades) {
    console.log(`- ${fmtTime(t.executedAt)} ${t.instrument?.symbol} qty=${t.quantity} px=${t.price}`)
  }

  console.log('\n========== A2e. VỊ THẾ HIỆN TẠI ==========')
  const positions = await db.position.findMany({
    include: { instrument: { select: { symbol: true } }, brokerAccount: { select: { accountNumber: true, accountType: true } } },
  })
  for (const p of positions) {
    console.log(
      `- ${p.brokerAccount?.accountType}:${p.brokerAccount?.accountNumber} ${p.instrument?.symbol} qty=${p.quantity} avg=${p.avgPrice} opened=${fmtTime(p.openedAt)}`,
    )
  }

  console.log('\n========== A2f. TÀI KHOẢN ==========')
  const accounts = await db.brokerAccount.findMany()
  for (const a of accounts) {
    console.log(`- ${a.accountType}:${a.accountNumber} broker=${a.broker} cash=${a.cashBalance} equity=${a.equity} status=${a.status}`)
  }

  console.log('\n========== A2g. APP SETTINGS (đầu tư/k sandbox) ==========')
  const settings = await db.appSetting.findMany()
  for (const s of settings) {
    if (/k-|sandbox|trading|live|vndirect|ml-|k4/i.test(s.key)) {
      console.log(`- ${s.key} = ${(s.value || '').slice(0, 220)}`)
    }
  }

  console.log('\n========== A2h. QUAN HỆ THỊ TRƯỜNG (RelationInsight mới nhất) ==========')
  const insight = await db.relationInsight.findFirst({ orderBy: { generatedAt: 'desc' } })
  if (insight) {
    console.log(`generated=${fmtTime(insight.generatedAt)} model=${insight.model} relations=${insight.relationsCount}`)
    console.log('narrative:', insight.narrative.slice(0, 1500))
  }

  console.log('\n========== A2i. THẢO LUẬN AGENT (AgentMessage 3 ngày, 40 mới nhất) ==========')
  const msgs = await db.agentMessage.findMany({
    orderBy: { createdAt: 'desc' },
    take: 40,
    include: { fromAgent: { select: { code: true } } },
  })
  for (const m of msgs.reverse()) {
    console.log(`\n--- ${fmtTime(m.createdAt)} [${m.fromAgent?.code || m.fromAgentId?.slice(0, 8) || 'system'}] sentiment=${m.sentiment || '-'} ---`)
    const body = (m.content || '').slice(0, 700)
    console.log(body)
  }

  console.log('\n========== A2j. RISK ALERTS 7 NGÀY ==========')
  const alerts = await db.riskAlert.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  console.log(`Cảnh báo 7 ngày: ${alerts.length}`)
  for (const r of alerts) {
    console.log(`- ${fmtTime(r.createdAt)} ${r.code} sev=${r.severity} msg="${(r.message || '').slice(0, 120)}"`)
  }
}

main()
  .catch((e) => {
    console.error('FAIL', e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())

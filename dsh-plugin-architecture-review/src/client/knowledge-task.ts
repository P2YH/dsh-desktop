/** Run Architecture Review knowledge tasks through the public DSH Session service. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

export type KnowledgeSessionId = Awaited<ReturnType<Context['sessions']['create']>>

export type KnowledgeTask =
  | { readonly kind: 'maintain' }
  | { readonly kind: 'query'; readonly question: string }
  | { readonly kind: 'verify'; readonly reviewId: string }
  | { readonly kind: 'experts' }
  | { readonly kind: 'expert'; readonly expertId: string; readonly expertName: string; readonly question: string }
  | { readonly kind: 'review'; readonly reviewId: string; readonly expertIds: readonly string[]; readonly runId?: string }

export function knowledgeTaskPrompt(task: KnowledgeTask): string {
  const instruction = task.kind === 'maintain'
    ? '维护当前架构评审工作区的资料与知识：检查新资料及现有 Wiki，逐份核对原件，更新相关页面、索引和日志，并报告矛盾与待补资料。'
    : task.kind === 'query'
      ? `查询当前架构评审工作区的资料与知识，给出可回溯到原件的答案。问题：${task.question.trim()}`
      : task.kind === 'verify'
        ? `核对架构评审 ${task.reviewId} 的资料和候选问题：检查当前版本原件、所选规范及 Wiki，对每条判断给出准确出处和无法核实之处。不要直接修改 Finding 状态或决策。`
        : task.kind === 'review'
          ? `对架构评审 ${task.reviewId} 开展多专家协作核对（运行 ${task.runId ?? '未登记'}）。仅由以下已选专家参与：${task.expertIds.join('、')}。不得邀请未选专家。先读取 review.md、sources.md、当前版本资料、适用规范以及 wiki/synthesis/architecture-review-experts.json，核实这些 ID 对应的角色及职责。PDF 的自动文字稿路径列于 sources.md，须按页码回溯 PDF 原件；文字稿不覆盖图表、签章和排版。必须对每位已选专家分别调用 DSH 的 subagent 工具（spawn，run_in_background: false）；每次调用的 prompt 第一行必须是 ARCH_REVIEW_EXPERT_ID=<该专家ID>，不得在该次调用的参数中出现其他专家 ID。每位专家只分析自己的专业范围，检查资料原件的证据、反证、分歧和无法核实之处。要求每位子智能体最终以 JSON 代码块回答：{"issues":[{"title":"问题标题","opinion":"原文结论","evidence":["原件路径和具体位置"],"counterEvidence":[],"limitations":[]}]}。等待实际工具结果再汇总；失败明确标出，不得伪造结论。不可读取的原件注明限制。不要修改 findings.json、candidates.json、决策或报告，最终裁决由人完成。`
          : task.kind === 'experts'
          ? '依据当前工作区 Wiki 生成或更新评审专家智能体分工：核对适用标准，维护 wiki/synthesis/architecture-review-experts.md 和 wiki/synthesis/architecture-review-experts.json、索引及日志。明确专家能力、职责、出处与边界，验证 JSON 格式。'
          : `以专家目录中 ${task.expertId} 的辅助核对职责，查阅 Wiki 与相关原始资料，回答：${task.question.trim()}。逐项说明适用范围、依据、缺口和无法核实之处，不作最终评审决定。`
  return `/architecture-review-knowledge\n${instruction}`
}

export async function launchKnowledgeTask(ctx: Context, root: string, task: KnowledgeTask, existingSessionId?: KnowledgeSessionId): Promise<KnowledgeSessionId> {
  const sessionId = existingSessionId ?? await ctx.sessions.create({ cwd: root })
  const session = ctx.sessions.binding(sessionId)?.session
  if (session === undefined) throw new Error('created session is unavailable')
  const result = await session.prompt([{ type: 'text', text: knowledgeTaskPrompt(task) }], 'queue')
  if (!result.ok) throw new Error(result.error.message)
  return sessionId
}

export interface KnowledgeTurn {
  readonly turn: number
  readonly question: string
  readonly answer: string
  readonly outcome?: string
  readonly failure?: string
  readonly delegations: number
}

export interface ExpertSessionProgress {
  readonly expertId: string
  readonly status: 'waiting' | 'reviewing' | 'completed' | 'failed'
  readonly conclusion: string
  readonly error?: string
}

/** A call only counts for the expert named in its own subagent prompt, and completion requires its tool result. */
export function expertSessionProgress(entries: readonly SessionEventLikeEntry[], expertIds: readonly string[]): {
  readonly terminal: boolean
  readonly experts: readonly ExpertSessionProgress[]
} {
  const calls = new Map<string, string>()
  const states = new Map<string, ExpertSessionProgress>()
  let terminal = false
  for (const { event } of entries) {
    if (event.type === 'tool/call' && event.data.name === 'subagent') {
      let args: unknown
      try { args = JSON.parse(event.data.arguments) } catch { continue }
      const prompt = typeof args === 'object' && args !== null && 'prompt' in args && typeof args.prompt === 'string' ? args.prompt : ''
      const id = /^ARCH_REVIEW_EXPERT_ID=([a-z][a-z0-9-]{1,49})\s*$/mu.exec(prompt)?.[1]
      if (id !== undefined && expertIds.includes(id)) {
        calls.set(event.data.callId, id)
        states.set(id, { expertId: id, status: 'reviewing', conclusion: '' })
      }
    } else if (event.type === 'tool/result') {
      const id = calls.get(event.data.message.source.callId)
      if (id === undefined) continue
      const blocks = event.data.message.content as readonly { type: string; content?: unknown; isError?: boolean }[]
      const conclusion = blocks.map(block => block.type === 'tool-result' ? textBlocks(block.content) : '').join('\n').trim()
      const failed = blocks.some(block => block.type === 'tool-result' && block.isError) || event.data.error !== undefined
      states.set(id, { expertId: id, status: failed ? 'failed' : 'completed', conclusion,
        ...(failed ? { error: event.data.error?.code ?? (conclusion.slice(0, 500) || '委派失败') } : {}) })
    } else if (event.type === 'turn/end') {
      terminal = true
    }
  }
  return { terminal, experts: expertIds.map(expertId => {
    const state = states.get(expertId) ?? { expertId, status: 'waiting' as const, conclusion: '' }
    return terminal && state.status !== 'completed' && state.status !== 'failed'
      ? { ...state, status: 'failed', error: state.status === 'waiting' ? '未发起专家委派' : '专家委派未返回结果' }
      : state
  }) }
}

/** Assemble only the user-facing questions and answers from the staged session window. */
export function knowledgeTranscript(entries: readonly SessionEventLikeEntry[]): readonly KnowledgeTurn[] {
  const turns = new Map<number, {
    question: string
    answers: string[]
    live: Map<number, Map<number, string>>
    outcome?: string
    failure?: string
    delegations: Set<string>
  }>()
  let currentTurn: number | undefined
  for (const { event } of entries) {
    if (event.type === 'turn/start') {
      const turn = event.data.turn as number
      currentTurn = turn
      turns.set(turn, { question: '', answers: [], live: new Map(), delegations: new Set() })
    } else if (event.type === 'user/message' && event.data.source.kind === 'user' && currentTurn !== undefined) {
      const turn = turns.get(currentTurn)
      if (turn !== undefined && turn.question === '') {
        turn.question = displayQuestion(textBlocks(event.data.content))
      }
    } else if (event.type === 'assistant/message') {
      const answer = textBlocks(event.data.message.content).trim()
      if (answer !== '') turns.get(event.data.turn)?.answers.push(answer)
    } else if (event.type === 'tool/call' && event.data.name === 'subagent') {
      turns.get(event.data.turn)?.delegations.add(event.data.callId)
    } else if (event.type === 'assistant/live-chunk') {
      const turn = turns.get(event.data.turn)
      const chunk = event.data.chunk
      if (turn === undefined || (chunk.type !== 'text-delta' && chunk.type !== 'block-end')) continue
      const blocks = turn.live.get(event.data.step) ?? new Map<number, string>()
      if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text)
      else if (chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text)
      turn.live.set(event.data.step, blocks)
    } else if (event.type === 'turn/end') {
      const turn = turns.get(event.data.turn)
      if (turn !== undefined) {
        turn.outcome = event.data.reason.kind
        if (event.data.reason.kind === 'error') turn.failure = event.data.reason.error.message
      }
    }
  }
  return [...turns].map(([turn, value]) => {
    const live = [...value.live.values()].flatMap(blocks => [...blocks].sort(([a], [b]) => a - b).map(([, text]) => text)).join('\n').trim()
    return {
      turn,
      question: value.question,
      delegations: value.delegations.size,
      answer: [...value.answers, ...(live === '' ? [] : [live])].join('\n\n'),
      ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
      ...(value.failure === undefined ? {} : { failure: value.failure }),
    }
  })
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter((block: unknown): block is { type: 'text'; text: string } =>
    typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string',
  ).map(block => block.text).join('\n')
}

function displayQuestion(prompt: string): string {
  if (!prompt.startsWith('/architecture-review-knowledge\n')) return prompt
  const instruction = prompt.slice('/architecture-review-knowledge\n'.length)
  if (instruction.startsWith('查询当前架构评审工作区')) return instruction.split('问题：').slice(1).join('问题：') || instruction
  if (instruction.startsWith('维护当前架构评审工作区')) return '维护知识'
  if (instruction.startsWith('依据当前工作区 Wiki 生成')) return '更新评审专家智能体'
  if (instruction.startsWith('对架构评审')) return `${instruction.split(' 开展')[0]} · 专家协作核对`
  if (instruction.startsWith('以专家目录中')) return instruction.split('，回答：')[1]?.split('。逐项说明')[0] ?? '专家核对'
  if (instruction.startsWith('核对架构评审')) return instruction.split('：')[0] ?? '资料核对'
  return instruction
}

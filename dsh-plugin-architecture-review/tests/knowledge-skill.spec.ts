import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import { architectureReviewSkillProvider, registerArchitectureReviewSkill } from '../src/knowledge-skill.ts'
import { expertSessionProgress, knowledgeTaskPrompt, knowledgeTranscript, launchKnowledgeTask } from '../src/client/knowledge-task.ts'

describe('Architecture Review knowledge skill', () => {
  it('registers a packaged skill that can be loaded from the Profile', async () => {
    const registerProvider = vi.fn()
    registerArchitectureReviewSkill({ skills: { registerProvider } } as unknown as Context)
    expect(registerProvider).toHaveBeenCalledOnce()
    const provider = registerProvider.mock.calls[0]![0]() as ReturnType<typeof architectureReviewSkillProvider>
    const candidates = await provider.list({}) as readonly SkillCandidate[]
    expect(candidates[0]?.name).toBe('architecture-review-knowledge')
    const definition = await provider.get(candidates[0]!, {})
    expect(definition?.content).toContain('The wiki helps locate and connect facts; original files remain the authority.')
    expect(definition?.content).toContain('## Review evidence')
    expect(definition?.content).toContain('## Review expert agents')
    expect(definition?.content).not.toMatch(/^---/u)
  })

  it('starts a workspace-scoped session with explicit skill invocation for each task', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const create = vi.fn().mockResolvedValue('session-1')
    const open = vi.fn()
    const ctx = { sessions: { create, binding: () => ({ session: { prompt } }), open } } as unknown as Context
    const sessionId = await launchKnowledgeTask(ctx, 'C:\\review-workspace', { kind: 'verify', reviewId: 'AR-001' })
    expect(sessionId).toBe('session-1')
    expect(create).toHaveBeenCalledWith({ cwd: 'C:\\review-workspace' })
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: expect.stringMatching(/^\/architecture-review-knowledge\n.*AR-001/su) }], 'queue')
    expect(open).not.toHaveBeenCalled()
    expect(knowledgeTaskPrompt({ kind: 'maintain' })).toContain('维护当前架构评审工作区')
    expect(knowledgeTaskPrompt({ kind: 'query', question: ' 数据一致性？ ' })).toContain('问题：数据一致性？')
    expect(knowledgeTaskPrompt({ kind: 'experts' })).toContain('architecture-review-experts.json')
    expect(knowledgeTaskPrompt({ kind: 'expert', expertId: 'data-architecture', expertName: '数据架构专家', question: ' 主数据来源？ ' })).toContain('回答：主数据来源？')
    const reviewPrompt = knowledgeTaskPrompt({ kind: 'review', reviewId: 'AR-003', expertIds: ['data-architecture', 'security-architecture'] })
    expect(reviewPrompt).toContain('subagent 工具（spawn，run_in_background: false）')
    expect(reviewPrompt).toContain('仅由以下已选专家参与：data-architecture、security-architecture')
    expect(reviewPrompt).toContain('不得邀请未选专家')
  })

  it('keeps the workbench visible when the prompt is not accepted', async () => {
    const open = vi.fn()
    const ctx = {
      sessions: { create: async () => 'session-2', binding: () => ({ session: { prompt: async () => ({ ok: false, error: { message: 'unavailable' } }) } }), open },
    } as unknown as Context
    await expect(launchKnowledgeTask(ctx, 'C:\\review-workspace', { kind: 'maintain' })).rejects.toThrow('unavailable')
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps follow-up questions in the same knowledge session', async () => {
    const create = vi.fn()
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const open = vi.fn()
    const ctx = { sessions: { create, binding: () => ({ session: { prompt } }), open } } as unknown as Context
    await launchKnowledgeTask(ctx, 'C:\\review-workspace', { kind: 'query', question: '后续问题？' }, 'session-1' as never)
    expect(create).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: expect.stringContaining('问题：后续问题？') }], 'queue')
    expect(open).not.toHaveBeenCalled()
  })

  it('projects streamed answers, settled answers and failures for the workbench', () => {
    const entries = [
      { type: 'event', event: { type: 'turn/start', data: { turn: 1 } } },
      { type: 'event', event: { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: knowledgeTaskPrompt({ kind: 'query', question: '依据是什么？' }) }] } } },
      { type: 'event', event: { type: 'tool/call', data: { turn: 1, callId: 'expert-1', name: 'subagent' } } },
      { type: 'event', event: { type: 'tool/call', data: { turn: 1, callId: 'read-1', name: 'read_file' } } },
      { type: 'transient', event: { type: 'assistant/live-chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '正在核对' } } } },
    ] as unknown as SessionEventLikeEntry[]
    expect(knowledgeTranscript(entries)).toMatchObject([{ question: '依据是什么？', answer: '正在核对', delegations: 1 }])
    entries.splice(4, 1, { type: 'event', event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '原件第 3 页。' }] } } } } as unknown as SessionEventLikeEntry)
    entries.push({ type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } } as unknown as SessionEventLikeEntry)
    expect(knowledgeTranscript(entries)).toMatchObject([{ answer: '原件第 3 页。', outcome: 'completed' }])
    entries.push({ type: 'event', event: { type: 'turn/start', data: { turn: 2 } } } as unknown as SessionEventLikeEntry)
    entries.push({ type: 'event', event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: '网络不可用' } } } } } as unknown as SessionEventLikeEntry)
    expect(knowledgeTranscript(entries)[1]).toMatchObject({ outcome: 'error', failure: '网络不可用' })
  })

  it('counts expert completion from matching tool results, not delegation calls', () => {
    const entries = [{ event: { type: 'tool/call', data: { name: 'subagent', callId: 'call-1', arguments: JSON.stringify({ prompt: 'ARCH_REVIEW_EXPERT_ID=expert-1\n核对设计' }) } } }] as unknown as SessionEventLikeEntry[]
    expect(expertSessionProgress(entries, ['expert-1', 'expert-2']).experts).toMatchObject([
      { status: 'reviewing' }, { status: 'waiting' },
    ])
    entries.push({ event: { type: 'tool/result', data: { message: { source: { callId: 'call-1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '{"issues":[]}' }] }] } } } } as unknown as SessionEventLikeEntry)
    expect(expertSessionProgress(entries, ['expert-1', 'expert-2']).experts).toMatchObject([
      { status: 'completed', conclusion: '{"issues":[]}' }, { status: 'waiting' },
    ])
    entries.push({ event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } } as unknown as SessionEventLikeEntry)
    expect(expertSessionProgress(entries, ['expert-1', 'expert-2']).experts).toMatchObject([
      { status: 'completed' }, { status: 'failed', error: '未发起专家委派' },
    ])
  })
})

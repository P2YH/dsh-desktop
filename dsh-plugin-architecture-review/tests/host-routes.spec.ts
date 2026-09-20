import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARCHITECTURE_REVIEW_EXPORT_PATH,
  ARCHITECTURE_REVIEW_ARTIFACTS_PATH,
  ARCHITECTURE_REVIEW_EXPERTS_PATH,
  ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH,
  ARCHITECTURE_REVIEW_PAGES_PATH,
  ARCHITECTURE_REVIEW_REVIEWS_PATH,
  ARCHITECTURE_REVIEW_WORKSPACE_PATH,
  apply,
} from '../src/index.ts'

interface TestRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function startHost(rejection: { value: 401 | 403 | undefined }): Promise<{ base: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-architecture-review-routes-'))
  roots.push(root)
  const routes: TestRoute[] = []
  const context = {
    skills: { registerProvider: () => () => {} },
    connection: {
      requestRejection: () => rejection.value,
    },
    webServer: {
      register(route: TestRoute) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
    effect(install: () => unknown) {
      install()
    },
  } as unknown as Context
  apply(context, { workspace: root })

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const exact = routes.find(route => route.kind === 'exact' && route.path === path)
    const prefix = routes
      .filter(route => route.kind === 'prefix' && (path === route.path || path.startsWith(`${route.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
    const route = exact ?? prefix
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void Promise.resolve(route.handler(req, res)).catch((cause: unknown) => {
      res.statusCode = 500
      res.end(cause instanceof Error ? cause.message : String(cause))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test HTTP server did not bind')
  return { base: `http://127.0.0.1:${String(address.port)}`, root }
}

describe('Architecture Review Host routes', () => {
  it('deletes a review through the authenticated detail route', async () => {
    const rejection: { value: 401 | 403 | undefined } = { value: undefined }
    const { base, root } = await startHost(rejection)
    await fetch(`${base}${ARCHITECTURE_REVIEW_WORKSPACE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root }),
    })
    const created = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '删除测试' }),
    })
    const { reviewId } = await created.json() as { reviewId: string }
    const path = `${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${reviewId}`
    expect((await fetch(path, { method: 'PATCH' })).headers.get('allow')).toBe('GET, DELETE')
    rejection.value = 403
    expect((await fetch(path, { method: 'DELETE' })).status).toBe(403)
    rejection.value = undefined
    const deleted = await fetch(path, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toEqual({ reviewId })
    expect((await fetch(path)).status).toBe(404)
    expect((await fetch(path, { method: 'DELETE' })).status).toBe(404)
  })

  it('reads a Wiki-derived expert catalog and handles missing or malformed catalogs', async () => {
    const rejection: { value: 401 | 403 | undefined } = { value: undefined }
    const { base, root } = await startHost(rejection)
    await fetch(`${base}${ARCHITECTURE_REVIEW_WORKSPACE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root }),
    })
    const missing = await fetch(`${base}${ARCHITECTURE_REVIEW_EXPERTS_PATH}`)
    expect(missing.status).toBe(200)
    await expect(missing.json()).resolves.toEqual({ catalog: null })
    const catalogPath = join(root, 'wiki/synthesis/architecture-review-experts.json')
    const catalog = {
      version: 1, generatedAt: '2026-09-17T00:00:00.000Z', basis: ['wiki/standards/example.md'], limitations: '原件未提供',
      experts: [{ id: 'business-architecture', name: '业务专家', focus: '业务', role: '核对业务架构',
        capabilities: ['比对业务流程'], responsibilities: ['记录候选问题'], baseline: '序号 5–21',
        sources: [{ path: 'wiki/standards/example.md', detail: '附件6 序号 5–21' }], boundaries: '人确认结论' }],
    }
    await writeFile(catalogPath, JSON.stringify(catalog))
    const response = await fetch(`${base}${ARCHITECTURE_REVIEW_EXPERTS_PATH}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ catalog })
    expect((await fetch(`${base}${ARCHITECTURE_REVIEW_EXPERTS_PATH}`, { method: 'POST' })).status).toBe(405)
    rejection.value = 403
    expect((await fetch(`${base}${ARCHITECTURE_REVIEW_EXPERTS_PATH}`)).status).toBe(403)
    rejection.value = undefined
    await writeFile(catalogPath, JSON.stringify({ ...catalog, experts: [{ ...catalog.experts[0], sources: [{ path: 'wiki/../secret.md', detail: 'invalid' }] }] }))
    expect((await fetch(`${base}${ARCHITECTURE_REVIEW_EXPERTS_PATH}`)).status).toBe(500)
  })

  it('applies the injected connection trust fence before private route work', async () => {
    const rejection: { value: 401 | 403 | undefined } = { value: 403 }
    const { base } = await startHost(rejection)

    expect((await fetch(`${base}${ARCHITECTURE_REVIEW_WORKSPACE_PATH}`)).status).toBe(403)
    rejection.value = 401
    expect((await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}`)).status).toBe(401)
    rejection.value = undefined
    const snapshot = await fetch(`${base}${ARCHITECTURE_REVIEW_WORKSPACE_PATH}`)
    expect(snapshot.status).toBe(200)
    await expect(snapshot.json()).resolves.toMatchObject({ initialized: false })
  })

  it('initializes a workspace, creates a review, and serves its detail prefix', async () => {
    const rejection: { value: 401 | 403 | undefined } = { value: undefined }
    const { base, root } = await startHost(rejection)
    const initialize = await fetch(`${base}${ARCHITECTURE_REVIEW_WORKSPACE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    })
    expect(initialize.status).toBe(201)

    const create = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ title: '订单域架构评审', owner: '平台组' }),
    })
    expect(create.status).toBe(201)
    await expect(create.json()).resolves.toMatchObject({ reviewId: 'AR-001', status: 'draft' })

    const detail = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/AR-001`)
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({ reviewId: 'AR-001', title: '订单域架构评审' })
  })

  it('enforces JSON media type, malformed-body handling, and the body-size ceiling', async () => {
    const rejection: { value: 401 | 403 | undefined } = { value: undefined }
    const { base, root } = await startHost(rejection)
    await fetch(`${base}${ARCHITECTURE_REVIEW_WORKSPACE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    })

    const text = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ title: 'wrong media type' }),
    })
    expect(text.status).toBe(415)

    const malformed = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(malformed.status).toBe(400)

    for (const field of ['systemName', 'type', 'owner', 'description']) {
      const invalidField = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'invalid field', [field]: 42 }),
      })
      expect(invalidField.status).toBe(400)
    }

    const oversized = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'large', description: 'x'.repeat(33 * 1024) }),
    })
    expect(oversized.status).toBe(413)
  })

  it('runs the local artifact, lint, finding, decision, operation, and export workflow', async () => {
    const rejection: { value: 401 | 403 | undefined } = { value: undefined }
    const { base, root } = await startHost(rejection)
    await fetch(`${base}${ARCHITECTURE_REVIEW_WORKSPACE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    })
    await writeFile(join(root, 'wiki/synthesis/architecture-review-experts.json'), JSON.stringify({
      version: 1, generatedAt: new Date().toISOString(), basis: ['wiki/index.md'], limitations: '人工核实',
      experts: [{ id: 'security-expert', name: '安全专家', focus: '安全', role: '核对安全', capabilities: ['审查'],
        responsibilities: ['核对证据'], baseline: 'security.md', sources: [{ path: 'raw/sources/standards/security.md', detail: '安全规范' }], boundaries: '不决策' }],
    }))
    const created = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '本地工作流评审', ruleIds: ['security'], expertIds: ['security-expert'] }),
    })
    const review = await created.json() as { reviewId: string; ruleIds: string[] }
    expect(review.ruleIds).toEqual(['security'])

    const prematureDecision = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: 'approved' }),
    })
    expect(prematureDecision.status).toBe(400)

    const artifact = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'architecture.md', content: '# 系统\n\n参见 [缺失页面](missing.md)。\n' }),
    })
    expect(artifact.status).toBe(201)
    await expect(artifact.json()).resolves.toMatchObject({ name: 'architecture.md', parseStatus: 'ready' })
    const sources = await fetch(`${base}${ARCHITECTURE_REVIEW_ARTIFACTS_PATH}`)
    await expect(sources.json()).resolves.toMatchObject({ artifacts: [expect.objectContaining({ reviewId: review.reviewId, name: 'architecture.md' })] })
    const preview = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/artifact-content?name=architecture.md`)
    await expect(preview.json()).resolves.toMatchObject({ content: '# 系统\n\n参见 [缺失页面](missing.md)。\n', truncated: false })
    const traversal = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/artifact-content?name=${encodeURIComponent('../review.md')}`)
    expect(traversal.status).toBe(400)

    const ingest = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/ingest`, { method: 'POST' })
    expect(ingest.status).toBe(202)
    const ingestOperation = await ingest.json() as { operationId: string; status: string }
    expect(ingestOperation.status).toBe('completed')

    const run = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/run`, { method: 'POST' })
    expect(run.status).toBe(202)
    const runOperation = await run.json() as { operationId: string; result: { findingCount: number; selectedRuleIds: string[] } }
    expect(runOperation.result.findingCount).toBe(1)
    expect(runOperation.result.selectedRuleIds).toEqual(['security'])
    const runningReview = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}`)
    await expect(runningReview.json()).resolves.toMatchObject({ status: 'prechecked', ruleIds: ['security'] })

    const findingsResponse = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/findings`)
    const findingsPayload = await findingsResponse.json() as { findings: Array<{ findingId: string; status: string }> }
    expect(findingsPayload.findings).toHaveLength(1)
    const finding = findingsPayload.findings[0]!
    const findingUpdate = await fetch(`${base}/api/architecture-review/findings/${finding.findingId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' }),
    })
    expect(findingUpdate.status).toBe(400)
    const missingReason = await fetch(`${base}/api/architecture-review/findings/${finding.findingId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'accepted-risk' }),
    })
    expect(missingReason.status).toBe(400)
    const accepted = await fetch(`${base}/api/architecture-review/findings/${finding.findingId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'accepted-risk', reason: '规范文件暂缺，评审人接受该范围限制' }),
    })
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({ status: 'accepted-risk', reason: '规范文件暂缺，评审人接受该范围限制' })
    const reopen = await fetch(`${base}/api/architecture-review/findings/${finding.findingId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'proposed' }),
    })
    expect(reopen.status).toBe(200)
    const invalidTransition = await fetch(`${base}/api/architecture-review/findings/${finding.findingId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }),
    })
    expect(invalidTransition.status).toBe(400)
    await fetch(`${base}/api/architecture-review/findings/${finding.findingId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'rejected', reason: '缺失的规范文件不属于本次范围' }),
    })

    await writeFile(join(root, 'raw/sources/standards/security.md'), '# 安全规范\n')
    const selected = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}`)
    await expect(selected.json()).resolves.toMatchObject({ basisPaths: ['raw/sources/standards/security.md'], subagentMode: true })
    const expertRunResponse = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/expert-run`, { method: 'POST' })
    expect(expertRunResponse.status).toBe(201)
    const expertRun = await expertRunResponse.json() as { runId: string }
    const sessionId = 'session-12345678'
    await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/expert-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: expertRun.runId, sessionId }),
    })
    const duplicate = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/expert-run`, { method: 'POST' })
    expect(duplicate.status).toBe(409)
    const concluded = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/expert-result`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: expertRun.runId, sessionId,
        expertId: 'security-expert', status: 'completed', conclusion: JSON.stringify({ issues: [{ title: '安全边界', opinion: '需核实', evidence: [`raw/sources/reviews/${review.reviewId}/v1/architecture.md:1`], counterEvidence: [], limitations: [] }] }) }),
    })
    expect(concluded.status).toBe(200)
    const candidates = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/candidates`)
    const candidatePayload = await candidates.json() as { candidates: Array<{ candidateId: string }> }
    expect(candidatePayload.candidates).toHaveLength(1)
    const handled = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/candidates`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidateId: candidatePayload.candidates[0]!.candidateId,
        status: 'confirmed', reason: '人工核对原件后确认' }),
    })
    expect(handled.status).toBe(200)

    const decision = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'approved', reason: '资料检查完成' }),
    })
    expect(decision.status).toBe(201)
    await expect(decision.json()).resolves.toMatchObject({ reportPath: `wiki/reviews/${review.reviewId}/report.md` })
    const completedReview = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}`)
    await expect(completedReview.json()).resolves.toMatchObject({ status: 'completed' })

    await writeFile(join(root, 'wiki/broken-link.md'), '# 检查\n\n[缺失](missing.md)\n')
    const lint = await fetch(`${base}${ARCHITECTURE_REVIEW_REVIEWS_PATH}/${review.reviewId}/lint`, { method: 'POST' })
    expect(lint.status).toBe(202)
    await expect(lint.json()).resolves.toMatchObject({ status: 'completed', result: { issueCount: 1 } })

    const pages = await fetch(`${base}${ARCHITECTURE_REVIEW_PAGES_PATH}`)
    expect(pages.status).toBe(200)
    await expect(pages.json()).resolves.toMatchObject({ pages: expect.arrayContaining([expect.objectContaining({ path: `reviews/${review.reviewId}/report.md` })]) })
    const page = await fetch(`${base}${ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH}?path=${encodeURIComponent(`reviews/${review.reviewId}/report.md`)}`)
    expect(page.status).toBe(200)
    await expect(page.json()).resolves.toMatchObject({ path: `reviews/${review.reviewId}/report.md` })

    const exported = await fetch(`${base}${ARCHITECTURE_REVIEW_EXPORT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId: review.reviewId }),
    })
    expect(exported.status).toBe(201)
    await expect(exported.json()).resolves.toMatchObject({ format: 'markdown', path: `exports/${review.reviewId}-report.md` })

    const operation = await fetch(`${base}/api/architecture-review/operations/${ingestOperation.operationId}`)
    expect(operation.status).toBe(200)
    await expect(operation.json()).resolves.toMatchObject({ operationId: ingestOperation.operationId, type: 'ingest' })
  })
})

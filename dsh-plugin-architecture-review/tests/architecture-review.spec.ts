import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchitectureReviewService } from '../src/architecture-review.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix = 'dsh-architecture-review-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function workspace(): Promise<{ root: string; service: ArchitectureReviewService }> {
  const root = await tempRoot()
  const service = new ArchitectureReviewService()
  await service.init(root)
  return { root, service }
}

function pdfFixture(text: string): Buffer {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : ''
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

describe('Architecture Review workspace', () => {
  it('deletes only the selected review and its materials without reusing its ID', async () => {
    const { root, service } = await workspace()
    const first = await service.createReview({ title: '待删除' })
    const second = await service.createReview({ title: '保留项目' })
    await service.importArtifact(first.reviewId, { name: 'design.md', content: '# 原始资料' })
    await service.ingestReview(first.reviewId)
    await service.runReview(first.reviewId)
    const outside = await tempRoot('dsh-architecture-review-external-')
    await writeFile(join(outside, 'keep.txt'), '外部文件')
    await symlink(outside, join(root, 'wiki/reviews', first.reviewId, 'external-link'), 'junction')
    expect((await service.listOperations()).some(operation => operation.reviewId === first.reviewId)).toBe(true)

    await expect(service.deleteReview(first.reviewId)).resolves.toEqual({ reviewId: first.reviewId })
    expect(await service.getReview(first.reviewId)).toBeNull()
    expect(await service.getReview(second.reviewId)).not.toBeNull()
    await expect(readdir(join(root, 'wiki/reviews', first.reviewId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(root, 'raw/sources/reviews', first.reviewId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await service.listOperations()).some(operation => operation.reviewId === first.reviewId)).toBe(false)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('外部文件')
    expect(await readFile(join(root, 'wiki/index.md'), 'utf8')).toContain('Architecture Reviews')
    await service.deleteReview(second.reviewId)
    expect((await service.createReview({ title: '新项目' })).reviewId).toBe('AR-003')
    await expect(service.deleteReview(first.reviewId)).rejects.toThrow('review not found')
  })

  it('accepts a text PDF as review material, indexes its pages, and keeps an image-only PDF blocked', async () => {
    const { root, service } = await workspace()
    const review = await service.createReview({ title: 'PDF 资料预检' })
    const original = await service.importArtifact(review.reviewId, { name: 'design.pdf', contentBase64: pdfFixture('Architecture review material').toString('base64') })
    expect(original.parseStatus).toBe('ready')
    const scan = await service.importArtifact(review.reviewId, { name: 'scan.pdf', contentBase64: pdfFixture('').toString('base64') })
    expect(scan.parseStatus).toBe('stored-only')
    await service.ingestReview(review.reviewId)
    expect((await service.artifactContent(review.reviewId, 'design.pdf')).content).toContain('第 1 页\n\nArchitecture review material')
    expect((await service.artifactContent(review.reviewId, 'scan.pdf')).content).toBeNull()
    const textPath = join(root, 'wiki/reviews', review.reviewId, 'extracted', `${original.sha256}.md`)
    expect(await readFile(textPath, 'utf8')).toContain('Architecture review material')
    expect(await readFile(join(root, 'wiki/reviews', review.reviewId, 'sources.md'), 'utf8')).toContain(`extracted/${original.sha256}.md`)
    await service.runReview(review.reviewId)
    expect((await service.listFindings(review.reviewId)).some(finding => finding.title === '缺少评审资料')).toBe(false)
    const scannedReview = await service.createReview({ title: '扫描件预检' })
    await service.importArtifact(scannedReview.reviewId, { name: 'scan.pdf', contentBase64: pdfFixture('').toString('base64') })
    await service.runReview(scannedReview.reviewId)
    expect((await service.listFindings(scannedReview.reviewId))[0]?.title).toBe('缺少可读取的评审资料')
  })
  it('gates expert launch, records six real outcomes, survives reload, and requires a fresh run for changed material', async () => {
    const { root, service } = await workspace()
    const expertIds = Array.from({ length: 6 }, (_, index) => `expert-${index + 1}`)
    await writeFile(join(root, 'wiki/synthesis/architecture-review-experts.json'), JSON.stringify({
      version: 1, generatedAt: new Date().toISOString(), basis: ['wiki/index.md'], limitations: '人工核实',
      experts: expertIds.map(id => ({ id, name: id, focus: id, role: '核对', capabilities: ['核对资料'], responsibilities: ['核对证据'],
        baseline: 'security.md', sources: [{ path: 'raw/sources/standards/security.md', detail: '安全规范' }], boundaries: '不决策' })),
    }))
    const review = await service.createReview({ title: '六专家评审', ruleIds: ['security'], expertIds })
    expect(review).toMatchObject({ subagentMode: true, basisPaths: ['raw/sources/standards/security.md'] })
    expect((await service.getReview(review.reviewId))?.status).toBe('draft')
    await service.runReview(review.reviewId)
    expect((await service.listFindings(review.reviewId))[0]?.title).toBe('缺少评审资料')
    await expect(service.startExpertReview(review.reviewId)).rejects.toThrow(/readable review material/u)
    await service.importArtifact(review.reviewId, { name: 'design.md', content: '# 设计依据' })
    await expect(service.startExpertReview(review.reviewId)).rejects.toThrow(/review standard is missing/u)
    await writeFile(join(root, 'raw/sources/standards/security.md'), '# 安全规范\n')
    const run = await service.startExpertReview(review.reviewId)
    expect(run.standards).toHaveLength(1)
    await expect(service.deleteReview(review.reviewId)).rejects.toThrow('expert review is running')
    await expect(service.startExpertReview(review.reviewId)).rejects.toThrow(/running/u)
    await expect(service.importArtifact(review.reviewId, { name: 'during.md', content: '变更' })).rejects.toThrow(/running/u)
    const sessionId = 'session-12345678'
    await service.bindExpertSession(review.reviewId, run.runId, sessionId)
    for (const id of expertIds.slice(0, 5)) {
      await service.recordExpertResult(review.reviewId, run.runId, id, sessionId, {
        status: 'completed', conclusion: JSON.stringify({ issues: [{ title: '权限边界', opinion: `${id} 的核对意见`,
          evidence: [`raw/sources/reviews/${review.reviewId}/v1/design.md:1`], counterEvidence: [], limitations: [] }] }),
      })
    }
    expect((await service.getReview(review.reviewId))?.run?.experts.filter(expert => expert.status === 'completed')).toHaveLength(5)
    expect((await service.getReview(review.reviewId))?.status).toBe('reviewing')
    await service.recordExpertResult(review.reviewId, run.runId, expertIds[5]!, sessionId, { status: 'failed', conclusion: '', error: '委派超时' })
    const restored = new ArchitectureReviewService(root)
    expect((await restored.getReview(review.reviewId))?.run).toMatchObject({ runId: run.runId, status: 'human-review', experts: expect.arrayContaining([expect.objectContaining({ status: 'failed', error: '委派超时' })]) })
    const [candidate] = await restored.listCandidates(review.reviewId)
    expect(candidate?.expertIds).toHaveLength(5)
    await expect(restored.createDecision(review.reviewId, { result: 'approved', reason: '该专家未完成' })).rejects.toThrow(/all experts/u)
    await restored.updateCandidate(review.reviewId, candidate!.candidateId, { status: 'confirmed', reason: '逐项核实原件' })
    await expect(restored.createDecision(review.reviewId, { result: 'conditional', reason: '专家失败，负责人接受限制' })).resolves.toMatchObject({ reviewId: review.reviewId })
    expect(await readFile(join(root, 'wiki/reviews', review.reviewId, 'report.md'), 'utf8')).toContain('- 人工判断：已认定为问题')
    await restored.retryExpert(review.reviewId, expertIds[5]!)
    await restored.bindExpertSession(review.reviewId, run.runId, 'session-retry-1234', expertIds[5])
    await restored.recordExpertResult(review.reviewId, run.runId, expertIds[5]!, 'session-retry-1234', { status: 'completed', conclusion: JSON.stringify({ issues: [{ title: '权限边界', opinion: '补充核对', evidence: [`raw/sources/reviews/${review.reviewId}/v1/design.md:1`] }] }) })
    await writeFile(join(root, 'raw/sources/standards/security.md'), '# 规范修订\n')
    await expect(restored.createDecision(review.reviewId, { result: 'conditional', reason: '复核' })).rejects.toThrow(/standards changed/u)
    await writeFile(join(root, 'raw/sources/standards/security.md'), '# 安全规范\n')
    await restored.importArtifact(review.reviewId, { name: 'revision.md', content: '# 补充资料' })
    await expect(restored.createDecision(review.reviewId, { result: 'approved' })).rejects.toThrow(/materials changed/u)
    const second = await restored.startExpertReview(review.reviewId)
    expect(second.runId).not.toBe(run.runId)
    expect(second.sourceVersion).not.toBe(run.sourceVersion)
    expect(second.sources).toHaveLength(2)
    expect(await restored.listCandidates(review.reviewId)).toEqual([])
  })
  it('persists selected expert agents, validates catalog IDs, and reads older reviews', async () => {
    const { root, service } = await workspace()
    const catalog = {
      version: 1, generatedAt: '2026-09-17T00:00:00.000Z', basis: ['wiki/index.md'], limitations: '待人工核实',
      experts: [{ id: 'data-architecture', name: '数据专家', focus: '数据', role: '核对数据架构',
        capabilities: ['检查模型'], responsibilities: ['提出候选问题'], baseline: '本地规范',
        sources: [{ path: 'raw/sources/standards/data.md', detail: '数据规范' }], boundaries: '不作决策' }],
    }
    await writeFile(join(root, 'wiki/synthesis/architecture-review-experts.json'), JSON.stringify(catalog))
    const review = await service.createReview({ title: '专家选择', expertIds: ['data-architecture'] })
    expect(review).toMatchObject({ expertIds: ['data-architecture'], subagentMode: true, basisPaths: ['raw/sources/standards/data.md'] })
    await expect(service.updateReviewExperts(review.reviewId, { expertIds: ['unknown-expert'] }))
      .rejects.toThrow(/current catalog/u)
    await expect(service.updateReviewExperts(review.reviewId, { expertIds: [] }))
      .rejects.toThrow(/selected experts are required/u)
    const updated = await service.updateReviewExperts(review.reviewId, { expertIds: ['data-architecture'], subagentMode: false })
    expect(updated).toMatchObject({ expertIds: ['data-architecture'], subagentMode: true, basisPaths: ['raw/sources/standards/data.md'] })
    expect(await readFile(join(root, 'wiki/reviews', review.reviewId, 'review.md'), 'utf8'))
      .toContain('expert_ids: ["data-architecture"]\nsubagent_mode: true')
    const older = await service.createReview({ title: '旧格式' })
    const path = join(root, 'wiki/reviews', older.reviewId, 'review.md')
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace(/^expert_ids:.*\n|^subagent_mode:.*\n/gmu, ''))
    expect(await service.getReview(older.reviewId)).toMatchObject({ expertIds: [], subagentMode: true })
  })

  it('initializes the documented folder structure idempotently', async () => {
    const { root, service } = await workspace()
    const first = await service.snapshot()
    const second = await service.init(root)

    expect(first.initialized).toBe(true)
    expect(second.reviewCount).toBe(0)
    expect(second.wikiCount).toBeGreaterThan(0)
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toContain('human confirmation')
  })

  it('restores the selected workspace after the Host restarts', async () => {
    const storage = await tempRoot('dsh-architecture-review-selection-')
    const root = await tempRoot()
    const selectionPath = join(storage, 'workspace.json')
    const first = new ArchitectureReviewService(undefined, selectionPath)
    await first.init(root)
    await first.createReview({ title: '恢复工作区', ruleIds: ['security', 'data'] })

    const restored = new ArchitectureReviewService(undefined, selectionPath)
    await expect(restored.snapshot()).resolves.toMatchObject({ initialized: true, root, reviewCount: 1 })
    await expect(restored.getReview('AR-001')).resolves.toMatchObject({ ruleIds: ['security', 'data'] })
  })

  it('moves a precheck Finding through human handling without opening a premature decision', async () => {
    const { root, service } = await workspace()
    const review = await service.createReview({ title: '人工处理' })
    await service.runReview(review.reviewId)
    const finding = (await service.listFindings(review.reviewId))[0]!
    await writeFile(join(root, 'wiki/reviews', review.reviewId, 'findings.json'), JSON.stringify([{ ...finding, evidence: ['source:design.md'] }]))

    await expect(service.updateFinding(finding.findingId, { status: 'resolved' })).rejects.toThrow(/transition/u)
    await expect(service.updateFinding(finding.findingId, { status: 'confirmed' })).resolves.toMatchObject({ status: 'confirmed' })
    await expect(service.updateFinding(finding.findingId, { status: 'in-progress' })).resolves.toMatchObject({ status: 'in-progress' })
    await expect(service.createDecision(review.reviewId, { result: 'approved' })).rejects.toThrow(/finish expert review/u)
    await expect(service.updateFinding(finding.findingId, { status: 'resolved', reason: '资料已经补齐' })).resolves.toMatchObject({ status: 'resolved' })
    await expect(service.createDecision(review.reviewId, { result: 'approved' })).rejects.toThrow(/finish expert review/u)
  })

  it('serializes concurrent review creation into complete atomic files and an audit log', async () => {
    const { root, service } = await workspace()
    const [first, second] = await Promise.all([
      service.createReview({ title: '支付平台重构', owner: '架构组' }),
      service.createReview({ title: '用户中心拆分' }),
    ])

    expect([first.reviewId, second.reviewId].sort()).toEqual(['AR-001', 'AR-002'])
    const firstMarkdown = await readFile(join(root, 'wiki/reviews/AR-001/review.md'), 'utf8')
    const secondMarkdown = await readFile(join(root, 'wiki/reviews/AR-002/review.md'), 'utf8')
    expect(firstMarkdown).toMatch(/^---\nreview_id: AR-001[\s\S]+\n---\n/u)
    expect(secondMarkdown).toMatch(/^---\nreview_id: AR-002[\s\S]+\n---\n/u)
    const log = await readFile(join(root, 'wiki/log.md'), 'utf8')
    expect(log).toContain('create review AR-001')
    expect(log).toContain('create review AR-002')
    expect((await readdir(join(root, 'wiki/reviews/AR-001'))).sort()).toEqual(['review.md', 'v1'])
  })

  it('serializes numbering across independent service instances sharing a workspace', async () => {
    const { root } = await workspace()
    const firstService = new ArchitectureReviewService(root)
    const secondService = new ArchitectureReviewService(root)
    const [first, second] = await Promise.all([
      firstService.createReview({ title: '跨进程一' }),
      secondService.createReview({ title: '跨进程二' }),
    ])

    expect([first.reviewId, second.reviewId].sort()).toEqual(['AR-001', 'AR-002'])
  })

  it('atomically replaces the audit log without mutating an external hard-link alias', async () => {
    const { root, service } = await workspace()
    const outsideRoot = await tempRoot('dsh-architecture-review-audit-')
    const outside = join(outsideRoot, 'outside.log')
    const audit = join(root, 'wiki/log.md')
    await writeFile(outside, 'outside stays unchanged\n')
    await rm(audit)
    await link(outside, audit)

    await service.createReview({ title: '原子审计日志' })

    await expect(readFile(outside, 'utf8')).resolves.toBe('outside stays unchanged\n')
    await expect(readFile(audit, 'utf8')).resolves.toContain('create review AR-001')
    expect((await readdir(join(root, 'wiki'))).some(name => name.endsWith('.lock') || name.endsWith('.tmp'))).toBe(false)
  })

  it('reserves incomplete review directory numbers instead of overwriting them', async () => {
    const { root, service } = await workspace()
    await mkdir(join(root, 'wiki/reviews/AR-007'))

    await expect(service.createReview({ title: '新评审' })).resolves.toMatchObject({ reviewId: 'AR-008' })
  })

  it('rejects non-absolute, oversized, and UNC workspace paths', async () => {
    const service = new ArchitectureReviewService()
    await expect(service.init('relative/workspace')).rejects.toThrow(/absolute/u)
    await expect(service.init(`${join(tmpdir(), 'workspace')}${'x'.repeat(4096)}`)).rejects.toThrow(/bounded/u)
    if (process.platform === 'win32') {
      await expect(service.init('\\\\server\\share')).rejects.toThrow(/UNC/u)
    }
  })

  it('rejects a workspace path that traverses a symbolic link or junction', async () => {
    const container = await tempRoot('dsh-architecture-review-links-')
    const outside = await tempRoot('dsh-architecture-review-outside-')
    const linked = join(container, 'linked')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')

    const service = new ArchitectureReviewService()
    await expect(service.init(join(linked, 'workspace'))).rejects.toThrow(/symlink/u)
  })
})

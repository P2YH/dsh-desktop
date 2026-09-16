import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchitectureReviewService } from '../src/architecture-review.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<{ root: string; service: ArchitectureReviewService }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-architecture-review-'))
  roots.push(root)
  const service = new ArchitectureReviewService()
  await service.init(root)
  return { root, service }
}

describe('Architecture Review workspace', () => {
  it('initializes the documented folder structure idempotently', async () => {
    const { root, service } = await workspace()
    const first = await service.snapshot()
    const second = await service.init(root)
    expect(first.initialized).toBe(true)
    expect(second.reviewCount).toBe(0)
    expect(second.wikiCount).toBeGreaterThan(0)
  })

  it('creates sequential reviews with frontmatter and an audit log', async () => {
    const { root, service } = await workspace()
    const [first, second] = await Promise.all([
      service.createReview({ title: '支付平台重构', owner: '架构组' }),
      service.createReview({ title: '用户中心拆分' }),
    ])
    expect([first.reviewId, second.reviewId].sort()).toEqual(['AR-001', 'AR-002'])
    const markdown = await readFile(join(root, 'wiki/reviews/AR-001/review.md'), 'utf8')
    expect(markdown).toContain('review_id: AR-001')
    expect(await readFile(join(root, 'wiki/log.md'), 'utf8')).toContain('create review AR-001')
  })

  it('rejects non-absolute and UNC workspace paths', async () => {
    const service = new ArchitectureReviewService()
    await expect(service.init('relative/workspace')).rejects.toThrow(/absolute/u)
    if (process.platform === 'win32') {
      await expect(service.init('\\\\server\\share')).rejects.toThrow(/UNC/u)
    }
  })
})

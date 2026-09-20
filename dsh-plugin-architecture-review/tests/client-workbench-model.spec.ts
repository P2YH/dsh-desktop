import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULE_IDS,
  candidateStatusLabel,
  formatFileSize,
  parseWorkbenchRoute,
  reviewStatusLabel,
  selectedRuleSummary,
  sourceKind,
  validateReviewBasics,
  withWorkbenchRoute,
} from '../src/client/workbench-model.ts'

describe('architecture review client workbench model', () => {
  it('parses list and valid review-detail deep links without accepting arbitrary ids', () => {
    expect(parseWorkbenchRoute('?architectureReviewView=knowledge')).toEqual({ view: 'knowledge' })
    expect(parseWorkbenchRoute('?architectureReviewView=review&architectureReviewId=AR-012')).toEqual({
      view: 'review',
      reviewId: 'AR-012',
    })
    expect(parseWorkbenchRoute('?architectureReviewView=review&architectureReviewId=../../secret')).toEqual({
      view: 'dashboard',
    })
  })

  it('updates only architecture review route parameters', () => {
    const result = new URL(withWorkbenchRoute('http://127.0.0.1:3090/?profile=architecture-review', {
      view: 'review',
      reviewId: 'AR-101',
    }))
    expect(result.searchParams.get('profile')).toBe('architecture-review')
    expect(result.searchParams.get('architectureReviewView')).toBe('review')
    expect(result.searchParams.get('architectureReviewId')).toBe('AR-101')

    const list = new URL(withWorkbenchRoute(result, { view: 'reviews' }))
    expect(list.searchParams.get('architectureReviewId')).toBeNull()
  })

  it('requires the information needed by the first wizard step', () => {
    expect(validateReviewBasics({ title: '  ', systemName: '', owner: '' })).toEqual({
      title: '请输入评审名称',
      systemName: '请输入系统名称',
      owner: '请输入负责人',
    })
    expect(validateReviewBasics({ title: '支付平台重构', systemName: '支付平台', owner: '平台组' })).toEqual({})
  })

  it('summarizes the default and complete review scopes', () => {
    expect(selectedRuleSummary(DEFAULT_RULE_IDS)).toEqual({ ruleCount: 10, documentCount: 4 })
    expect(selectedRuleSummary([...DEFAULT_RULE_IDS, 'cost'])).toEqual({ ruleCount: 12, documentCount: 5 })
  })

  it('formats source metadata for the import step', () => {
    expect(sourceKind('architecture.md')).toBe('Markdown')
    expect(sourceKind('openapi.yaml')).toBe('OpenAPI / 配置')
    expect(sourceKind('service.openapi')).toBe('OpenAPI / 配置')
    expect(sourceKind('diagram.PNG')).toBe('架构图片')
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB')
  })

  it('uses readable labels while retaining unknown host statuses', () => {
    expect(reviewStatusLabel('human-review')).toBe('待人工确认')
    expect(reviewStatusLabel('completed')).toBe('已完成')
    expect(reviewStatusLabel('custom-state')).toBe('custom-state')
    expect(candidateStatusLabel('confirmed')).toBe('已认定为问题')
    expect(candidateStatusLabel('rejected')).toBe('已判定不成立')
    expect(candidateStatusLabel('needs-evidence')).toBe('待补充证据')
  })
})

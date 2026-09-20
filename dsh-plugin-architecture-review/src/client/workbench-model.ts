import { DEFAULT_ARCHITECTURE_REVIEW_RULE_IDS, type CreateReviewInput } from '../architecture-review-contract.ts'

export const WORKBENCH_VIEW_PARAM = 'architectureReviewView'
export const WORKBENCH_REVIEW_PARAM = 'architectureReviewId'

export const WORKBENCH_VIEWS = [
  'dashboard',
  'reviews',
  'review',
  'knowledge',
  'rules',
  'operations',
  'settings',
] as const

export type WorkbenchView = typeof WORKBENCH_VIEWS[number]

export interface WorkbenchRoute {
  readonly view: WorkbenchView
  readonly reviewId?: string
}

export interface ReviewRule {
  readonly id: 'security' | 'reliability' | 'api' | 'data' | 'cost'
  readonly label: string
  readonly description: string
  readonly ruleCount: number
  readonly documentCount: number
}

export const REVIEW_RULES: readonly ReviewRule[] = [
  { id: 'security', label: '安全规范', description: '身份认证、授权、数据保护与威胁建模', ruleCount: 3, documentCount: 1 },
  { id: 'reliability', label: '可靠性规范', description: '容量、容错、恢复目标与可观测性', ruleCount: 3, documentCount: 1 },
  { id: 'api', label: '接口规范', description: '契约兼容、错误处理、幂等与版本管理', ruleCount: 2, documentCount: 1 },
  { id: 'data', label: '数据规范', description: '数据模型、一致性、生命周期与合规', ruleCount: 2, documentCount: 1 },
  { id: 'cost', label: '成本规范', description: '资源预算、弹性策略与成本风险', ruleCount: 2, documentCount: 1 },
]

export const DEFAULT_RULE_IDS = DEFAULT_ARCHITECTURE_REVIEW_RULE_IDS

export const REVIEW_TYPES = [
  ['new-system', '新系统'],
  ['major-change', '重大变更'],
  ['data', '数据专项'],
  ['security', '安全专项'],
  ['technical-debt', '技术债'],
] as const

export function parseWorkbenchRoute(search: string): WorkbenchRoute {
  const params = new URLSearchParams(search)
  const value = params.get(WORKBENCH_VIEW_PARAM)
  const reviewId = params.get(WORKBENCH_REVIEW_PARAM)
  if (value === 'review' && reviewId !== null && /^AR-\d{3,}$/.test(reviewId)) {
    return { view: 'review', reviewId }
  }
  if (value !== null && WORKBENCH_VIEWS.some(view => view === value) && value !== 'review') {
    return { view: value as Exclude<WorkbenchView, 'review'> }
  }
  return { view: 'dashboard' }
}

export function withWorkbenchRoute(input: string | URL, route: WorkbenchRoute): string {
  const url = new URL(input)
  url.searchParams.set(WORKBENCH_VIEW_PARAM, route.view)
  if (route.view === 'review' && route.reviewId !== undefined) {
    url.searchParams.set(WORKBENCH_REVIEW_PARAM, route.reviewId)
  } else {
    url.searchParams.delete(WORKBENCH_REVIEW_PARAM)
  }
  return url.toString()
}

export function reviewStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: '草稿',
    prechecked: '已预检',
    queued: '等待中',
    reviewing: '评审中',
    'human-review': '待人工确认',
    completed: '已完成',
    waiting: '等待中',
    failed: '失败',
    cancelled: '已取消',
    proposed: '待确认',
    confirmed: '已确认',
    'in-progress': '处理中',
    resolved: '已解决',
    'accepted-risk': '已接受风险',
    'needs-evidence': '待补证',
    rejected: '已驳回',
    Blocker: '阻断',
    Major: '重要',
    Minor: '一般',
    Info: '提示',
    UNVERIFIED: '未验证',
  }
  return labels[status] ?? status
}

export function candidateStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    proposed: '待判断',
    confirmed: '已认定为问题',
    rejected: '已判定不成立',
    'needs-evidence': '待补充证据',
    'accepted-risk': '已接受风险',
  }
  return labels[status] ?? status
}

export function reviewTypeLabel(type: string): string {
  return REVIEW_TYPES.find(([id]) => id === type)?.[1] ?? type
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function sourceKind(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'pdf') return 'PDF'
  if (extension === 'docx') return 'DOCX'
  if (extension === 'md' || extension === 'markdown') return 'Markdown'
  if (extension === 'yaml' || extension === 'yml' || extension === 'json' || extension === 'openapi') return 'OpenAPI / 配置'
  if (extension === 'png' || extension === 'jpg' || extension === 'jpeg' || extension === 'webp') return '架构图片'
  if (extension === 'txt') return '文本'
  return '文件'
}

export function validateReviewBasics(input: CreateReviewInput): Partial<Record<keyof CreateReviewInput, string>> {
  const errors: Partial<Record<keyof CreateReviewInput, string>> = {}
  const title = input.title.trim()
  if (title.length === 0) errors.title = '请输入评审名称'
  else if (title.length > 200) errors.title = '评审名称不能超过 200 个字符'
  if ((input.systemName?.trim().length ?? 0) === 0) errors.systemName = '请输入系统名称'
  if ((input.owner?.trim().length ?? 0) === 0) errors.owner = '请输入负责人'
  if ((input.description?.length ?? 0) > 2000) errors.description = '评审说明不能超过 2000 个字符'
  return errors
}

export function selectedRuleSummary(selectedIds: readonly string[]): { ruleCount: number; documentCount: number } {
  return REVIEW_RULES.reduce((summary, rule) => {
    if (!selectedIds.includes(rule.id)) return summary
    return {
      ruleCount: summary.ruleCount + rule.ruleCount,
      documentCount: summary.documentCount + rule.documentCount,
    }
  }, { ruleCount: 0, documentCount: 0 })
}

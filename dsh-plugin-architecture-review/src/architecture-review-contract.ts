/** Browser-safe contracts shared by the Architecture Review Host and Client. */

export const ARCHITECTURE_REVIEW_WORKSPACE_PATH = '/api/architecture-review/workspace'
export const ARCHITECTURE_REVIEW_WORKSPACE_INIT_PATH = `${ARCHITECTURE_REVIEW_WORKSPACE_PATH}/init`
export const ARCHITECTURE_REVIEW_REVIEWS_PATH = '/api/architecture-review/reviews'
/** URL prefix for read-only review detail requests. */
export const ARCHITECTURE_REVIEW_REVIEW_PREFIX = `${ARCHITECTURE_REVIEW_REVIEWS_PATH}/`
export const ARCHITECTURE_REVIEW_OPERATIONS_PATH = '/api/architecture-review/operations'
export const ARCHITECTURE_REVIEW_FINDINGS_PATH = '/api/architecture-review/findings'
export const ARCHITECTURE_REVIEW_PAGES_PATH = '/api/architecture-review/pages'
export const ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH = `${ARCHITECTURE_REVIEW_PAGES_PATH}/content`
export const ARCHITECTURE_REVIEW_EXPORT_PATH = '/api/architecture-review/export'
export const ARCHITECTURE_REVIEW_ARTIFACTS_PATH = '/api/architecture-review/artifacts'
export const ARCHITECTURE_REVIEW_EXPERTS_PATH = '/api/architecture-review/experts'
export const ARCHITECTURE_REVIEW_STANDARDS_PATH = '/api/architecture-review/standards'

export const ARCHITECTURE_REVIEW_RULE_IDS = ['security', 'reliability', 'api', 'data', 'cost'] as const
export type ArchitectureReviewRuleId = typeof ARCHITECTURE_REVIEW_RULE_IDS[number]
export const DEFAULT_ARCHITECTURE_REVIEW_RULE_IDS: readonly ArchitectureReviewRuleId[] = ['security', 'reliability', 'api', 'data']

export interface ArchitectureReviewWorkspaceSnapshot {
  readonly initialized: boolean
  readonly root: string | null
  readonly reviewCount: number
  readonly sourceCount: number
  readonly wikiCount: number
}

export interface ArchitectureReviewSummary {
  readonly reviewId: string
  readonly version: string
  readonly title: string
  readonly status: string
  readonly path: string
  readonly updatedAt: string | null
  readonly ruleIds: readonly ArchitectureReviewRuleId[]
  readonly basisPaths: readonly string[]
  readonly expertIds: readonly string[]
  readonly subagentMode: boolean
  readonly run?: ArchitectureReviewRun | null
}

export interface ArchitectureReviewRun {
  readonly runId: string
  readonly reviewId: string
  readonly status: 'starting' | 'reviewing' | 'human-review'
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly sourceVersion: string
  readonly sources: readonly ArchitectureReviewArtifact[]
  readonly standards: readonly { readonly path: string; readonly sha256: string }[]
  readonly ruleIds: readonly ArchitectureReviewRuleId[]
  readonly catalogVersion: string
  readonly sessionId: string | null
  readonly experts: readonly ArchitectureReviewExpertTask[]
}

export interface ArchitectureReviewExpertTask {
  readonly expertId: string
  readonly name: string
  readonly status: 'waiting' | 'reviewing' | 'completed' | 'failed'
  readonly sessionId: string | null
  readonly conclusion: string | null
  readonly error: string | null
  readonly updatedAt: string
}

export interface ArchitectureReviewCandidate {
  readonly candidateId: string
  readonly title: string
  readonly status: 'proposed' | 'confirmed' | 'rejected' | 'needs-evidence' | 'accepted-risk'
  readonly expertIds: readonly string[]
  readonly opinions: readonly { readonly expertId: string; readonly text: string }[]
  readonly evidence: readonly string[]
  readonly counterEvidence: readonly string[]
  readonly limitations: readonly string[]
  readonly reason: string | null
}

export interface CreateReviewInput {
  readonly title: string
  readonly systemName?: string
  readonly type?: string
  readonly owner?: string
  readonly description?: string
  readonly ruleIds?: readonly ArchitectureReviewRuleId[]
  readonly expertIds?: readonly string[]
  readonly subagentMode?: boolean
}

export interface ReviewExpertsInput {
  readonly expertIds: readonly string[]
  /** Accepted for older clients; expert collaboration is always enabled. */
  readonly subagentMode?: boolean
}

export interface ImportArtifactInput {
  readonly name: string
  readonly content?: string
  readonly contentBase64?: string
}

export interface ArchitectureReviewArtifact {
  readonly name: string
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly parseStatus: 'ready' | 'stored-only'
}

export interface ArchitectureReviewSource extends ArchitectureReviewArtifact {
  readonly reviewId: string
}

export interface ArchitectureReviewArtifactContent extends ArchitectureReviewArtifact {
  readonly content: string | null
  readonly truncated: boolean
}

export type ArchitectureReviewFindingStatus =
  | 'proposed'
  | 'confirmed'
  | 'in-progress'
  | 'resolved'
  | 'accepted-risk'
  | 'rejected'

export interface ArchitectureReviewFinding {
  readonly findingId: string
  readonly reviewId: string
  readonly title: string
  readonly dimension: 'completeness' | 'rules'
  readonly severity: 'Blocker' | 'Major'
  readonly confidence: 'UNVERIFIED'
  readonly status: ArchitectureReviewFindingStatus
  readonly problem: string
  readonly recommendation: string
  readonly evidence: readonly string[]
  readonly reason: string | null
  readonly updatedAt: string
}

export interface ArchitectureReviewOperation {
  readonly operationId: string
  readonly type: 'ingest' | 'review' | 'lint'
  readonly reviewId: string | null
  readonly status: 'completed' | 'failed'
  readonly startedAt: string
  readonly finishedAt: string
  readonly result: Record<string, unknown>
}

export interface ArchitectureReviewPageSummary {
  readonly path: string
  readonly title: string
  readonly updatedAt: string
}

export interface ArchitectureReviewExpert {
  readonly id: string
  readonly name: string
  readonly focus: string
  readonly role: string
  readonly capabilities: readonly string[]
  readonly responsibilities: readonly string[]
  readonly baseline: string
  readonly sources: readonly { readonly path: string; readonly detail: string }[]
  readonly boundaries: string
}

export interface ArchitectureReviewExpertCatalog {
  readonly version: 1
  readonly generatedAt: string
  readonly basis: readonly string[]
  readonly limitations: string
  readonly experts: readonly ArchitectureReviewExpert[]
}

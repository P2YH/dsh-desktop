/** Renderer-safe contracts for the Architecture Review Host API. */

export const ARCHITECTURE_REVIEW_WORKSPACE_PATH = '/api/architecture-review/workspace'
export const ARCHITECTURE_REVIEW_REVIEWS_PATH = '/api/architecture-review/reviews'
/** Prefix reserved for read-only review detail routes. */
export const ARCHITECTURE_REVIEW_REVIEW_PREFIX = `${ARCHITECTURE_REVIEW_REVIEWS_PATH}/`

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
}

export interface CreateReviewInput {
  readonly title: string
  readonly systemName?: string
  readonly type?: string
  readonly owner?: string
  readonly description?: string
}

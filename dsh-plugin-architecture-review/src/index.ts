/** DSH Host plugin for the file-backed Architecture Review workspace. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  ARCHITECTURE_REVIEW_REVIEWS_PATH,
  ARCHITECTURE_REVIEW_WORKSPACE_PATH,
  ArchitectureReviewService,
  handleArchitectureReviewRequest,
} from './architecture-review.ts'
import { registerArchitectureReviewSkill } from './knowledge-skill.ts'

export {
  ARCHITECTURE_REVIEW_ARTIFACTS_PATH,
  ARCHITECTURE_REVIEW_EXPORT_PATH,
  ARCHITECTURE_REVIEW_EXPERTS_PATH,
  ARCHITECTURE_REVIEW_FINDINGS_PATH,
  ARCHITECTURE_REVIEW_OPERATIONS_PATH,
  ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH,
  ARCHITECTURE_REVIEW_PAGES_PATH,
  ARCHITECTURE_REVIEW_REVIEWS_PATH,
  ARCHITECTURE_REVIEW_REVIEW_PREFIX,
  ARCHITECTURE_REVIEW_WORKSPACE_PATH,
  ARCHITECTURE_REVIEW_WORKSPACE_INIT_PATH,
  ARCHITECTURE_REVIEW_STANDARDS_PATH,
  ArchitectureReviewService,
  handleArchitectureReviewRequest,
} from './architecture-review.ts'
export type {
  ArchitectureReviewArtifact,
  ArchitectureReviewExpert,
  ArchitectureReviewExpertCatalog,
  ArchitectureReviewArtifactContent,
  ArchitectureReviewSource,
  ArchitectureReviewRuleId,
  ArchitectureReviewFinding,
  ArchitectureReviewFindingStatus,
  ArchitectureReviewOperation,
  ArchitectureReviewPageSummary,
  ArchitectureReviewSummary,
  ArchitectureReviewRun,
  ArchitectureReviewExpertTask,
  ArchitectureReviewCandidate,
  ArchitectureReviewWorkspaceSnapshot,
  CreateReviewInput,
  ImportArtifactInput,
  ReviewExpertsInput,
} from './architecture-review-contract.ts'

/** Stable Cordis plugin name. */
export const name = 'architecture-review'
/** HTTP route carrier and the DSH browser trust/authentication service. */
export const inject = ['webServer', 'connection', 'skills']

export interface Config {
  /** Optional absolute workspace restored when the Profile starts. */
  readonly workspace?: string
}

/** Runtime-validated plugin configuration supplied by a Profile bundle. */
export const Config: z<Config> = z.object({
  workspace: z.string().min(1).required(false),
})

/** Trust surface used by private Host routes. */
interface ArchitectureReviewConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

function connectionOf(ctx: Context): ArchitectureReviewConnection {
  return Reflect.get(ctx, 'connection') as ArchitectureReviewConnection
}

function rejectRequest(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const rejection = connectionOf(ctx).requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

/** Register the workspace, review collection, and review detail routes. */
export function apply(ctx: Context, config: Config = {}): void {
  registerArchitectureReviewSkill(ctx)
  const configuredWorkspace = config.workspace ?? process.env.DSH_ARCHITECTURE_REVIEW_WORKSPACE
  const service = new ArchitectureReviewService(
    configuredWorkspace || undefined,
    configuredWorkspace ? undefined : join(resolveDshHome(), 'architecture-review', 'workspace.json'),
  )

  const register = (kind: 'exact' | 'prefix', path: string, label: string): void => {
    ctx.effect(() => ctx.webServer.register({
      kind,
      path,
      handler: (req, res) => {
        if (rejectRequest(ctx, req, res)) return
        const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname
        return handleArchitectureReviewRequest(req, res, service, requestPath)
      },
    }), `architecture-review: ${label}`)
  }

  register('exact', ARCHITECTURE_REVIEW_WORKSPACE_PATH, 'workspace route')
  register('exact', ARCHITECTURE_REVIEW_REVIEWS_PATH, 'review collection route')
  // Exact routes win before prefix routes. The API prefix carries review
  // details and the local workflow endpoints (artifacts, operations, pages,
  // findings, decisions, lint, and export) without relying on private Host
  // APIs.
  register('prefix', '/api/architecture-review', 'review workflow routes')
}

/** Local, file-backed primitives for an Architecture Review workspace. */

import constants from 'node:constants'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { extractText, getDocumentProxy } from 'unpdf'
import {
  ARCHITECTURE_REVIEW_EXPORT_PATH,
  ARCHITECTURE_REVIEW_EXPERTS_PATH,
  ARCHITECTURE_REVIEW_ARTIFACTS_PATH,
  ARCHITECTURE_REVIEW_FINDINGS_PATH,
  ARCHITECTURE_REVIEW_OPERATIONS_PATH,
  ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH,
  ARCHITECTURE_REVIEW_PAGES_PATH,
  ARCHITECTURE_REVIEW_REVIEWS_PATH,
  ARCHITECTURE_REVIEW_REVIEW_PREFIX,
  ARCHITECTURE_REVIEW_WORKSPACE_PATH,
  ARCHITECTURE_REVIEW_RULE_IDS,
  ARCHITECTURE_REVIEW_STANDARDS_PATH,
  DEFAULT_ARCHITECTURE_REVIEW_RULE_IDS,
  type ArchitectureReviewArtifact,
  type ArchitectureReviewExpertCatalog,
  type ArchitectureReviewRun,
  type ArchitectureReviewExpertTask,
  type ArchitectureReviewCandidate,
  type ArchitectureReviewArtifactContent,
  type ArchitectureReviewRuleId,
  type ArchitectureReviewSource,
  type ArchitectureReviewFinding,
  type ArchitectureReviewFindingStatus,
  type ArchitectureReviewOperation,
  type ArchitectureReviewPageSummary,
  type ArchitectureReviewSummary,
  type ArchitectureReviewWorkspaceSnapshot,
  type CreateReviewInput,
  type ImportArtifactInput,
  type ReviewExpertsInput,
} from './architecture-review-contract.ts'

export {
  ARCHITECTURE_REVIEW_EXPORT_PATH,
  ARCHITECTURE_REVIEW_EXPERTS_PATH,
  ARCHITECTURE_REVIEW_ARTIFACTS_PATH,
  ARCHITECTURE_REVIEW_FINDINGS_PATH,
  ARCHITECTURE_REVIEW_OPERATIONS_PATH,
  ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH,
  ARCHITECTURE_REVIEW_PAGES_PATH,
  ARCHITECTURE_REVIEW_REVIEWS_PATH,
  ARCHITECTURE_REVIEW_REVIEW_PREFIX,
  ARCHITECTURE_REVIEW_WORKSPACE_PATH,
  ARCHITECTURE_REVIEW_WORKSPACE_INIT_PATH,
  ARCHITECTURE_REVIEW_STANDARDS_PATH,
} from './architecture-review-contract.ts'

const MAX_BODY_BYTES = 32 * 1024
const MAX_ARTIFACT_BODY_BYTES = 8 * 1024 * 1024
const MAX_PATH_BYTES = 4096
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
const MAX_PAGE_BYTES = 512 * 1024
const MAX_PDF_PAGES = 100
const MAX_EXPERT_CATALOG_BYTES = 128 * 1024
const MAX_RUN_BYTES = 512 * 1024
const EXPERT_CATALOG_PATH = 'wiki/synthesis/architecture-review-experts.json'

const TEXT_ARTIFACT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.openapi'])
const BINARY_ARTIFACT_EXTENSIONS = new Set(['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp'])
interface PdfText {
  readonly content: string | null
  readonly pageCount: number
}
const FINDING_STATUSES: readonly ArchitectureReviewFindingStatus[] = [
  'proposed', 'confirmed', 'in-progress', 'resolved', 'accepted-risk', 'rejected',
]
const FINDING_TRANSITIONS: Record<ArchitectureReviewFindingStatus, readonly ArchitectureReviewFindingStatus[]> = {
  proposed: ['confirmed', 'accepted-risk', 'rejected'],
  confirmed: ['in-progress', 'accepted-risk', 'rejected'],
  'in-progress': ['resolved', 'accepted-risk', 'rejected'],
  resolved: ['proposed'],
  'accepted-risk': ['proposed'],
  rejected: ['proposed'],
}
const CANDIDATE_STATUS_LABELS: Record<ArchitectureReviewCandidate['status'], string> = {
  proposed: '待判断',
  confirmed: '已认定为问题',
  rejected: '已判定不成立',
  'needs-evidence': '待补充证据',
  'accepted-risk': '已接受风险',
}

function ensureSafeAbsolutePath(value: string): string {
  if (!isAbsolute(value) || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new Error('workspace path must be an absolute, bounded path')
  }
  if (process.platform === 'win32' && value.startsWith('\\\\')) {
    throw new Error('UNC workspace paths are not supported')
  }
  return resolve(value)
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function ensureNoSymlinkAncestors(path: string): Promise<void> {
  const chain: string[] = []
  let current = resolve(path)
  for (;;) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const candidate of chain.reverse()) {
    try {
      const info = await lstat(candidate)
      if (info.isSymbolicLink()) throw new Error('workspace path may not traverse symlinks')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw cause
    }
  }
}

async function countFiles(root: string): Promise<number> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) count += await countFiles(path)
    else if (entry.isFile()) count += 1
  }
  return count
}

async function ensureRealDirectory(path: string, root: string): Promise<void> {
  if (!within(root, path)) throw new Error('workspace path escaped root')
  const chain: string[] = []
  let current = resolve(path)
  while (current !== root) {
    chain.push(current)
    current = dirname(current)
  }
  chain.push(root)
  for (const directory of chain.reverse()) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('workspace contains an unsafe symbolic link')
    }
  }
}

function yamlValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null
}

function validRuleIds(value: unknown): value is readonly ArchitectureReviewRuleId[] {
  return Array.isArray(value) && value.length > 0 && value.length <= ARCHITECTURE_REVIEW_RULE_IDS.length
    && value.every((id: unknown) => typeof id === 'string' && ARCHITECTURE_REVIEW_RULE_IDS.includes(id as ArchitectureReviewRuleId))
    && new Set(value).size === value.length
}

function expertCatalog(value: unknown): value is ArchitectureReviewExpertCatalog {
  const catalog = objectValue(value)
  if (catalog?.version !== 1 || typeof catalog.generatedAt !== 'string' || !Number.isFinite(Date.parse(catalog.generatedAt))
    || typeof catalog.limitations !== 'string' || !Array.isArray(catalog.basis) || catalog.basis.length > 20
    || !catalog.basis.every(item => typeof item === 'string' && item.length <= 300)
    || !Array.isArray(catalog.experts) || catalog.experts.length === 0 || catalog.experts.length > 20) return false
  const ids = new Set<string>()
  return catalog.experts.every(item => {
    const expert = objectValue(item)
    if (expert === null || typeof expert.id !== 'string' || !/^[a-z][a-z0-9-]{1,49}$/u.test(expert.id)
      || ids.has(expert.id) || !['name', 'focus', 'role', 'baseline', 'boundaries'].every(key =>
        typeof expert[key] === 'string' && (expert[key] as string).length > 0 && (expert[key] as string).length <= 1000)
      || !Array.isArray(expert.capabilities) || !Array.isArray(expert.responsibilities)
      || expert.capabilities.length < 1 || expert.capabilities.length > 12
      || expert.responsibilities.length < 1 || expert.responsibilities.length > 12
      || ![...expert.capabilities, ...expert.responsibilities].every(text => typeof text === 'string' && text.length > 0 && text.length <= 500)
      || !Array.isArray(expert.sources) || expert.sources.length < 1 || expert.sources.length > 12) return false
    ids.add(expert.id)
    return expert.sources.every(source => {
      const citation = objectValue(source)
      return citation !== null && typeof citation.path === 'string'
        && /^(wiki|raw)\/[^\\\0\r\n]+\.md$/u.test(citation.path)
        && citation.path.length <= 400
        && citation.path.split('/').every(segment => segment !== '.' && segment !== '..' && segment !== '')
        && typeof citation.detail === 'string' && citation.detail.length > 0 && citation.detail.length <= 300
    })
  })
}

function reviewRuleIds(text: string): readonly ArchitectureReviewRuleId[] {
  try {
    const value = JSON.parse(yamlValue(text, 'rule_ids') ?? 'null') as unknown
    if (validRuleIds(value)) return value
  } catch {
    // Older reviews have no stored selection.
  }
  return DEFAULT_ARCHITECTURE_REVIEW_RULE_IDS
}

function validExpertIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 20
    && value.every((id: unknown) => typeof id === 'string' && /^[a-z][a-z0-9-]{1,49}$/u.test(id))
    && new Set(value).size === value.length
}

function reviewExperts(text: string): ReviewExpertsInput & { subagentMode: boolean } {
  try {
    const ids: unknown = JSON.parse(yamlValue(text, 'expert_ids') ?? '[]')
    return { expertIds: validExpertIds(ids) ? ids : [], subagentMode: true }
  } catch {
    return { expertIds: [], subagentMode: true }
  }
}

function validBasisPaths(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 30 && new Set(value).size === value.length
    && value.every((path: unknown) => typeof path === 'string' && path.length <= 500
      && /^raw\/sources\/standards\/(?:[^/\\.][^/\\]*\/)*[^/\\.][^/\\]*\.md$/iu.test(path)
      && path.split('/').every(part => part !== '.' && part !== '..'))
}

function expertBasisPaths(catalog: ArchitectureReviewExpertCatalog | null, expertIds: readonly string[]): readonly string[] {
  if (catalog === null) return []
  const selected = new Set(expertIds)
  return [...new Set(catalog.experts.filter(expert => selected.has(expert.id))
    .flatMap(expert => expert.sources.map(source => source.path))
    .filter(path => validBasisPaths([path])))]
}

function readWorkspaceSelection(path: string): string | undefined {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PATH_BYTES + 128) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as { path?: unknown }
    return typeof value.path === 'string' ? ensureSafeAbsolutePath(value.path) : undefined
  } catch {
    return undefined
  }
}

async function readRegularFileNoFollow(path: string, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('workspace audit log must be a regular file')
  }
  if (before.size > maxBytes) throw new Error('workspace file is too large')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    const after = await lstat(path)
    if (!opened.isFile() || !after.isFile() || after.isSymbolicLink()
      || opened.dev !== after.dev || opened.ino !== after.ino || opened.size > maxBytes) {
      throw new Error('workspace audit log changed while opening')
    }
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

async function readRegularBufferNoFollow(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('workspace file must be a regular file')
  }
  if (before.size > maxBytes) throw new Error('workspace file is too large')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    const after = await lstat(path)
    if (!opened.isFile() || !after.isFile() || after.isSymbolicLink()
      || opened.dev !== after.dev || opened.ino !== after.ino || opened.size > maxBytes) {
      throw new Error('workspace file changed while opening')
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** Publish an immutable source by linking a complete sibling into place. */
async function writeImmutableFile(path: string, content: Buffer): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    // A hard-link publish is atomic and exclusive on the filesystems DSH
    // supports; it never overwrites an existing source with a partial file.
    await link(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function operationId(): string {
  return `OP-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`
}

function safeArtifactName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 200 || name.includes('\0') || name.includes('/') || name.includes('\\')
    || name === '.' || name === '..' || basename(name) !== name || name.endsWith('.') || name.endsWith(' ')
    || (process.platform === 'win32' && name.includes(':'))) {
    throw new Error('artifact name must be a simple file name')
  }
  const extension = extname(name).toLowerCase()
  if (!TEXT_ARTIFACT_EXTENSIONS.has(extension) && !BINARY_ARTIFACT_EXTENSIONS.has(extension)) {
    throw new Error('artifact type is not supported')
  }
  return name
}

function decodeArtifact(input: ImportArtifactInput): { name: string; content: Buffer; parseStatus: 'ready' | 'stored-only' } {
  const name = safeArtifactName(input.name)
  if ((input.content === undefined) === (input.contentBase64 === undefined)) {
    throw new Error('artifact content or contentBase64 is required')
  }
  let content: Buffer
  if (input.content !== undefined) {
    content = Buffer.from(input.content, 'utf8')
  } else {
    const encoded = input.contentBase64!.replace(/\s+/gu, '')
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
      throw new Error('contentBase64 must be valid base64')
    }
    content = Buffer.from(encoded, 'base64')
  }
  if (content.byteLength > MAX_ARTIFACT_BYTES) throw new Error('artifact is too large')
  const parseStatus = TEXT_ARTIFACT_EXTENSIONS.has(extname(name).toLowerCase()) ? 'ready' : 'stored-only'
  return { name, content, parseStatus }
}

async function regularFiles(root: string): Promise<string[]> {
  const result: string[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw cause
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(...await regularFiles(path))
    else if (entry.isFile() && !entry.isSymbolicLink()) result.push(path)
  }
  return result
}

export class ArchitectureReviewService {
  private workspaceRoot: string | null
  private createTail: Promise<void> = Promise.resolve()
  private readonly pdfTextCache = new Map<string, Promise<PdfText>>()

  constructor(initialRoot?: string, private readonly selectionPath?: string) {
    const selected = initialRoot ?? (selectionPath === undefined ? undefined : readWorkspaceSelection(selectionPath))
    this.workspaceRoot = selected === undefined ? null : ensureSafeAbsolutePath(selected)
  }

  get root(): string | null {
    return this.workspaceRoot
  }

  async init(root: string): Promise<ArchitectureReviewWorkspaceSnapshot> {
    const target = ensureSafeAbsolutePath(root)
    await ensureNoSymlinkAncestors(target)
    await mkdir(target, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(target)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('workspace root must be a real directory')
    }
    const previousRoot = this.workspaceRoot
    this.workspaceRoot = target
    try {
      const directories = [
        'raw/sources/reviews',
        'raw/sources/standards',
        'raw/assets',
        'wiki/standards',
        'wiki/entities',
        'wiki/concepts',
        'wiki/reviews',
        'wiki/synthesis',
        '.wiki-tmp',
        'exports',
      ]
      for (const directory of directories) {
        const directoryPath = join(target, directory)
        await mkdir(directoryPath, { recursive: true, mode: 0o700 })
        await ensureRealDirectory(directoryPath, target)
      }
      await this.ensureFile('purpose.md', '# Architecture Review Workspace\n')
      await this.ensureFile('AGENTS.md', '# Workspace rules\n\nUse `/architecture-review-knowledge` for knowledge maintenance, source-backed questions, and review evidence checks. Raw sources are immutable. Review findings require human confirmation in the workbench.\n')
      await this.ensureFile('.wiki-schema.md', '# Wiki schema\n\n- `raw/` contains original sources; never modify them. `wiki/` contains maintained Markdown.\n- `wiki/index.md` links to maintained pages with one-line descriptions; `wiki/log.md` records dated ingest, query synthesis, and lint actions.\n- Use `wiki/entities/`, `wiki/concepts/`, `wiki/standards/`, and `wiki/synthesis/` for durable knowledge; `wiki/reviews/<id>/` stores review-specific outputs.\n- Cite original paths with the review/version and a precise section, line, or short quotation. Label unsupported or unreadable claims as unverified.\n- Link related wiki pages and record contradictions or superseded statements instead of silently replacing claims.\n')
      await this.ensureFile('wiki/index.md', '# Architecture Reviews\n')
      await this.ensureFile('wiki/log.md', '')
      if (this.selectionPath !== undefined) {
        await mkdir(dirname(this.selectionPath), { recursive: true, mode: 0o700 })
        await writeFileAtomic(this.selectionPath, `${JSON.stringify({ path: target })}\n`, { mode: 0o600, dirMode: 0o700 })
      }
      return this.snapshot()
    } catch (cause) {
      this.workspaceRoot = previousRoot
      throw cause
    }
  }

  async snapshot(): Promise<ArchitectureReviewWorkspaceSnapshot> {
    if (this.workspaceRoot === null) {
      return { initialized: false, root: null, reviewCount: 0, sourceCount: 0, wikiCount: 0 }
    }
    const markerPaths = ['purpose.md', '.wiki-schema.md', 'wiki/index.md']
    let initialized = true
    try {
      await ensureRealDirectory(this.workspaceRoot, this.workspaceRoot)
      for (const marker of markerPaths) {
        const info = await lstat(join(this.workspaceRoot, marker))
        if (!info.isFile() || info.isSymbolicLink()) {
          initialized = false
          break
        }
      }
    } catch {
      initialized = false
    }
    if (!initialized) {
      return { initialized: false, root: this.workspaceRoot, reviewCount: 0, sourceCount: 0, wikiCount: 0 }
    }
    const reviews = await this.listReviews()
    return {
      initialized: true,
      root: this.workspaceRoot,
      reviewCount: reviews.length,
      sourceCount: await countFiles(join(this.workspaceRoot, 'raw/sources')),
      wikiCount: await countFiles(join(this.workspaceRoot, 'wiki')),
    }
  }

  async listReviews(): Promise<readonly ArchitectureReviewSummary[]> {
    if (this.workspaceRoot === null) return []
    const catalog = await this.getExpertCatalog()
    const root = join(this.workspaceRoot, 'wiki/reviews')
    await ensureRealDirectory(root, this.workspaceRoot)
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const reviews: ArchitectureReviewSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^AR-\d{3,}$/.test(entry.name)) continue
      const directory = join(root, entry.name)
      const file = join(directory, 'review.md')
      try {
        await ensureRealDirectory(directory, this.workspaceRoot)
        const fileInfo = await lstat(file)
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) continue
        const text = await readFile(file, 'utf8')
        const run = await this.readRun(entry.name)
        const storedStatus = yamlValue(text, 'status') ?? 'draft'
        const experts = reviewExperts(text)
        reviews.push({
          reviewId: entry.name,
          version: yamlValue(text, 'version') ?? 'v1',
          title: yamlValue(text, 'title') ?? entry.name,
          status: storedStatus === 'human-review' && run === null ? 'prechecked' : storedStatus,
          path: `wiki/reviews/${entry.name}/review.md`,
          updatedAt: yamlValue(text, 'updated_at'),
          ruleIds: reviewRuleIds(text),
          basisPaths: expertBasisPaths(catalog, experts.expertIds),
          ...experts,
          run,
        })
      } catch {
        // Incomplete review directories are reserved but do not appear in lists.
      }
    }
    return reviews.sort((a, b) => a.reviewId.localeCompare(b.reviewId))
  }

  async getReview(reviewId: string): Promise<ArchitectureReviewSummary | null> {
    if (!/^AR-\d{3,}$/.test(reviewId)) return null
    return (await this.listReviews()).find(item => item.reviewId === reviewId) ?? null
  }

  private async nextReviewNumber(entries: readonly { name: string }[]): Promise<number> {
    const path = join(this.requireRoot(), '.review-sequence')
    await this.assertNoSymlinkPath(path)
    let reserved = 1
    try {
      const value = (await readRegularFileNoFollow(path, 32)).trim()
      if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('review sequence is invalid')
      reserved = Number(value)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    const highest = entries.reduce((max, entry) => {
      const match = /^AR-(\d{3,})$/u.exec(entry.name)
      return match === null ? max : Math.max(max, Number(match[1]))
    }, 0)
    const next = Math.max(reserved, highest + 1)
    if (!Number.isSafeInteger(next + 1)) throw new Error('review sequence is exhausted')
    return next
  }

  private async reserveReviewNumber(next: number): Promise<void> {
    const path = join(this.requireRoot(), '.review-sequence')
    await this.assertNoSymlinkPath(path)
    await writeFileAtomic(path, `${next}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  async createReview(input: CreateReviewInput): Promise<ArchitectureReviewSummary> {
    const run = this.createTail.then(async () => {
      if (this.workspaceRoot === null) throw new Error('workspace is not initialized')
      const reviewsRoot = join(this.workspaceRoot, 'wiki/reviews')
      await ensureRealDirectory(reviewsRoot, this.workspaceRoot)
      // The in-memory queue protects one Host instance; this lock also
      // serializes numbering when multiple DSH processes share a workspace.
      return withFileLock(reviewsRoot, () => this.createReviewUnsafe(input), { waitMs: 10_000 })
    })
    this.createTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async createReviewUnsafe(input: CreateReviewInput): Promise<ArchitectureReviewSummary> {
    if (this.workspaceRoot === null) throw new Error('workspace is not initialized')
    const title = input.title.trim()
    const ruleIds = input.ruleIds ?? DEFAULT_ARCHITECTURE_REVIEW_RULE_IDS
    const expertIds = input.expertIds ?? []
    const subagentMode = true
    if (!validRuleIds(ruleIds)) throw new Error('ruleIds must contain selected review categories')
    await this.validateReviewExperts({ expertIds, subagentMode })
    const basisPaths = expertBasisPaths(await this.getExpertCatalog(), expertIds)
    if (!title || title.length > 200) {
      throw new Error('title is required and must be <= 200 characters')
    }
    const reviewsRoot = join(this.workspaceRoot, 'wiki/reviews')
    await ensureRealDirectory(reviewsRoot, this.workspaceRoot)
    const entries = await readdir(reviewsRoot, { withFileTypes: true })
    let next = await this.nextReviewNumber(entries)
    let reviewId: string
    let dir: string
    for (;;) {
      reviewId = `AR-${String(next).padStart(3, '0')}`
      dir = join(reviewsRoot, reviewId)
      if (!within(this.workspaceRoot, dir)) throw new Error('invalid review path')
      await this.assertNoSymlinkPath(dir)
      await this.reserveReviewNumber(next + 1)
      try {
        await mkdir(dir, { mode: 0o700 })
        break
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
        // A non-cooperating writer may have reserved the number after the
        // directory scan. Treat it like an incomplete reservation and retry.
        next += 1
      }
    }
    await mkdir(join(dir, 'v1'), { mode: 0o700 })
    await this.assertNoSymlinkPath(join(dir, 'v1'))
    const updatedAt = new Date().toISOString()
    const content = `---\nreview_id: ${reviewId}\nversion: v1\nstatus: draft\ntitle: ${JSON.stringify(title)}\nsystem_name: ${JSON.stringify(input.systemName?.trim() ?? '')}\ntype: ${JSON.stringify(input.type?.trim() ?? 'new-system')}\nowner: ${JSON.stringify(input.owner?.trim() ?? '')}\nrule_ids: ${JSON.stringify(ruleIds)}\nbasis_paths: ${JSON.stringify(basisPaths)}\nexpert_ids: ${JSON.stringify(expertIds)}\nsubagent_mode: ${subagentMode}\nupdated_at: ${updatedAt}\n---\n\n# ${title}\n\n${input.description?.trim() ?? ''}\n`
    await writeFileAtomic(join(dir, 'review.md'), content, { mode: 0o600, dirMode: 0o700 })
    await this.appendFileAtomic('wiki/log.md', `${updatedAt} create review ${reviewId}\n`)
    return {
      reviewId,
      version: 'v1',
      title,
      status: 'draft',
      path: `wiki/reviews/${reviewId}/review.md`,
      updatedAt,
      ruleIds,
      basisPaths,
      expertIds,
      subagentMode,
    }
  }

  async deleteReview(reviewId: string): Promise<{ reviewId: string }> {
    const root = this.requireRoot()
    const reviewsRoot = join(root, 'wiki/reviews')
    await ensureRealDirectory(reviewsRoot, root)
    return withFileLock(reviewsRoot, async () => {
      const review = await this.requireReview(reviewId)
      if (review.run?.status === 'starting' || review.run?.status === 'reviewing' || review.status === 'reviewing') {
        throw new Error('expert review is running')
      }
      const reviewDirectory = join(reviewsRoot, reviewId)
      const sourcesDirectory = join(root, 'raw/sources/reviews', reviewId)
      await this.assertNoSymlinkPath(reviewDirectory)
      await this.assertNoSymlinkPath(sourcesDirectory)
      await ensureRealDirectory(reviewDirectory, root)
      await this.reserveReviewNumber(await this.nextReviewNumber(await readdir(reviewsRoot, { withFileTypes: true })))
      await rm(sourcesDirectory, { recursive: true, force: true })
      await rm(reviewDirectory, { recursive: true })
      for (const operation of await this.listOperations()) {
        if (operation.reviewId !== reviewId) continue
        const path = join(root, '.wiki-tmp/operations', `${operation.operationId}.json`)
        await this.assertNoSymlinkPath(path)
        await rm(path)
      }
      await this.appendFileAtomic('wiki/log.md', `${new Date().toISOString()} delete review ${reviewId}\n`)
      return { reviewId }
    }, { waitMs: 10_000 })
  }

  private async validateReviewExperts(input: ReviewExpertsInput): Promise<void> {
    if (!validExpertIds(input.expertIds)) throw new Error('selected expert IDs are invalid')
    if (input.expertIds.length === 0) return
    const catalog = await this.getExpertCatalog()
    if (catalog === null || input.expertIds.some(id => !catalog.experts.some(expert => expert.id === id))) {
      throw new Error('selected expert IDs must exist in the current catalog')
    }
  }

  async updateReviewExperts(reviewId: string, input: ReviewExpertsInput): Promise<ArchitectureReviewSummary> {
    await this.requireReview(reviewId)
    if (['starting', 'reviewing'].includes((await this.readRun(reviewId))?.status ?? '')) throw new Error('expert review is running')
    if (input.expertIds.length === 0) throw new Error('selected experts are required')
    await this.validateReviewExperts(input)
    const basisPaths = expertBasisPaths(await this.getExpertCatalog(), input.expertIds)
    const root = this.requireRoot()
    const path = join(root, 'wiki/reviews', reviewId, 'review.md')
    await withFileLock(path, async () => {
      const text = await readRegularFileNoFollow(path, MAX_PAGE_BYTES)
      const updatedAt = new Date().toISOString()
      const metadata = `expert_ids: ${JSON.stringify(input.expertIds)}\nsubagent_mode: true\nbasis_paths: ${JSON.stringify(basisPaths)}\n`
      const updated = text.replace(/^expert_ids:.*\n|^subagent_mode:.*\n|^basis_paths:.*\n/gmu, '')
        .replace(/^(updated_at:).+$/mu, `${metadata}$1 ${updatedAt}`)
      if (updated === text || !updated.includes('---\n')) throw new Error('review metadata is invalid')
      await writeFileAtomic(path, updated, { mode: 0o600, dirMode: 0o700 })
    }, { waitMs: 10_000 })
    await this.appendFileAtomic('wiki/log.md', `${new Date().toISOString()} select review experts ${reviewId}: ${input.expertIds.join(',')}\n`)
    return this.requireReview(reviewId)
  }

  async listStandards(): Promise<readonly { path: string; sha256: string }[]> {
    const root = this.requireRoot()
    const paths = (await regularFiles(join(root, 'raw/sources/standards'))).filter(path => extname(path).toLowerCase() === '.md')
    return Promise.all(paths.map(async path => ({ path: relative(root, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(await readRegularBufferNoFollow(path, MAX_ARTIFACT_BYTES)).digest('hex') })))
  }

  private pdfText(sha256: string, content: Buffer): Promise<PdfText> {
    const cached = this.pdfTextCache.get(sha256)
    if (cached !== undefined) return cached
    const extraction = (async (): Promise<PdfText> => {
      try {
        const pdf = await getDocumentProxy(new Uint8Array(content))
        if (pdf.numPages > MAX_PDF_PAGES) return { content: null, pageCount: pdf.numPages }
        const result = await extractText(pdf)
        const pages = Array.isArray(result.text) ? result.text : [result.text]
        if (!pages.some(page => page.trim())) return { content: null, pageCount: result.totalPages }
        const text = pages.map((page, index) => `## 第 ${index + 1} 页\n\n${page.trim()}`).join('\n\n')
        return { content: Buffer.byteLength(text, 'utf8') <= MAX_PAGE_BYTES ? text : null, pageCount: result.totalPages }
      } catch {
        return { content: null, pageCount: 0 }
      }
    })()
    this.pdfTextCache.set(sha256, extraction)
    if (this.pdfTextCache.size > 32) this.pdfTextCache.delete(this.pdfTextCache.keys().next().value!)
    return extraction
  }

  async importArtifact(reviewId: string, input: ImportArtifactInput): Promise<ArchitectureReviewArtifact> {
    const review = await this.getReview(reviewId)
    if (review === null) throw new Error('review not found')
    if (['starting', 'reviewing'].includes(review.run?.status ?? '')) throw new Error('expert review is running')
    const root = this.requireRoot()
    const decoded = decodeArtifact(input)
    const directory = join(root, 'raw/sources/reviews', reviewId, review.version)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await ensureRealDirectory(directory, root)
    const target = join(directory, decoded.name)
    await this.assertNoSymlinkPath(target)
    try {
      await lstat(target)
      throw new Error('artifact already exists')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    await writeImmutableFile(target, decoded.content)
    await this.assertNoSymlinkPath(target)
    const relativePath = `raw/sources/reviews/${reviewId}/${review.version}/${decoded.name}`
    const sha256 = createHash('sha256').update(decoded.content).digest('hex')
    const artifact: ArchitectureReviewArtifact = {
      name: decoded.name,
      path: relativePath,
      size: decoded.content.byteLength,
      sha256,
      parseStatus: extname(decoded.name).toLowerCase() !== '.pdf' ? decoded.parseStatus
        : (await this.pdfText(sha256, decoded.content)).content === null ? 'stored-only' : 'ready',
    }
    await this.appendFileAtomic('wiki/log.md', `${new Date().toISOString()} import artifact ${relativePath}\n`)
    return artifact
  }

  async ingestReview(reviewId: string): Promise<ArchitectureReviewOperation> {
    return this.executeOperation('ingest', reviewId, async () => {
      const artifacts = await this.listArtifacts(reviewId)
      const root = this.requireRoot()
      const directory = join(root, 'wiki/reviews', reviewId)
      await ensureRealDirectory(directory, root)
      const sourceLines: string[] = []
      for (const artifact of artifacts) {
        let extracted = ''
        if (extname(artifact.name).toLowerCase() === '.pdf' && artifact.parseStatus === 'ready') {
          const original = await readRegularBufferNoFollow(join(root, artifact.path), MAX_ARTIFACT_BYTES)
          const text = await this.pdfText(artifact.sha256, original)
          if (text.content !== null) {
            const textDirectory = join(directory, 'extracted')
            await mkdir(textDirectory, { recursive: true, mode: 0o700 })
            await ensureRealDirectory(textDirectory, root)
            const textPath = `wiki/reviews/${reviewId}/extracted/${artifact.sha256}.md`
            await writeFileAtomic(join(root, textPath), `# ${artifact.name} - 自动提取文字\n\n原件：\`${artifact.path}\`\n页数：${text.pageCount}\n\n> 文字层提取结果；图表、签章和排版请核对 PDF 原件。\n\n${text.content}\n`, { mode: 0o600, dirMode: 0o700 })
            extracted = `；文字稿：\`${textPath}\``
          }
        }
        sourceLines.push(`- \`${artifact.path}\` (${artifact.size} bytes, SHA-256 \`${artifact.sha256}\`, ${artifact.parseStatus})${extracted}`)
      }
      const lines = [
        `# ${reviewId} 资料摘要`,
        '',
        `资料数量：${artifacts.length}`,
        '',
        ...sourceLines,
        '',
        'PDF 有可提取文字时会生成带页码的文字稿；扫描版 PDF、DOCX 和图片需另附可读取的文本资料。文字稿不能替代原件中的图表、签章和排版核对。',
        '',
      ]
      await writeFileAtomic(join(directory, 'sources.md'), lines.join('\n'), { mode: 0o600, dirMode: 0o700 })
      await this.appendFileAtomic('wiki/log.md', `${new Date().toISOString()} ingest review ${reviewId}\n`)
      return { artifactCount: artifacts.length, mode: 'local-summary' }
    })
  }

  async listArtifactsForReview(reviewId: string): Promise<readonly ArchitectureReviewArtifact[]> {
    return this.listArtifacts(reviewId)
  }

  async artifactContent(reviewId: string, fileName: string): Promise<ArchitectureReviewArtifactContent> {
    const review = await this.requireReview(reviewId)
    const name = safeArtifactName(fileName)
    const root = this.requireRoot()
    const directory = join(root, 'raw/sources/reviews', reviewId, review.version)
    await ensureRealDirectory(directory, root)
    const path = join(directory, name)
    let content: Buffer
    try {
      content = await readRegularBufferNoFollow(path, MAX_ARTIFACT_BYTES)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('artifact not found')
      throw cause
    }
    const isText = TEXT_ARTIFACT_EXTENSIONS.has(extname(name).toLowerCase())
    const pdfText = extname(name).toLowerCase() === '.pdf'
      ? await this.pdfText(createHash('sha256').update(content).digest('hex'), content) : null
    return {
      name,
      path: `raw/sources/reviews/${reviewId}/${review.version}/${name}`,
      size: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      parseStatus: isText || (pdfText !== null && pdfText.content !== null) ? 'ready' : 'stored-only',
      content: isText ? content.subarray(0, MAX_PAGE_BYTES).toString('utf8') : pdfText?.content ?? null,
      truncated: isText && content.byteLength > MAX_PAGE_BYTES,
    }
  }

  async listSources(): Promise<readonly ArchitectureReviewSource[]> {
    const reviews = await this.listReviews()
    return (await Promise.all(reviews.map(async review =>
      (await this.listArtifacts(review.reviewId)).map(artifact => ({ ...artifact, reviewId: review.reviewId }))
    ))).flat()
  }

  async runReview(reviewId: string): Promise<ArchitectureReviewOperation> {
    return this.executeOperation('review', reviewId, async () => {
      const review = await this.requireReview(reviewId)
      if (['starting', 'reviewing'].includes(review.run?.status ?? '')) throw new Error('expert review is running')
      const artifacts = await this.listArtifacts(reviewId)
      const standards = new Set((await this.listStandards()).map(item => item.path))
      const now = new Date().toISOString()
      const findings: ArchitectureReviewFinding[] = []
      if (!artifacts.some(artifact => artifact.parseStatus === 'ready')) {
        const empty = artifacts.length === 0
        findings.push({
          findingId: `${reviewId}-F-001`,
          reviewId,
          title: empty ? '缺少评审资料' : '缺少可读取的评审资料',
          dimension: 'completeness',
          severity: 'Blocker',
          confidence: 'UNVERIFIED',
          status: 'proposed',
          problem: empty ? '当前评审没有导入任何原始资料，无法验证架构设计。' : '已保存的附件没有可提取的文字，无法核对架构设计。',
          recommendation: empty ? '导入架构说明、接口定义、数据模型或部署资料后再开始评审。' : '为扫描版 PDF、DOCX 或图片补充 OCR、Markdown 或 TXT 文本版后重新预检。',
          evidence: [],
          reason: null,
          updatedAt: now,
        })
      }
      const missingStandards = review.basisPaths.filter(path => !standards.has(path))
      if (review.basisPaths.length === 0 || missingStandards.length > 0) {
        findings.push({
          findingId: `${reviewId}-F-${String(findings.length + 1).padStart(3, '0')}`,
          reviewId,
          title: '专家引用的评审规范尚未齐全',
          dimension: 'rules',
          severity: 'Major',
          confidence: 'UNVERIFIED',
          status: 'proposed',
          problem: review.basisPaths.length === 0 ? '所选专家目录未引用工作区中的规范原件。' : `专家引用的规范原件已缺失：${missingStandards.join('、')}。`,
          recommendation: '更新专家目录的规范原件引用，或补齐缺失文件后重新预检。',
          evidence: [],
          reason: null,
          updatedAt: now,
        })
      }
      await this.writeFindings(reviewId, findings)
      await this.writeReviewStatus(reviewId, 'prechecked')
      await this.appendFileAtomic('wiki/log.md', `${now} run local review ${reviewId}\n`)
      return { mode: 'local-check', findingCount: findings.length, artifactCount: artifacts.length, standardCount: standards.size, selectedRuleIds: review.ruleIds }
    })
  }

  private async readRun(reviewId: string): Promise<ArchitectureReviewRun | null> {
    const path = join(this.requireRoot(), 'wiki/reviews', reviewId, 'expert-run.json')
    try {
      const run = JSON.parse(await readRegularFileNoFollow(path, MAX_RUN_BYTES)) as ArchitectureReviewRun
      if (run.reviewId !== reviewId || !Array.isArray(run.experts)) throw new Error('expert run is invalid')
      return run
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
  }

  private async changeRun(reviewId: string, change: (current: ArchitectureReviewRun | null) => Promise<ArchitectureReviewRun>): Promise<ArchitectureReviewRun> {
    await this.requireReview(reviewId)
    const path = join(this.requireRoot(), 'wiki/reviews', reviewId, 'expert-run.json')
    return withFileLock(path, async () => {
      const next = await change(await this.readRun(reviewId))
      await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return next
    }, { waitMs: 10_000 })
  }

  async startExpertReview(reviewId: string): Promise<ArchitectureReviewRun> {
    const review = await this.requireReview(reviewId)
    if (['starting', 'reviewing'].includes(review.run?.status ?? '')) throw new Error('expert review is running')
    const sources = await this.listArtifacts(reviewId)
    if (sources.length === 0 || !sources.some(source => source.parseStatus === 'ready')) throw new Error('readable review material is required')
    if (review.expertIds.length === 0) throw new Error('selected experts are required')
    const catalog = await this.getExpertCatalog()
    if (catalog === null || review.expertIds.some(id => !catalog.experts.some(expert => expert.id === id))) throw new Error('selected expert IDs must exist in the current catalog')
    const root = this.requireRoot()
    if (review.basisPaths.length === 0) throw new Error('selected experts must reference review standards')
    const standards = new Map((await this.listStandards()).map(item => [item.path, item]))
    const selected = review.basisPaths.map(path => {
      const standard = standards.get(path)
      if (standard === undefined) throw new Error(`review standard is missing: ${path}`)
      return standard
    })
    const startedAt = new Date().toISOString()
    await this.ingestReview(reviewId)
    await this.runReview(reviewId)
    const run = await this.changeRun(reviewId, async current => {
      if (current?.status === 'starting' || current?.status === 'reviewing') throw new Error('expert review is running')
      return {
        runId: `RUN-${randomBytes(12).toString('hex')}`, reviewId, status: 'starting', startedAt, finishedAt: null,
        sourceVersion: `${review.version}-${createHash('sha256').update(JSON.stringify(sources.map(source => [source.path, source.sha256]))).digest('hex').slice(0, 12)}`,
        sources, standards: selected, ruleIds: review.ruleIds,
        catalogVersion: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'), sessionId: null,
        experts: review.expertIds.map(expertId => ({ expertId, name: catalog.experts.find(expert => expert.id === expertId)!.name,
          status: 'waiting' as const, sessionId: null, conclusion: null, error: null, updatedAt: startedAt })),
      }
    })
    await writeFileAtomic(join(root, 'wiki/reviews', reviewId, 'candidates.json'), '[]\n', { mode: 0o600, dirMode: 0o700 })
    await this.writeReviewStatus(reviewId, 'reviewing')
    return run
  }

  async bindExpertSession(reviewId: string, runId: string, sessionId: string, expertId?: string): Promise<ArchitectureReviewRun> {
    if (!/^[\w-]{8,128}$/u.test(sessionId)) throw new Error('session ID is invalid')
    return this.changeRun(reviewId, async current => {
      if (current?.runId !== runId || !['starting', 'reviewing'].includes(current.status)) throw new Error('expert run is not active')
      if (expertId === undefined) {
        if (current.sessionId !== null && current.sessionId !== sessionId) throw new Error('expert session already attached')
        return { ...current, status: 'reviewing', sessionId,
          experts: current.experts.map(expert => expert.status === 'waiting' ? { ...expert, sessionId, updatedAt: new Date().toISOString() } : expert) }
      }
      const expert = current.experts.find(item => item.expertId === expertId)
      if (expert?.status !== 'waiting' || expert.sessionId !== null) throw new Error('expert retry is not waiting')
      return { ...current, status: 'reviewing', experts: current.experts.map(item => item.expertId === expertId
        ? { ...item, sessionId, updatedAt: new Date().toISOString() } : item) }
    })
  }

  async retryExpert(reviewId: string, expertId: string): Promise<ArchitectureReviewRun> {
    const run = await this.changeRun(reviewId, async current => {
      if (current?.status !== 'human-review') throw new Error('expert run is not ready for retry')
      if (!current.experts.some(expert => expert.expertId === expertId && expert.status === 'failed')) throw new Error('only failed experts can be retried')
      return { ...current, status: 'reviewing', finishedAt: null, experts: current.experts.map(expert => expert.expertId === expertId
        ? { ...expert, status: 'waiting', sessionId: null, error: null, updatedAt: new Date().toISOString() } : expert) }
    })
    await this.writeReviewStatus(reviewId, 'reviewing')
    return run
  }

  async recordExpertResult(reviewId: string, runId: string, expertId: string, sessionId: string,
    input: { status: 'reviewing' | 'completed' | 'failed'; conclusion: string; error?: string }): Promise<ArchitectureReviewRun> {
    if (input.conclusion.length > 24_000 || (input.error?.length ?? 0) > 1000) throw new Error('expert result is too large')
    const run = await this.changeRun(reviewId, async current => {
      if (current?.runId !== runId || current.status !== 'reviewing') throw new Error('expert run is not active')
      const expert = current.experts.find(item => item.expertId === expertId)
      if (expert?.sessionId !== sessionId || !['waiting', 'reviewing'].includes(expert.status)) throw new Error('expert task is not active')
      const experts: ArchitectureReviewExpertTask[] = current.experts.map(item => item.expertId === expertId
        ? { ...item, status: input.status, conclusion: input.conclusion || null, error: input.error ?? null, updatedAt: new Date().toISOString() } : item)
      const finished = experts.every(item => item.status === 'completed' || item.status === 'failed')
      return { ...current, experts, status: finished ? 'human-review' : 'reviewing', finishedAt: finished ? new Date().toISOString() : null }
    })
    if (input.status === 'completed') await this.mergeCandidates(reviewId, expertId, input.conclusion)
    if (run.status === 'human-review') await this.writeReviewStatus(reviewId, 'human-review')
    return run
  }

  async failExpertLaunch(reviewId: string, runId: string, message: string): Promise<ArchitectureReviewRun> {
    if (!message.trim() || message.length > 1000) throw new Error('failure reason is required')
    const run = await this.changeRun(reviewId, async current => {
      if (current?.runId !== runId || !['starting', 'reviewing'].includes(current.status)) throw new Error('expert run is not active')
      const experts: ArchitectureReviewExpertTask[] = current.experts.map(item => item.status === 'waiting'
        ? { ...item, status: 'failed', error: message, updatedAt: new Date().toISOString() } : item)
      const finished = experts.every(item => item.status === 'completed' || item.status === 'failed')
      return { ...current, experts, status: finished ? 'human-review' : 'reviewing', finishedAt: finished ? new Date().toISOString() : null }
    })
    if (run.status === 'human-review') await this.writeReviewStatus(reviewId, 'human-review')
    return run
  }

  async listCandidates(reviewId: string): Promise<readonly ArchitectureReviewCandidate[]> {
    await this.requireReview(reviewId)
    const path = join(this.requireRoot(), 'wiki/reviews', reviewId, 'candidates.json')
    try { return JSON.parse(await readRegularFileNoFollow(path, MAX_RUN_BYTES)) as ArchitectureReviewCandidate[] }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []; throw cause }
  }

  private async mergeCandidates(reviewId: string, expertId: string, output: string): Promise<void> {
    const path = join(this.requireRoot(), 'wiki/reviews', reviewId, 'candidates.json')
    let issues: Array<{ title: string; opinion: string; evidence?: string[]; counterEvidence?: string[]; limitations?: string[] }> = []
    let structured = false
    try {
      const block = /```(?:json)?\s*([\s\S]*?)```/u.exec(output)?.[1] ?? output
      const parsed = JSON.parse(block) as { issues?: typeof issues }
      if (Array.isArray(parsed.issues)) { issues = parsed.issues; structured = true }
    } catch { /* Preserve unstructured expert output as an unverified candidate. */ }
    if (!structured) issues = [{ title: '待核对专家意见', opinion: output || '专家没有提供可解析的结论', limitations: ['专家未提供结构化问题或可核实证据。'] }]
    if (issues.length === 0) return
    await withFileLock(path, async () => {
      const candidates = [...await this.listCandidates(reviewId)]
      for (const issue of issues.slice(0, 30)) {
        if (typeof issue.title !== 'string' || typeof issue.opinion !== 'string' || !issue.title.trim() || !issue.opinion.trim()) continue
        const title = issue.title.trim().slice(0, 200)
        const existing = candidates.find(item => item.title.toLowerCase() === title.toLowerCase() && item.status === 'proposed')
        const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 500)) : []
        const opinion = { expertId, text: issue.opinion.slice(0, 8000) }
        if (existing === undefined) candidates.push({ candidateId: `C-${randomBytes(6).toString('hex')}`, title, status: 'proposed', expertIds: [expertId],
          opinions: [opinion], evidence: strings(issue.evidence), counterEvidence: strings(issue.counterEvidence), limitations: strings(issue.limitations), reason: null })
        else candidates[candidates.indexOf(existing)] = { ...existing, expertIds: [...existing.expertIds, expertId], opinions: [...existing.opinions, opinion],
          evidence: [...existing.evidence, ...strings(issue.evidence)], counterEvidence: [...existing.counterEvidence, ...strings(issue.counterEvidence)], limitations: [...existing.limitations, ...strings(issue.limitations)] }
      }
      await writeFileAtomic(path, `${JSON.stringify(candidates, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    }, { waitMs: 10_000 })
  }

  async updateCandidate(reviewId: string, candidateId: string, input: { status: ArchitectureReviewCandidate['status']; reason?: string }): Promise<ArchitectureReviewCandidate> {
    await this.requireReview(reviewId)
    const path = join(this.requireRoot(), 'wiki/reviews', reviewId, 'candidates.json')
    return withFileLock(path, async () => {
      const candidates = [...await this.listCandidates(reviewId)]
      const index = candidates.findIndex(item => item.candidateId === candidateId)
      if (index < 0) throw new Error('candidate not found')
      const current = candidates[index]!
      if (input.status === 'confirmed' && current.evidence.length === 0) throw new Error('candidate evidence is required')
      if (input.status !== 'proposed' && !input.reason?.trim()) throw new Error('candidate reason is required')
      const updated = { ...current, status: input.status, reason: input.reason?.trim() || null }
      candidates[index] = updated
      await writeFileAtomic(path, `${JSON.stringify(candidates, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return updated
    }, { waitMs: 10_000 })
  }

  async getOperation(id: string): Promise<ArchitectureReviewOperation | null> {
    if (!/^OP-[a-z0-9]+-[a-f0-9]{10}$/u.test(id)) return null
    const root = this.requireRoot()
    const path = join(root, '.wiki-tmp/operations', `${id}.json`)
    try {
      const value = JSON.parse(await readRegularFileNoFollow(path)) as ArchitectureReviewOperation
      if (value.operationId !== id) return null
      return value
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
  }

  async listOperations(): Promise<readonly ArchitectureReviewOperation[]> {
    const root = this.requireRoot()
    const directory = join(root, '.wiki-tmp/operations')
    const files = (await regularFiles(directory)).filter(path => path.endsWith('.json'))
    const operations: ArchitectureReviewOperation[] = []
    for (const file of files) {
      try {
        const value = JSON.parse(await readRegularFileNoFollow(file, MAX_PAGE_BYTES)) as ArchitectureReviewOperation
        if (/^OP-[a-z0-9]+-[a-f0-9]{10}$/u.test(value.operationId)) operations.push(value)
      } catch {
        // Ignore incomplete operation files; a later run can rebuild them.
      }
    }
    return operations.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  async listFindings(reviewId: string): Promise<readonly ArchitectureReviewFinding[]> {
    await this.requireReview(reviewId)
    return this.readFindings(reviewId)
  }

  async updateFinding(findingId: string, input: { status: ArchitectureReviewFindingStatus; reason?: string }): Promise<ArchitectureReviewFinding> {
    const match = /^(AR-\d{3,})-F-\d{3,}$/u.exec(findingId)
    if (match === null || !FINDING_STATUSES.includes(input.status)) throw new Error('finding status is invalid')
    const reviewId = match[1]!
    await this.requireReview(reviewId)
    const reason = input.reason?.trim() ?? ''
    if ((input.status === 'rejected' || input.status === 'accepted-risk') && !reason) {
      throw new Error('a reason is required for this finding status')
    }
    const findings = [...await this.readFindings(reviewId)]
    const index = findings.findIndex(finding => finding.findingId === findingId)
    if (index < 0) throw new Error('finding not found')
    const current = findings[index]!
    if (!FINDING_TRANSITIONS[current.status].includes(input.status)) throw new Error('finding status transition is invalid')
    if (['confirmed', 'in-progress', 'resolved'].includes(input.status) && current.evidence.length === 0) {
      throw new Error('finding evidence is required for confirmation')
    }
    const updated: ArchitectureReviewFinding = {
      ...current,
      status: input.status,
      reason: reason || (input.status === 'proposed' ? null : current.reason),
      updatedAt: new Date().toISOString(),
    }
    findings[index] = updated
    await this.writeFindings(reviewId, findings)
    return updated
  }

  async createDecision(reviewId: string, input: { result: 'approved' | 'conditional' | 'changes-requested' | 'rejected'; reason?: string }): Promise<{ reviewId: string; decisionPath: string; reportPath: string }> {
    const review = await this.requireReview(reviewId)
    const run = review.run
    if (run?.status !== 'human-review') throw new Error('finish expert review before creating a decision')
    if (!['approved', 'conditional', 'changes-requested', 'rejected'].includes(input.result)) {
      throw new Error('decision result is invalid')
    }
    const reason = input.reason?.trim() ?? ''
    if ((input.result === 'rejected' || input.result === 'changes-requested') && !reason) {
      throw new Error('a reason is required for a rejected or changes-requested decision')
    }
    const failures = run.experts.filter(expert => expert.status !== 'completed')
    if (failures.length > 0 && !reason) throw new Error('incomplete expert review requires a reason')
    if (input.result === 'approved' && failures.length > 0) throw new Error('unreserved approval requires all experts')
    const currentSources = await this.listArtifacts(reviewId)
    if (JSON.stringify(currentSources) !== JSON.stringify(run.sources)) throw new Error('review materials changed; start a new expert review')
    if (JSON.stringify(review.basisPaths) !== JSON.stringify(run.standards.map(item => item.path))) throw new Error('review basis changed; start a new expert review')
    if (JSON.stringify(review.expertIds) !== JSON.stringify(run.experts.map(item => item.expertId))) throw new Error('selected experts changed; start a new expert review')
    for (const standard of run.standards) {
      const current = await readRegularBufferNoFollow(join(this.requireRoot(), standard.path), MAX_ARTIFACT_BYTES)
      if (createHash('sha256').update(current).digest('hex') !== standard.sha256) throw new Error('review standards changed; start a new expert review')
    }
    if (input.result === 'approved' && run.sources.some(source => source.parseStatus !== 'ready')) throw new Error('unreserved approval requires readable originals')
    const candidates = await this.listCandidates(reviewId)
    if (candidates.some(item => item.status === 'proposed' || item.status === 'needs-evidence')) throw new Error('candidate issues require human handling')
    if (input.result === 'approved' && candidates.some(item => item.limitations.length > 0 || !item.evidence.some(evidence => run.sources.some(source => evidence.includes(source.path))))) {
      throw new Error('unreserved approval requires verified original evidence')
    }
    const findings = await this.readFindings(reviewId)
    const unresolvedBlocker = findings.some(finding => finding.severity === 'Blocker'
      && !['resolved', 'accepted-risk', 'rejected'].includes(finding.status))
    if (unresolvedBlocker) throw new Error('unconfirmed Blocker findings must be resolved before a decision')
    const root = this.requireRoot()
    const directory = join(root, 'wiki/reviews', reviewId)
    const updatedAt = new Date().toISOString()
    const decisionPath = `wiki/reviews/${reviewId}/decision.md`
    const reportPath = `wiki/reviews/${reviewId}/report.md`
    const decision = `---\nreview_id: ${reviewId}\nstatus: ${input.result}\nupdated_at: ${updatedAt}\n---\n\n# 架构评审决策\n\n结果：${input.result}\n\n${reason}\n`
    const report = `# 架构评审报告 ${reviewId}\n\n- 决策：${input.result}\n- 更新时间：${updatedAt}\n- 运行 ID：${run.runId}\n- 资料版本：${run.sourceVersion}\n- 资料快照：${run.sources.map(source => `${source.path} (SHA-256 ${source.sha256})`).join('；')}\n- 评审依据：${run.standards.map(item => `${item.path} (SHA-256 ${item.sha256})`).join('；')}\n- 专家目录 SHA-256：${run.catalogVersion}\n- 决策说明：${reason || '无'}\n\n## 专家任务\n\n${run.experts.map(expert => `### ${expert.name} (${expert.expertId})\n\n- 状态：${expert.status}\n- 会话：${expert.sessionId ?? '未启动'}\n- 限制：${expert.error ?? '无'}\n\n${expert.conclusion ?? '无结论'}\n`).join('\n')}\n## 人工处理的候选问题\n\n${candidates.length === 0 ? '未形成候选问题。' : candidates.map(item => `### ${item.title}\n\n- 人工判断：${CANDIDATE_STATUS_LABELS[item.status]}\n- 来源专家：${item.expertIds.join('、')}\n- 支持证据：${item.evidence.join('；') || '无'}\n- 反证：${item.counterEvidence.join('；') || '无'}\n- 未核实限制：${item.limitations.join('；') || '无'}\n- 判断依据：${item.reason ?? '无'}\n\n${item.opinions.map(opinion => `- ${opinion.expertId}：${opinion.text}`).join('\n')}\n`).join('\n')}\n## 本地预检\n\n${findings.length === 0 ? '没有本地预检缺失项。' : findings.map(finding => `### ${finding.title}\n\n- 严重度：${finding.severity}\n- 状态：${finding.status}\n- 证据：${finding.evidence.join(', ') || '无'}\n\n${finding.problem}\n`).join('\n')}\n`
    await writeFileAtomic(join(directory, 'decision.md'), decision, { mode: 0o600, dirMode: 0o700 })
    await writeFileAtomic(join(directory, 'report.md'), report, { mode: 0o600, dirMode: 0o700 })
    await this.writeReviewStatus(reviewId, 'completed')
    await this.appendFileAtomic('wiki/log.md', `${updatedAt} decision ${reviewId} ${input.result}\n`)
    return { reviewId, decisionPath, reportPath }
  }

  async lint(reviewId?: string): Promise<ArchitectureReviewOperation> {
    return this.executeOperation('lint', reviewId ?? null, async () => {
      const root = this.requireRoot()
      const wikiRoot = join(root, 'wiki')
      const files = (await regularFiles(wikiRoot)).filter(path => extname(path).toLowerCase() === '.md')
      const issues: Array<{ path: string; kind: 'broken-link'; target: string }> = []
      for (const file of files) {
        const text = await readRegularFileNoFollow(file)
        const sourceDirectory = dirname(file)
        for (const match of text.matchAll(/\]\(([^)#?]+)(?:[#?][^)]*)?\)/gu)) {
          const target = match[1]?.trim()
          if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('/')) continue
          const candidate = resolve(sourceDirectory, target)
          if (!within(wikiRoot, candidate)) {
            issues.push({ path: relative(wikiRoot, file).replaceAll(sep, '/'), kind: 'broken-link', target })
            continue
          }
          try {
            const info = await lstat(candidate)
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file')
          } catch {
            issues.push({ path: relative(wikiRoot, file).replaceAll(sep, '/'), kind: 'broken-link', target })
          }
        }
      }
      return { issueCount: issues.length, issues }
    })
  }

  async listPages(): Promise<readonly ArchitectureReviewPageSummary[]> {
    const root = this.requireRoot()
    const wikiRoot = join(root, 'wiki')
    const files = (await regularFiles(wikiRoot)).filter(path => extname(path).toLowerCase() === '.md')
    const pages: ArchitectureReviewPageSummary[] = []
    for (const file of files) {
      const relativePath = relative(wikiRoot, file).replaceAll(sep, '/')
      const text = await readRegularFileNoFollow(file, MAX_PAGE_BYTES)
      const title = /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? relativePath
      const info = await lstat(file)
      pages.push({ path: relativePath, title, updatedAt: info.mtime.toISOString() })
    }
    return pages.sort((a, b) => a.path.localeCompare(b.path))
  }

  async getExpertCatalog(): Promise<ArchitectureReviewExpertCatalog | null> {
    const root = this.requireRoot()
    const path = join(root, EXPERT_CATALOG_PATH)
    await ensureRealDirectory(dirname(path), root)
    try {
      const catalog: unknown = JSON.parse(await readRegularFileNoFollow(path, MAX_EXPERT_CATALOG_BYTES))
      if (!expertCatalog(catalog)) throw new Error('expert catalog is invalid; regenerate it from the Wiki')
      return catalog
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
  }

  async pageContent(pagePath: string): Promise<{ path: string; content: string }> {
    const value = pagePath.trim()
    if (!value || value.includes('\\') || value.includes('\0') || isAbsolute(value) || extname(value).toLowerCase() !== '.md') {
      throw new Error('page path must be a relative Markdown path')
    }
    const root = this.requireRoot()
    const wikiRoot = join(root, 'wiki')
    const target = resolve(wikiRoot, value)
    if (!within(wikiRoot, target)) throw new Error('page path escaped wiki root')
    await ensureRealDirectory(dirname(target), root)
    return { path: value.replaceAll('\\', '/'), content: await readRegularFileNoFollow(target, MAX_PAGE_BYTES) }
  }

  async exportReview(reviewId: string): Promise<{ format: 'markdown'; path: string }> {
    const review = await this.requireReview(reviewId)
    if (review.status !== 'completed') throw new Error('finish decision before exporting a report')
    const root = this.requireRoot()
    const source = join(root, 'wiki/reviews', reviewId, 'report.md')
    const content = await readRegularFileNoFollow(source, MAX_PAGE_BYTES)
    const relativePath = `exports/${reviewId}-report.md`
    await writeFileAtomic(join(root, relativePath), content, { mode: 0o600, dirMode: 0o700 })
    await this.appendFileAtomic('wiki/log.md', `${new Date().toISOString()} export ${reviewId} markdown\n`)
    return { format: 'markdown', path: relativePath }
  }

  private requireRoot(): string {
    if (this.workspaceRoot === null) throw new Error('workspace is not initialized')
    return this.workspaceRoot
  }

  private async requireReview(reviewId: string): Promise<ArchitectureReviewSummary> {
    if (!/^AR-\d{3,}$/u.test(reviewId)) throw new Error('review not found')
    const review = await this.getReview(reviewId)
    if (review === null) throw new Error('review not found')
    return review
  }

  private async writeReviewStatus(reviewId: string, status: 'prechecked' | 'reviewing' | 'human-review' | 'completed'): Promise<void> {
    const root = this.requireRoot()
    const path = join(root, 'wiki/reviews', reviewId, 'review.md')
    await withFileLock(path, async () => {
      const text = await readRegularFileNoFollow(path, MAX_PAGE_BYTES)
      if (!/^status: .+$/mu.test(text) || !/^updated_at: .+$/mu.test(text)) throw new Error('review metadata is invalid')
      const updated = text.replace(/^status: .+$/mu, `status: ${status}`)
        .replace(/^updated_at: .+$/mu, `updated_at: ${new Date().toISOString()}`)
      await writeFileAtomic(path, updated, { mode: 0o600, dirMode: 0o700 })
    }, { waitMs: 10_000 })
  }

  private async listArtifacts(reviewId: string): Promise<ArchitectureReviewArtifact[]> {
    const review = await this.requireReview(reviewId)
    const root = this.requireRoot()
    const directory = join(root, 'raw/sources/reviews', reviewId, review.version)
    const files = await regularFiles(directory)
    const result: ArchitectureReviewArtifact[] = []
    for (const file of files) {
      const name = basename(file)
      const content = await readRegularBufferNoFollow(file, MAX_ARTIFACT_BYTES)
      const sha256 = createHash('sha256').update(content).digest('hex')
      const pdfText = extname(name).toLowerCase() === '.pdf' ? await this.pdfText(sha256, content) : null
      result.push({
        name,
        path: `raw/sources/reviews/${reviewId}/${review.version}/${name}`,
        size: content.byteLength,
        sha256,
        parseStatus: TEXT_ARTIFACT_EXTENSIONS.has(extname(name).toLowerCase()) || (pdfText !== null && pdfText.content !== null)
          ? 'ready' : 'stored-only',
      })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async readFindings(reviewId: string): Promise<ArchitectureReviewFinding[]> {
    const root = this.requireRoot()
    const path = join(root, 'wiki/reviews', reviewId, 'findings.json')
    try {
      const value = JSON.parse(await readRegularFileNoFollow(path, MAX_PAGE_BYTES)) as unknown
      if (!Array.isArray(value)) throw new Error('findings file is invalid')
      return value as ArchitectureReviewFinding[]
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
  }

  private async writeFindings(reviewId: string, findings: readonly ArchitectureReviewFinding[]): Promise<void> {
    const root = this.requireRoot()
    const directory = join(root, 'wiki/reviews', reviewId)
    await ensureRealDirectory(directory, root)
    const path = join(directory, 'findings.json')
    await withFileLock(path, async () => {
      await writeFileAtomic(path, `${JSON.stringify(findings, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    }, { waitMs: 10_000 })
  }

  private async executeOperation(
    type: ArchitectureReviewOperation['type'],
    reviewId: string | null,
    action: () => Promise<Record<string, unknown>>,
  ): Promise<ArchitectureReviewOperation> {
    const startedAt = new Date().toISOString()
    const id = operationId()
    let operation: ArchitectureReviewOperation
    try {
      const result = await action()
      operation = { operationId: id, type, reviewId, status: 'completed', startedAt, finishedAt: new Date().toISOString(), result }
    } catch (cause) {
      operation = {
        operationId: id,
        type,
        reviewId,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        result: { error: 'operation failed' },
      }
      await this.writeOperation(operation)
      throw cause
    }
    await this.writeOperation(operation)
    return operation
  }

  private async writeOperation(operation: ArchitectureReviewOperation): Promise<void> {
    const root = this.requireRoot()
    await writeFileAtomic(
      join(root, '.wiki-tmp/operations', `${operation.operationId}.json`),
      `${JSON.stringify(operation, null, 2)}\n`,
      { mode: 0o600, dirMode: 0o700 },
    )
  }

  private async ensureFile(relativePath: string, content: string): Promise<void> {
    if (this.workspaceRoot === null) return
    const target = resolve(this.workspaceRoot, relativePath)
    if (!within(this.workspaceRoot, target)) throw new Error('workspace path escaped root')
    await this.assertNoSymlinkPath(target)
    try {
      const info = await stat(target)
      if (!info.isFile()) throw new Error('workspace marker must be a regular file')
      return
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    await writeFileAtomic(target, content, { mode: 0o600, dirMode: 0o700 })
  }

  private async appendFileAtomic(relativePath: string, content: string): Promise<void> {
    if (this.workspaceRoot === null) return
    const target = resolve(this.workspaceRoot, relativePath)
    if (!within(this.workspaceRoot, target)) throw new Error('workspace path escaped root')
    await this.assertNoSymlinkPath(target)
    await withFileLock(target, async () => {
      await this.assertNoSymlinkPath(target)
      let previous = ''
      try {
        previous = await readRegularFileNoFollow(target)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
      await this.assertNoSymlinkPath(target)
      await writeFileAtomic(target, previous + content, { mode: 0o600, dirMode: 0o700 })
    })
  }

  private async assertNoSymlinkPath(target: string): Promise<void> {
    if (this.workspaceRoot === null) return
    if (!within(this.workspaceRoot, target)) throw new Error('workspace path escaped root')
    const rel = relative(this.workspaceRoot, target)
    let current = this.workspaceRoot
    for (const part of rel.split(/[\\/]+/u).filter(Boolean)) {
      current = join(current, part)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error('workspace path may not traverse symlinks')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') break
        throw cause
      }
    }
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(value))
}

function sendMethodNotAllowed(res: ServerResponse, methods: string): void {
  res.setHeader('allow', methods)
  sendJson(res, 405, { error: 'method not allowed' })
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > maxBytes) {
      req.resume()
      throw new Error('request body is too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks, size).toString('utf8').trim()
  if (text.length === 0) throw new Error('request body is required')
  return JSON.parse(text) as unknown
}

function isJsonRequest(req: IncomingMessage): boolean {
  return req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

/** Keep filesystem and platform details out of the browser-facing response. */
function requestError(cause: unknown): { status: number; message: string } {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message === 'review not found' || message === 'finding not found' || message === 'operation not found' || message === 'artifact not found' || message === 'candidate not found') {
    return { status: 404, message }
  }
  if (message === 'artifact already exists' || message === 'expert review is running' || message === 'expert session already attached' || message === 'expert task is not active') return { status: 409, message }
  if (message === 'a reason is required for this finding status' || message === 'a reason is required for a rejected or changes-requested decision'
    || message === 'finding status transition is invalid' || message === 'finding evidence is required for confirmation'
    || message === 'run the review before creating a decision' || message === 'unconfirmed Blocker findings must be resolved before a decision'
    || message.startsWith('review standard is missing') || message.startsWith('selected review standard is missing') || message.startsWith('unreserved approval')
    || message.startsWith('finish expert review') || message.startsWith('incomplete expert review')
    || message.startsWith('finish decision before exporting')
    || message.startsWith('review materials changed') || message.startsWith('review basis changed') || message.startsWith('selected experts changed') || message.startsWith('candidate issues require')
    || message.startsWith('only failed experts') || message.startsWith('expert run is not')) {
    return { status: 400, message }
  }
  if (message === 'artifact type is not supported') return { status: 415, message }
  if (message === 'request body is too large') {
    return { status: 413, message }
  }
  if (cause instanceof SyntaxError) {
    return { status: 400, message: 'request body must be valid JSON' }
  }
  if (message.includes('required') || message.includes('must be')
    || message.includes('absolute') || message.includes('bounded')
    || message.includes('UNC') || message.includes('symlink')
    || message.includes('escaped root') || message.includes('invalid review path')) {
    return { status: 400, message }
  }
  return { status: 500, message: 'architecture review request failed' }
}

function parseCreateReviewInput(value: unknown): CreateReviewInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.title !== 'string') return null
  for (const field of ['systemName', 'type', 'owner', 'description'] as const) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string') return null
  }
  if (candidate.ruleIds !== undefined && !validRuleIds(candidate.ruleIds)) return null
  if (candidate.expertIds !== undefined && !validExpertIds(candidate.expertIds)) return null
  if (candidate.subagentMode !== undefined && typeof candidate.subagentMode !== 'boolean') return null
  return candidate as unknown as CreateReviewInput
}

function parseReviewExpertsInput(value: unknown): ReviewExpertsInput | null {
  const candidate = objectValue(value)
  if (candidate === null || !validExpertIds(candidate.expertIds)
    || (candidate.subagentMode !== undefined && typeof candidate.subagentMode !== 'boolean')) return null
  return candidate as unknown as ReviewExpertsInput
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseArtifactInput(value: unknown): ImportArtifactInput | null {
  const candidate = objectValue(value)
  if (candidate === null || typeof candidate.name !== 'string') return null
  if (candidate.content !== undefined && typeof candidate.content !== 'string') return null
  if (candidate.contentBase64 !== undefined && typeof candidate.contentBase64 !== 'string') return null
  return candidate as unknown as ImportArtifactInput
}

function parseReviewAction(path: string): { reviewId: string; action: string } | null {
  const match = new RegExp(`^${ARCHITECTURE_REVIEW_REVIEWS_PATH}/(AR-\\d{3,})/(artifact-content|artifacts|ingest|run|findings|decision|lint|experts|basis|expert-run|expert-session|expert-result|expert-retry|expert-fail|candidates)$`, 'u').exec(path)
  return match === null ? null : { reviewId: match[1]!, action: match[2]! }
}

function parseOperationPath(path: string): string | null {
  const match = new RegExp(`^${ARCHITECTURE_REVIEW_OPERATIONS_PATH}/(OP-[a-z0-9]+-[a-f0-9]{10})$`, 'u').exec(path)
  return match?.[1] ?? null
}

function parseFindingPath(path: string): string | null {
  const match = new RegExp(`^${ARCHITECTURE_REVIEW_FINDINGS_PATH}/(AR-\\d{3,}-F-\\d{3,})$`, 'u').exec(path)
  return match?.[1] ?? null
}

function parseDecisionInput(value: unknown): { result: 'approved' | 'conditional' | 'changes-requested' | 'rejected'; reason?: string } | null {
  const candidate = objectValue(value)
  if (candidate === null || typeof candidate.result !== 'string') return null
  if (!['approved', 'conditional', 'changes-requested', 'rejected'].includes(candidate.result)) return null
  if (candidate.reason !== undefined && typeof candidate.reason !== 'string') return null
  return candidate as { result: 'approved' | 'conditional' | 'changes-requested' | 'rejected'; reason?: string }
}

function parseFindingUpdate(value: unknown): { status: ArchitectureReviewFindingStatus; reason?: string } | null {
  const candidate = objectValue(value)
  if (candidate === null || typeof candidate.status !== 'string' || !FINDING_STATUSES.includes(candidate.status as ArchitectureReviewFindingStatus)) return null
  if (candidate.reason !== undefined && typeof candidate.reason !== 'string') return null
  return candidate as { status: ArchitectureReviewFindingStatus; reason?: string }
}

function parseReviewId(value: unknown): string | null {
  return typeof value === 'string' && /^AR-\d{3,}$/u.test(value) ? value : null
}

/** Handle one already-authenticated Architecture Review HTTP request. */
export async function handleArchitectureReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: ArchitectureReviewService,
  path: string,
): Promise<void> {
  try {
    if (path === ARCHITECTURE_REVIEW_WORKSPACE_PATH || path === `${ARCHITECTURE_REVIEW_WORKSPACE_PATH}/init`) {
      if (req.method === 'GET') return sendJson(res, 200, await service.snapshot())
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'GET, POST')
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
      const value = await readJson(req)
      if (typeof value !== 'object' || value === null || typeof (value as { path?: unknown }).path !== 'string') {
        return sendJson(res, 400, { error: 'path is required' })
      }
      return sendJson(res, 201, await service.init((value as { path: string }).path))
    }
    if (path === ARCHITECTURE_REVIEW_REVIEWS_PATH) {
      if (req.method === 'GET') return sendJson(res, 200, { reviews: await service.listReviews() })
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'GET, POST')
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
      const value = parseCreateReviewInput(await readJson(req))
      if (value === null) {
        return sendJson(res, 400, { error: 'title is required and optional fields must be strings' })
      }
      return sendJson(res, 201, await service.createReview(value))
    }
    const reviewAction = parseReviewAction(path)
    if (reviewAction !== null) {
      const { reviewId, action } = reviewAction
      if (action === 'findings' && req.method === 'GET') {
        return sendJson(res, 200, { findings: await service.listFindings(reviewId) })
      }
      if (action === 'artifacts' && req.method === 'GET') {
        return sendJson(res, 200, { artifacts: await service.listArtifactsForReview(reviewId) })
      }
      if (action === 'artifact-content' && req.method === 'GET') {
        const name = new URL(req.url ?? path, 'http://localhost').searchParams.get('name')
        if (name === null) return sendJson(res, 400, { error: 'name is required' })
        return sendJson(res, 200, await service.artifactContent(reviewId, name))
      }
      if (action === 'artifacts' && req.method === 'POST') {
        if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
        const value = parseArtifactInput(await readJson(req, MAX_ARTIFACT_BODY_BYTES))
        if (value === null) return sendJson(res, 400, { error: 'artifact name and content are required' })
        return sendJson(res, 201, await service.importArtifact(reviewId, value))
      }
      if (action === 'ingest' && req.method === 'POST') return sendJson(res, 202, await service.ingestReview(reviewId))
      if (action === 'experts' && req.method === 'PATCH') {
        if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
        const value = parseReviewExpertsInput(await readJson(req))
        if (value === null) return sendJson(res, 400, { error: 'expertIds are required' })
        return sendJson(res, 200, await service.updateReviewExperts(reviewId, value))
      }
      if (action === 'expert-run' && req.method === 'POST') return sendJson(res, 201, await service.startExpertReview(reviewId))
      if (action === 'expert-session' && req.method === 'POST') {
        if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
        const value = objectValue(await readJson(req))
        if (typeof value?.runId !== 'string' || typeof value.sessionId !== 'string'
          || (value.expertId !== undefined && typeof value.expertId !== 'string')) return sendJson(res, 400, { error: 'expert session is invalid' })
        return sendJson(res, 200, await service.bindExpertSession(reviewId, value.runId, value.sessionId, value.expertId as string | undefined))
      }
      if (action === 'expert-result' && req.method === 'POST') {
        if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
        const value = objectValue(await readJson(req, MAX_RUN_BYTES))
        if (typeof value?.runId !== 'string' || typeof value.expertId !== 'string' || typeof value.sessionId !== 'string'
          || !['reviewing', 'completed', 'failed'].includes(value.status as string) || typeof value.conclusion !== 'string'
          || (value.error !== undefined && typeof value.error !== 'string')) return sendJson(res, 400, { error: 'expert result is invalid' })
        return sendJson(res, 200, await service.recordExpertResult(reviewId, value.runId, value.expertId, value.sessionId,
          { status: value.status as 'reviewing' | 'completed' | 'failed', conclusion: value.conclusion, ...(typeof value.error === 'string' ? { error: value.error } : {}) }))
      }
      if (action === 'expert-retry' && req.method === 'POST') {
        if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
        const value = objectValue(await readJson(req))
        if (typeof value?.expertId !== 'string') return sendJson(res, 400, { error: 'expert ID is required' })
        return sendJson(res, 200, await service.retryExpert(reviewId, value.expertId))
      }
      if (action === 'expert-fail' && req.method === 'POST') {
        if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
        const value = objectValue(await readJson(req))
        if (typeof value?.runId !== 'string' || typeof value.message !== 'string') return sendJson(res, 400, { error: 'failure reason is required' })
        return sendJson(res, 200, await service.failExpertLaunch(reviewId, value.runId, value.message))
      }
      if (action === 'candidates' && req.method === 'GET') return sendJson(res, 200, { candidates: await service.listCandidates(reviewId) })
      if (action === 'candidates' && req.method === 'PATCH') {
        if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
        const value = objectValue(await readJson(req))
        if (typeof value?.candidateId !== 'string' || !['proposed', 'confirmed', 'rejected', 'needs-evidence', 'accepted-risk'].includes(value.status as string)
          || (value.reason !== undefined && typeof value.reason !== 'string')) return sendJson(res, 400, { error: 'candidate update is invalid' })
        return sendJson(res, 200, await service.updateCandidate(reviewId, value.candidateId,
          { status: value.status as ArchitectureReviewCandidate['status'], ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) }))
      }
      if (action === 'run' && req.method === 'POST') return sendJson(res, 202, await service.runReview(reviewId))
      if (action === 'lint' && req.method === 'POST') return sendJson(res, 202, await service.lint(reviewId))
      if (action === 'decision' && req.method === 'POST') {
        if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
        const value = parseDecisionInput(await readJson(req))
        if (value === null) return sendJson(res, 400, { error: 'decision result is invalid' })
        return sendJson(res, 201, await service.createDecision(reviewId, value))
      }
      return sendMethodNotAllowed(res, action === 'findings' || action === 'artifact-content' ? 'GET' : action === 'artifacts' ? 'GET, POST' : action === 'experts' || action === 'candidates' ? 'GET, PATCH' : 'POST')
    }
    const operation = parseOperationPath(path)
    if (operation !== null) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      const value = await service.getOperation(operation)
      if (value === null) return sendJson(res, 404, { error: 'operation not found' })
      return sendJson(res, 200, value)
    }
    if (path === ARCHITECTURE_REVIEW_OPERATIONS_PATH) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      return sendJson(res, 200, { operations: await service.listOperations() })
    }
    if (path === ARCHITECTURE_REVIEW_ARTIFACTS_PATH) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      return sendJson(res, 200, { artifacts: await service.listSources() })
    }
    if (path === ARCHITECTURE_REVIEW_STANDARDS_PATH) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      return sendJson(res, 200, { standards: await service.listStandards() })
    }
    const finding = parseFindingPath(path)
    if (finding !== null) {
      if (req.method !== 'PATCH') return sendMethodNotAllowed(res, 'PATCH')
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
      const value = parseFindingUpdate(await readJson(req))
      if (value === null) return sendJson(res, 400, { error: 'finding status is invalid' })
      return sendJson(res, 200, await service.updateFinding(finding, value))
    }
    if (path === ARCHITECTURE_REVIEW_PAGES_PATH) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      return sendJson(res, 200, { pages: await service.listPages() })
    }
    if (path === ARCHITECTURE_REVIEW_EXPERTS_PATH) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      return sendJson(res, 200, { catalog: await service.getExpertCatalog() })
    }
    if (path === ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH) {
      if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
      const pagePath = new URL(req.url ?? path, 'http://localhost').searchParams.get('path')
      if (pagePath === null) return sendJson(res, 400, { error: 'path is required' })
      return sendJson(res, 200, await service.pageContent(pagePath))
    }
    if (path === ARCHITECTURE_REVIEW_EXPORT_PATH) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
      const value = objectValue(await readJson(req))
      const reviewId = parseReviewId(value?.reviewId)
      if (reviewId === null) return sendJson(res, 400, { error: 'reviewId is required' })
      if (value?.format !== undefined && value.format !== 'markdown') {
        return sendJson(res, 501, { error: 'only markdown export is currently supported' })
      }
      return sendJson(res, 201, await service.exportReview(reviewId))
    }
    if (path.startsWith(ARCHITECTURE_REVIEW_REVIEW_PREFIX)) {
      const reviewId = path.slice(ARCHITECTURE_REVIEW_REVIEW_PREFIX.length)
      if (req.method === 'DELETE' && /^AR-\d{3,}$/u.test(reviewId)) {
        return sendJson(res, 200, await service.deleteReview(reviewId))
      }
      if (req.method !== 'GET') return sendMethodNotAllowed(res, /^AR-\d{3,}$/u.test(reviewId) ? 'GET, DELETE' : 'GET')
      const review = await service.getReview(reviewId)
      if (review === null) return sendJson(res, 404, { error: 'review not found' })
      return sendJson(res, 200, review)
    }
    return sendJson(res, 404, { error: 'not found' })
  } catch (cause) {
    const error = requestError(cause)
    return sendJson(res, error.status, { error: error.message })
  }
}

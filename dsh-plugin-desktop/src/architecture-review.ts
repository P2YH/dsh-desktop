/** Local, file-backed primitives for the Architecture Review workspace. */

import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  ARCHITECTURE_REVIEW_REVIEWS_PATH,
  ARCHITECTURE_REVIEW_REVIEW_PREFIX,
  ARCHITECTURE_REVIEW_WORKSPACE_PATH,
  type ArchitectureReviewSummary,
  type ArchitectureReviewWorkspaceSnapshot,
  type CreateReviewInput,
} from './architecture-review-contract.ts'

export { ARCHITECTURE_REVIEW_REVIEWS_PATH, ARCHITECTURE_REVIEW_REVIEW_PREFIX, ARCHITECTURE_REVIEW_WORKSPACE_PATH } from './architecture-review-contract.ts'

const MAX_BODY_BYTES = 32 * 1024
const MAX_PATH_BYTES = 4096

function ensureSafeAbsolutePath(value: string): string {
  if (!isAbsolute(value) || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new Error('workspace path must be an absolute, bounded path')
  }
  if (process.platform === 'win32' && value.startsWith('\\\\')) throw new Error('UNC workspace paths are not supported')
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
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return 0 }
  let count = 0
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) count += await countFiles(path)
    else if (entry.isFile()) count += 1
  }
  return count
}

async function ensureRealDirectory(path: string, root: string): Promise<void> {
  const chain: string[] = []
  let current = resolve(path)
  while (within(root, current) && current !== root) {
    chain.push(current)
    current = dirname(current)
  }
  chain.push(root)
  for (const directory of chain.reverse()) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('workspace contains an unsafe symbolic link')
  }
}

function yamlValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null
}

export class ArchitectureReviewService {
  private workspaceRoot: string | null
  private createTail: Promise<void> = Promise.resolve()

  constructor(initialRoot?: string) {
    this.workspaceRoot = initialRoot === undefined ? null : ensureSafeAbsolutePath(initialRoot)
  }

  get root(): string | null { return this.workspaceRoot }

  async init(root: string): Promise<ArchitectureReviewWorkspaceSnapshot> {
    const target = ensureSafeAbsolutePath(root)
    await ensureNoSymlinkAncestors(target)
    await mkdir(target, { recursive: true })
    const rootInfo = await lstat(target)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('workspace root must be a real directory')
    const previousRoot = this.workspaceRoot
    this.workspaceRoot = target
    try {
      for (const directory of ['raw/sources/reviews', 'raw/sources/standards', 'raw/assets', 'wiki/standards', 'wiki/entities', 'wiki/concepts', 'wiki/reviews', 'wiki/synthesis', '.wiki-tmp', 'exports']) {
        const directoryPath = join(target, directory)
        await mkdir(directoryPath, { recursive: true })
        await ensureRealDirectory(directoryPath, target)
      }
      await this.ensureFile('purpose.md', '# Architecture Review Workspace\n')
      await this.ensureFile('AGENTS.md', '# Workspace rules\n\nReview findings require human confirmation.\n')
      await this.ensureFile('.wiki-schema.md', '# Wiki schema\n')
      await this.ensureFile('wiki/index.md', '# Architecture Reviews\n')
      await this.ensureFile('wiki/log.md', '')
      return this.snapshot()
    } catch (cause) {
      this.workspaceRoot = previousRoot
      throw cause
    }
  }

  async snapshot(): Promise<ArchitectureReviewWorkspaceSnapshot> {
    if (this.workspaceRoot === null) return { initialized: false, root: null, reviewCount: 0, sourceCount: 0, wikiCount: 0 }
    const markerPaths = ['purpose.md', '.wiki-schema.md', 'wiki/index.md']
    let initialized = true
    try {
      await ensureRealDirectory(this.workspaceRoot, this.workspaceRoot)
      for (const marker of markerPaths) {
        const info = await lstat(join(this.workspaceRoot, marker))
        if (!info.isFile() || info.isSymbolicLink()) { initialized = false; break }
      }
    } catch { initialized = false }
    if (!initialized) return { initialized: false, root: this.workspaceRoot, reviewCount: 0, sourceCount: 0, wikiCount: 0 }
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
    const root = join(this.workspaceRoot, 'wiki/reviews')
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
    const reviews: ArchitectureReviewSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^AR-\d{3,}$/.test(entry.name)) continue
      const file = join(root, entry.name, 'review.md')
      try {
        const text = await readFile(file, 'utf8')
        reviews.push({
          reviewId: entry.name,
          version: yamlValue(text, 'version') ?? 'v1',
          title: yamlValue(text, 'title') ?? entry.name,
          status: yamlValue(text, 'status') ?? 'draft',
          path: `wiki/reviews/${entry.name}/review.md`,
          updatedAt: yamlValue(text, 'updated_at'),
        })
      } catch { /* ignore incomplete review directories */ }
    }
    return reviews.sort((a, b) => a.reviewId.localeCompare(b.reviewId))
  }

  async getReview(reviewId: string): Promise<ArchitectureReviewSummary | null> {
    if (!/^AR-\d{3,}$/.test(reviewId)) return null
    return (await this.listReviews()).find(item => item.reviewId === reviewId) ?? null
  }

  async createReview(input: CreateReviewInput): Promise<ArchitectureReviewSummary> {
    const run = this.createTail.then(() => this.createReviewUnsafe(input))
    this.createTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async createReviewUnsafe(input: CreateReviewInput): Promise<ArchitectureReviewSummary> {
    if (this.workspaceRoot === null) throw new Error('workspace is not initialized')
    const title = input.title.trim()
    if (!title || title.length > 200) throw new Error('title is required and must be <= 200 characters')
    const existing = await this.listReviews()
    const next = existing.reduce((max, item) => Math.max(max, Number(item.reviewId.slice(3)) || 0), 0) + 1
    const reviewId = `AR-${String(next).padStart(3, '0')}`
    const dir = join(this.workspaceRoot, 'wiki/reviews', reviewId)
    if (!within(this.workspaceRoot, dir)) throw new Error('invalid review path')
    await this.assertNoSymlinkPath(dir)
    await mkdir(join(dir, 'v1'), { recursive: true })
    await this.assertNoSymlinkPath(join(dir, 'v1'))
    const updatedAt = new Date().toISOString()
    const content = `---\nreview_id: ${reviewId}\nversion: v1\nstatus: draft\ntitle: ${JSON.stringify(title)}\nsystem_name: ${JSON.stringify(input.systemName?.trim() ?? '')}\ntype: ${JSON.stringify(input.type?.trim() ?? 'new-system')}\nowner: ${JSON.stringify(input.owner?.trim() ?? '')}\nupdated_at: ${updatedAt}\n---\n\n# ${title}\n\n${input.description?.trim() ?? ''}\n`
    await writeFileAtomic(join(dir, 'review.md'), content, { mode: 0o600, dirMode: 0o700 })
    await this.ensureFile('wiki/log.md', `${updatedAt} create review ${reviewId}\n`, true)
    return { reviewId, version: 'v1', title, status: 'draft', path: `wiki/reviews/${reviewId}/review.md`, updatedAt }
  }

  private async ensureFile(relativePath: string, content: string, append = false): Promise<void> {
    if (this.workspaceRoot === null) return
    const target = resolve(this.workspaceRoot, relativePath)
    if (!within(this.workspaceRoot, target)) throw new Error('workspace path escaped root')
    await this.assertNoSymlinkPath(target)
    try { await stat(target); if (!append) return } catch { /* create below */ }
    if (append) await writeFile(target, content, { encoding: 'utf8', flag: 'a' })
    else await writeFileAtomic(target, content, { mode: 0o600, dirMode: 0o700 })
  }

  private async assertNoSymlinkPath(target: string): Promise<void> {
    if (this.workspaceRoot === null) return
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) throw new Error('request body is required')
  return JSON.parse(text) as unknown
}

function isJsonRequest(req: IncomingMessage): boolean {
  return req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function originAllowed(req: IncomingMessage, expectedOrigin: string): boolean {
  let expected: URL
  try {
    expected = new URL(expectedOrigin)
    if (expected.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(expected.hostname)) return false
  } catch { return false }
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '::1' || remote === '127.0.0.1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
  if (!loopback || req.headers.host?.toLowerCase() !== expected.host.toLowerCase()) return false
  if (req.headers.origin === expected.origin) return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin'
  if (req.method !== 'GET' || req.headers['sec-fetch-site'] !== 'same-origin') return false
  try { return new URL(req.headers.referer ?? '').origin === expected.origin } catch { return false }
}

/** Handle workspace and review operations for the private renderer API. */
export async function handleArchitectureReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: ArchitectureReviewService,
  path: string,
): Promise<void> {
  if (!originAllowed(req, expectedOrigin)) return sendJson(res, 403, { error: 'forbidden' })
  try {
    if (path === ARCHITECTURE_REVIEW_WORKSPACE_PATH) {
      if (req.method === 'GET') return sendJson(res, 200, await service.snapshot())
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
      const value = await readJson(req)
      if (typeof value !== 'object' || value === null || typeof (value as { path?: unknown }).path !== 'string') return sendJson(res, 400, { error: 'path is required' })
      return sendJson(res, 201, await service.init((value as { path: string }).path))
    }
    if (path === ARCHITECTURE_REVIEW_REVIEWS_PATH) {
      if (req.method === 'GET') return sendJson(res, 200, { reviews: await service.listReviews() })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content type must be application/json' })
      const value = await readJson(req)
      if (typeof value !== 'object' || value === null || typeof (value as { title?: unknown }).title !== 'string') return sendJson(res, 400, { error: 'title is required' })
      return sendJson(res, 201, await service.createReview(value as CreateReviewInput))
    }
    if (path.startsWith(ARCHITECTURE_REVIEW_REVIEW_PREFIX)) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const review = await service.getReview(path.slice(ARCHITECTURE_REVIEW_REVIEW_PREFIX.length))
      if (review === null) return sendJson(res, 404, { error: 'review not found' })
      return sendJson(res, 200, review)
    }
    return sendJson(res, 404, { error: 'not found' })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const status = message === 'request body is too large'
      ? 413
      : (cause instanceof SyntaxError || message.includes('required') || message.includes('must be') ? 400 : 500)
    return sendJson(res, status, { error: message })
  }
}

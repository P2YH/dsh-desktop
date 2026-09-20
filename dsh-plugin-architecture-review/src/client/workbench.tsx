/** Architecture review workbench surfaces for the DSH Web client. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  ARCHITECTURE_REVIEW_ARTIFACTS_PATH,
  ARCHITECTURE_REVIEW_EXPORT_PATH,
  ARCHITECTURE_REVIEW_EXPERTS_PATH,
  ARCHITECTURE_REVIEW_OPERATIONS_PATH,
  ARCHITECTURE_REVIEW_PAGES_PATH,
  ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH,
  ARCHITECTURE_REVIEW_REVIEW_PREFIX,
  ARCHITECTURE_REVIEW_REVIEWS_PATH,
  ARCHITECTURE_REVIEW_WORKSPACE_PATH,
  ARCHITECTURE_REVIEW_STANDARDS_PATH,
  type ArchitectureReviewArtifact,
  type ArchitectureReviewArtifactContent,
  type ArchitectureReviewExpert,
  type ArchitectureReviewExpertCatalog,
  type ArchitectureReviewRun,
  type ArchitectureReviewCandidate,
  type ArchitectureReviewOperation,
  type ArchitectureReviewPageSummary,
  type ArchitectureReviewSummary,
  type ArchitectureReviewSource,
  type ArchitectureReviewWorkspaceSnapshot,
  type CreateReviewInput,
  type ReviewExpertsInput,
} from '../architecture-review-contract.ts'
import { ARCHITECTURE_REVIEW_CSS } from './workbench-css.ts'
import { expertSessionProgress, knowledgeTranscript, launchKnowledgeTask, type KnowledgeSessionId, type KnowledgeTask } from './knowledge-task.ts'
import {
  REVIEW_TYPES,
  candidateStatusLabel,
  formatFileSize,
  parseWorkbenchRoute,
  reviewStatusLabel,
  sourceKind,
  validateReviewBasics,
  withWorkbenchRoute,
  type WorkbenchRoute,
  type WorkbenchView,
} from './workbench-model.ts'

export const ARCHITECTURE_REVIEW_PANEL_ID = 'architecture-review'

type MainProps = PropsRuntime<'main'>
type OverlayProps = PropsRuntime<'shell.overlay'>
type PanelIconProps = { size: number; active: boolean }

interface ReviewDetail extends ArchitectureReviewSummary {
  readonly systemName?: string
  readonly type?: string
  readonly owner?: string
  readonly description?: string
  readonly sourceCount?: number
  readonly ruleCount?: number
  readonly sources?: readonly ArchitectureReviewArtifact[]
  readonly versions?: readonly string[]
  readonly candidates?: readonly ArchitectureReviewCandidate[]
}

interface WikiPageContent extends ArchitectureReviewPageSummary {
  readonly content?: string
  readonly type?: string
  readonly sourceCount?: number
}

interface WikiPageSummary extends ArchitectureReviewPageSummary {
  /** The Host page contract uses its relative path as the stable identity. */
  readonly id: string
  readonly type?: string
  readonly sourceCount?: number
}
type OperationSummary = ArchitectureReviewOperation

interface ActiveKnowledgeTask {
  readonly root: string
  readonly sessionId: KnowledgeSessionId
  readonly task: KnowledgeTask
}

const KNOWLEDGE_SESSION_KEY = 'architecture-review:knowledge-session'
const KNOWLEDGE_MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' }

interface DraftSource {
  readonly key: string
  readonly file: File
  readonly digest: string | null
  readonly status: 'hashing' | 'ready' | 'error'
}

type ReviewBasics = Required<Omit<CreateReviewInput, 'ruleIds' | 'expertIds' | 'subagentMode'>>

const NAV_ITEMS: readonly [Exclude<WorkbenchView, 'review'>, string][] = [
  ['dashboard', '工作台'],
  ['reviews', '评审项目'],
  ['knowledge', '资料与知识'],
  ['rules', '评审专家智能体'],
  ['operations', '运行记录'],
  ['settings', '设置'],
]

const OPEN_CREATE_EVENT = 'architecture-review:open-create'
const REVIEW_CREATED_EVENT = 'architecture-review:review-created'

interface ReviewCreatedDetail {
  readonly review: ArchitectureReviewSummary
  readonly task?: ActiveKnowledgeTask
  readonly launchError?: string
}

function ArchitectureReviewIcon({ size, active }: PanelIconProps) {
  return <span style={{ fontSize: size, lineHeight: 1, opacity: active ? 1 : 0.72 }} aria-hidden>⌘</span>
}

function ArchitectureReviewWorkbench({ client }: MainProps & { client: ClientContext }) {
  const [route, setRoute] = useState<WorkbenchRoute>(() => parseWorkbenchRoute(window.location.search))
  const [workspace, setWorkspace] = useState<ArchitectureReviewWorkspaceSnapshot | null>(null)
  const [reviews, setReviews] = useState<readonly ArchitectureReviewSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [knowledgeTask, setKnowledgeTask] = useState<ActiveKnowledgeTask | null>(readKnowledgeTask)

  const refresh = async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const [nextWorkspace, reviewPayload] = await Promise.all([
        requestJson<ArchitectureReviewWorkspaceSnapshot>(ARCHITECTURE_REVIEW_WORKSPACE_PATH, undefined, signal),
        requestJson<{ reviews?: readonly ArchitectureReviewSummary[] }>(ARCHITECTURE_REVIEW_REVIEWS_PATH, undefined, signal),
      ])
      if (signal?.aborted) return
      setWorkspace(nextWorkspace)
      setReviews(reviewPayload.reviews ?? [])
      setError(null)
    } catch (cause) {
      if (signal?.aborted || isAbortError(cause)) return
      setError(messageFor(cause, '无法连接架构评审服务，请重试。'))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    try {
      if (knowledgeTask === null) window.sessionStorage.removeItem(KNOWLEDGE_SESSION_KEY)
      else window.sessionStorage.setItem(KNOWLEDGE_SESSION_KEY, JSON.stringify(knowledgeTask))
    } catch {
      // The active result remains available until this page is closed.
    }
  }, [knowledgeTask])

  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-plugin-architecture-review'
    style.dataset.pluginCss = 'architecture-review-workbench'
    style.textContent = ARCHITECTURE_REVIEW_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  useEffect(() => {
    const onPopState = () => setRoute(parseWorkbenchRoute(window.location.search))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (next: WorkbenchRoute) => {
    setRoute(next)
    window.history.pushState({ architectureReviewRoute: next }, '', withWorkbenchRoute(window.location.href, next))
    if (next.view === 'dashboard' || next.view === 'reviews') void refresh()
  }

  useEffect(() => {
    const onCreated = (event: Event) => {
      const { review, task, launchError } = (event as CustomEvent<ReviewCreatedDetail>).detail
      if (task !== undefined) setKnowledgeTask(task)
      setNotice(`${review.reviewId} 草稿已创建。资料可读取后即可启动专家评审。`)
      void refresh().then(() => {
        navigate({ view: 'review', reviewId: review.reviewId })
        if (launchError !== undefined) setError(launchError)
      })
    }
    window.addEventListener(REVIEW_CREATED_EVENT, onCreated)
    return () => window.removeEventListener(REVIEW_CREATED_EVENT, onCreated)
  }, [])

  const openCreate = () => {
    if (workspace?.initialized !== true) {
      setNotice('请先初始化架构评审工作区。')
      navigate({ view: 'settings' })
      return
    }
    window.dispatchEvent(new Event(OPEN_CREATE_EVENT))
  }

  const startKnowledgeTask = async (task: KnowledgeTask): Promise<KnowledgeSessionId> => {
    if (workspace?.initialized !== true || workspace.root === null) throw new Error('workspace is not initialized')
    const previous = knowledgeTask?.root === workspace.root && knowledgeTask.task.kind === 'query' && task.kind === 'query'
      ? knowledgeTask.sessionId : undefined
    const sessionId = await launchKnowledgeTask(client, workspace.root, task, previous)
    setKnowledgeTask({ root: workspace.root, sessionId, task })
    if (task.kind === 'verify') navigate({ view: 'knowledge' })
    return sessionId
  }

  const currentNav = route.view === 'review' ? 'reviews' : route.view

  return (
    <div className="dshArchitectureReview" data-architecture-review-view={route.view}>
      <aside className="dshArchitectureReviewNav" aria-label="架构评审导航">
        <div className="dshArchitectureReviewBrand"><span aria-hidden>⌘</span><strong>架构评审</strong></div>
        <nav>
          {NAV_ITEMS.map(([id, label]) => (
            <button key={id} type="button" className={id === currentNav ? 'active' : ''} onClick={() => navigate({ view: id })} aria-current={id === currentNav ? 'page' : undefined}>
              <span aria-hidden>{navigationIcon(id)}</span>{label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="dshArchitectureReviewContent">
        {error !== null && <Banner kind="error" message={error} actionLabel="重试" onAction={() => void refresh()} />}
        {notice !== null && <Banner kind="success" message={notice} actionLabel="关闭" onAction={() => setNotice(null)} />}
        {route.view === 'dashboard' && <Dashboard workspace={workspace} reviews={reviews} loading={loading} onCreate={openCreate} onNavigate={navigate} />}
        {route.view === 'reviews' && <ReviewsPage workspace={workspace} reviews={reviews} loading={loading} onCreate={openCreate} onOpen={reviewId => navigate({ view: 'review', reviewId })} onDeleted={reviewId => { setReviews(current => current.filter(review => review.reviewId !== reviewId)); setNotice(`${reviewId} 已删除。`); void refresh() }} onRefresh={() => void refresh()} onInitialize={() => navigate({ view: 'settings' })} />}
        {route.view === 'review' && route.reviewId !== undefined && <ReviewDetailPage client={client} reviewId={route.reviewId} fallback={reviews.find(review => review.reviewId === route.reviewId)} activeTask={knowledgeTask !== null && knowledgeTask.root === workspace?.root && knowledgeTask.task.kind === 'review' && knowledgeTask.task.reviewId === route.reviewId ? knowledgeTask : null} onClearTask={() => setKnowledgeTask(null)} onBack={() => navigate({ view: 'reviews' })} onKnowledgeTask={startKnowledgeTask} />}
        {route.view === 'knowledge' && <KnowledgePage client={client} workspace={workspace} activeTask={knowledgeTask?.root === workspace?.root ? knowledgeTask : null} onClearTask={() => setKnowledgeTask(null)} onOpenReview={reviewId => navigate({ view: 'review', reviewId })} onInitialize={() => navigate({ view: 'settings' })} onKnowledgeTask={startKnowledgeTask} />}
        {route.view === 'rules' && <ExpertsPage client={client} workspace={workspace} activeTask={knowledgeTask?.root === workspace?.root ? knowledgeTask : null} onClearTask={() => setKnowledgeTask(null)} onKnowledgeTask={startKnowledgeTask} onInitialize={() => navigate({ view: 'settings' })} />}
        {route.view === 'operations' && <OperationsPage workspace={workspace} onInitialize={() => navigate({ view: 'settings' })} onOpen={reviewId => navigate({ view: 'review', reviewId })} />}
        {route.view === 'settings' && <SettingsPage workspace={workspace} onPickDirectory={() => client.uiWorkspace.pickDirectory()} onInitialized={async () => { await refresh(); setNotice('工作区已初始化。'); navigate({ view: 'dashboard' }) }} />}
      </section>
    </div>
  )
}

function Banner({ kind, message, actionLabel, onAction }: { kind: 'error' | 'success'; message: string; actionLabel: string; onAction: () => void }) {
  return <div className={`dshArchitectureReviewBanner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><span>{message}</span><button type="button" onClick={onAction}>{actionLabel}</button></div>
}

function Dashboard({ workspace, reviews, loading, onCreate, onNavigate }: {
  workspace: ArchitectureReviewWorkspaceSnapshot | null
  reviews: readonly ArchitectureReviewSummary[]
  loading: boolean
  onCreate: () => void
  onNavigate: (route: WorkbenchRoute) => void
}) {
  const activeCount = reviews.filter(review => ['queued', 'reviewing', 'human-review'].includes(review.status)).length
  const pendingCount = reviews.filter(review => review.status === 'human-review').length
  const recent = [...reviews].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 5)
  if (!loading && workspace?.initialized !== true) {
    return (
      <main className="dshArchitectureReviewPage">
        <PageHeader title="架构评审工作台" description="集中查看评审进度、待确认问题和本地知识库状态。" />
        <div className="dshArchitectureReviewPanel"><EmptyState icon="⌂" title="创建架构评审知识库" description="选择一个本地目录保存原始资料、Wiki 页面、评审结果和运行日志。" actionLabel="初始化工作区" onAction={() => onNavigate({ view: 'settings' })} /></div>
      </main>
    )
  }
  return (
    <main className="dshArchitectureReviewPage">
      <PageHeader title="架构评审工作台" description="集中查看评审进度、待确认问题和本地知识库状态。" actions={<><button type="button" className="secondary" onClick={() => onNavigate({ view: 'operations' })}>◷ 运行任务</button><button type="button" className="primary" onClick={onCreate}>＋ 新建评审</button></>} />
      <div className="dshArchitectureReviewMetrics">
        <button type="button" className="dshArchitectureReviewMetric" onClick={() => onNavigate({ view: 'reviews' })}><strong>{pendingCount}</strong><span>待处理评审</span><small>需要人工处理</small></button>
        <button type="button" className="dshArchitectureReviewMetric" onClick={() => onNavigate({ view: 'reviews' })}><strong>{activeCount}</strong><span>进行中评审</span><small>{reviews.length} 个评审项目</small></button>
        <button type="button" className="dshArchitectureReviewMetric" onClick={() => onNavigate({ view: 'knowledge' })}><strong>{workspace?.wikiCount ?? 0}</strong><span>Wiki 页面</span><small>{workspace?.sourceCount ?? 0} 份原始资料</small></button>
      </div>
      <div className="dshArchitectureReviewDashboard">
        <section className="dshArchitectureReviewPanel large">
          <PanelHeader title="最近评审" action="查看全部" onAction={() => onNavigate({ view: 'reviews' })} />
          {recent.length === 0 ? <EmptyState compact icon="▣" title="暂无评审项目" description="创建第一个评审，填写基本信息并选择参与专家。" actionLabel="新建评审" onAction={onCreate} /> : recent.map(review => <ReviewRow key={review.reviewId} review={review} onClick={() => onNavigate({ view: 'review', reviewId: review.reviewId })} />)}
        </section>
        <section className="dshArchitectureReviewPanel">
          <PanelHeader title="知识库状态" action="打开" onAction={() => onNavigate({ view: 'knowledge' })} />
          <div className="dshArchitectureReviewPanelBody"><div className="dshArchitectureReviewFacts"><div className="dshArchitectureReviewFact"><strong>{workspace?.sourceCount ?? 0}</strong><small>原始资料</small></div><div className="dshArchitectureReviewFact"><strong>{workspace?.wikiCount ?? 0}</strong><small>Wiki 页面</small></div></div><p>运行知识健康检查后可查看断链、矛盾和缺失索引。</p></div>
        </section>
        <section className="dshArchitectureReviewPanel">
          <PanelHeader title="最近运行" action="查看记录" onAction={() => onNavigate({ view: 'operations' })} />
          <div className="dshArchitectureReviewPanelBody"><p>查看资料摄入、完整性检查和 Lint 的最近结果。</p></div>
        </section>
      </div>
    </main>
  )
}

function ReviewsPage({ workspace, reviews, loading, onCreate, onOpen, onDeleted, onRefresh, onInitialize }: {
  workspace: ArchitectureReviewWorkspaceSnapshot | null
  reviews: readonly ArchitectureReviewSummary[]
  loading: boolean
  onCreate: () => void
  onOpen: (reviewId: string) => void
  onDeleted: (reviewId: string) => void
  onRefresh: () => void
  onInitialize: () => void
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deleteReview = async (review: ArchitectureReviewSummary) => {
    if (!window.confirm(`确定永久删除“${review.title}”（${review.reviewId}）吗？\n\n项目的待评审资料、专家意见、决策报告和运行记录将被删除，无法撤销。已导出的报告和共享知识库内容会保留。`)) return
    setDeletingId(review.reviewId)
    setDeleteError(null)
    try {
      await requestJson(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(review.reviewId)}`, { method: 'DELETE' })
      onDeleted(review.reviewId)
    } catch (cause) {
      setDeleteError(messageFor(cause, '删除评审项目失败，请重试。'))
    } finally {
      setDeletingId(null)
    }
  }
  return (
    <main className="dshArchitectureReviewPage">
      <PageHeader title="评审项目" description="创建、打开和跟踪本地工作区中的架构评审。" actions={<><button type="button" className="secondary" onClick={onRefresh} disabled={loading}>↻ 刷新</button><button type="button" className="primary" onClick={onCreate} disabled={workspace?.initialized !== true}>＋ 新建评审</button></>} />
      {deleteError !== null && <Banner kind="error" message={deleteError} actionLabel="关闭" onAction={() => setDeleteError(null)} />}
      {workspace?.initialized !== true
        ? <div className="dshArchitectureReviewPanel"><EmptyState icon="⌂" title="工作区尚未初始化" description="先选择本地工作区，才能创建评审。" actionLabel="初始化工作区" onAction={onInitialize} /></div>
        : reviews.length === 0
          ? <div className="dshArchitectureReviewPanel"><EmptyState icon="▣" title="暂无评审项目" description="通过四步向导创建第一个架构评审。" actionLabel="新建评审" onAction={onCreate} /></div>
          : <div className="dshArchitectureReviewReviewList">{reviews.map(review => <article key={review.reviewId} className="dshArchitectureReviewReviewCard"><button type="button" className="dshArchitectureReviewReviewOpen" onClick={() => onOpen(review.reviewId)}><h2>{review.title}</h2><p>{review.reviewId} · {review.version}</p></button><Status status={review.status} /><div className="dshArchitectureReviewReviewMeta"><time>{formatDate(review.updatedAt)}</time></div><button type="button" className="secondary dshArchitectureReviewReviewDelete" title={review.status === 'reviewing' || review.run?.status === 'starting' || review.run?.status === 'reviewing' ? '专家评审进行中，暂不能删除' : `删除 ${review.title}`} disabled={deletingId !== null || review.status === 'reviewing' || review.run?.status === 'starting' || review.run?.status === 'reviewing'} onClick={() => void deleteReview(review)}>{deletingId === review.reviewId ? '删除中…' : '删除'}</button></article>)}</div>}
    </main>
  )
}

function ReviewDetailPage({ client, reviewId, fallback, activeTask, onClearTask, onBack, onKnowledgeTask }: {
  client: ClientContext
  reviewId: string
  fallback: ArchitectureReviewSummary | undefined
  activeTask: ActiveKnowledgeTask | null
  onClearTask: () => void
  onBack: () => void
  onKnowledgeTask: (task: KnowledgeTask) => Promise<KnowledgeSessionId>
}) {
  const [review, setReview] = useState<ReviewDetail | null>(fallback ?? null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [decision, setDecision] = useState<'approved' | 'conditional' | 'changes-requested' | 'rejected'>('conditional')
  const [decisionReason, setDecisionReason] = useState('')
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [detailTab, setDetailTab] = useState<'materials' | 'experts' | 'candidates' | 'decision'>('materials')
  const [selectedSource, setSelectedSource] = useState<ArchitectureReviewArtifactContent | null>(null)
  const [reportContent, setReportContent] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ArchitectureReviewExpertCatalog | null>(null)
  const [expertIds, setExpertIds] = useState<readonly string[]>(fallback?.expertIds ?? [])
  const [showExpertSelection, setShowExpertSelection] = useState(false)
  const [expertError, setExpertError] = useState<string | null>(null)
  const [standards, setStandards] = useState<readonly { path: string; sha256: string }[]>([])
  const importInput = useRef<HTMLInputElement>(null)

  const load = async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const reviewPath = `${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}`
      const [summary, artifactPayload, candidatePayload, standardPayload] = await Promise.all([
        requestJson<ArchitectureReviewSummary>(reviewPath, undefined, signal),
        requestJson<{ artifacts?: readonly ArchitectureReviewArtifact[] }>(`${reviewPath}/artifacts`, undefined, signal)
          .catch(cause => cause instanceof RequestError && (cause.status === 404 || cause.status === 405)
            ? { artifacts: [] }
            : Promise.reject(cause)),
        requestJson<{ candidates?: readonly ArchitectureReviewCandidate[] }>(`${reviewPath}/candidates`, undefined, signal),
        requestJson<{ standards?: readonly { path: string; sha256: string }[] }>(ARCHITECTURE_REVIEW_STANDARDS_PATH, undefined, signal),
      ])
      if (signal?.aborted) return
      const detail: ReviewDetail = {
        ...summary,
        sources: artifactPayload.artifacts ?? [],
        candidates: candidatePayload.candidates ?? [],
      }
      setReview(detail)
      setStandards(standardPayload.standards ?? [])
      setExpertIds(detail.expertIds)
      setError(null)
    } catch (cause) {
      if (!signal?.aborted && !isAbortError(cause)) setError(messageFor(cause, '无法读取评审详情。'))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    setSelectedSource(null)
    setReportContent(null)
    setShowExpertSelection(false)
    void load(controller.signal)
    return () => controller.abort()
  }, [reviewId])

  useEffect(() => {
    const controller = new AbortController()
    void requestJson<{ catalog: ArchitectureReviewExpertCatalog | null }>(ARCHITECTURE_REVIEW_EXPERTS_PATH, undefined, controller.signal)
      .then(payload => { if (!controller.signal.aborted) { setCatalog(payload.catalog); setExpertError(null) } })
      .catch(cause => { if (!isAbortError(cause)) setExpertError(messageFor(cause, '无法读取专家目录。')) })
    return () => controller.abort()
  }, [reviewId])

  const saveExperts = async (): Promise<ArchitectureReviewSummary> => {
    if (review !== null && review.expertIds.join(',') === expertIds.join(',')) return review
    const updated = await requestJson<ArchitectureReviewSummary>(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}/experts`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expertIds } satisfies ReviewExpertsInput),
    })
    setReview(current => current === null ? current : { ...current, ...updated })
    return updated
  }

  const saveExpertSelection = async () => {
    setActionBusy(true)
    try { await saveExperts(); setActionMessage('参与专家已保存。') }
    catch (cause) { setActionMessage(messageFor(cause, '保存参与专家失败。')) }
    finally { setActionBusy(false) }
  }

  const openSource = async (source: ArchitectureReviewArtifact) => {
    setActionMessage(null)
    try {
      const detail = await requestJson<ArchitectureReviewArtifactContent>(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}/artifact-content?name=${encodeURIComponent(source.name)}`)
      setSelectedSource(detail)
    } catch (cause) {
      setActionMessage(messageFor(cause, '无法读取这份资料。'))
    }
  }

  const importSources = async (files: FileList | null) => {
    if (files === null || files.length === 0) return
    const chosen = Array.from(files)
    const invalid = chosen.find(file => !isSupportedSource(file.name) || file.size > 5 * 1024 * 1024)
    if (invalid !== undefined) {
      setActionMessage(`${invalid.name} 格式不支持或超过 5 MB。`)
      if (importInput.current !== null) importInput.current.value = ''
      return
    }
    const duplicate = chosen.find(file => review?.sources?.some(source => source.name === file.name))
    if (duplicate !== undefined) {
      setActionMessage(`${duplicate.name} 已存在，请先选择其他文件名。`)
      if (importInput.current !== null) importInput.current.value = ''
      return
    }
    if (chosen.length > 25 - (review?.sources?.length ?? 0) || new Set(chosen.map(file => file.name)).size !== chosen.length) {
      setActionMessage('每个评审最多保存 25 份资料，且文件名不能重复。')
      if (importInput.current !== null) importInput.current.value = ''
      return
    }
    setActionBusy(true)
    setActionMessage('正在导入资料…')
    try {
      const uploaded = await uploadSources(reviewId, chosen)
      const operation = await requestJson<ArchitectureReviewOperation>(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}/ingest`, { method: 'POST' })
      rememberOperation(operation)
      await load()
      setDetailTab('materials')
      const unreadable = uploaded.filter(source => source.parseStatus !== 'ready')
      setActionMessage(unreadable.length === 0
        ? `已添加 ${uploaded.length} 份待评审资料，均可读取。`
        : `已添加 ${uploaded.length} 份资料；${unreadable.map(source => source.name).join('、')} 无法读取正文，请补充 OCR、Markdown 或 TXT 文本版。`)
    } catch (cause) {
      setActionMessage(`资料提交失败：${messageFor(cause, '请重试。')} 已保存的文件会显示在资料列表中。`)
      await load()
    } finally {
      setActionBusy(false)
      if (importInput.current !== null) importInput.current.value = ''
    }
  }

  const startReview = async () => {
    if (!review?.sources?.some(source => source.parseStatus === 'ready')) { setDetailTab('materials'); setActionMessage('请先添加至少一份可读取的待评审资料。'); return }
    if (expertIds.length === 0) { setDetailTab('experts'); setActionMessage('请先选择参与评审的专家。'); return }
    if (catalog === null || expertIds.some(id => !catalog.experts.some(expert => expert.id === id))) {
      setDetailTab('experts'); setActionMessage('专家目录已变化，请刷新后重新选择。'); return
    }
    if (review?.run?.status === 'starting' || review?.run?.status === 'reviewing') { setDetailTab('experts'); return }
    if (review?.run !== null && review?.run !== undefined
      && !window.confirm('重新评审会替换当前候选问题，已有处理状态与报告可能不再适用。继续吗？')) return
    setActionBusy(true)
    setActionMessage('正在启动专家评审…')
    try {
      await saveExperts()
      const path = `${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}`
      const run = await requestJson<ArchitectureReviewRun>(`${path}/expert-run`, { method: 'POST' })
      setDetailTab('experts')
      await load()
      try {
        const sessionId = await onKnowledgeTask({ kind: 'review', reviewId, expertIds, runId: run.runId })
        await requestJson(`${path}/expert-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.runId, sessionId }) })
        setActionMessage(`已启动 ${expertIds.length} 位专家的协作评审。`)
      } catch (cause) {
        await requestJson(`${path}/expert-fail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.runId, message: messageFor(cause, '专家会话启动失败') }) })
        setActionMessage('专家会话启动失败，可在专家进度中逐位重试。')
      }
      await load()
    } catch (cause) {
      setActionMessage(messageFor(cause, '无法启动评审任务。'))
    } finally {
      setActionBusy(false)
    }
  }

  const retryExpert = async (expertId: string) => {
    setActionBusy(true)
    const path = `${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}`
    try {
      const run = await requestJson<ArchitectureReviewRun>(`${path}/expert-retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expertId }) })
      await load()
      try {
        const sessionId = await onKnowledgeTask({ kind: 'review', reviewId, expertIds: [expertId], runId: run.runId })
        await requestJson(`${path}/expert-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.runId, sessionId, expertId }) })
        setActionMessage('已重新启动该专家。')
      } catch (cause) {
        await requestJson(`${path}/expert-fail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.runId, message: messageFor(cause, '专家重试启动失败') }) })
        setActionMessage('专家重试启动失败。')
      }
      await load()
    } catch (cause) { setActionMessage(messageFor(cause, '无法重试专家。')) }
    finally { setActionBusy(false) }
  }

  const runLint = async () => {
    setActionBusy(true)
    try {
      const operation = await requestJson<ArchitectureReviewOperation>(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}/lint`, { method: 'POST' })
      rememberOperation(operation)
      setActionMessage(`Lint 已完成，发现 ${String(operation.result.issueCount ?? 0)} 个断链。`)
    } catch (cause) {
      setActionMessage(messageFor(cause, 'Lint 运行失败。'))
    } finally {
      setActionBusy(false)
    }
  }

  const verifySources = async () => {
    setActionBusy(true)
    try {
      await onKnowledgeTask({ kind: 'verify', reviewId })
    } catch {
      setActionMessage('无法启动资料核对会话，请重试。')
    } finally {
      setActionBusy(false)
    }
  }

  const createDecision = async () => {
    if ((decision === 'rejected' || decision === 'changes-requested') && decisionReason.trim().length === 0) {
      setDecisionMessage('退回或拒绝评审时必须填写理由。')
      return
    }
    setActionBusy(true)
    setDecisionMessage('正在生成决策…')
    try {
      await requestJson(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: decision, reason: decisionReason.trim() }),
      })
      await load()
      setDecisionMessage('决策和 Markdown 报告已生成。')
    } catch (cause) {
      setDecisionMessage(messageFor(cause, '无法生成决策，请先处理未确认的 Blocker。'))
    } finally {
      setActionBusy(false)
    }
  }

  const updateCandidate = async (candidateId: string, status: ArchitectureReviewCandidate['status'], reason: string): Promise<boolean> => {
    setActionBusy(true)
    try {
      const updated = await requestJson<ArchitectureReviewCandidate>(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}/candidates`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidateId, status, reason }),
      })
      setReview(current => current === null || current.candidates === undefined ? current
        : { ...current, candidates: current.candidates.map(item => item.candidateId === updated.candidateId ? updated : item) })
      setActionMessage(`已保存：${candidateStatusLabel(status)}。`)
      return true
    } catch (cause) { setActionMessage(messageFor(cause, '无法保存处理记录。')); return false }
    finally { setActionBusy(false) }
  }

  const openReport = async () => {
    try {
      const page = await requestJson<{ content: string }>(`${ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH}?path=${encodeURIComponent(`reviews/${reviewId}/report.md`)}`)
      setReportContent(current => current === null ? page.content : null)
      setDecisionMessage(null)
    } catch (cause) {
      setDecisionMessage(messageFor(cause, '报告尚未生成，请先完成决策。'))
    }
  }

  const exportReport = async () => {
    setActionBusy(true)
    setDecisionMessage('正在导出报告…')
    try {
      const result = await requestJson<{ path?: string }>(ARCHITECTURE_REVIEW_EXPORT_PATH, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewId, format: 'markdown' }),
      })
      setDecisionMessage(result.path === undefined ? '报告已导出。' : `报告已导出到 ${result.path}`)
    } catch (cause) {
      setDecisionMessage(messageFor(cause, '报告导出失败，请先生成决策。'))
    } finally {
      setActionBusy(false)
    }
  }

  const run = review?.run
  const runActive = run?.status === 'starting' || run?.status === 'reviewing'
  const sourcesChanged = run !== undefined && run !== null && (JSON.stringify(review?.sources ?? []) !== JSON.stringify(run.sources)
    || JSON.stringify(review?.basisPaths ?? []) !== JSON.stringify(run.standards.map(item => item.path))
    || JSON.stringify(review?.expertIds ?? []) !== JSON.stringify(run.experts.map(item => item.expertId))
    || run.standards.some(item => standards.find(standard => standard.path === item.path)?.sha256 !== item.sha256))
  const hasReadableSource = review?.sources?.some(source => source.parseStatus === 'ready') ?? false
  const unreadableSources = review?.sources?.filter(source => source.parseStatus !== 'ready') ?? []
  const ready = hasReadableSource && expertIds.length > 0
  const pendingCandidates = review?.candidates?.filter(item => item.status === 'proposed' || item.status === 'needs-evidence').length ?? 0
  const failedExperts = run?.experts.filter(expert => expert.status === 'failed').length ?? 0
  const stages = ['资料准备', '专家评审', '人工确认', '决策'] as const
  const stageIndex = sourcesChanged ? 0 : review?.status === 'completed' ? 3 : run?.status === 'human-review' ? 2 : runActive ? 1 : 0
  const primaryLabel = runActive ? '查看进度' : !hasReadableSource ? '补充评审资料' : expertIds.length === 0 ? '选择评审专家' : sourcesChanged ? '重新评审' : run?.status === 'human-review' ? pendingCandidates > 0 ? '处理未决意见' : '查看决策' : run === null || run === undefined ? '开始专家评审' : '重新评审'
  const primaryAction = () => {
    if (runActive) setDetailTab('experts')
    else if (!hasReadableSource) { setDetailTab('materials'); setActionMessage((review?.sources?.length ?? 0) > 0 ? '已保存的资料尚无可读取正文。扫描版 PDF、DOCX 或图片请补充可读取的文本版。' : '请添加至少一份可读取的待评审资料。'); importInput.current?.click() }
    else if (expertIds.length === 0) { setDetailTab('experts'); setActionMessage('请选择参与评审的专家。') }
    else if (run?.status === 'human-review' && !sourcesChanged) setDetailTab(pendingCandidates > 0 ? 'candidates' : 'decision')
    else void startReview()
  }

  return (
    <main className="dshArchitectureReviewPage">
      <button type="button" className="backButton" onClick={onBack}>← 返回评审项目</button>
      <PageHeader title={review?.title ?? reviewId} description={`${reviewId}${review === null ? '' : ` · ${review.version} · ${sourcesChanged ? '待重新评审' : reviewStatusLabel(review.status)}`}`} actions={<><input ref={importInput} type="file" hidden multiple accept=".pdf,.docx,.md,.markdown,.txt,.json,.yaml,.yml,.openapi,.png,.jpg,.jpeg,.webp" onChange={event => void importSources(event.currentTarget.files)} /><button type="button" className="secondary" onClick={() => importInput.current?.click()} disabled={review === null || actionBusy || runActive}>添加待评审资料</button><button type="button" className="primary" onClick={primaryAction} disabled={review === null || actionBusy}>{actionBusy ? '处理中…' : primaryLabel}</button></>} />
      {error !== null && <Banner kind="error" message={error} actionLabel="重试" onAction={() => void load()} />}
      {actionMessage !== null && <Banner kind={actionMessage.includes('失败') || actionMessage.includes('无法') || actionMessage.includes('请先') || actionMessage.includes('不支持') || actionMessage.includes('已存在') ? 'error' : 'success'} message={actionMessage} actionLabel="关闭" onAction={() => setActionMessage(null)} />}
      <ol className="dshArchitectureReviewStages" aria-label="评审阶段">{stages.map((stage, index) => <li key={stage} aria-current={index === stageIndex ? 'step' : undefined} className={index === stageIndex ? 'current' : index < stageIndex ? 'done' : ''}><span>{index + 1}</span>{stage}</li>)}</ol>
      {sourcesChanged && <div className="dshArchitectureReviewNotice" role="status">评审资料、依据或专家选择已变化。当前结论只适用于上一次运行，请重新评审后再决策。</div>}
      {runActive && run !== undefined && run !== null && <ExpertRunMonitor key={run.runId} client={client} reviewId={reviewId} run={run} onUpdate={() => void load()} onError={setActionMessage} />}
      <div className="dshArchitectureReviewTabs" role="tablist" aria-label="评审详情">{([['materials', '资料'], ['experts', '专家进度'], ['candidates', '候选问题'], ['decision', '决策']] as const).map(([id, label]) => <button type="button" role="tab" key={id} aria-selected={detailTab === id} className={detailTab === id ? 'active' : ''} onClick={() => setDetailTab(id)}>{label}{id === 'candidates' && pendingCandidates > 0 ? ` ${pendingCandidates}` : ''}</button>)}</div>
      {detailTab === 'experts' && <>
      <section className="dshArchitectureReviewExpertsSetup" aria-label="参与评审的专家智能体">
        <div className="dshArchitectureReviewPanelHeader"><h2>{run ? '本次参与专家' : '参与评审的专家智能体'}</h2><div className="dshArchitectureReviewHeaderActions">{!runActive && (run === null || run === undefined || showExpertSelection) && <button type="button" className="secondary" disabled={actionBusy || review === null || expertIds.length === 0} onClick={() => void saveExpertSelection()}>保存选择</button>}{run && !runActive && <button type="button" className="secondary" onClick={() => setShowExpertSelection(value => !value)}>{showExpertSelection ? '收起配置' : '调整下次评审专家'}</button>}</div></div>
        {run && <p>{run.experts.map(expert => expert.name).join('、')} · {run.experts.filter(expert => expert.status === 'completed').length}/{run.experts.length} 已完成</p>}
        {!runActive && (run === null || run === undefined || showExpertSelection) && <ExpertChoices catalog={catalog} selected={expertIds} onToggle={id => setExpertIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])} />}
        {review !== null && review.expertIds.length > 0 && <p>已选专家引用 {review.basisPaths.length} 份规范原件，启动评审时会统一核对。</p>}
        {expertError !== null && <p role="alert">{expertError}</p>}
      </section>
      {run !== undefined && run !== null && <section className="dshArchitectureReviewExpertTasks"><div className="dshArchitectureReviewPanelHeader"><h2>专家任务 · {run.experts.filter(item => item.status === 'completed').length}/{run.experts.length} 已完成</h2>{!runActive && <button type="button" className="secondary" disabled={actionBusy || !ready} onClick={() => void startReview()}>重新评审{sourcesChanged ? '更新后资料' : '同一资料'}</button>}</div><p>运行 ID：{run.runId} · 资料 {run.sourceVersion} · 评审依据 {run.standards.length} 份</p>{run.experts.map(expert => <article key={expert.expertId}><div><strong>{expert.name}</strong><Status status={expert.status} />{expert.status === 'failed' && run.status === 'human-review' && <button type="button" className="secondary" disabled={actionBusy} onClick={() => void retryExpert(expert.expertId)}>重试该专家</button>}</div>{expert.error && <p role="alert">{expert.error}</p>}{expert.conclusion && <details><summary>查看原始结论与证据</summary><pre>{expert.conclusion}</pre></details>}</article>)}</section>}
      {run && activeTask !== null && activeTask.task.kind === 'review' && (run.sessionId === activeTask.sessionId || run.experts.some(expert => expert.sessionId === activeTask.sessionId)) && <details className="dshArchitectureReviewTranscript"><summary>查看协作会话原文</summary><KnowledgeResult key={activeTask.sessionId} client={client} activeTask={activeTask} onClear={onClearTask} /></details>}
      </>}
      {detailTab === 'materials' && <>
      <div className="dshArchitectureReviewDetail" aria-busy={loading}>
        <aside className="dshArchitectureReviewDetailColumn">
          <h2>{run === null || run === undefined ? '待评审资料' : '本次评审资料'}</h2>
          <div className="dshArchitectureReviewTreeItem active"><span aria-hidden>◫</span>{review?.version ?? 'v1'}</div>
          <h3>原始资料</h3>
          {(review?.sources?.length ?? 0) === 0 ? <p>尚未添加待评审资料</p> : review?.sources?.map(source => <button type="button" className={`dshArchitectureReviewTreeItem${selectedSource?.path === source.path ? ' active' : ''}`} key={source.path} title={source.path} onClick={() => void openSource(source)}><span aria-hidden>▧</span><span><strong>{source.name}</strong><small>{source.parseStatus === 'ready' ? source.name.toLowerCase().endsWith('.pdf') ? '已提取文字，图表需核对原件' : '可读取' : source.name.toLowerCase().endsWith('.pdf') ? '未提取到文字，需 OCR 或文本版' : '仅保存，需补充文本版'}</small></span></button>)}
        </aside>
        <section className="dshArchitectureReviewDetailColumn">
          <h2>资料提交状态</h2>
          <div className="dshArchitectureReviewDetailSummary"><span><strong>{review?.sources?.length ?? 0}</strong><small>已提交</small></span><span><strong>{review?.sources?.filter(source => source.parseStatus === 'ready').length ?? 0}</strong><small>可读取</small></span><span><strong>{unreadableSources.length}</strong><small>需补文本</small></span></div>
          {(review?.sources?.length ?? 0) === 0
            ? <EmptyState compact icon="▧" title="尚未提交资料" description="添加架构说明、接口定义、数据模型或部署资料后即可开始评审。" />
            : unreadableSources.length === 0
              ? <EmptyState compact icon="✓" title="资料均可读取" description="启动专家评审时会核对专家引用的规范原件。" />
              : <div className="dshArchitectureReviewNotice"><strong>以下原件无法读取正文</strong><p>{unreadableSources.map(source => source.name).join('、')}</p><span>原件已保存，请补充 OCR、Markdown 或 TXT 文本版。</span></div>}
        </section>
        <aside className="dshArchitectureReviewDetailColumn">
          <h2>原始资料</h2>
          {selectedSource !== null ? <ArtifactPreview artifact={selectedSource} /> : <div className="dshArchitectureReviewEvidence"><span className="dshArchitectureReviewEvidenceIcon" aria-hidden>◎</span><strong>选择一份资料</strong><span>文件信息和可读取内容会显示在这里。</span></div>}
        </aside>
      </div>
      <div className="dshArchitectureReviewHeaderActions"><button type="button" className="secondary" onClick={() => void verifySources()} disabled={review === null || actionBusy}>资料核对</button><button type="button" className="secondary" onClick={() => void runLint()} disabled={review === null || actionBusy}>运行 Wiki Lint</button></div>
      </>}
      {detailTab === 'candidates' && <section className="dshArchitectureReviewCandidateList"><h2>候选问题</h2><p>还有 {pendingCandidates} 条意见未作最终判断。标记为“待补充证据”的意见仍需处理，不能形成决策；此操作不会自动发出补充资料请求。</p>{(review?.candidates?.length ?? 0) === 0 ? <EmptyState compact icon="◎" title="暂无候选问题" description={runActive ? '专家任务结束后会汇总到这里。' : '启动专家评审后在这里处理意见。'} /> : review?.candidates?.map(candidate => <CandidateCard key={candidate.candidateId} candidate={candidate} busy={actionBusy || runActive} onUpdate={(status, reason) => updateCandidate(candidate.candidateId, status, reason)} />)}</section>}
      {detailTab === 'decision' &&
      <section className="dshArchitectureReviewPanel dshArchitectureReviewDecisionPanel">
        <div className="dshArchitectureReviewPanelHeader"><h2>决策与报告</h2><div className="dshArchitectureReviewHeaderActions"><button type="button" className="secondary" onClick={() => void openReport()} disabled={review?.status !== 'completed'}>{reportContent === null ? '查看报告' : '收起报告'}</button><button type="button" className="secondary" onClick={() => void exportReport()} disabled={review?.status !== 'completed' || actionBusy}>⇩ 导出 Markdown</button></div></div>
        <div className="dshArchitectureReviewPanelBody"><div className="dshArchitectureReviewFormGrid"><div className="dshArchitectureReviewField"><label htmlFor="architecture-review-decision">评审结果</label><select id="architecture-review-decision" value={decision} onChange={event => setDecision(event.currentTarget.value as typeof decision)}><option value="approved">通过</option><option value="conditional">有条件通过</option><option value="changes-requested">退回修改</option><option value="rejected">拒绝</option></select></div><div className="dshArchitectureReviewField"><label htmlFor="architecture-review-decision-reason">决策说明</label><textarea id="architecture-review-decision-reason" value={decisionReason} onChange={event => setDecisionReason(event.currentTarget.value)} placeholder="记录风险接受、未完成专家和后续行动" /></div></div>{run?.status !== 'human-review' && <p className="dshArchitectureReviewDecisionWarning">请等待所有专家任务结束，再进行人工确认。</p>}{sourcesChanged && <p className="dshArchitectureReviewDecisionWarning">资料或评审依据已变化，请重新评审后再决策。</p>}{failedExperts > 0 && <p className="dshArchitectureReviewDecisionWarning">{failedExperts} 位专家未完成，继续决策必须说明理由，且不能无保留通过。</p>}{pendingCandidates > 0 && <p className="dshArchitectureReviewDecisionWarning">还有 {pendingCandidates} 条专家意见未作最终判断（含待补充证据），请先处理。</p>}<div className="dshArchitectureReviewHeaderActions"><button type="button" className="primary" onClick={() => void createDecision()} disabled={run?.status !== 'human-review' || actionBusy || sourcesChanged || pendingCandidates > 0}>生成决策与报告</button>{decisionMessage !== null && <span role="status">{decisionMessage}</span>}</div>{reportContent !== null && <pre className="dshArchitectureReviewReport">{reportContent}</pre>}</div>
      </section>
      }
    </main>
  )
}

function ArtifactPreview({ artifact }: { artifact: ArchitectureReviewArtifactContent }) {
  return <div className="dshArchitectureReviewEvidence"><strong>{artifact.name}</strong><dl className="dshArchitectureReviewMetaList"><dt>大小</dt><dd>{formatFileSize(artifact.size)}</dd><dt>路径</dt><dd>{artifact.path}</dd><dt>SHA-256</dt><dd>{artifact.sha256}</dd></dl>{artifact.content === null ? <p>{artifact.name.toLowerCase().endsWith('.pdf') ? 'PDF 未提取到可读取文字，请补充 OCR 或文本版。' : '此格式已安全保存，请另附可读取的文本版。'}</p> : <>{artifact.name.toLowerCase().endsWith('.pdf') && <p>以下为自动提取的文字层；图表、签章及排版仍需核对 PDF 原件。</p>}<pre className="dshArchitectureReviewReport">{artifact.content}</pre>{artifact.truncated && <p>只显示前 512 KB。</p>}</>}</div>
}

function ExpertRunMonitor({ client, reviewId, run, onUpdate, onError }: {
  client: ClientContext
  reviewId: string
  run: ArchitectureReviewRun
  onUpdate: () => void
  onError: (message: string) => void
}) {
  const sessions = useKnowledgeSnapshot(client.sessions.list)
  const sessionId = run.experts.find(expert => expert.status === 'waiting' || expert.status === 'reviewing')?.sessionId ?? null
  const binding = sessionId !== null && sessions.byId[sessionId] !== undefined ? client.sessions.binding(sessionId) : undefined
  useEffect(() => {
    if (sessionId !== null && binding !== undefined && sessions.current !== sessionId) client.sessions.open(sessionId)
  }, [client, sessionId, binding, sessions.current])
  if (sessionId === null || binding === undefined) return null
  return <ExpertRunSession key={sessionId} binding={binding} reviewId={reviewId} run={run} sessionId={sessionId} onUpdate={onUpdate} onError={onError} />
}

function ExpertRunSession({ binding, reviewId, run, sessionId, onUpdate, onError }: {
  binding: SessionBinding
  reviewId: string
  run: ArchitectureReviewRun
  sessionId: string
  onUpdate: () => void
  onError: (message: string) => void
}) {
  const window = useKnowledgeSnapshot(binding.eventSource)
  const progress = expertSessionProgress(window.entries, run.experts.filter(expert => expert.sessionId === sessionId).map(expert => expert.expertId))
  const inFlight = useRef(new Set<string>())
  useEffect(() => {
    for (const state of progress.experts) {
      const stored = run.experts.find(expert => expert.expertId === state.expertId)
      if (stored === undefined || stored.status === 'completed' || stored.status === 'failed'
        || stored.status === state.status || state.status === 'waiting' || inFlight.current.has(state.expertId)) continue
      inFlight.current.add(state.expertId)
      void requestJson(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}/expert-result`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: run.runId, expertId: state.expertId, sessionId, status: state.status,
          conclusion: state.conclusion, ...(state.error === undefined ? {} : { error: state.error }) }),
      }).then(onUpdate).catch(cause => onError(messageFor(cause, '无法保存专家进度。'))).finally(() => inFlight.current.delete(state.expertId))
    }
  }, [window.entries, run, sessionId, reviewId, onUpdate, onError])
  return null
}

function CandidateCard({ candidate, busy, onUpdate }: {
  candidate: ArchitectureReviewCandidate
  busy: boolean
  onUpdate: (status: ArchitectureReviewCandidate['status'], reason: string) => Promise<boolean>
}) {
  const [reason, setReason] = useState('')
  const actions = [
    { status: 'confirmed', label: '认定问题成立', title: '认定专家意见成立；保留处理记录，不会自动生成正式问题。' },
    { status: 'rejected', label: '判定意见不成立', title: '认为该意见不成立或不适用，并记录判断依据。' },
    { status: 'needs-evidence', label: '证据不足，待补资料', title: '暂缓判断，仍不能形成决策；需补充资料后重新评审，不会自动发出通知。' },
    { status: 'accepted-risk', label: '记录并接受风险', title: '保留风险及接受理由；本次评审的最终结果仍需另行决策。' },
  ] as const
  return <article className="dshArchitectureReviewCandidate"><header><h3>{candidate.title}</h3><span className="dshArchitectureReviewStatus" data-status={candidate.status}>{candidateStatusLabel(candidate.status)}</span></header>
    <p>参与意见：{candidate.expertIds.join('、')}</p>
    <dl><dt>支持证据</dt><dd>{candidate.evidence.length ? candidate.evidence.join('；') : '暂无可核实证据'}</dd><dt>反证与分歧</dt><dd>{candidate.counterEvidence.length ? candidate.counterEvidence.join('；') : '暂无'}</dd><dt>未核实限制</dt><dd>{candidate.limitations.length ? candidate.limitations.join('；') : '暂无'}</dd></dl>
    <details><summary>查看专家原文</summary>{candidate.opinions.map((opinion, index) => <p key={`${opinion.expertId}-${index}`}><strong>{opinion.expertId}：</strong>{opinion.text}</p>)}</details>
    {candidate.reason && <p><strong>上次判断依据：</strong>{candidate.reason}</p>}
    <label className="dshArchitectureReviewCandidateReason">判断依据（必填）<textarea value={reason} onChange={event => setReason(event.currentTarget.value)} placeholder="写明证据、还缺少的资料，或接受风险的理由" /></label>
    <div className="dshArchitectureReviewHeaderActions">{actions.map(action => <button type="button" key={action.status} className="secondary" title={action.title} disabled={busy || !reason.trim() || (action.status === 'confirmed' && candidate.evidence.length === 0)} onClick={async () => { if (await onUpdate(action.status, reason)) setReason('') }}>{action.label}</button>)}</div>
    {candidate.evidence.length === 0 && <small className="dshArchitectureReviewCandidateHint">没有可核实证据，暂不能认定问题成立。</small>}
  </article>
}

function KnowledgePage({ client, workspace, activeTask, onClearTask, onOpenReview, onInitialize, onKnowledgeTask }: {
  client: ClientContext
  workspace: ArchitectureReviewWorkspaceSnapshot | null
  activeTask: ActiveKnowledgeTask | null
  onClearTask: () => void
  onOpenReview: (reviewId: string) => void
  onInitialize: () => void
  onKnowledgeTask: (task: KnowledgeTask) => Promise<void>
}) {
  const [tab, setTab] = useState<'raw' | 'wiki'>('raw')
  const [pages, setPages] = useState<readonly WikiPageSummary[]>([])
  const [artifacts, setArtifacts] = useState<readonly ArchitectureReviewSource[]>([])
  const [selectedPage, setSelectedPage] = useState<WikiPageContent | null>(null)
  const [selectedArtifact, setSelectedArtifact] = useState<ArchitectureReviewArtifactContent | null>(null)
  const [query, setQuery] = useState('')
  const [question, setQuestion] = useState('')
  const [taskBusy, setTaskBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (workspace?.initialized !== true) return
    const controller = new AbortController()
    if (tab === 'raw') {
      void requestJson<{ artifacts?: readonly ArchitectureReviewSource[] }>(ARCHITECTURE_REVIEW_ARTIFACTS_PATH, undefined, controller.signal).then(payload => { setArtifacts(payload.artifacts ?? []); setError(null) }).catch(cause => { if (!isAbortError(cause)) setError(messageFor(cause, '无法读取原始资料。')) })
    } else {
      void requestJson<{ pages?: readonly ArchitectureReviewPageSummary[] }>(ARCHITECTURE_REVIEW_PAGES_PATH, undefined, controller.signal).then(payload => { setPages((payload.pages ?? []).map(page => ({ ...page, id: page.path }))); setError(null) }).catch(cause => { if (!isAbortError(cause)) setError(messageFor(cause, '无法读取页面目录。')) })
    }
    return () => controller.abort()
  }, [workspace?.initialized, tab])

  const openPage = async (page: WikiPageSummary) => {
    try {
      const payload = await requestJson<WikiPageContent>(`${ARCHITECTURE_REVIEW_PAGE_CONTENT_PATH}?path=${encodeURIComponent(page.path)}`)
      setSelectedPage(payload)
      setError(null)
    } catch (cause) {
      setError(messageFor(cause, '无法读取页面内容。'))
    }
  }
  const openArtifact = async (artifact: ArchitectureReviewSource) => {
    try {
      const payload = await requestJson<ArchitectureReviewArtifactContent>(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(artifact.reviewId)}/artifact-content?name=${encodeURIComponent(artifact.name)}`)
      setSelectedArtifact(payload)
      setError(null)
    } catch (cause) {
      setError(messageFor(cause, '无法读取原始资料。'))
    }
  }
  const startTask = async (task: KnowledgeTask) => {
    setTaskBusy(true)
    setError(null)
    try {
      await onKnowledgeTask(task)
      if (task.kind === 'query') setQuestion('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法启动知识会话，请重试。')
    } finally {
      setTaskBusy(false)
    }
  }
  const term = query.trim().toLowerCase()
  const visiblePages = pages.filter(page => `${page.title} ${page.path}`.toLowerCase().includes(term))
  const visibleArtifacts = artifacts.filter(artifact => `${artifact.name} ${artifact.path} ${artifact.reviewId}`.toLowerCase().includes(term))
  const visibleCount = tab === 'raw' ? visibleArtifacts.length : visiblePages.length
  if (workspace?.initialized !== true) return <main className="dshArchitectureReviewPage"><PageHeader title="资料与知识" description="浏览工作区中的原始资料和 Wiki 文件。" /><div className="dshArchitectureReviewPanel"><EmptyState icon="⌂" title="工作区尚未初始化" description="选择本地工作区后即可浏览资料。" actionLabel="初始化工作区" onAction={onInitialize} /></div></main>
  return <main className="dshArchitectureReviewPage">
    <PageHeader title="资料与知识" description="浏览工作区中的原始资料和 Wiki 文件。" actions={<button type="button" className="secondary" onClick={() => void startTask({ kind: 'maintain' })} disabled={taskBusy}>维护知识</button>} />
    <form className="dshArchitectureReviewKnowledgeQuery" onSubmit={event => { event.preventDefault(); if (question.trim()) void startTask({ kind: 'query', question }) }}>
      <label htmlFor="architecture-review-question">查询资料与知识</label>
      <div><input id="architecture-review-question" value={question} onChange={event => setQuestion(event.currentTarget.value)} placeholder="输入需要原件核对的问题" /><button type="submit" className="primary" disabled={taskBusy || question.trim() === ''}>{activeTask?.task.kind === 'query' ? '继续提问' : '查询'}</button></div>
    </form>
    {activeTask !== null && <KnowledgeResult key={activeTask.sessionId} client={client} activeTask={activeTask} onClear={onClearTask} onOpenReview={onOpenReview} />}
    <div className="dshArchitectureReviewKnowledgeToolbar">
      <div className="dshArchitectureReviewTabs" role="tablist"><button type="button" role="tab" aria-selected={tab === 'raw'} className={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')}>原始资料</button><button type="button" role="tab" aria-selected={tab === 'wiki'} className={tab === 'wiki' ? 'active' : ''} onClick={() => setTab('wiki')}>Wiki 文件</button></div>
      <div className="dshArchitectureReviewField"><input aria-label="筛选文件" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="筛选名称或路径" /></div>
    </div>
    {error !== null && <Banner kind="error" message={error} actionLabel="关闭" onAction={() => setError(null)} />}
    {visibleCount === 0 ? <div className="dshArchitectureReviewPanel"><EmptyState icon="◫" title={term === '' ? `暂无${tab === 'raw' ? '原始资料' : 'Wiki 文件'}` : '没有匹配结果'} description={tab === 'raw' ? '从评审详情导入资料后会显示在这里。' : '初始化工作区或运行评审后会生成 Wiki 文件。'} /></div> : <div className="dshArchitectureReviewDetail"><section className="dshArchitectureReviewDetailColumn">{tab === 'raw' ? visibleArtifacts.map(artifact => <button type="button" className={`dshArchitectureReviewTreeItem${selectedArtifact?.path === artifact.path ? ' active' : ''}`} key={artifact.path} onClick={() => void openArtifact(artifact)}><span aria-hidden>▧</span><span><strong>{artifact.name}</strong><small>{artifact.reviewId} · {formatFileSize(artifact.size)}</small></span></button>) : visiblePages.map(page => <button type="button" className={`dshArchitectureReviewTreeItem${selectedPage?.path === page.path ? ' active' : ''}`} key={page.path} onClick={() => void openPage(page)}><span aria-hidden>▧</span><span><strong>{page.title}</strong><small>{page.path}</small></span></button>)}</section><section className="dshArchitectureReviewDetailColumn dshArchitectureReviewDetailWide">{tab === 'raw' ? selectedArtifact === null ? <EmptyState compact icon="◎" title="选择一份资料" description="文件信息和可预览的正文会显示在这里。" /> : <ArtifactPreview artifact={selectedArtifact} /> : selectedPage === null ? <EmptyState compact icon="◎" title="选择一个文件" description="文件正文会显示在这里。" /> : <><h2>{selectedPage.title}</h2><dl className="dshArchitectureReviewMetaList"><dt>路径</dt><dd>{selectedPage.path}</dd></dl>{selectedPage.content !== undefined && <pre>{selectedPage.content}</pre>}</>}</section></div>}
  </main>
}

function useKnowledgeSnapshot<T>(source: { subscribe(listener: () => void): () => void; getSnapshot(): T }): T {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const getSnapshot = useCallback(() => source.getSnapshot(), [source])
  return useSyncExternalStore(subscribe, getSnapshot)
}

function KnowledgeResult({ client, activeTask, onClear, onOpenReview, onComplete }: {
  client: ClientContext
  activeTask: ActiveKnowledgeTask
  onClear: () => void
  onOpenReview?: (reviewId: string) => void
  onComplete?: () => void
}) {
  const sessions = useKnowledgeSnapshot(client.sessions.list)
  const binding = sessions.byId[activeTask.sessionId] === undefined ? undefined : client.sessions.binding(activeTask.sessionId)
  const reviewId = activeTask.task.kind === 'verify' || activeTask.task.kind === 'review' ? activeTask.task.reviewId : null
  useEffect(() => {
    if (binding !== undefined && client.sessions.list.getSnapshot().current !== activeTask.sessionId) {
      client.sessions.open(activeTask.sessionId)
      client.layout.selectPanel(ARCHITECTURE_REVIEW_PANEL_ID as MainPanelId)
    }
  }, [client, activeTask.sessionId, binding])
  return <section className="dshArchitectureReviewKnowledgeResult" aria-label="知识任务结果">
    <div className="dshArchitectureReviewKnowledgeResultHeader">
      <div><h2>{activeTask.task.kind === 'maintain' ? '知识维护' : activeTask.task.kind === 'verify' ? `${activeTask.task.reviewId} 资料核对` : activeTask.task.kind === 'review' ? `${activeTask.task.reviewId} 专家协作评审` : activeTask.task.kind === 'experts' ? '专家目录更新' : activeTask.task.kind === 'expert' ? `${activeTask.task.expertName}咨询` : '查询结果'}</h2><span>工作区知识会话</span></div>
      <div className="dshArchitectureReviewHeaderActions">
        {reviewId !== null && onOpenReview !== undefined && <button type="button" className="secondary" onClick={() => onOpenReview(reviewId)}>返回评审</button>}
        {binding === undefined
          ? <button type="button" className="secondary" disabled>新建查询</button>
          : <KnowledgeNewQueryButton binding={binding} onClear={onClear} label={activeTask.task.kind === 'review' ? '收起结果' : '新建查询'} />}
      </div>
    </div>
    {binding === undefined
      ? <p className="dshArchitectureReviewKnowledgeStatus">正在恢复会话…</p>
      : <KnowledgeSessionResult binding={binding} task={activeTask.task} onComplete={onComplete} />}
  </section>
}

function KnowledgeNewQueryButton({ binding, onClear, label }: { binding: SessionBinding; onClear: () => void; label: string }) {
  const session = useKnowledgeSnapshot(binding.session)
  const busy = session.running || session.queue.length > 0 || session.pendingSubmissions.length > 0 || session.awaitingFirstTurn
  return <button type="button" className="secondary" onClick={onClear} disabled={busy} title={busy ? '等待当前任务完成' : undefined}>{label}</button>
}

function KnowledgeSessionResult({ binding, task, onComplete }: { binding: SessionBinding; task: KnowledgeTask; onComplete?: (() => void) | undefined }) {
  const session = useKnowledgeSnapshot(binding.session)
  const window = useKnowledgeSnapshot(binding.eventSource)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const completionNotified = useRef(false)
  const turns = knowledgeTranscript(window.entries)
  const last = turns.at(-1)
  const delegated = turns.reduce((total, turn) => total + turn.delegations, 0)
  const queued = session.queue.length > 0 || session.pendingSubmissions.length > 0 || session.awaitingFirstTurn
  useEffect(() => {
    if (task.kind === 'experts' && !completionNotified.current && !session.running && !queued && last?.outcome === 'completed') {
      completionNotified.current = true
      onComplete?.()
    }
  }, [task.kind, session.running, queued, last?.outcome, onComplete])
  const failure = last?.failure ?? (last?.outcome === undefined && !session.running ? session.lastAgentError : null)
    ?? (session.openState === 'error' ? session.openError?.message : null)
  const status = failure !== null && failure !== undefined ? failure
    : session.openState === 'loading' || session.openState === 'cold' ? '正在读取会话…'
      : session.running ? '正在查阅资料…'
        : queued ? '等待执行…'
          : last?.outcome === 'aborted' || last?.outcome === 'interrupted' ? '已停止'
            : last?.outcome === 'blocked' ? '任务未能完成'
              : last?.outcome === 'max-tokens' ? '已达到输出上限' : '已完成'
  const cancel = async () => {
    setCancelling(true)
    setCancelError(null)
    try {
      const result = await binding.session.cancel()
      if (!result.ok) setCancelError(result.error.message)
    } catch (cause) {
      setCancelError(cause instanceof Error ? cause.message : '停止任务失败。')
    } finally {
      setCancelling(false)
    }
  }
  return <>
    {task.kind === 'review' && <p className="dshArchitectureReviewKnowledgeStatus" role="status">子智能体委派：{delegated}/{task.expertIds.length}{!session.running && !queued && last?.outcome === 'completed' && delegated < task.expertIds.length ? '。委派未全部发出，请检查回答并重试。' : ''}</p>}
    <div className="dshArchitectureReviewKnowledgeProgress" role="status"><span>{status}</span>{session.running && <button type="button" className="secondary" onClick={() => void cancel()} disabled={cancelling}>{cancelling ? '正在停止…' : '停止'}</button>}</div>
    {cancelError !== null && <p className="dshArchitectureReviewKnowledgeFailure" role="alert">{cancelError}</p>}
    <div className="dshArchitectureReviewKnowledgeTurns" aria-live="polite">
      {turns.length === 0 && <div className="dshArchitectureReviewKnowledgeTurn"><strong>提问</strong><p>{task.kind === 'query' || task.kind === 'expert' ? task.question : task.kind === 'verify' ? `${task.reviewId} 资料核对` : task.kind === 'review' ? `${task.reviewId} 专家协作评审` : task.kind === 'experts' ? '更新专家目录' : '维护知识'}</p><p className="dshArchitectureReviewKnowledgePending">{status}</p></div>}
      {turns.map(turn => <div className="dshArchitectureReviewKnowledgeTurn" key={turn.turn}>
        <strong>提问</strong><p>{turn.question || (task.kind === 'query' ? task.question : '资料核对')}</p>
        {turn.answer !== '' && <><strong>回答</strong><div className="dshArchitectureReviewKnowledgeAnswer"><MarkdownText text={turn.answer} streaming={turn.outcome === undefined} labels={KNOWLEDGE_MARKDOWN_LABELS} /></div></>}
        {turn.failure !== undefined && <p className="dshArchitectureReviewKnowledgeFailure" role="alert">{turn.failure}</p>}
        {turn.answer === '' && turn.failure === undefined && <p className="dshArchitectureReviewKnowledgePending">{turn.outcome === undefined ? '正在核对资料…' : '没有生成回答。'}</p>}
      </div>)}
    </div>
  </>
}

function ExpertsPage({ client, workspace, activeTask, onClearTask, onKnowledgeTask, onInitialize }: {
  client: ClientContext
  workspace: ArchitectureReviewWorkspaceSnapshot | null
  activeTask: ActiveKnowledgeTask | null
  onClearTask: () => void
  onKnowledgeTask: (task: KnowledgeTask) => Promise<void>
  onInitialize: () => void
}) {
  const [catalog, setCatalog] = useState<ArchitectureReviewExpertCatalog | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async (signal?: AbortSignal) => {
    if (workspace?.initialized !== true) return
    try {
      const payload = await requestJson<{ catalog: ArchitectureReviewExpertCatalog | null }>(ARCHITECTURE_REVIEW_EXPERTS_PATH, undefined, signal)
      if (signal?.aborted) return
      setCatalog(payload.catalog)
      setSelectedId(current => payload.catalog?.experts.some(expert => expert.id === current) ? current : payload.catalog?.experts[0]?.id ?? null)
      setError(null)
    } catch (cause) {
      if (!signal?.aborted && !isAbortError(cause)) setError(messageFor(cause, '无法读取专家目录。'))
    }
  }
  useEffect(() => {
    setCatalog(null)
    setSelectedId(null)
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [workspace?.root, workspace?.initialized])
  const start = async (task: KnowledgeTask) => {
    setBusy(true)
    setError(null)
    try {
      await onKnowledgeTask(task)
      if (task.kind === 'expert') setQuestion('')
    } catch (cause) {
      setError(messageFor(cause, '无法启动专家知识会话。'))
    } finally {
      setBusy(false)
    }
  }
  const selected = catalog?.experts.find(expert => expert.id === selectedId) ?? null
  if (workspace?.initialized !== true) return <main className="dshArchitectureReviewPage"><PageHeader title="评审专家智能体" description="依据工作区 Wiki 的评审依据组织专家分工。" /><EmptyState icon="⌂" title="工作区尚未初始化" description="选择知识库目录后，可从 Wiki 形成专家分工。" actionLabel="初始化工作区" onAction={onInitialize} /></main>
  return <main className="dshArchitectureReviewPage">
    <PageHeader title="评审专家智能体" description="从当前 Wiki 归纳的核对角色、能力与职责。" actions={<><button type="button" className="secondary" onClick={() => void load()} disabled={busy}>刷新目录</button><button type="button" className="primary" onClick={() => void start({ kind: 'experts' })} disabled={busy}>{busy && activeTask?.task.kind === 'experts' ? '正在启动…' : '从 Wiki 更新'}</button></>} />
    {error !== null && <Banner kind="error" message={error} actionLabel="重试" onAction={() => void load()} />}
    {activeTask !== null && (activeTask.task.kind === 'experts' || activeTask.task.kind === 'expert') && <KnowledgeResult key={activeTask.sessionId} client={client} activeTask={activeTask} onClear={onClearTask} onOpenReview={() => {}} onComplete={() => void load()} />}
    {catalog === null ? <EmptyState icon="◎" title="尚无专家目录" description="从当前 Wiki 生成专家分工后，这里会显示可咨询的角色。" /> : <>
      <div className="dshArchitectureReviewExpertNotice">{catalog.limitations}<br />更新于 {formatDate(catalog.generatedAt)} · {catalog.experts.length} 位专家。评审项目按所选专家协作核对。</div>
      <div className="dshArchitectureReviewExperts">
        <nav aria-label="专家列表" className="dshArchitectureReviewExpertNav">{catalog.experts.map(expert => <button type="button" key={expert.id} className={expert.id === selected?.id ? 'active' : ''} aria-current={expert.id === selected?.id ? 'true' : undefined} onClick={() => { setSelectedId(expert.id); setQuestion('') }}><strong>{expert.name}</strong><small>{expert.focus}</small></button>)}</nav>
        {selected !== null && <ExpertDetail expert={selected} question={question} onQuestion={setQuestion} busy={busy} onConsult={() => void start({ kind: 'expert', expertId: selected.id, expertName: selected.name, question })} />}
      </div>
    </>}
  </main>
}

function ExpertDetail({ expert, question, onQuestion, busy, onConsult }: { expert: ArchitectureReviewExpert; question: string; onQuestion: (value: string) => void; busy: boolean; onConsult: () => void }) {
  return <article className="dshArchitectureReviewExpertDetail"><header><span>{expert.focus}</span><h2>{expert.name}</h2><p>{expert.role}</p></header><div className="dshArchitectureReviewExpertColumns"><section><h3>核心能力</h3><ul>{expert.capabilities.map(item => <li key={item}>{item}</li>)}</ul></section><section><h3>核对职责</h3><ul>{expert.responsibilities.map(item => <li key={item}>{item}</li>)}</ul></section></div><section><h3>适用基线</h3><p>{expert.baseline}</p></section><section><h3>来源依据</h3><ul className="dshArchitectureReviewExpertSources">{expert.sources.map(source => <li key={`${source.path}:${source.detail}`}><strong>{source.detail}</strong><code>{source.path}</code></li>)}</ul></section><section><h3>职责边界</h3><p>{expert.boundaries}</p></section><form className="dshArchitectureReviewExpertQuery" onSubmit={event => { event.preventDefault(); if (question.trim()) onConsult() }}><label htmlFor="architecture-review-expert-question">向{expert.name}咨询</label><div><input id="architecture-review-expert-question" value={question} onChange={event => onQuestion(event.currentTarget.value)} placeholder="输入要核对的项目问题" /><button type="submit" className="primary" disabled={busy || question.trim() === ''}>咨询</button></div></form></article>
}

function OperationsPage({ workspace, onInitialize, onOpen }: { workspace: ArchitectureReviewWorkspaceSnapshot | null; onInitialize: () => void; onOpen: (reviewId: string) => void }) {
  const [operations, setOperations] = useState<readonly OperationSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = async (signal?: AbortSignal) => {
    if (workspace?.initialized !== true) return
    try {
      const payload = await requestJson<{ operations?: readonly ArchitectureReviewOperation[] }>(ARCHITECTURE_REVIEW_OPERATIONS_PATH, undefined, signal)
      if (!signal?.aborted) { setOperations(payload.operations ?? []); setError(null) }
    } catch (cause) {
      if (!signal?.aborted && !isAbortError(cause)) { setOperations([]); setError(messageFor(cause, '运行记录暂不可用。')) }
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = window.setInterval(() => void load(controller.signal), 5_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [workspace?.initialized])
  const operationLabels: Record<ArchitectureReviewOperation['type'], string> = { ingest: '资料提交', review: '历史资料检查', lint: 'Wiki Lint' }
  if (workspace?.initialized !== true) return <main className="dshArchitectureReviewPage"><PageHeader title="运行记录" description="查看资料提交、评审和 Wiki Lint 的结果。" /><div className="dshArchitectureReviewPanel"><EmptyState icon="⌂" title="工作区尚未初始化" description="选择本地工作区后即可查看运行记录。" actionLabel="初始化工作区" onAction={onInitialize} /></div></main>
  return <main className="dshArchitectureReviewPage"><PageHeader title="运行记录" description="查看资料提交、评审和 Wiki Lint 的结果。" actions={<button type="button" className="secondary" onClick={() => void load()}>↻ 刷新</button>} />{error !== null && <Banner kind="error" message={error} actionLabel="关闭" onAction={() => setError(null)} />}{operations.length === 0 ? <div className="dshArchitectureReviewPanel"><EmptyState icon="◷" title="暂无运行记录" description="从评审详情启动任务后，结果会显示在这里。" /></div> : <div className="dshArchitectureReviewReviewList">{operations.map(operation => <button type="button" className="dshArchitectureReviewReviewCard" key={operation.operationId} disabled={operation.reviewId === null} onClick={() => { if (operation.reviewId !== null) onOpen(operation.reviewId) }}><div><h2>{operationLabels[operation.type]}</h2><p>{operation.reviewId ?? '工作区任务'} · {formatDate(operation.startedAt)}</p></div><Status status={operation.status} /><div className="dshArchitectureReviewReviewMeta"><div>{operation.status === 'failed' ? '打开评审重试' : operation.type === 'review' ? `${String(operation.result.findingCount ?? 0)} 条历史检查项` : operation.type === 'lint' ? `${String(operation.result.issueCount ?? 0)} 个断链` : `${String(operation.result.artifactCount ?? 0)} 份资料`}</div></div></button>)}</div>}</main>
}

function SettingsPage({ workspace, onPickDirectory, onInitialized }: { workspace: ArchitectureReviewWorkspaceSnapshot | null; onPickDirectory: () => Promise<string | null>; onInitialized: () => Promise<void> }) {
  const [path, setPath] = useState(workspace?.root ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (workspace?.root !== null && workspace?.root !== undefined) setPath(workspace.root) }, [workspace?.root])
  const pickDirectory = async () => {
    setPicking(true); setError(null)
    try {
      const selected = await onPickDirectory()
      if (selected !== null) setPath(selected)
    } catch (cause) {
      setError(messageFor(cause, '无法打开目录选择器，请输入绝对路径。'))
    } finally { setPicking(false) }
  }
  const initialize = async () => {
    if (path.trim().length === 0) { setError('请输入本地绝对路径。'); return }
    setSubmitting(true); setError(null)
    try {
      await requestJson(ARCHITECTURE_REVIEW_WORKSPACE_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.trim() }) })
      await onInitialized()
    } catch (cause) {
      setError(messageFor(cause, '初始化工作区失败，请检查目录权限和路径。'))
    } finally { setSubmitting(false) }
  }
  return <main className="dshArchitectureReviewPage narrow"><PageHeader title="设置" description="管理本地知识工作区。" />{error !== null && <Banner kind="error" message={error} actionLabel="关闭" onAction={() => setError(null)} />}<section className="dshArchitectureReviewSettingsSection"><h2>本地工作区</h2><p>该目录保存原始资料、Wiki 文件、评审结果、导出文件和运行日志。</p>{workspace?.initialized === true && <div className="dshArchitectureReviewPath">{workspace.root}</div>}<div className="dshArchitectureReviewForm"><div className="dshArchitectureReviewField"><label htmlFor="architecture-review-workspace">工作区绝对路径</label><div className="dshArchitectureReviewPathPicker"><input id="architecture-review-workspace" value={path} onChange={event => { setPath(event.currentTarget.value); setError(null) }} placeholder="C:\\Documents\\architecture-review-workspace" autoComplete="off" /><button type="button" className="secondary" onClick={() => void pickDirectory()} disabled={submitting || picking}>{picking ? '正在选择…' : '选择目录'}</button></div><small>也可以手动输入绝对路径；选择目录后仍需点击初始化。</small></div><div><button type="button" className="primary" onClick={() => void initialize()} disabled={submitting || picking}>{submitting ? '正在初始化…' : workspace?.initialized === true ? '验证并使用此目录' : '初始化工作区'}</button></div></div></section></main>
}

function ArchitectureReviewOverlay(_props: OverlayProps) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_CREATE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_CREATE_EVENT, onOpen)
  }, [])
  return open ? <CreateReviewWizard onClose={() => setOpen(false)} /> : null
}

function CreateReviewWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [input, setInput] = useState<ReviewBasics>({ title: '', systemName: '', type: 'new-system', owner: '', description: '' })
  const [errors, setErrors] = useState<Partial<Record<keyof CreateReviewInput, string>>>({})
  const [sources, setSources] = useState<readonly DraftSource[]>([])
  const [catalog, setCatalog] = useState<ArchitectureReviewExpertCatalog | null>(null)
  const [expertIds, setExpertIds] = useState<readonly string[]>([])
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [created, setCreated] = useState<ArchitectureReviewSummary | null>(null)
  const [uploadedKeys, setUploadedKeys] = useState<ReadonlySet<string>>(new Set())
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void requestJson<{ catalog: ArchitectureReviewExpertCatalog | null }>(ARCHITECTURE_REVIEW_EXPERTS_PATH, undefined, controller.signal)
      .then(payload => { if (!controller.signal.aborted) setCatalog(payload.catalog) })
      .catch(cause => { if (!isAbortError(cause)) setSubmitError(messageFor(cause, '无法读取专家目录。')) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', onKeyDown)
    dialog.current?.focus()
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [submitting, onClose])

  const update = (field: keyof ReviewBasics, value: string) => {
    setInput(current => ({ ...current, [field]: value }))
    setErrors(current => ({ ...current, [field]: undefined }))
  }

  const addFiles = async (files: readonly File[]) => {
    const rejected = files.filter(file => !isSupportedSource(file.name) || file.size > 5 * 1024 * 1024)
    const valid = files.filter(file => isSupportedSource(file.name) && file.size <= 5 * 1024 * 1024)
    const accepted = valid.slice(0, Math.max(0, 25 - sources.length))
    if (rejected.length > 0) setSubmitError(`${rejected.map(file => file.name).join('、')} 未添加（格式不支持或超过 5 MB）。`)
    else if (valid.length > accepted.length) setSubmitError('最多导入 25 份资料，多余文件未添加。')
    else setSubmitError(null)
    const known = new Set(sources.map(source => source.file.name))
    const added = accepted.filter(file => { if (known.has(file.name)) return false; known.add(file.name); return true }).map(file => ({ key: fileKey(file), file, digest: null, status: 'hashing' as const }))
    if (added.length < accepted.length && rejected.length === 0) setSubmitError('同名文件未重复添加。')
    if (added.length === 0) return
    setSources(current => [...current, ...added])
    await Promise.all(added.map(async source => {
      try {
        const digest = await digestFile(source.file)
        setSources(current => current.map(item => item.key === source.key ? { ...item, digest, status: 'ready' } : item))
      } catch {
        setSources(current => current.map(item => item.key === source.key ? { ...item, status: 'error' } : item))
      }
    }))
  }

  const next = () => {
    if (step === 0) {
      const nextErrors = validateReviewBasics(input)
      setErrors(nextErrors)
      if (Object.keys(nextErrors).length > 0) return
    }
    if (step === 2 && expertIds.length === 0) { setSubmitError('请至少选择一位参与评审的专家。'); return }
    setSubmitError(null)
    setStep(current => Math.min(3, current + 1))
  }

  const finish = async () => {
    if (sources.length > 0 && !sensitiveConfirmed) { setSubmitError('请确认已检查资料中的敏感信息。'); return }
    if (sources.some(source => source.status === 'hashing')) { setSubmitError('请等待资料摘要计算完成。'); return }
    if (sources.some(source => source.status === 'error')) { setSubmitError('有资料摘要计算失败，请移除后重新选择。'); return }
    setSubmitting(true); setSubmitError(null)
    let phase = '创建评审'
    let reviewCreated = created !== null
    let unreadableNames: readonly string[] = []
    try {
      const review = created ?? await requestJson<ArchitectureReviewSummary>(ARCHITECTURE_REVIEW_REVIEWS_PATH, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, expertIds }),
      })
      reviewCreated = true
      setCreated(review)
      const pendingSources = sources.filter(source => !uploadedKeys.has(source.key))
      if (pendingSources.length > 0) {
        phase = '导入资料'
        const uploaded = await uploadSources(review.reviewId, pendingSources.map(source => source.file), file => setUploadedKeys(current => new Set(current).add(fileKey(file))))
        unreadableNames = uploaded.filter(source => source.parseStatus !== 'ready').map(source => source.name)
      }
      if (sources.length > 0) {
        phase = '摄入资料'
        const operation = await requestJson<ArchitectureReviewOperation>(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(review.reviewId)}/ingest`, { method: 'POST' })
        rememberOperation(operation)
      }
      window.dispatchEvent(new CustomEvent(REVIEW_CREATED_EVENT, { detail: {
        review,
        ...(unreadableNames.length === 0 ? {} : { launchError: `${unreadableNames.join('、')} 无法读取正文，请补充 OCR、Markdown 或 TXT 文本版。` }),
      } satisfies ReviewCreatedDetail }))
      onClose()
    } catch (cause) {
      setSubmitError(!reviewCreated ? messageFor(cause, '创建评审失败，请重试。') : `${phase}失败：${messageFor(cause, '请重试或先打开评审。')}`)
    } finally { setSubmitting(false) }
  }

  const skipFailedUpload = () => {
    if (created === null) return
    window.dispatchEvent(new CustomEvent(REVIEW_CREATED_EVENT, { detail: { review: created } satisfies ReviewCreatedDetail }))
    onClose()
  }

  const steps = ['基本信息', '待评审资料', '评审专家', '创建草稿']
  return <div className="dshArchitectureReviewOverlay"><div ref={dialog} className="dshArchitectureReviewDialog" role="dialog" aria-modal="true" aria-labelledby="architecture-review-create-title" tabIndex={-1}><header className="dshArchitectureReviewDialogHeader"><div><h2 id="architecture-review-create-title">新建架构评审</h2><p>{steps[step]}</p></div><button type="button" className="iconButton" onClick={onClose} disabled={submitting} aria-label="关闭">×</button></header><div className="dshArchitectureReviewDialogBody"><div className="dshArchitectureReviewSteps">{steps.map((label, index) => <div key={label} className={`dshArchitectureReviewStep${index === step ? ' active' : index < step ? ' done' : ''}`}><span>{index < step ? '✓' : index + 1}</span><strong>{label}</strong></div>)}</div>{submitError !== null && <div className="dshArchitectureReviewDialogError" role="alert">{submitError}</div>}{step === 0 && <BasicsStep input={input} errors={errors} onChange={update} />}{step === 1 && <SourcesStep sources={sources} onAdd={files => void addFiles(files)} onRemove={key => setSources(current => current.filter(item => item.key !== key))} />}{step === 2 && <ExpertChoices catalog={catalog} selected={expertIds} onToggle={id => setExpertIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])} />}{step === 3 && <SummaryStep input={input} sources={sources} experts={catalog?.experts.filter(expert => expertIds.includes(expert.id)) ?? []} confirmed={sensitiveConfirmed} onConfirmed={setSensitiveConfirmed} />}</div><footer className="dshArchitectureReviewDialogFooter"><button type="button" className="secondary" onClick={onClose} disabled={submitting}>取消</button><div>{created !== null && submitError !== null && <button type="button" className="secondary" onClick={skipFailedUpload}>先打开评审</button>}{step > 0 && <button type="button" className="secondary" onClick={() => setStep(current => current - 1)} disabled={submitting || created !== null}>上一步</button>}{step < 3 ? <button type="button" className="primary" onClick={next}>下一步</button> : <button type="button" className="primary" onClick={() => void finish()} disabled={submitting || (sources.length > 0 && !sensitiveConfirmed)}>{submitting ? '正在处理…' : created === null ? '创建评审' : '重试资料导入'}</button>}</div></footer></div></div>
}

function BasicsStep({ input, errors, onChange }: { input: ReviewBasics; errors: Partial<Record<keyof CreateReviewInput, string>>; onChange: (field: keyof ReviewBasics, value: string) => void }) {
  return <div className="dshArchitectureReviewFormGrid"><Field id="review-title" label="评审名称" error={errors.title}><input id="review-title" value={input.title} maxLength={200} autoFocus onChange={event => onChange('title', event.currentTarget.value)} placeholder="例如：支付平台重构 v3" /></Field><Field id="review-system" label="系统名称" error={errors.systemName}><input id="review-system" value={input.systemName} onChange={event => onChange('systemName', event.currentTarget.value)} placeholder="例如：支付平台" /></Field><Field id="review-type" label="评审类型"><select id="review-type" value={input.type} onChange={event => onChange('type', event.currentTarget.value)}>{REVIEW_TYPES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Field id="review-owner" label="负责人" error={errors.owner}><input id="review-owner" value={input.owner} onChange={event => onChange('owner', event.currentTarget.value)} placeholder="姓名或团队" /></Field><div className="full"><Field id="review-description" label="评审说明" error={errors.description}><textarea id="review-description" value={input.description} maxLength={2000} onChange={event => onChange('description', event.currentTarget.value)} placeholder="说明背景、范围和需要重点关注的问题" /><small>{input.description.length}/2000</small></Field></div></div>
}

function SourcesStep({ sources, onAdd, onRemove }: { sources: readonly DraftSource[]; onAdd: (files: readonly File[]) => void; onRemove: (key: string) => void }) {
  return <><label className="dshArchitectureReviewDropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); onAdd(Array.from(event.dataTransfer.files)) }}><input type="file" multiple accept=".pdf,.docx,.md,.markdown,.txt,.json,.yaml,.yml,.openapi,.png,.jpg,.jpeg,.webp" onChange={event => onAdd(Array.from(event.currentTarget.files ?? []))} /><span aria-hidden>⇧</span><strong>添加待评审资料</strong><small>PDF、DOCX、Markdown、TXT、OpenAPI 和架构图片；单文件不超过 5 MB</small></label>{sources.length === 0 ? <EmptyState compact icon="▧" title="尚未添加待评审资料" description="可先创建草稿，再从详情页补充资料。" /> : <div className="dshArchitectureReviewSourceList">{sources.map(source => <div className="dshArchitectureReviewSource" key={source.key}><span><strong>{source.file.name}</strong><small>{sourceKind(source.file.name)} · {formatFileSize(source.file.size)}</small></span><code>{source.status === 'hashing' ? '计算 SHA-256…' : source.status === 'error' ? '摘要失败' : source.digest?.slice(0, 12)}</code><button type="button" aria-label={`移除 ${source.file.name}`} onClick={() => onRemove(source.key)}>×</button></div>)}</div>}</>
}

function ExpertChoices({ catalog, selected, onToggle }: {
  catalog: ArchitectureReviewExpertCatalog | null
  selected: readonly string[]
  onToggle: (id: string) => void
}) {
  return <div className="dshArchitectureReviewExpertChoices">
    <h3>参与评审的专家</h3>
    {catalog === null ? <p>当前工作区尚无专家目录，可在“评审专家智能体”中从 Wiki 生成。</p> : <div className="dshArchitectureReviewExpertGrid">{catalog.experts.map(expert => <label key={expert.id} className="dshArchitectureReviewExpertChoice"><input type="checkbox" checked={selected.includes(expert.id)} onChange={() => onToggle(expert.id)} /><span><strong>{expert.name}</strong><small>{expert.focus}</small></span></label>)}</div>}
  </div>
}

function SummaryStep({ input, sources, experts, confirmed, onConfirmed }: { input: ReviewBasics; sources: readonly DraftSource[]; experts: readonly ArchitectureReviewExpert[]; confirmed: boolean; onConfirmed: (value: boolean) => void }) {
  return <><dl className="dshArchitectureReviewSummary"><dt>评审名称</dt><dd>{input.title}</dd><dt>系统</dt><dd>{input.systemName}</dd><dt>类型</dt><dd>{REVIEW_TYPES.find(([id]) => id === input.type)?.[1] ?? input.type}</dd><dt>负责人</dt><dd>{input.owner}</dd><dt>待评审资料</dt><dd>{sources.length} 份{sources.length > 0 ? `，共 ${formatFileSize(sources.reduce((sum, source) => sum + source.file.size, 0))}` : ''}</dd><dt>拟参与专家</dt><dd>{experts.map(expert => expert.name).join('、')}</dd><dt>输出目录</dt><dd>wiki/reviews/AR-xxx/</dd></dl><div className="dshArchitectureReviewNotice">创建后保持草稿状态。提交资料时会检查正文是否可读取，启动评审时会核对专家引用的规范原件。</div>{sources.length > 0 && <label className="dshArchitectureReviewConfirm"><input type="checkbox" checked={confirmed} onChange={event => onConfirmed(event.currentTarget.checked)} /><span><strong>我已检查待导入资料中的敏感信息</strong><br />原始资料只保存在所选本地工作区。</span></label>}</>
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string | undefined; children: ReactNode }) {
  return <div className="dshArchitectureReviewField"><label htmlFor={id}>{label}</label>{children}{error !== undefined && <small className="fieldError">{error}</small>}</div>
}

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <header className="dshArchitectureReviewHeader"><div><h1>{title}</h1><p>{description}</p></div>{actions !== undefined && <div className="dshArchitectureReviewHeaderActions">{actions}</div>}</header>
}

function PanelHeader({ title, action, onAction }: { title: string; action: string; onAction: () => void }) {
  return <div className="dshArchitectureReviewPanelHeader"><h2>{title}</h2><button type="button" className="textButton" onClick={onAction}>{action}</button></div>
}

function EmptyState({ icon, title, description, actionLabel, onAction, compact = false }: { icon: string; title: string; description: string; actionLabel?: string; onAction?: () => void; compact?: boolean }) {
  return <div className={`dshArchitectureReviewEmpty${compact ? ' compact' : ''}`}><span className="dshArchitectureReviewEmptyIcon" aria-hidden>{icon}</span><strong>{title}</strong><p>{description}</p>{actionLabel !== undefined && onAction !== undefined && <button type="button" className="primary" onClick={onAction}>{actionLabel}</button>}</div>
}

function ReviewRow({ review, onClick }: { review: ArchitectureReviewSummary; onClick: () => void }) {
  return <button type="button" className="dshArchitectureReviewRow" onClick={onClick}><span className="dshArchitectureReviewRowTitle"><strong>{review.title}</strong><small>{review.reviewId} · {review.version}</small></span><Status status={review.status} /><time>{formatDate(review.updatedAt)}</time></button>
}

function Status({ status }: { status: string }) {
  return <span className="dshArchitectureReviewStatus" data-status={status}>{reviewStatusLabel(status)}</span>
}

function navigationIcon(view: WorkbenchView): string {
  if (view === 'dashboard') return '⌂'
  if (view === 'reviews' || view === 'review') return '▣'
  if (view === 'knowledge') return '◫'
  if (view === 'rules') return '◇'
  if (view === 'operations') return '◷'
  return '⚙'
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

function messageFor(cause: unknown, fallback: string): string {
  if (!(cause instanceof RequestError)) return fallback
  if (cause.message.startsWith('review standards are missing: ')) {
    return `无法启动评审，缺少专家引用的规范原件：${cause.message.slice('review standards are missing: '.length)}`
  }
  const labels: Record<string, string> = {
    'review not found': '评审不存在，请返回项目列表。',
    'artifact not found': '资料不存在，请刷新后重试。',
    'artifact already exists': '同名资料已存在，请更换文件名。',
    'finding evidence is required for confirmation': '缺少可回溯证据，不能确认或解决此问题。',
    'finding status transition is invalid': '当前状态不支持此操作，请刷新评审。',
    'a reason is required for this finding status': '请填写处理理由。',
    'a reason is required for a rejected or changes-requested decision': '请填写决策说明。',
    'unconfirmed Blocker findings must be resolved before a decision': '请先处理阻断问题。',
    'run the review before creating a decision': '请先完成专家评审。',
    'readable review material is required': '待评审资料没有可读取正文，请在资料提交环节补充 OCR、Markdown 或 TXT 文本版。',
    'selected experts must reference review standards': '所选专家没有引用规范原件，请先更新专家目录。',
  }
  return labels[cause.message] ?? (cause.status >= 500 ? fallback : cause.message)
}

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RequestError'
  }
}

async function requestJson<T = unknown>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init, ...(signal === undefined ? {} : { signal }) })
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  if (!response.ok) throw new RequestError(typeof payload?.error === 'string' ? payload.error : `请求失败（${response.status}）`, response.status)
  return payload as T
}

async function uploadSources(reviewId: string, files: readonly File[], onUploaded?: (file: File) => void): Promise<readonly ArchitectureReviewArtifact[]> {
  const uploaded: ArchitectureReviewArtifact[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    const chunkSize = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
    }
    uploaded.push(await requestJson<ArchitectureReviewArtifact>(`${ARCHITECTURE_REVIEW_REVIEW_PREFIX}${encodeURIComponent(reviewId)}/artifacts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, contentBase64: btoa(binary) }),
    }))
    onUploaded?.(file)
  }
  return uploaded
}

function rememberOperation(operation: ArchitectureReviewOperation): void {
  try {
    const current = JSON.parse(window.sessionStorage.getItem('architecture-review:operations') ?? '[]') as unknown
    const ids = Array.isArray(current) ? current.filter((id): id is string => typeof id === 'string') : []
    if (!ids.includes(operation.operationId)) ids.push(operation.operationId)
    window.sessionStorage.setItem('architecture-review:operations', JSON.stringify(ids.slice(-50)))
  } catch {
    // Session storage can be disabled; the operation still completed on Host.
  }
}

function readKnowledgeTask(): ActiveKnowledgeTask | null {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(KNOWLEDGE_SESSION_KEY) ?? 'null') as Partial<ActiveKnowledgeTask> | null
    if (stored === null || typeof stored.root !== 'string' || typeof stored.sessionId !== 'string') return null
    if (stored.task?.kind !== 'query' && stored.task?.kind !== 'verify' && stored.task?.kind !== 'maintain' && stored.task?.kind !== 'review'
      && stored.task?.kind !== 'experts' && stored.task?.kind !== 'expert') return null
    if (stored.task.kind === 'expert' && (typeof stored.task.expertId !== 'string' || typeof stored.task.expertName !== 'string' || typeof stored.task.question !== 'string')) return null
    if (stored.task.kind === 'review' && (typeof stored.task.reviewId !== 'string' || !Array.isArray(stored.task.expertIds)
      || !stored.task.expertIds.every(id => typeof id === 'string'))) return null
    return stored as ActiveKnowledgeTask
  } catch {
    return null
  }
}

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function isSupportedSource(name: string): boolean {
  return /\.(?:pdf|docx|md|markdown|txt|json|ya?ml|openapi|png|jpe?g|webp)$/iu.test(name)
}

async function digestFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export const inject = ['slots', 'layout', 'sessions', 'uiWorkspace']

/** Register the workbench panel, global overlay, and sidebar entries. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({ name: 'main', key: ARCHITECTURE_REVIEW_PANEL_ID }, (props: MainProps) => <ArchitectureReviewWorkbench {...props} client={ctx} />)
    if (new URLSearchParams(window.location.search).has('architectureReviewView')) {
      ctx.layout.selectPanel(ARCHITECTURE_REVIEW_PANEL_ID as MainPanelId)
    }
    return dispose
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'architecture-review-dialog', order: 30, label: '架构评审对话框' }, (props: OverlayProps) => <ArchitectureReviewOverlay {...props} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: ARCHITECTURE_REVIEW_PANEL_ID as MainPanelId, order: 30, label: '架构评审' }, ArchitectureReviewIcon))
}

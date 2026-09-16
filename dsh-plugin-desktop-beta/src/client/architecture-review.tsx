/** Architecture review workbench client surfaces.
 *
 * The first slice intentionally keeps data local to the page. Host routes can
 * replace the placeholder cards incrementally without changing the shell or
 * navigation contract.
 */
import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export const ARCHITECTURE_REVIEW_PANEL_ID = 'architecture-review'

type MainProps = PropsRuntime<'main'>
type PanelIconProps = { size: number; active: boolean }
type ActionProps = PropsRuntime<'sidebar.footer.action'> & { wide: boolean } & InjectFace<{ onOpen: () => void }>
type WorkspaceSnapshot = { initialized: boolean; root: string | null; reviewCount: number; sourceCount: number; wikiCount: number }
type ReviewSummary = { reviewId: string; version: string; title: string; status: string; updatedAt: string | null }

const NAV_ITEMS = [
  ['dashboard', '工作台'],
  ['reviews', '评审项目'],
  ['knowledge', '资料与知识'],
  ['rules', '评审规则'],
  ['operations', '运行记录'],
  ['settings', '设置'],
] as const

function ArchitectureReviewIcon({ size, active }: PanelIconProps) {
  return <span style={{ fontSize: size, lineHeight: 1, opacity: active ? 1 : 0.72 }} aria-hidden>⌘</span>
}

function ArchitectureReviewAction({ wide, onOpen }: ActionProps) {
  return <button type="button" className="dshArchitectureReviewAction" onClick={onOpen} aria-label="架构评审">⌘{wide && <span>架构评审</span>}</button>
}

function ArchitectureReviewWorkbench(_props: MainProps) {
  const [view, setView] = useState('dashboard')
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      const [workspaceResponse, reviewsResponse] = await Promise.all([
        fetch('/api/architecture-review/workspace', { credentials: 'same-origin' }),
        fetch('/api/architecture-review/reviews', { credentials: 'same-origin' }),
      ])
      if (workspaceResponse.ok) setWorkspace(await workspaceResponse.json() as WorkspaceSnapshot)
      if (reviewsResponse.ok) {
        const payload = await reviewsResponse.json() as { reviews?: ReviewSummary[] }
        setReviews(payload.reviews ?? [])
      }
    } finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [])

  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-plugin-desktop'
    style.dataset.pluginCss = 'architecture-review-workbench'
    style.textContent = ARCHITECTURE_REVIEW_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  useEffect(() => {
    const onPopState = () => {
      const value = new URLSearchParams(window.location.search).get('architectureReviewView')
      if (value && NAV_ITEMS.some(([id]) => id === value)) setView(value)
    }
    onPopState()
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (next: string) => {
    setView(next)
    const url = new URL(window.location.href)
    url.searchParams.set('architectureReviewView', next)
    window.history.pushState({ architectureReviewView: next }, '', url)
  }

  return (
    <div className="dshArchitectureReview" data-architecture-review-view={view}>
      <aside className="dshArchitectureReviewNav" aria-label="架构评审导航">
        <div className="dshArchitectureReviewBrand"><span aria-hidden>⌘</span><strong>架构评审</strong></div>
        <nav>
          {NAV_ITEMS.map(([id, label]) => (
            <button key={id} type="button" className={id === view ? 'active' : ''} onClick={() => navigate(id)} aria-current={id === view ? 'page' : undefined}>
              <span aria-hidden>{id === 'dashboard' ? '⌂' : id === 'reviews' ? '▣' : id === 'knowledge' ? '◫' : id === 'rules' ? '✓' : id === 'operations' ? '◷' : '⚙'}</span>{label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="dshArchitectureReviewContent">
        {view === 'dashboard' ? <Dashboard workspace={workspace} reviews={reviews} loading={loading} onCreate={() => navigate('reviews')} onNavigate={navigate} /> : <SectionView view={view} reviews={reviews} onRefresh={refresh} onNavigate={navigate} />}
      </section>
    </div>
  )
}

const ARCHITECTURE_REVIEW_CSS = `
.dshArchitectureReview{display:flex;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-fg-base);font-family:var(--dsw-font-family,Inter,system-ui,sans-serif)}
.dshArchitectureReviewNav{width:208px;flex:none;padding:24px 12px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dshArchitectureReviewBrand{display:flex;align-items:center;gap:10px;padding:0 12px 24px;font-size:16px}.dshArchitectureReviewBrand span{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:var(--dsw-alias-accent,#6366f1);color:#fff}
.dshArchitectureReviewNav nav{display:flex;flex-direction:column;gap:4px}.dshArchitectureReviewNav button{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;text-align:left;font-size:13px}.dshArchitectureReviewNav button:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#888) 16%,transparent)}.dshArchitectureReviewNav button.active{background:color-mix(in srgb,var(--dsw-alias-accent,#6366f1) 16%,transparent);color:var(--dsw-alias-accent,#6366f1);font-weight:600}
.dshArchitectureReviewContent{min-width:0;flex:1;overflow:auto;padding:32px 40px}.dshArchitectureReviewHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:28px}.dshArchitectureReview h1{margin:0;font-size:24px;letter-spacing:-.02em}.dshArchitectureReview p{margin:7px 0;color:var(--dsw-alias-fg-muted,#6b7280);font-size:13px}.primary{border:0;border-radius:8px;padding:9px 15px;background:var(--dsw-alias-accent,#6366f1);color:#fff;cursor:pointer;font-weight:600}.primary:hover{filter:brightness(1.08)}
.dshArchitectureReviewStats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:24px}.dshArchitectureReviewStats button{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;text-align:left}.dshArchitectureReviewStats button:hover{border-color:var(--dsw-alias-accent,#6366f1)}.dshArchitectureReviewStats strong{font-size:28px}.dshArchitectureReviewStats span{font-weight:600}.dshArchitectureReviewStats small{color:var(--dsw-alias-fg-muted,#6b7280)}
.dshArchitectureReviewGrid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(220px,1fr);gap:14px}.dshArchitectureReviewCard{padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.dshArchitectureReviewRecent{grid-row:span 2}.cardTitle{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.cardTitle h2{margin:0;font-size:15px}.cardTitle button,.textButton{padding:0;border:0;background:none;color:var(--dsw-alias-accent,#6366f1);cursor:pointer;font-size:12px}.dshArchitectureReviewRow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px;width:100%;padding:13px 0;border:0;border-top:1px solid var(--dsw-alias-border-l1);background:none;color:inherit;cursor:pointer;text-align:left}.dshArchitectureReviewRow span{display:flex;flex-direction:column;gap:3px;min-width:0}.dshArchitectureReviewRow strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.dshArchitectureReviewRow small,.dshArchitectureReviewRow time{color:var(--dsw-alias-fg-muted,#6b7280);font-size:12px}.dshArchitectureReviewRow em{font-style:normal;color:#d97706;font-size:12px}.dshArchitectureReviewFacts{display:flex;gap:20px;margin:8px 0 18px}.dshArchitectureReviewFacts strong{font-size:17px}.warning{color:#d97706!important}.run{display:flex;align-items:center;gap:8px}.run span{font-size:10px}.run.ok span{color:#16a34a}.run.failed span{color:#dc2626}.run small{margin-left:auto;color:var(--dsw-alias-fg-muted,#6b7280)}
.dshArchitectureReviewSection{max-width:860px}.dshArchitectureReviewEmpty{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:56px;padding:48px 20px;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px;text-align:center}.dshArchitectureReviewEmpty span{font-size:32px;color:var(--dsw-alias-fg-muted,#6b7280)}.dshArchitectureReviewEmpty small{margin-bottom:10px;color:var(--dsw-alias-fg-muted,#6b7280)}
.dshArchitectureReviewAction{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:34px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:12px}.dshArchitectureReviewAction:hover{background:color-mix(in srgb,var(--dsw-alias-accent,#6366f1) 12%,transparent)}.dshArchitectureReviewAction span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:760px){.dshArchitectureReviewNav{width:168px}.dshArchitectureReviewContent{padding:24px 20px}.dshArchitectureReviewStats{grid-template-columns:1fr}.dshArchitectureReviewGrid{grid-template-columns:1fr}.dshArchitectureReviewRecent{grid-row:auto}}
`

function Dashboard({ workspace, reviews, loading, onCreate, onNavigate }: { workspace: WorkspaceSnapshot | null; reviews: ReviewSummary[]; loading: boolean; onCreate: () => void; onNavigate: (view: string) => void }) {
  const sourceCount = workspace?.sourceCount ?? 0
  const wikiCount = workspace?.wikiCount ?? 0
  return (
    <>
      <header className="dshArchitectureReviewHeader"><div><h1>架构评审工作台</h1><p>集中查看待办、评审进度和知识库健康度</p></div><button type="button" className="primary" onClick={onCreate}>＋ 新建评审</button></header>
      {!loading && workspace?.initialized !== true && <div className="dshArchitectureReviewEmpty"><span aria-hidden>⌂</span><strong>还没有架构评审知识库</strong><small>请先在设置中初始化工作区，再导入资料并开始评审。</small><button type="button" className="primary" onClick={() => onNavigate('settings')}>初始化工作区</button></div>}
      <div className="dshArchitectureReviewStats">
        <button type="button" onClick={() => onNavigate('reviews')}><strong>{reviews.length}</strong><span>评审项目</span><small>当前工作区</small></button>
        <button type="button" onClick={() => onNavigate('reviews')}><strong>{reviews.filter(review => review.status === 'reviewing').length}</strong><span>进行中评审</span><small>当前活跃项目</small></button>
        <button type="button" onClick={() => onNavigate('operations')}><strong>2</strong><span>逾期整改</span><small>超过计划时间</small></button>
      </div>
      <div className="dshArchitectureReviewGrid">
        <article className="dshArchitectureReviewCard dshArchitectureReviewRecent"><div className="cardTitle"><h2>最近评审</h2><button type="button" onClick={() => onNavigate('reviews')}>查看全部</button></div>{reviews.length === 0 ? <p>暂无评审项目</p> : reviews.slice(0, 5).map(review => <ReviewRow key={review.reviewId} title={`${review.title} ${review.version}`} status={review.status} severity="—" time={review.updatedAt?.slice(0, 10) ?? ''} />)}</article>
        <article className="dshArchitectureReviewCard"><div className="cardTitle"><h2>知识库状态</h2><button type="button" onClick={() => onNavigate('knowledge')}>打开知识库</button></div><div className="dshArchitectureReviewFacts"><strong>资料 {sourceCount} 份</strong><strong>Wiki {wikiCount} 页</strong></div><p className="warning">知识健康度由 Lint 运行后更新</p><button type="button" className="textButton" onClick={() => onNavigate('knowledge')}>运行健康检查 →</button></article>
        <article className="dshArchitectureReviewCard"><div className="cardTitle"><h2>最近运行</h2><button type="button" onClick={() => onNavigate('operations')}>查看记录</button></div><p className="run ok"><span>●</span> Ingest 完成 <small>2 分钟前</small></p><p className="run failed"><span>●</span> AI 评审失败 <small>1 小时前</small></p></article>
      </div>
    </>
  )
}

function ReviewRow({ title, status, severity, time }: { title: string; status: string; severity: string; time: string }) {
  return <button type="button" className="dshArchitectureReviewRow"><span><strong>{title}</strong><small>{status}</small></span><em>{severity}</em><time>{time}</time></button>
}

function SectionView({ view, reviews, onRefresh, onNavigate }: { view: string; reviews: ReviewSummary[]; onRefresh: () => Promise<void>; onNavigate: (view: string) => void }) {
  const label = NAV_ITEMS.find(([id]) => id === view)?.[1] ?? '架构评审'
  const create = async () => {
    const title = window.prompt('评审名称')?.trim()
    if (!title) return
    const response = await fetch('/api/architecture-review/reviews', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
    if (!response.ok) return
    await onRefresh()
  }
  const initWorkspace = async () => {
    const path = window.prompt('架构评审工作区绝对路径')?.trim()
    if (!path) return
    const response = await fetch('/api/architecture-review/workspace', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
    if (response.ok) await onRefresh()
  }
  return <div className="dshArchitectureReviewSection"><div className="dshArchitectureReviewHeader"><div><h1>{label}</h1><p>架构资料、评审发现和决策记录统一保存在本地知识工作区。</p></div>{view === 'reviews' && <button type="button" className="primary" onClick={() => void create()}>＋ 新建评审</button>}</div>{view === 'reviews' && reviews.map(review => <div key={review.reviewId} className="dshArchitectureReviewCard" style={{ marginBottom: 12 }}><strong>{review.title}</strong><p>{review.reviewId} · {review.version} · {review.status}</p></div>)}{view === 'settings' && <div className="dshArchitectureReviewCard"><h2>工作区</h2><p>选择一个本地目录保存原始资料、Wiki 页面、评审结果和运行日志。</p><button type="button" className="primary" onClick={() => void initWorkspace()}>选择工作区目录</button></div>}{view !== 'reviews' && view !== 'settings' && <div className="dshArchitectureReviewEmpty"><span aria-hidden>◌</span><strong>{label}暂无数据</strong><small>你可以从工作台创建评审，或等待 Host 返回内容。</small><button type="button" className="primary" onClick={() => onNavigate('dashboard')}>返回工作台</button></div>}</div>
}

export function applyArchitectureReview(ctx: ClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ARCHITECTURE_REVIEW_PANEL_ID }, ArchitectureReviewWorkbench))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: ARCHITECTURE_REVIEW_PANEL_ID, order: 30, label: '架构评审' }, ArchitectureReviewIcon))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'architecture-review', order: 30, label: '架构评审',
    inject: () => ({ onOpen: () => ctx.layout.selectPanel(ARCHITECTURE_REVIEW_PANEL_ID as MainPanelId) }),
  }, ArchitectureReviewAction))
}

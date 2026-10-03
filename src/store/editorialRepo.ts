import { create } from 'zustand'
import { baseParagraphs } from '../data/manuscript'
import type { MasterAnnotation, SyncQueueItem } from '../types'

const REPO_KEY = 'sologsb-1002-editorial-repo-v1'
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

interface RepoSnapshot {
  revisions: Record<string, number>
  texts: Record<string, string>
  annotations: MasterAnnotation[]
}

const initialSnapshot = (): RepoSnapshot => ({
  revisions: Object.fromEntries(baseParagraphs.map((paragraph) => [paragraph.id, 1])),
  texts: Object.fromEntries(baseParagraphs.map((paragraph) => [paragraph.id, paragraph.text])),
  annotations: [],
})

const loadSnapshot = (): RepoSnapshot => {
  try {
    const raw = localStorage.getItem(REPO_KEY)
    if (!raw) return initialSnapshot()
    const parsed = JSON.parse(raw) as Partial<RepoSnapshot>
    const base = initialSnapshot()
    return {
      revisions: { ...base.revisions, ...parsed.revisions },
      texts: { ...base.texts, ...parsed.texts },
      annotations: parsed.annotations ?? [],
    }
  } catch {
    return initialSnapshot()
  }
}

const persist = (snapshot: RepoSnapshot) => {
  localStorage.setItem(REPO_KEY, JSON.stringify(snapshot))
}

/** 把队列项里已并成一条的批注展开为合订稿批注的正文与引用 */
const flattenItem = (item: SyncQueueItem) => ({
  quote: item.annotations.map((annotation) => annotation.quote).filter(Boolean).join(' / '),
  body: item.annotations.map((annotation, index) => item.annotations.length > 1 ? `${index + 1}) ${annotation.body}` : annotation.body).join(' '),
  suggestion: item.annotations.every((annotation) => annotation.type === 'suggestion')
    ? item.annotations.map((annotation) => annotation.suggestion).filter(Boolean).join(' ')
    : undefined,
  type: (item.annotations.every((annotation) => annotation.type === 'suggestion') ? 'suggestion' : 'comment') as MasterAnnotation['type'],
})

interface EditorialRepoState extends RepoSnapshot {
  /** 编辑部在合订稿上改稿：推进该段落修订号 */
  reviseParagraph: (paragraphId: string, text?: string) => void
  /**
   * 把一批离线批注并入合订稿并推进修订号，返回并入的批注记录。
   * 默认要求批注基准修订号与合订稿现修订号一致，否则抛错；
   * 编辑定夺“仍并入”时传 force。
   */
  mergeAnnotations: (item: SyncQueueItem, options?: { force?: boolean; source?: MasterAnnotation['source'] }) => MasterAnnotation
  resetRepo: () => void
}

export const useEditorialRepo = create<EditorialRepoState>((set, get) => {
  const commit = (patch: Partial<RepoSnapshot>) => {
    const next = { revisions: get().revisions, texts: get().texts, annotations: get().annotations, ...patch }
    persist(next)
    set(patch)
  }

  return {
    ...loadSnapshot(),
    reviseParagraph: (paragraphId, text) => {
      const state = get()
      const revision = (state.revisions[paragraphId] ?? 0) + 1
      const current = state.texts[paragraphId] ?? ''
      commit({
        revisions: { ...state.revisions, [paragraphId]: revision },
        texts: { ...state.texts, [paragraphId]: text ?? `${current.replace(/。$/, '')}【编辑部第 ${revision - 1} 次修订】。` },
      })
    },
    mergeAnnotations: (item, options) => {
      const state = get()
      const current = state.revisions[item.paragraphId] ?? 0
      if (!options?.force && current !== item.baseRevision) {
        throw new Error(`段落 ${item.paragraphId} 修订号不一致：批注基于 r${item.baseRevision}，合订稿已是 r${current}`)
      }
      const revision = current + 1
      const flat = flattenItem(item)
      const annotation: MasterAnnotation = {
        id: id('master-comment'),
        paragraphId: item.paragraphId,
        quote: flat.quote,
        body: flat.body,
        suggestion: flat.suggestion,
        type: flat.type,
        author: item.annotations[0]?.author ?? '审稿人',
        mergedAt: Date.now(),
        revision,
        source: options?.source ?? 'sync',
      }
      commit({
        revisions: { ...state.revisions, [item.paragraphId]: revision },
        annotations: [annotation, ...state.annotations],
      })
      return annotation
    },
    resetRepo: () => {
      const snapshot = initialSnapshot()
      persist(snapshot)
      set(snapshot)
    },
  }
})

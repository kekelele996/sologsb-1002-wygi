import { create } from 'zustand'
import { submitQueue } from '../services/syncEngine'
import { useEditorialRepo } from './editorialRepo'
import { useReviewStore } from './review'
import type { MasterAnnotation, OfflineAnnotation, SyncConflict, SyncQueueItem } from '../types'

const DRAFT_KEY = 'sologsb-1002-offline-draft-v2'
const LEGACY_KEY = 'sologsb-1002-offline-draft-v1'
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

interface DraftSnapshot {
  /** 本机批注稿所见的各段落修订号（对账基准） */
  localRevisions: Record<string, number>
  queue: SyncQueueItem[]
  conflicts: SyncConflict[]
  syncLog: { time: number; text: string }[]
  online: boolean
  simulateFailure: boolean
}

/** 旧版批注稿：没有修订号，只有批注本体 */
interface LegacyDraft {
  annotations: { id?: string; paragraphId: string; quote?: string; body: string; createdAt?: number }[]
}

const repoRevisions = () => useEditorialRepo.getState().revisions

const baseSnapshot = (): DraftSnapshot => ({
  localRevisions: { ...repoRevisions() },
  queue: [],
  conflicts: [],
  syncLog: [],
  online: true,
  simulateFailure: false,
})

/** 同一段落的离线批注先并成一条队列项再送出去 */
const coalesce = (queue: SyncQueueItem[], annotation: OfflineAnnotation): SyncQueueItem[] => {
  const existing = queue.find((item) => item.paragraphId === annotation.paragraphId)
  if (!existing) {
    return [...queue, {
      id: id('sync'),
      paragraphId: annotation.paragraphId,
      baseRevision: annotation.baseRevision,
      annotations: [annotation],
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
    }]
  }
  return queue.map((item) => item.id === existing.id
    ? { ...item, annotations: [...item.annotations, annotation], status: 'pending' as const, lastError: undefined }
    : item)
}

/** 没有修订号的批注按合订稿现版本补上 */
const backfill = (annotation: OfflineAnnotation): OfflineAnnotation => ({
  ...annotation,
  baseRevision: annotation.baseRevision || repoRevisions()[annotation.paragraphId] || 1,
})

const loadSnapshot = (): { snapshot: DraftSnapshot; migrated: number } => {
  let snapshot = baseSnapshot()
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DraftSnapshot>
      snapshot = {
        ...snapshot,
        ...parsed,
        localRevisions: { ...repoRevisions(), ...parsed.localRevisions },
        queue: (parsed.queue ?? []).map((item) => ({ ...item, annotations: item.annotations.map(backfill) })),
        conflicts: parsed.conflicts ?? [],
        syncLog: parsed.syncLog ?? [],
      }
    }
  } catch {
    snapshot = baseSnapshot()
  }

  // 升级迁移：旧批注稿补上修订号后并入待同步队列
  let migrated = 0
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as LegacyDraft
      for (const old of legacy.annotations ?? []) {
        migrated += 1
        snapshot.queue = coalesce(snapshot.queue, backfill({
          id: old.id ?? id('annotation'),
          paragraphId: old.paragraphId,
          type: 'comment',
          quote: old.quote ?? '',
          body: old.body,
          author: '审稿人 A',
          baseRevision: 0,
          createdAt: old.createdAt ?? Date.now(),
        }))
      }
      localStorage.removeItem(LEGACY_KEY)
      snapshot.syncLog = [{ time: Date.now(), text: `升级迁移：${migrated} 条旧批注按合订稿现版本补上修订号` }, ...snapshot.syncLog]
    }
  } catch {
    // 旧稿损坏时跳过迁移，保住现有队列
  }
  return { snapshot, migrated }
}

const persist = (state: DraftSnapshot) => {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({
    localRevisions: state.localRevisions,
    queue: state.queue,
    conflicts: state.conflicts,
    syncLog: state.syncLog.slice(0, 60),
    online: state.online,
    simulateFailure: state.simulateFailure,
  }))
}

const paragraphLabel = (paragraphId: string) => {
  const paragraph = useReviewStore.getState().paragraphs.find((item) => item.id === paragraphId)
  return `段落 ${paragraph?.number ?? paragraphId}`
}

/** 已并入合订稿的批注同步出现在审阅意见列表里 */
const ingestMaster = (annotation: MasterAnnotation) => {
  useReviewStore.getState().ingestComment({
    paragraphId: annotation.paragraphId,
    type: annotation.type,
    quote: annotation.quote,
    body: annotation.body,
    suggestion: annotation.suggestion,
    author: annotation.author,
    role: 'reviewer',
  })
}

interface OfflineDraftState extends DraftSnapshot {
  syncing: boolean
  migratedCount: number
  setOnline: (online: boolean) => void
  setSimulateFailure: (value: boolean) => void
  addAnnotation: (input: Pick<OfflineAnnotation, 'paragraphId' | 'type' | 'quote' | 'body' | 'suggestion' | 'author'>) => void
  syncNow: () => Promise<void>
  resolveConflict: (conflictId: string, decision: 'merge' | 'keep-master') => void
  acknowledgeMigration: () => void
  /** 演示用：写入一份没有修订号的旧批注稿并立即迁移 */
  seedLegacyAndMigrate: () => number
  resetDraft: () => void
}

export const useOfflineDraft = create<OfflineDraftState>((set, get) => {
  const { snapshot, migrated } = loadSnapshot()

  const log = (text: string) => {
    set((state) => ({ syncLog: [{ time: Date.now(), text }, ...state.syncLog].slice(0, 60) }))
  }

  return {
    ...snapshot,
    syncing: false,
    migratedCount: migrated,
    setOnline: (online) => {
      set({ online })
      if (online && get().queue.length > 0) {
        log('回网：按段落修订号开始对账')
        void get().syncNow()
      }
    },
    setSimulateFailure: (simulateFailure) => set({ simulateFailure }),
    addAnnotation: (input) => {
      const state = get()
      const annotation: OfflineAnnotation = {
        ...input,
        id: id('annotation'),
        baseRevision: state.localRevisions[input.paragraphId] ?? repoRevisions()[input.paragraphId] ?? 1,
        createdAt: Date.now(),
      }
      set({ queue: coalesce(state.queue, annotation) })
    },
    syncNow: async () => {
      const state = get()
      if (state.syncing) return
      const outgoing = state.queue
      if (!outgoing.length) return
      set({ syncing: true })
      const outcomes = await submitQueue(outgoing, {
        getRevision: (paragraphId) => useEditorialRepo.getState().revisions[paragraphId] ?? 0,
        getText: (paragraphId) => useEditorialRepo.getState().texts[paragraphId] ?? '',
        merge: (item) => useEditorialRepo.getState().mergeAnnotations(item),
      }, { failFromIndex: state.simulateFailure ? Math.max(0, outgoing.length - 1) : undefined })

      const mergedIds: string[] = []
      const failedById = new Map<string, string>()
      const newConflicts: SyncConflict[] = []
      const revisionUpdates: Record<string, number> = {}
      const logs: string[] = []

      for (const outcome of outcomes) {
        const label = paragraphLabel(outcome.item.paragraphId)
        if (outcome.status === 'merged') {
          mergedIds.push(outcome.item.id)
          revisionUpdates[outcome.item.paragraphId] = outcome.annotation.revision
          ingestMaster(outcome.annotation)
          logs.push(`${label}：合订稿未改动，${outcome.item.annotations.length} 条批注并成一条并入，修订号推进到 r${outcome.annotation.revision}`)
        } else if (outcome.status === 'conflict') {
          newConflicts.push({
            id: id('conflict'),
            paragraphId: outcome.item.paragraphId,
            item: outcome.item,
            baseRevision: outcome.item.baseRevision,
            masterRevision: outcome.masterRevision,
            masterText: outcome.masterText,
            detectedAt: Date.now(),
          })
          logs.push(`${label}：合订稿已到 r${outcome.masterRevision}（批注基于 r${outcome.item.baseRevision}），两边都留着等编辑定夺`)
        } else {
          failedById.set(outcome.item.id, outcome.error)
          logs.push(`${label}：${outcome.error}，留在队列里待重试`)
        }
      }

      set((current) => ({
        syncing: false,
        // 已并入的出队不重发；没送上去的留下重试
        queue: current.queue
          .filter((item) => !mergedIds.includes(item.id) && !newConflicts.some((conflict) => conflict.item.id === item.id))
          .map((item) => failedById.has(item.id)
            ? { ...item, status: 'failed' as const, attempts: item.attempts + 1, lastError: failedById.get(item.id) }
            : item),
        conflicts: [...newConflicts, ...current.conflicts],
        localRevisions: { ...current.localRevisions, ...revisionUpdates },
        syncLog: [...logs.map((text, index) => ({ time: Date.now() + index, text })).reverse(), ...current.syncLog].slice(0, 60),
      }))
    },
    resolveConflict: (conflictId, decision) => {
      const conflict = get().conflicts.find((item) => item.id === conflictId)
      if (!conflict || conflict.resolution) return
      const label = paragraphLabel(conflict.paragraphId)
      if (decision === 'merge') {
        const annotation = useEditorialRepo.getState().mergeAnnotations(conflict.item, { force: true, source: 'editor-override' })
        ingestMaster(annotation)
        set((state) => ({
          localRevisions: { ...state.localRevisions, [conflict.paragraphId]: annotation.revision },
          conflicts: state.conflicts.map((item) => item.id === conflictId ? { ...item, resolution: 'merged' as const } : item),
        }))
        log(`${label}：编辑定夺仍并入批注，合订稿修订号推进到 r${annotation.revision}`)
      } else {
        set((state) => ({
          localRevisions: { ...state.localRevisions, [conflict.paragraphId]: conflict.masterRevision },
          conflicts: state.conflicts.map((item) => item.id === conflictId ? { ...item, resolution: 'kept-master' as const } : item),
        }))
        log(`${label}：编辑定夺保留合订稿，批注稿留存备查不覆盖正文`)
      }
    },
    acknowledgeMigration: () => set({ migratedCount: 0 }),
    seedLegacyAndMigrate: () => {
      const paragraphs = useReviewStore.getState().paragraphs
      const legacy: LegacyDraft = {
        annotations: [
          { paragraphId: paragraphs[1]?.id ?? 'p-02', quote: '系统证据', body: '旧稿批注：证据范围建议收窄到期刊近五年文献。', createdAt: Date.now() - 604800000 },
          { paragraphId: paragraphs[1]?.id ?? 'p-02', quote: '代码生成与缺陷定位', body: '旧稿批注：建议补充与人工审查基线的对比。', createdAt: Date.now() - 518400000 },
          { paragraphId: paragraphs[5]?.id ?? 'p-06', quote: '认知负担', body: '旧稿批注：认知负担的测量工具需要引用量表来源。', createdAt: Date.now() - 432000000 },
        ],
      }
      localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy))
      const { snapshot, migrated } = loadSnapshot()
      set({ ...snapshot, migratedCount: migrated })
      return migrated
    },
    resetDraft: () => {
      localStorage.removeItem(DRAFT_KEY)
      localStorage.removeItem(LEGACY_KEY)
      set({ ...baseSnapshot(), syncing: false, migratedCount: 0 })
    },
  }
})

useOfflineDraft.subscribe((state) => persist(state))

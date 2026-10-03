import { create } from 'zustand'
import {
  addOfflineAnnotation, reconcile, resolveConflictByEditor,
  type EditorDecision,
} from '../services/sync/engine'
import { createMockTransport } from '../services/sync/mockTransport'
import {
  loadDraft, loadMaster, resetSyncDemo, saveDraft, saveMaster,
  upgradeAndSaveDraft,
} from '../services/sync/storage'
import type {
  MasterRepository, ReviewerOfflineDraft, SyncReport,
} from '../services/sync/types'

const REVIEWER = '审稿人 A'
const LEGACY_FLAG = 'sologsb-1002-legacy-seen'

const cloneMaster = (value: MasterRepository): MasterRepository =>
  JSON.parse(JSON.stringify(value)) as MasterRepository

const draftNeedsUpgrade = (draft: ReviewerOfflineDraft) =>
  draft.annotations.some((a) => a.baseRev === undefined && !a.synced && !a.resolution)
  || draft.queue.some((b) => b.baseRev === undefined)

const loadInitial = () => {
  const master = loadMaster()
  if (!localStorage.getItem(LEGACY_FLAG)) {
    // 首次访问：载入一份旧批注稿（没有段落修订号），演示升级流程
    const legacy = loadDraft(REVIEWER, true)
    saveDraft(legacy)
    localStorage.setItem(LEGACY_FLAG, '1')
    return { master, draft: legacy }
  }
  return { master, draft: loadDraft(REVIEWER, false) }
}

interface SyncConsoleState {
  master: MasterRepository
  draft: ReviewerOfflineDraft
  syncing: boolean
  report: SyncReport | null
  failureRate: number
  swallowNext: boolean
  needsUpgrade: boolean
  setFailureRate: (value: number) => void
  setSwallowNext: (value: boolean) => void
  upgradeLegacy: () => void
  addAnnotation: (input: { paragraphId: string; body: string; quote: string }) => void
  syncNow: () => Promise<void>
  decide: (batchId: string, decision: EditorDecision) => void
  /** 编辑部直接改正文并推进修订号，制造“这段动过”的对账场景 */
  touchMasterParagraph: (paragraphId: string, text: string) => void
  reset: () => void
}

export const useSyncStore = create<SyncConsoleState>((set, get) => {
  const initial = loadInitial()

  return {
    master: initial.master,
    draft: initial.draft,
    syncing: false,
    report: null,
    failureRate: 0,
    swallowNext: false,
    needsUpgrade: draftNeedsUpgrade(initial.draft),

    setFailureRate: (failureRate) => set({ failureRate }),
    setSwallowNext: (swallowNext) => set({ swallowNext }),

    upgradeLegacy: () => {
      const { draft, master } = get()
      const upgraded = upgradeAndSaveDraft(draft, master)
      set({ draft: upgraded, needsUpgrade: false })
    },

    addAnnotation: ({ paragraphId, body, quote }) => {
      const { draft, master } = get()
      const baseRev = master.paragraphs.find((p) => p.id === paragraphId)?.rev
      const next = addOfflineAnnotation(draft, {
        paragraphId,
        body: body.trim(),
        quote: quote.trim() || '（整段引用）',
        author: REVIEWER,
        baseRev,
      })
      saveDraft(next)
      set({ draft: next, report: null })
    },

    syncNow: async () => {
      const { draft, master, failureRate, swallowNext, syncing } = get()
      if (syncing || !draft.queue.length) return
      const swallowAckFor = swallowNext && draft.queue[0] ? [draft.queue[0].id] : []
      set({ syncing: true })
      try {
        const result = await reconcile(draft, master, createMockTransport({ failureRate, latency: 450, swallowAckFor }))
        saveMaster(result.master)
        saveDraft(result.draft)
        set({
          master: result.master,
          draft: result.draft,
          report: result.report,
          swallowNext: false,
        })
      } finally {
        set({ syncing: false })
      }
    },

    decide: (batchId, decision) => {
      const { draft, master } = get()
      const result = resolveConflictByEditor(draft, master, batchId, decision)
      saveMaster(result.master)
      saveDraft(result.draft)
      set({ master: result.master, draft: result.draft })
    },

    touchMasterParagraph: (paragraphId, text) => {
      const master = cloneMaster(get().master)
      const paragraph = master.paragraphs.find((p) => p.id === paragraphId)
      if (!paragraph || paragraph.text === text) return
      paragraph.text = text
      paragraph.rev += 1 // 编辑部改正文推进修订号，离线批注回来即对账为冲突
      saveMaster(master)
      set({ master, report: null })
    },

    reset: () => {
      resetSyncDemo()
      localStorage.removeItem(LEGACY_FLAG)
      const fresh = loadInitial()
      saveMaster(fresh.master)
      saveDraft(fresh.draft)
      set({
        master: fresh.master,
        draft: fresh.draft,
        report: null,
        failureRate: 0,
        swallowNext: false,
        needsUpgrade: draftNeedsUpgrade(fresh.draft),
        syncing: false,
      })
    },
  }
})

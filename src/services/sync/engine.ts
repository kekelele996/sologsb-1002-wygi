import type {
  BatchVerdict, MasterAnnotation, MasterRepository, OfflineAnnotation, PendingBatch,
  ReviewerOfflineDraft, SyncConflict, SyncReport, SyncReportItem,
} from './types'

let counter = 0
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 合并后的批注正文：保留每条批注作者与内容，并拼接引用片段 */
const joinBodies = (items: OfflineAnnotation[]) =>
  items.map((item) => `${item.author}：${item.body.trim()}`).join('\n')
const joinQuotes = (items: OfflineAnnotation[]) =>
  Array.from(new Set(items.map((item) => item.quote.trim()).filter(Boolean))).join(' / ')

/** 版本库对某段的只读判断 */
export const findMasterParagraph = (master: MasterRepository, paragraphId: string) =>
  master.paragraphs.find((paragraph) => paragraph.id === paragraphId)

// ─────────────────────────────────────────────────────────────
// 离线侧：添加批注并入队；同一段落的多次批注先并成一批再送
// ─────────────────────────────────────────────────────────────

/**
 * 审稿人离线添加批注。
 * baseRev 由当前本地持有的版本库段落修订号决定（离线时拿不到最新的也正常，
 * 对账时以修订号是否推进来判定）。
 */
export const addOfflineAnnotation = (
  draft: ReviewerOfflineDraft,
  input: Pick<OfflineAnnotation, 'paragraphId' | 'author' | 'body' | 'quote' | 'suggestion' | 'baseRev'>,
): ReviewerOfflineDraft => {
  const next = clone(draft)
  const annotation: OfflineAnnotation = { id: uid('a'), createdAt: Date.now(), ...input }
  next.annotations.push(annotation)

  // 同一段落已有待发批次就并进去，保证送出去时是一条；否则新开一批
  const existing = next.queue.find((batch) => batch.paragraphId === annotation.paragraphId)
  if (existing) {
    existing.memberIds.push(annotation.id)
    const revs = resolveMembers(next.annotations, existing).map((item) => item.baseRev).filter((v): v is number => typeof v === 'number')
    existing.baseRev = revs.length ? Math.min(...revs) : undefined
  } else {
    next.queue.push({
      id: uid('b'), paragraphId: annotation.paragraphId, memberIds: [annotation.id],
      baseRev: annotation.baseRev, attempts: 0, queuedAt: Date.now(),
    })
  }
  return next
}

const resolveMembers = (annotations: OfflineAnnotation[], batch: PendingBatch) =>
  batch.memberIds
    .map((memberId) => annotations.find((item) => item.id === memberId))
    .filter((item): item is OfflineAnnotation => Boolean(item))

// ─────────────────────────────────────────────────────────────
// 旧批注稿升级：没有修订号的批注，按合订稿现版本补上
// ─────────────────────────────────────────────────────────────

/**
 * 升级旧批注稿：baseRev 缺失的批注按版本库当前修订号补齐。
 * 待同步批次同理。已经同步/已定夺的批注不动。
 */
export const upgradeLegacyDraft = (
  draft: ReviewerOfflineDraft,
  master: MasterRepository,
): ReviewerOfflineDraft => {
  const next = clone(draft)
  for (const annotation of next.annotations) {
    if (annotation.baseRev === undefined && !annotation.synced && !annotation.resolution) {
      annotation.baseRev = findMasterParagraph(master, annotation.paragraphId)?.rev
    }
  }
  for (const batch of next.queue) {
    if (batch.baseRev === undefined) {
      batch.baseRev = findMasterParagraph(master, batch.paragraphId)?.rev
    }
  }
  next.lastPulledAt = Date.now()
  return next
}

// ─────────────────────────────────────────────────────────────
// 版本库提交接口：真正判定修订号的一方
// ─────────────────────────────────────────────────────────────

export interface MergedBatchPayload {
  batchId: string
  paragraphId: string
  baseRev?: number
  author: string
  body: string
  quote: string
  quoteContext: string
  suggestion?: string
  sourceIds: string[]
}

export interface MasterTransport {
  /**
   * 提交一个合并后的批次。
   * - 幂等：同一个 batchId 重复提交，直接返回上一次结果，已并进去的不会重发。
   * - 段落自 baseRev 后没动过：并入批注，修订号 +1，返回 committed。
   * - 段落修订号已推进：不覆盖合订稿，返回 stale，两边都留给编辑定夺。
   * - 网络/服务异常：返回 failed，批次留在审稿人队列里重试。
   */
  commit: (master: MasterRepository, payload: MergedBatchPayload) => Promise<{
    master: MasterRepository
    verdict: BatchVerdict
  }>
}

/**
 * 纯函数版提交，不含异步与随机故障，便于测试；
 * 浏览器侧用 createMockTransport 包一层网络延迟与可注入的失败率。
 */
export const applyCommit = (
  masterInput: MasterRepository,
  payload: MergedBatchPayload,
): { master: MasterRepository; verdict: BatchVerdict } => {
  const master = clone(masterInput)
  const paragraph = findMasterParagraph(master, payload.paragraphId)

  // 幂等：该批次此前已经受理（无论并入还是判为 stale），原样回放结果
  if (master.committedBatchIds.includes(payload.batchId)) {
    const existing = master.annotations.find((annotation) => annotation.sourceIds.includes(payload.sourceIds[0]))
    return {
      master,
      verdict: existing
        ? { kind: 'committed', batchId: payload.batchId, serverRev: paragraph?.rev ?? 0 }
        : { kind: 'stale', batchId: payload.batchId, serverRev: paragraph?.rev ?? 0 },
    }
  }

  if (!paragraph) {
    return { master, verdict: { kind: 'failed', batchId: payload.batchId, error: '合订稿中找不到该段落' } }
  }

  // 批注依据的修订号缺失视为旧稿未升级，安全起见判冲突交编辑，绝不直接覆盖
  if (payload.baseRev === undefined) {
    master.committedBatchIds.push(payload.batchId)
    return { master, verdict: { kind: 'stale', batchId: payload.batchId, serverRev: paragraph.rev } }
  }

  if (paragraph.rev !== payload.baseRev) {
    // 合订稿这段动过：不收批注、不动正文、不推进修订号，两边都留着等编辑定夺
    master.committedBatchIds.push(payload.batchId)
    return { master, verdict: { kind: 'stale', batchId: payload.batchId, serverRev: paragraph.rev } }
  }

  const merged: MasterAnnotation = {
    id: uid('m'),
    paragraphId: payload.paragraphId,
    author: payload.author,
    body: payload.body,
    quote: payload.quote,
    quoteContext: payload.quoteContext,
    suggestion: payload.suggestion,
    sourceIds: payload.sourceIds,
    createdAt: Date.now(),
    mergedAt: Date.now(),
  }
  master.annotations.push(merged)
  paragraph.rev += 1 // 批注并进去后推进段落修订号
  master.committedBatchIds.push(payload.batchId)
  return { master, verdict: { kind: 'committed', batchId: payload.batchId, serverRev: paragraph.rev } }
}

// ─────────────────────────────────────────────────────────────
// 回网对账：审稿人把待同步队列逐段送出版本库
// ─────────────────────────────────────────────────────────────

const buildPayload = (
  draft: ReviewerOfflineDraft,
  batch: PendingBatch,
): MergedBatchPayload | null => {
  const members = resolveMembers(draft.annotations, batch)
  if (!members.length) return null
  return {
    batchId: batch.id,
    paragraphId: batch.paragraphId,
    baseRev: batch.baseRev,
    author: Array.from(new Set(members.map((item) => item.author))).join('、'),
    body: joinBodies(members),
    quote: joinQuotes(members),
    quoteContext: members[0].quote,
    suggestion: members.map((item) => item.suggestion).filter(Boolean).join('\n') || undefined,
    sourceIds: members.map((item) => item.id),
  }
}

/**
 * 执行一次离线对账。
 *
 * 规则：
 * 1. 同一段落的多条离线批注已在入队时并为一批，送出的就是一条。
 * 2. committed：批注并入合订稿、修订号推进；队列里删掉该批，批注标记 synced，不重发。
 * 3. stale：合订稿这段动过，批次移出队列转为冲突，两边内容都保留给编辑定夺，批注稿不盖住合订稿。
 * 4. failed：只把没送上去的批次留在队列里（attempts/lastError 记账），下次重试。
 */
export const reconcile = async (
  draftInput: ReviewerOfflineDraft,
  masterInput: MasterRepository,
  transport: MasterTransport,
): Promise<{ draft: ReviewerOfflineDraft; master: MasterRepository; report: SyncReport }> => {
  const draft = clone(draftInput)
  let master = clone(masterInput)
  const merged: SyncReportItem[] = []
  const conflicts: SyncReportItem[] = []
  const failed: SyncReportItem[] = []

  // 逐段顺序提交：一批失败不阻塞其他段落
  for (const batch of [...draft.queue]) {
    const paragraph = findMasterParagraph(master, batch.paragraphId)
    const revBefore = paragraph?.rev
    const payload = buildPayload(draft, batch)
    if (!payload) {
      draft.queue = draft.queue.filter((item) => item.id !== batch.id)
      continue
    }

    batch.attempts += 1
    let verdict: BatchVerdict
    try {
      const result = await transport.commit(master, payload)
      master = result.master
      verdict = result.verdict
    } catch (error) {
      verdict = { kind: 'failed', batchId: batch.id, error: error instanceof Error ? error.message : String(error) }
    }

    if (verdict.kind === 'committed') {
      // 送上去了：只删这一批，成员批注标记已同步；已经并进去的不会重发
      draft.queue = draft.queue.filter((item) => item.id !== batch.id)
      draft.annotations = draft.annotations.map((annotation) =>
        batch.memberIds.includes(annotation.id) ? { ...annotation, synced: true } : annotation,
      )
      merged.push({
        paragraphId: batch.paragraphId, batchId: batch.id, memberIds: batch.memberIds,
        status: 'merged', masterRevBefore: revBefore, masterRevAfter: verdict.serverRev,
      })
    } else if (verdict.kind === 'stale') {
      // 两边都动过：移出队列、保留批注，挂冲突给编辑；批注稿不覆盖合订稿
      draft.queue = draft.queue.filter((item) => item.id !== batch.id)
      const members = resolveMembers(draft.annotations, batch)
      const conflict: SyncConflict = {
        batchId: batch.id,
        paragraphId: batch.paragraphId,
        masterText: paragraph?.text ?? '',
        masterRev: verdict.serverRev,
        offlineQuote: payload.quote,
        offlineBaseRev: batch.baseRev,
        mergedBody: payload.body,
        memberIds: batch.memberIds,
        detectedAt: Date.now(),
      }
      draft.conflicts.push(conflict)
      draft.annotations = draft.annotations.map((annotation) =>
        batch.memberIds.includes(annotation.id) ? { ...annotation, conflicted: true } : annotation,
      )
      conflicts.push({
        paragraphId: batch.paragraphId, batchId: batch.id, memberIds: members.map((item) => item.id),
        status: 'conflict', masterRevBefore: revBefore, masterRevAfter: verdict.serverRev,
      })
    } else {
      // 提交失败：批次留在队列，仅记账，等下次重试
      const queued = draft.queue.find((item) => item.id === batch.id)
      if (queued) {
        queued.lastError = verdict.error
      }
      failed.push({
        paragraphId: batch.paragraphId, batchId: batch.id, memberIds: batch.memberIds,
        status: 'failed', error: verdict.error,
      })
    }
  }

  draft.lastPulledAt = Date.now()
  return {
    draft,
    master,
    report: { merged, conflicts, failed, masterChanged: merged.length > 0, pulledAt: Date.now() },
  }
}

// ─────────────────────────────────────────────────────────────
// 编辑定夺：冲突保留了两边内容，由编辑决定并入或丢弃
// ─────────────────────────────────────────────────────────────

export type EditorDecision = 'attach' | 'discard'

/**
 * 编辑对一条冲突作出定夺。
 * - attach：以当前合订稿为准把批注并进去，修订号再推进一次；冲突记为 attached。
 * - discard：不并入，冲突记为 discarded，合订稿保持原样。
 * 无论哪种，审稿人队列里都不会再有该批（不重发）。
 */
export const resolveConflictByEditor = (
  draftInput: ReviewerOfflineDraft,
  masterInput: MasterRepository,
  batchId: string,
  decision: EditorDecision,
): { draft: ReviewerOfflineDraft; master: MasterRepository } => {
  const draft = clone(draftInput)
  const master = clone(masterInput)
  const conflict = draft.conflicts.find((item) => item.batchId === batchId)
  if (!conflict || conflict.resolution) return { draft, master }

  const paragraph = findMasterParagraph(master, conflict.paragraphId)
  if (decision === 'attach' && paragraph) {
    master.annotations.push({
      id: uid('m'),
      paragraphId: conflict.paragraphId,
      author: Array.from(new Set(conflict.memberIds
        .map((memberId) => draft.annotations.find((annotation) => annotation.id === memberId)?.author)
        .filter((v): v is string => Boolean(v)))).join('、'),
      body: conflict.mergedBody,
      quote: conflict.offlineQuote,
      quoteContext: paragraph.text,
      sourceIds: conflict.memberIds,
      createdAt: Date.now(),
      mergedAt: Date.now(),
    })
    paragraph.rev += 1
  }

  conflict.resolution = decision === 'attach' ? 'attached' : 'discarded'
  conflict.resolvedAt = Date.now()
  draft.annotations = draft.annotations.map((annotation) =>
    conflict.memberIds.includes(annotation.id)
      ? { ...annotation, conflicted: decision === 'attach' ? false : annotation.conflicted, synced: decision === 'attach' ? true : annotation.synced, resolution: decision === 'attach' ? 'attached' : 'discarded', resolvedAt: conflict.resolvedAt }
      : annotation,
  )
  return { draft, master }
}

/** 构造一份新的离线批注稿 */
export const createDraft = (paperId: string, reviewer: string): ReviewerOfflineDraft => ({
  paperId, reviewer, annotations: [], queue: [], conflicts: [], lastPulledAt: Date.now(),
})

export const __testing = { uid, joinBodies, joinQuotes, resolveMembers }

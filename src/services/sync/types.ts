// 离线批注对账的数据模型
// 两头各管各的：
// - MasterRepository：编辑部版本库，管合订稿正文、段落修订号、已并入的批注
// - ReviewerOfflineDraft：审稿人离线批注稿，管批注、引用片段、待同步队列

/** 已经并入合订稿的批注（同一段落的多条离线批注会先并成一条） */
export interface MasterAnnotation {
  id: string
  paragraphId: string
  author: string
  body: string
  quote: string
  /** 合订稿上该段落当时的正文快照，供编辑定夺时对照 */
  quoteContext: string
  suggestion?: string
  /** 由哪些离线批注合并而来 */
  sourceIds: string[]
  createdAt: number
  mergedAt: number
}

/** 合订稿段落。rev 即段落修订号，段落没动过就不推进。 */
export interface MasterParagraph {
  id: string
  section: string
  number: string
  text: string
  /** 段落修订号，单调递增；并入批注、正文修改都会推进 */
  rev: number
}

/** 编辑部版本库 */
export interface MasterRepository {
  paperId: string
  paragraphs: MasterParagraph[]
  annotations: MasterAnnotation[]
  /** 模拟接口已受理过的批次号，用于失败重试时幂等去重 */
  committedBatchIds: string[]
}

/** 审稿人在离线稿上写下的单条批注 */
export interface OfflineAnnotation {
  id: string
  paragraphId: string
  author: string
  body: string
  quote: string
  suggestion?: string
  createdAt: number
  /**
   * 离线时所依据的段落修订号。
   * 旧批注稿没有修订号（undefined），回网升级时按合订稿现版本补上。
   */
  baseRev?: number
  /** 已成功并入合订稿 */
  synced?: boolean
  /** 段落已在合订稿侧改动，等待编辑定夺；resolution 记录定夺结果 */
  conflicted?: boolean
  resolution?: 'attached' | 'discarded'
  resolvedAt?: number
}

/**
 * 待同步队列中的一个批次：同一段落离线批注多次，先并成一条再送出去。
 * 队列里只存批次号与成员，批注正文仍由 annotations 管。
 */
export interface PendingBatch {
  id: string
  paragraphId: string
  memberIds: string[]
  /** 批次创建时所依据的修订号，取成员中最旧的 baseRev（未升级的旧稿为 undefined） */
  baseRev?: number
  attempts: number
  lastError?: string
  queuedAt: number
}

/** 段落两边都动过、留给编辑定夺的冲突 */
export interface SyncConflict {
  batchId: string
  paragraphId: string
  /** 合订稿当前正文与修订号 */
  masterText: string
  masterRev: number
  /** 批注引用的离线片段与离线时修订号 */
  offlineQuote: string
  offlineBaseRev?: number
  mergedBody: string
  memberIds: string[]
  detectedAt: number
  resolution?: 'attached' | 'discarded'
  resolvedAt?: number
}

/** 审稿人离线批注稿 */
export interface ReviewerOfflineDraft {
  paperId: string
  reviewer: string
  annotations: OfflineAnnotation[]
  queue: PendingBatch[]
  conflicts: SyncConflict[]
  /** 最近一次从版本库刷新段落修订号的时间 */
  lastPulledAt?: number
}

export type BatchVerdict =
  | { kind: 'committed'; batchId: string; serverRev: number }
  | { kind: 'stale'; batchId: string; serverRev: number }
  | { kind: 'failed'; batchId: string; error: string }

export interface SyncReportItem {
  paragraphId: string
  batchId: string
  memberIds: string[]
  status: 'merged' | 'conflict' | 'failed'
  masterRevBefore?: number
  masterRevAfter?: number
  error?: string
}

export interface SyncReport {
  merged: SyncReportItem[]
  conflicts: SyncReportItem[]
  failed: SyncReportItem[]
  /** 本次对账后版本库是否被修改（供持久化判断） */
  masterChanged: boolean
  pulledAt: number
}

export type Role = 'author' | 'reviewer' | 'editor'
export type ParagraphStatus = 'open' | 'accepted' | 'locked'
export type CommentStatus = 'open' | 'accepted' | 'rejected' | 'merged'
export type CommentType = 'comment' | 'suggestion'

export interface Reply {
  id: string
  author: string
  role: Role
  body: string
  createdAt: number
}

export interface Comment {
  id: string
  paragraphId: string
  author: string
  role: Role
  type: CommentType
  quote: string
  body: string
  suggestion?: string
  status: CommentStatus
  replies: Reply[]
  createdAt: number
  mergedInto?: string
}

export interface Paragraph {
  id: string
  section: string
  number: string
  text: string
  original: string
  status: ParagraphStatus
  highlighted: boolean
}

export interface Version {
  id: string
  label: string
  createdAt: number
  paragraphs: Paragraph[]
}

export interface EditConflict {
  id: string
  paragraphId: string
  localText: string
  remoteText: string
  localAuthor: string
  remoteAuthor: string
  detectedAt: number
}

export interface HistorySnapshot {
  paragraphs: Paragraph[]
  comments: Comment[]
  versions: Version[]
}

/** 审稿人离线批注：记录批注时本机所见的段落修订号 */
export interface OfflineAnnotation {
  id: string
  paragraphId: string
  type: CommentType
  quote: string
  body: string
  suggestion?: string
  author: string
  baseRevision: number
  createdAt: number
}

export type SyncItemStatus = 'pending' | 'failed'

/** 待同步队列项：同一段落的多条离线批注已并成一条 */
export interface SyncQueueItem {
  id: string
  paragraphId: string
  baseRevision: number
  annotations: OfflineAnnotation[]
  status: SyncItemStatus
  attempts: number
  lastError?: string
  createdAt: number
}

/** 对账冲突：批注稿与合订稿两边都留着，等编辑定夺 */
export interface SyncConflict {
  id: string
  paragraphId: string
  item: SyncQueueItem
  baseRevision: number
  masterRevision: number
  masterText: string
  detectedAt: number
  resolution?: 'merged' | 'kept-master'
}

/** 合订稿（编辑部版本库）中已并入的批注 */
export interface MasterAnnotation {
  id: string
  paragraphId: string
  quote: string
  body: string
  suggestion?: string
  type: CommentType
  author: string
  mergedAt: number
  /** 并入后推进到的段落修订号 */
  revision: number
  source: 'sync' | 'editor-override'
}

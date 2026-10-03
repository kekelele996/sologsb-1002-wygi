import type { MasterAnnotation, SyncQueueItem } from '../types'

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** 同步引擎访问合订稿所需的最小接口 */
export interface MasterGateway {
  getRevision: (paragraphId: string) => number
  getText: (paragraphId: string) => string
  merge: (item: SyncQueueItem) => MasterAnnotation
}

export type SubmitOutcome =
  | { item: SyncQueueItem; status: 'merged'; annotation: MasterAnnotation }
  | { item: SyncQueueItem; status: 'conflict'; masterRevision: number; masterText: string }
  | { item: SyncQueueItem; status: 'failed'; error: string }

export interface SubmitOptions {
  /** 模拟提交中断：从第 N 条（0 起）开始全部送不出去 */
  failFromIndex?: number
  latency?: number
}

/**
 * 回网对账：逐条按段落修订号核对。
 * - 合订稿该段没动过（修订号一致）→ 并入并推进修订号；
 * - 动过 → 记冲突，两边都留着，批注稿不覆盖合订稿；
 * - 送不出去 → 标记失败留在队列里，已并入的不会重发。
 */
export const submitQueue = async (
  items: SyncQueueItem[],
  master: MasterGateway,
  options: SubmitOptions = {},
): Promise<SubmitOutcome[]> => {
  const outcomes: SubmitOutcome[] = []
  for (const [index, item] of items.entries()) {
    await wait(options.latency ?? 450)
    if (options.failFromIndex != null && index >= options.failFromIndex) {
      outcomes.push({ item, status: 'failed', error: '网络中断，该条未送达编辑部' })
      continue
    }
    const masterRevision = master.getRevision(item.paragraphId)
    if (masterRevision !== item.baseRevision) {
      outcomes.push({ item, status: 'conflict', masterRevision, masterText: master.getText(item.paragraphId) })
      continue
    }
    const annotation = master.merge(item)
    outcomes.push({ item, status: 'merged', annotation })
  }
  return outcomes
}

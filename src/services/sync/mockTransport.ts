import { applyCommit, type MasterTransport } from './engine'
import type { BatchVerdict, MasterAnnotation, MasterRepository } from './types'

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export interface MockTransportOptions {
  /** 普通网络失败概率（提交未到达版本库，批次原样留在队列） */
  failureRate?: number
  /**
   * 这些批次首次提交时“版本库已并入、但回执在回程中丢失”，
   * 用来演示重试的幂等性：再送一次只会拿回上次的结果，不会重复并入。
   */
  swallowAckFor?: string[]
  latency?: number
}

interface SwallowedResult {
  kind: 'committed' | 'stale'
  serverRev: number
  /** committed 时版本库已落库的批注，重放时用于在最新版本库上幂等补登 */
  annotation?: MasterAnnotation
}

/**
 * 浏览器内模拟的编辑部接口。
 * 用一张“已受理但客户端没收到回执”的台账记住批次，
 * 保证同 batchId 重试时幂等重放，绝不把同一条批注并两次。
 */
export const createMockTransport = (options: MockTransportOptions = {}): MasterTransport => {
  const failureRate = options.failureRate ?? 0
  const latency = options.latency ?? 500
  const swallow = new Set(options.swallowAckFor ?? [])
  const swallowed = new Map<string, SwallowedResult>()

  return {
    async commit(masterInput, payload) {
      await wait(latency)

      const replayed = swallowed.get(payload.batchId)
      if (replayed) {
        // 重放：在“最新”版本库上补登，而不是回放旧快照，避免盖掉期间其他批次的并入
        let master: MasterRepository = masterInput
        if (replayed.kind === 'committed' && replayed.annotation) {
          const already = master.annotations.some((item) => item.sourceIds.some((id) => replayed.annotation!.sourceIds.includes(id)))
          if (!already) {
            master = JSON.parse(JSON.stringify(master)) as MasterRepository
            master.annotations.push(replayed.annotation)
            const paragraph = master.paragraphs.find((item) => item.id === payload.paragraphId)
            if (paragraph && paragraph.rev < replayed.serverRev) paragraph.rev = replayed.serverRev
            master.committedBatchIds.push(payload.batchId)
          }
        } else if (!master.committedBatchIds.includes(payload.batchId)) {
          master = JSON.parse(JSON.stringify(master)) as MasterRepository
          master.committedBatchIds.push(payload.batchId)
        }
        return { master, verdict: { kind: replayed.kind, batchId: payload.batchId, serverRev: replayed.serverRev } as BatchVerdict }
      }

      if (Math.random() < failureRate) {
        throw new Error('网络中断：提交未到达编辑部版本库')
      }

      if (swallow.has(payload.batchId)) {
        // 服务端先落库再丢回执
        const result = applyCommit(masterInput, payload)
        if (result.verdict.kind === 'committed') {
          swallowed.set(payload.batchId, {
            kind: 'committed',
            serverRev: result.verdict.serverRev,
            annotation: result.master.annotations.find((item) => item.sourceIds.includes(payload.sourceIds[0])),
          })
        } else if (result.verdict.kind === 'stale') {
          swallowed.set(payload.batchId, { kind: 'stale', serverRev: result.verdict.serverRev })
        }
        throw new Error('回执超时：版本库可能已收到，重试时按批次号幂等核对')
      }

      return applyCommit(masterInput, payload)
    },
  }
}

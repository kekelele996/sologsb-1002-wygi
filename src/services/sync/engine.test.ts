import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMockTransport } from './mockTransport'
import {
  addOfflineAnnotation, applyCommit, createDraft, findMasterParagraph,
  reconcile, resolveConflictByEditor, upgradeLegacyDraft,
  type MasterTransport,
} from './engine'
import type { MasterRepository, ReviewerOfflineDraft } from './types'

const makeMaster = (): MasterRepository => ({
  paperId: 'P',
  paragraphs: [
    { id: 'p1', section: 'S', number: '1.', text: '正文第一段', rev: 2 },
    { id: 'p2', section: 'S', number: '2.', text: '正文第二段', rev: 1 },
  ],
  annotations: [],
  committedBatchIds: [],
})

const immediateTransport = (): MasterTransport => ({
  async commit(master, payload) {
    return applyCommit(master, payload)
  },
})

const failingOnceTransport = (): MasterTransport => {
  const failed = new Set<string>()
  return {
    async commit(master, payload) {
      if (!failed.has(payload.batchId)) {
        failed.add(payload.batchId)
        throw new Error('断网')
      }
      return applyCommit(master, payload)
    },
  }
}

test('同一段落离线批注多次：入队即并成一批，只送一条', () => {
  let draft = createDraft('P', '审稿人 A')
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '意见一', quote: '第一', baseRev: 2 })
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '意见二', quote: '第二', baseRev: 2 })
  draft = addOfflineAnnotation(draft, { paragraphId: 'p2', author: '审稿人 A', body: '另一段意见', quote: '段二', baseRev: 1 })

  assert.equal(draft.queue.length, 2)
  const p1batch = draft.queue.find((b) => b.paragraphId === 'p1')!
  assert.deepEqual(p1batch.memberIds.length, 2)
  const p2batch = draft.queue.find((b) => b.paragraphId === 'p2')!
  assert.deepEqual(p2batch.memberIds.length, 1)
})

test('合订稿段落没动过：批注并入、修订号推进、成员标记已同步且队列清空', async () => {
  const master = makeMaster()
  let draft = createDraft('P', '审稿人 A')
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '意见一', quote: '第一', baseRev: 2 })
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '意见二', quote: '第二', baseRev: 2 })

  const result = await reconcile(draft, master, immediateTransport())

  assert.equal(result.report.merged.length, 1)
  assert.equal(result.master.annotations.length, 1)
  assert.equal(result.master.annotations[0].body.includes('意见一'), true)
  assert.equal(result.master.annotations[0].body.includes('意见二'), true)
  assert.deepEqual(result.master.annotations[0].sourceIds.length, 2)
  assert.equal(findMasterParagraph(result.master, 'p1')!.rev, 3)
  assert.equal(result.draft.queue.length, 0)
  assert.ok(result.draft.annotations.every((a) => a.synced))
})

test('合订稿段落动过：不覆盖正文、不推进修订号，两边都留着转冲突', async () => {
  const master = makeMaster()
  // 编辑部先改正文，推进修订号 2 -> 3
  master.paragraphs[0].text = '正文第一段（作者已修改）'
  master.paragraphs[0].rev = 3

  let draft = createDraft('P', '审稿人 A')
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '离线意见', quote: '第一', baseRev: 2 })

  const result = await reconcile(draft, master, immediateTransport())

  assert.equal(result.report.conflicts.length, 1)
  assert.equal(result.report.merged.length, 0)
  // 合订稿原样未被批注稿盖住
  assert.equal(findMasterParagraph(result.master, 'p1')!.rev, 3)
  assert.equal(findMasterParagraph(result.master, 'p1')!.text, '正文第一段（作者已修改）')
  assert.equal(result.master.annotations.length, 0)
  // 两边都保留：批注仍在、移出队列、挂到冲突台
  assert.equal(result.draft.queue.length, 0)
  assert.equal(result.draft.conflicts.length, 1)
  assert.equal(result.draft.conflicts[0].masterText, '正文第一段（作者已修改）')
  assert.equal(result.draft.conflicts[0].mergedBody.includes('离线意见'), true)
  assert.ok(result.draft.annotations.every((a) => !a.synced))
})

test('提交失败：批次留在队列记账重试；成功后不重发', async () => {
  const master = makeMaster()
  let draft = createDraft('P', '审稿人 A')
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '意见', quote: '第一', baseRev: 2 })

  const transport = failingOnceTransport()
  const first = await reconcile(draft, master, transport)
  assert.equal(first.report.failed.length, 1)
  assert.equal(first.draft.queue.length, 1, '没送上去的留在队列')
  assert.equal(first.draft.queue[0].attempts, 1)
  assert.equal(first.draft.queue[0].lastError, '断网')
  // 版本库未被修改
  assert.equal(first.master.annotations.length, 0)
  assert.equal(findMasterParagraph(first.master, 'p1')!.rev, 2)

  // 重试：送上去，队列清空，只并入一次
  const second = await reconcile(first.draft, first.master, transport)
  assert.equal(second.report.merged.length, 1)
  assert.equal(second.report.failed.length, 0)
  assert.equal(second.draft.queue.length, 0)
  assert.equal(second.master.annotations.length, 1)
  assert.equal(findMasterParagraph(second.master, 'p1')!.rev, 3)
})

test('一批失败不阻塞其他段落的批次', async () => {
  const master = makeMaster()
  let draft = createDraft('P', '审稿人 A')
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: 'A', body: 'p1意见', quote: '一', baseRev: 2 })
  draft = addOfflineAnnotation(draft, { paragraphId: 'p2', author: 'A', body: 'p2意见', quote: '二', baseRev: 1 })

  const transport: MasterTransport = {
    async commit(currentMaster, payload) {
      if (payload.paragraphId === 'p1') throw new Error('p1 网断了')
      return applyCommit(currentMaster, payload)
    },
  }
  const result = await reconcile(draft, master, transport)
  assert.equal(result.report.failed.length, 1)
  assert.equal(result.report.merged.length, 1)
  assert.deepEqual(result.draft.queue.map((b) => b.paragraphId), ['p1'])
})

test('旧批注稿升级：没有修订号的批注按合订稿现版本补上', () => {
  const master = makeMaster()
  const legacy: ReviewerOfflineDraft = {
    paperId: 'P', reviewer: 'A',
    annotations: [
      { id: 'a1', paragraphId: 'p1', author: 'A', body: '旧意见', quote: '第一', createdAt: 1 },
    ],
    queue: [
      { id: 'b1', paragraphId: 'p1', memberIds: ['a1'], attempts: 0, queuedAt: 1 },
    ],
    conflicts: [],
  }
  const upgraded = upgradeLegacyDraft(legacy, master)
  assert.equal(upgraded.annotations[0].baseRev, 2)
  assert.equal(upgraded.queue[0].baseRev, 2)
  assert.ok(upgraded.lastPulledAt)
  // 原对象不被改动
  assert.equal(legacy.annotations[0].baseRev, undefined)
})

test('升级后的旧批注可以正常并入并推进修订号', async () => {
  const master = makeMaster()
  const legacy: ReviewerOfflineDraft = {
    paperId: 'P', reviewer: 'A',
    annotations: [{ id: 'a1', paragraphId: 'p2', author: 'A', body: '旧意见', quote: '二', createdAt: 1 }],
    queue: [{ id: 'b1', paragraphId: 'p2', memberIds: ['a1'], attempts: 0, queuedAt: 1 }],
    conflicts: [],
  }
  const upgraded = upgradeLegacyDraft(legacy, master)
  const result = await reconcile(upgraded, master, immediateTransport())
  assert.equal(result.report.merged.length, 1)
  assert.equal(findMasterParagraph(result.master, 'p2')!.rev, 2)
})

test('编辑定夺 attach：以合订稿现版为准并入，修订号再推进', async () => {
  const master = makeMaster()
  master.paragraphs[0].rev = 3 // 编辑部已动过
  let draft = createDraft('P', '审稿人 A')
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '离线意见', quote: '第一', baseRev: 2 })
  const afterSync = await reconcile(draft, master, immediateTransport())
  assert.equal(afterSync.draft.conflicts.length, 1)

  const batchId = afterSync.draft.conflicts[0].batchId
  const decided = resolveConflictByEditor(afterSync.draft, afterSync.master, batchId, 'attach')

  assert.equal(decided.master.annotations.length, 1)
  assert.equal(findMasterParagraph(decided.master, 'p1')!.rev, 4)
  assert.equal(decided.draft.conflicts[0].resolution, 'attached')
  assert.ok(decided.draft.annotations.every((a) => a.synced))
  // 定夺不可重复执行（不会重复并入）
  const again = resolveConflictByEditor(decided.draft, decided.master, batchId, 'attach')
  assert.equal(again.master.annotations.length, 1)
  assert.equal(findMasterParagraph(again.master, 'p1')!.rev, 4)
})

test('编辑定夺 discard：丢弃批注，合订稿原样保留', async () => {
  const master = makeMaster()
  master.paragraphs[0].rev = 3
  let draft = createDraft('P', '审稿人 A')
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '离线意见', quote: '第一', baseRev: 2 })
  const afterSync = await reconcile(draft, master, immediateTransport())
  const batchId = afterSync.draft.conflicts[0].batchId

  const decided = resolveConflictByEditor(afterSync.draft, afterSync.master, batchId, 'discard')
  assert.equal(decided.master.annotations.length, 0)
  assert.equal(findMasterParagraph(decided.master, 'p1')!.rev, 3)
  assert.equal(decided.draft.conflicts[0].resolution, 'discarded')
  assert.equal(decided.draft.queue.length, 0)
})

test('版本库幂等：同批次号重复提交不会把批注并两次', () => {
  const master = makeMaster()
  const payload = {
    batchId: 'b-fixed', paragraphId: 'p1', baseRev: 2, author: 'A',
    body: '意见', quote: '第一', quoteContext: '正文第一段', sourceIds: ['a1'],
  }
  const first = applyCommit(master, payload)
  assert.equal(first.verdict.kind, 'committed')
  assert.equal(findMasterParagraph(first.master, 'p1')!.rev, 3)

  // 拿“旧版本库快照”重放（模拟客户端回执丢失后拿老快照重试）
  const replay = applyCommit(first.master, payload)
  assert.equal(replay.verdict.kind, 'committed')
  assert.equal(replay.master.annotations.length, 1, '不会重复并入')
  assert.equal(findMasterParagraph(replay.master, 'p1')!.rev, 3, '修订号不重复推进')
})

test('baseRev 缺失的批次不会被直接并入，安全判为冲突', async () => {
  const master = makeMaster()
  const draft: ReviewerOfflineDraft = {
    paperId: 'P', reviewer: 'A',
    annotations: [{ id: 'a1', paragraphId: 'p1', author: 'A', body: '无修订号', quote: '一', createdAt: 1 }],
    queue: [{ id: 'b1', paragraphId: 'p1', memberIds: ['a1'], attempts: 0, queuedAt: 1 }],
    conflicts: [],
  }
  const result = await reconcile(draft, master, immediateTransport())
  assert.equal(result.report.conflicts.length, 1)
  assert.equal(result.master.annotations.length, 0)
})

test('回执丢失后重试：版本库只并入一次，重试拿回 committed 而不重发', async () => {
  const master = makeMaster()
  let draft = createDraft('P', '审稿人 A')
  draft = addOfflineAnnotation(draft, { paragraphId: 'p1', author: '审稿人 A', body: '意见', quote: '第一', baseRev: 2 })
  const batchId = draft.queue[0].id

  // 第一次：服务端落库但回执超时，批次留在队列
  const firstTransport = createMockTransport({ latency: 1, swallowAckFor: [batchId] })
  const first = await reconcile(draft, master, firstTransport)
  assert.equal(first.report.failed.length, 1)
  assert.equal(first.draft.queue.length, 1)

  // 第二次：普通传输（不带 swallow），同 batchId 触发幂等台账重放
  const secondTransport = createMockTransport({ latency: 1 })
  const second = await reconcile(first.draft, first.master, secondTransport)
  assert.equal(second.report.merged.length, 1)
  assert.equal(second.master.annotations.length, 1, '回执丢失的批次只并入一次')
  assert.equal(findMasterParagraph(second.master, 'p1')!.rev, 3)
  assert.equal(second.draft.queue.length, 0)
})

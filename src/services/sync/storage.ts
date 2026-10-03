import type { MasterRepository, ReviewerOfflineDraft } from './types'
import { createDraft, upgradeLegacyDraft } from './engine'

const MASTER_KEY = 'sologsb-1002-master-v1'
const DRAFT_KEY_PREFIX = 'sologsb-1002-reviewer-draft-v1'

export const draftKey = (reviewer: string) => `${DRAFT_KEY_PREFIX}:${reviewer}`

// ── 合订稿示例数据：段落修订号从 3 起步，便于演示“动过 / 没动过” ──
const seedMaster = (): MasterRepository => ({
  paperId: 'MS-2026-0417',
  committedBatchIds: [],
  paragraphs: [
    { id: 'p-01', section: '摘要', number: '1.', text: '开源软件供应链的稳定性不仅取决于代码质量，也取决于维护者能否持续识别并回应社区需求。', rev: 3 },
    { id: 'p-02', section: '1 引言', number: '2.', text: '近年来，大型语言模型被广泛用于代码生成与缺陷定位，但在真实维护工作流中改变了哪些协作行为，仍缺少系统证据。', rev: 4 },
    { id: 'p-03', section: '1 引言', number: '3.', text: '本文收集 12 个活跃开源项目连续 18 个月的议题记录，并访谈 26 位核心维护者。', rev: 2 },
    { id: 'p-04', section: '2 方法', number: '4.', text: '我们采用混合研究方法，将议题生命周期划分为响应、评审与合并三个阶段。编码过程由两名研究者独立完成。', rev: 5 },
    { id: 'p-05', section: '2 方法', number: '5.', text: '当编码结果不一致时，研究者通过讨论达成一致；若仍有分歧，则邀请第三位研究者裁决。', rev: 2 },
    { id: 'p-06', section: '3 结果', number: '6.', text: '初步结果显示，辅助工具缩短了首次响应时间，但没有显著降低维护者处理复杂议题的认知负担。', rev: 2 },
    { id: 'p-07', section: '3 结果', number: '7.', text: '在高活跃度项目中，维护者更关注建议是否可验证，而非建议生成速度。', rev: 1 },
  ],
  annotations: [
    {
      id: 'm-seed-1', paragraphId: 'p-04', author: '审稿人 C',
      body: '审稿人 C：建议报告编码者间一致性系数，并明确不一致处理规则。',
      quote: '两名研究者独立完成', quoteContext: '编码过程由两名研究者独立完成。',
      sourceIds: ['seed-a-1'], createdAt: Date.now() - 3600_000, mergedAt: Date.now() - 3600_000,
    },
  ],
})

const read = <T,>(key: string): T | null => {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

export const loadMaster = (): MasterRepository => read<MasterRepository>(MASTER_KEY) ?? seedMaster()
export const saveMaster = (master: MasterRepository) => localStorage.setItem(MASTER_KEY, JSON.stringify(master))

/**
 * 载入审稿人离线稿。
 * @param legacy 为 true 时造一份“旧批注稿”：批注没有段落修订号，
 *   首次回网走升级流程，按合订稿现版本补上。
 */
export const loadDraft = (reviewer: string, legacy = false): ReviewerOfflineDraft => {
  const stored = read<ReviewerOfflineDraft>(draftKey(reviewer))
  if (stored) return stored

  if (legacy) {
    // 旧稿：故意不写 baseRev，模拟升级前的历史数据
    const legacyDraft: ReviewerOfflineDraft = {
      paperId: 'MS-2026-0417',
      reviewer,
      annotations: [
        { id: 'legacy-a-1', paragraphId: 'p-05', author: reviewer, body: '第三位研究者裁决的标准是否在预注册中写明？', quote: '邀请第三位研究者裁决', createdAt: Date.now() - 86_400_000 },
        { id: 'legacy-a-2', paragraphId: 'p-05', author: reviewer, body: '建议补充裁决者的利益冲突回避说明。', quote: '第三位研究者裁决', createdAt: Date.now() - 80_000_000 },
      ],
      queue: [
        { id: 'legacy-b-1', paragraphId: 'p-05', memberIds: ['legacy-a-1', 'legacy-a-2'], attempts: 0, queuedAt: Date.now() - 80_000_000 },
      ],
      conflicts: [],
    }
    return legacyDraft
  }
  return createDraft('MS-2026-0417', reviewer)
}

export const saveDraft = (draft: ReviewerOfflineDraft) =>
  localStorage.setItem(draftKey(draft.reviewer), JSON.stringify(draft))

/** 升级旧批注稿并持久化：没有修订号的批注按版本库现版本补上 */
export const upgradeAndSaveDraft = (draft: ReviewerOfflineDraft, master: MasterRepository): ReviewerOfflineDraft => {
  const upgraded = upgradeLegacyDraft(draft, master)
  saveDraft(upgraded)
  return upgraded
}

export const resetSyncDemo = () => {
  localStorage.removeItem(MASTER_KEY)
  Object.keys(localStorage)
    .filter((key) => key.startsWith(DRAFT_KEY_PREFIX))
    .forEach((key) => localStorage.removeItem(key))
}

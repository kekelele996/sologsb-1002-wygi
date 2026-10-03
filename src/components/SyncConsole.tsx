import { useState } from 'react'
import {
  ApiOutlined, CheckCircleOutlined, ClockCircleOutlined, CloudSyncOutlined,
  CloudServerOutlined, CommentOutlined, ExclamationCircleOutlined, ReloadOutlined,
  RetweetOutlined, SafetyOutlined, ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons'
import {
  Alert, Badge, Button, Card, Checkbox, Divider, Drawer, Empty, Input, Modal,
  Select, Slider, Space, Statistic, Tag, Tooltip, Typography, message,
} from 'antd'
import { useSyncStore } from '../store/syncConsole'
import type { MasterParagraph, PendingBatch, SyncConflict } from '../services/sync/types'

const { Text, Paragraph } = Typography

const formatTime = (value?: number) => value
  ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
  : '—'

const annotationState = (state: { synced?: boolean; conflicted?: boolean; resolution?: string }) => {
  if (state.resolution === 'attached') return { color: 'green', text: '已并入（编辑定夺）' }
  if (state.resolution === 'discarded') return { color: 'default', text: '已丢弃（编辑定夺）' }
  if (state.synced) return { color: 'green', text: '已并入合订稿' }
  if (state.conflicted) return { color: 'volcano', text: '待编辑定夺' }
  return { color: 'gold', text: '离线待同步' }
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function SyncConsole({ open, onClose }: Props) {
  const {
    master, draft, syncing, report, failureRate, swallowNext, needsUpgrade,
    setFailureRate, setSwallowNext, upgradeLegacy, addAnnotation, syncNow, decide,
    touchMasterParagraph, reset,
  } = useSyncStore()

  const [paragraphId, setParagraphId] = useState(master.paragraphs[2]?.id ?? master.paragraphs[0].id)
  const [body, setBody] = useState('')
  const [quote, setQuote] = useState('')
  const [editorOpen, setEditorOpen] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [resetOpen, setResetOpen] = useState(false)

  const queueCount = draft.queue.reduce((sum, batch) => sum + batch.memberIds.length, 0)
  const pendingConflicts = draft.conflicts.filter((c) => !c.resolution)
  const mergedCount = master.annotations.length

  const memberCount = (batch: PendingBatch) => batch.memberIds.length

  const submitAnnotation = () => {
    if (!body.trim()) { message.warning('请先填写批注内容'); return }
    addAnnotation({ paragraphId, body, quote })
    setBody(''); setQuote('')
    message.success('批注已存入离线稿，同段落再次批注会并为一批')
  }

  const openEditorModal = (paragraph: MasterParagraph) => {
    setEditorOpen(paragraph.id)
    setEditText(paragraph.text)
  }
  const submitEditorEdit = () => {
    if (editorOpen) {
      touchMasterParagraph(editorOpen, editText.trim())
      const rev = master.paragraphs.find((p) => p.id === editorOpen)?.rev
      message.success(`编辑部已改正文，段落修订号将推进到 ${(rev ?? 0) + 1}`)
    }
    setEditorOpen(null)
  }

  const runSync = async () => {
    if (needsUpgrade) { message.warning('旧批注稿还没补修订号，请先升级'); return }
    await syncNow()
    const r = useSyncStore.getState().report
    if (r) {
      if (r.merged.length) message.success(`已并入 ${r.merged.length} 批，段落修订号已推进`)
      if (r.conflicts.length) message.warning(`${r.conflicts.length} 批段落被编辑部动过，已挂起待编辑定夺`)
      if (r.failed.length) message.error(`${r.failed.length} 批未送达，已留在队列重试`)
    }
  }

  const selectedParagraph = master.paragraphs.find((p) => p.id === paragraphId)

  return (
    <Drawer
      title={<span><CloudSyncOutlined /> 离线批注对账台 · {master.paperId}</span>}
      width={1180} open={open} onClose={onClose} destroyOnClose
      extra={<Space>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => setResetOpen(true)}>重置演示</Button>
      </Space>}
    >
      {needsUpgrade && (
        <Alert
          type="warning" showIcon icon={<SafetyOutlined />} style={{ marginBottom: 16 }}
          message="检测到旧版批注稿：批注没有段落修订号"
          description={
            <Space direction="vertical" size={4}>
              <span>旧稿中的 {draft.annotations.filter((a) => a.baseRev === undefined).length} 条离线批注在升级前不能对账。升级会按合订稿当前版本把修订号补上，再进入待同步队列。</span>
              <Button size="small" type="primary" icon={<SafetyOutlined />} onClick={upgradeLegacy}>按合订稿现版本补上修订号</Button>
            </Space>
          }
        />
      )}

      <div className="sync-stats">
        <Card size="small"><Statistic title="合订稿段落" value={master.paragraphs.length} prefix={<CloudServerOutlined />} /></Card>
        <Card size="small"><Statistic title="已并入批注" value={mergedCount} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#3f8600' }} /></Card>
        <Card size="small"><Statistic title="待同步批注" value={queueCount} prefix={<ClockCircleOutlined />} valueStyle={{ color: queueCount ? '#d48806' : undefined }} /></Card>
        <Card size="small"><Statistic title="待编辑定夺" value={pendingConflicts.length} prefix={<WarningOutlined />} valueStyle={{ color: pendingConflicts.length ? '#cf1322' : undefined }} /></Card>
      </div>

      <div className="sync-controls">
        <Space wrap size="large">
          <span className="control-block">
            <Text strong>模拟断网率</Text>
            <Slider style={{ width: 140, margin: '0 10px' }} min={0} max={1} step={0.1}
              value={failureRate} onChange={setFailureRate} disabled={syncing}
              tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }} />
          </span>
          <Tooltip title="首条待发批次“版本库已并入但回执丢失”，再点对账可验证不会重复并入">
            <Checkbox checked={swallowNext} onChange={(e) => setSwallowNext(e.target.checked)} disabled={syncing || !draft.queue.length}>
              模拟回执丢失（验证幂等重试）
            </Checkbox>
          </Tooltip>
          <Button type="primary" size="large" icon={<ApiOutlined />} loading={syncing}
            disabled={needsUpgrade || !draft.queue.length} onClick={() => void runSync()}>
            {syncing ? '对账中…' : '回网：按段落修订号对账'}
          </Button>
          {draft.lastPulledAt && <Text type="secondary" className="pulled-at">最近刷新 {formatTime(draft.lastPulledAt)}</Text>}
        </Space>
      </div>

      {report && (
        <Alert
          style={{ margin: '12px 0 16px' }} type={report.failed.length || report.conflicts.length ? 'warning' : 'success'} showIcon
          message={`对账完成：并入 ${report.merged.length} 批 · 冲突待决 ${report.conflicts.length} 批 · 未送达 ${report.failed.length} 批`}
          description={
            <Space direction="vertical" size={2}>
              {report.merged.map((item) => (
                <span key={item.batchId}><Tag color="green">并入</Tag>段落 {item.paragraphId} 修订号 {item.masterRevBefore} → {item.masterRevAfter}</span>
              ))}
              {report.conflicts.map((item) => {
                const conflict = draft.conflicts.find((c) => c.batchId === item.batchId)
                return <span key={item.batchId}><Tag color="volcano">冲突</Tag>段落 {item.paragraphId} 合订稿已到 rev {item.masterRevAfter}，离线依据 rev {conflict?.offlineBaseRev}，两边均保留</span>
              })}
              {report.failed.map((item) => (
                <span key={item.batchId}><Tag color="red">未送达</Tag>批次 {item.batchId.slice(-6)}（{item.error}），仍留在队列</span>
              ))}
            </Space>
          }
        />
      )}

      <div className="sync-grid">
        {/* 左：编辑部版本库 */}
        <Card
          size="small" className="sync-col"
          title={<span><CloudServerOutlined /> 编辑部版本库（合订稿）</span>}
          extra={<Tooltip title="编辑部改正文会推进该段修订号；此时离线批注对账即冲突，批注稿不会盖住合订稿"><Tag>改正文可造冲突</Tag></Tooltip>}
        >
          <div className="paragraph-rev-list">
            {master.paragraphs.map((paragraph) => {
              const attached = master.annotations.filter((a) => a.paragraphId === paragraph.id)
              return (
                <div key={paragraph.id} className="rev-row">
                  <div className="rev-row-head">
                    <Tag color="blue">rev {paragraph.rev}</Tag>
                    <b>{paragraph.number} {paragraph.section}</b>
                    {!!attached.length && <Badge count={`${attached.length} 批注`} showZero color="#3f8600" style={{ marginLeft: 'auto' }} />}
                    <Button size="small" type="link" onClick={() => openEditorModal(paragraph)}>编辑部修改</Button>
                  </div>
                  <p className="rev-text">{paragraph.text}</p>
                </div>
              )
            })}
          </div>
        </Card>

        {/* 中：审稿人离线稿 */}
        <Card
          size="small" className="sync-col"
          title={<span><CommentOutlined /> {draft.reviewer}的离线批注稿</span>}
          extra={<Badge count={`队列 ${draft.queue.length} 批 / ${queueCount} 条`} showZero color={queueCount ? 'd48806' : 'd9d9d9'} />}
        >
          <div className="offline-composer">
            <Select size="small" style={{ width: '100%' }} value={paragraphId} onChange={setParagraphId}
              options={master.paragraphs.map((p) => ({ value: p.id, label: `${p.number} · rev ${p.rev} · ${p.text.slice(0, 16)}…` }))} />
            <Input.TextArea size="small" placeholder="引用片段（可留空，默认整段引用）" value={quote} onChange={(e) => setQuote(e.target.value)} autoSize={{ minRows: 1, maxRows: 2 }} />
            <Input.TextArea size="small" placeholder="离线批注内容…（同一段落多写几条，发送时自动并成一条）" value={body} onChange={(e) => setBody(e.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} />
            <Button size="small" type="dashed" block icon={<ThunderboltOutlined />} onClick={submitAnnotation}>
              离线写下批注（依据 rev {selectedParagraph?.rev}）
            </Button>
          </div>

          <Divider style={{ margin: '10px 0' }} orientation="left" plain>待同步队列（先合并再送出）</Divider>
          {!draft.queue.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="队列已清空" />}
          {draft.queue.map((batch) => {
            const paragraph = master.paragraphs.find((p) => p.id === batch.paragraphId)
            const members = batch.memberIds
              .map((id) => draft.annotations.find((a) => a.id === id))
              .filter(Boolean)
            const stale = paragraph && batch.baseRev !== undefined && paragraph.rev !== batch.baseRev
            return (
              <Card key={batch.id} size="small" className={`queue-batch ${batch.lastError ? 'has-error' : ''}`}>
                <div className="rev-row-head">
                  <Tag>批次 {batch.id.slice(-5)}</Tag>
                  <b>段落 {paragraph?.number}</b>
                  <Tag color={stale ? 'volcano' : 'default'}>依据 rev {batch.baseRev ?? '?'}</Tag>
                  <Tag color="blue">合订稿 rev {paragraph?.rev}</Tag>
                  {!!batch.attempts && <Tag icon={<RetweetOutlined />} color={batch.lastError ? 'red' : 'green'}>重试 {batch.attempts}</Tag>}
                </div>
                <div className="batch-members">
                  <Tag color="purple">{memberCount(batch)} 条已并为一条</Tag>
                  {members.map((m) => (
                    <div key={m!.id} className="batch-member">“{m!.quote}” — {m!.body}</div>
                  ))}
                </div>
                {batch.lastError && <Alert type="error" showIcon style={{ marginTop: 6, padding: '4px 8px' }} message={batch.lastError} />}
              </Card>
            )
          })}

          <Divider style={{ margin: '10px 0' }} orientation="left" plain>全部批注</Divider>
          <div className="offline-all">
            {draft.annotations.map((a) => {
              const state = annotationState(a)
              return (
                <div key={a.id} className="offline-item">
                  <div><Tag>{master.paragraphs.find((p) => p.id === a.paragraphId)?.number}</Tag>“{a.quote}”</div>
                  <div className="offline-item-body">{a.body}</div>
                  <Tag color={state.color}>{state.text}</Tag>
                  <Text type="secondary"> baseRev {a.baseRev ?? '未升级'}</Text>
                </div>
              )
            })}
            {!draft.annotations.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有离线批注" />}
          </div>
        </Card>

        {/* 右：冲突定夺 */}
        <Card
          size="small" className="sync-col"
          title={<span><ExclamationCircleOutlined /> 编辑定夺台</span>}
          extra={<Badge count={pendingConflicts.length} showZero color={pendingConflicts.length ? '#cf1322' : '#d9d9d9'} />}
        >
          {!draft.conflicts.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有冲突：合订稿段落没动过的批注会直接并入" />}
          {draft.conflicts.map((conflict) => (
            <ConflictCard key={conflict.batchId} conflict={conflict}
              masterText={master.paragraphs.find((p) => p.id === conflict.paragraphId)?.text ?? ''}
              masterRev={master.paragraphs.find((p) => p.id === conflict.paragraphId)?.rev ?? 0}
              onDecide={(d) => decide(conflict.batchId, d)} />
          ))}
        </Card>
      </div>

      <Modal
        title="编辑部修改合订稿正文"
        open={editorOpen !== null}
        onCancel={() => setEditorOpen(null)}
        onOk={submitEditorEdit}
        okText="保存并推进修订号"
      >
        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
          保存后该段修订号 +1。审稿人离线时若依据的是旧修订号，回网对账时两边都保留、由你定夺，批注不会盖住合订稿。
        </Paragraph>
        <Input.TextArea rows={5} value={editText} onChange={(e) => setEditText(e.target.value)} />
      </Modal>

      <Modal title="重置离线对账演示" open={resetOpen} onCancel={() => setResetOpen(false)}
        onOk={() => { reset(); setResetOpen(false); message.success('已恢复：含一份无修订号的旧批注稿') }} okText="重置" okButtonProps={{ danger: true }}>
        将清空版本库与离线稿，恢复到初始状态（含一份待升级的旧批注稿）。
      </Modal>
    </Drawer>
  )
}

function ConflictCard({ conflict, masterText, masterRev, onDecide }: {
  conflict: SyncConflict
  masterText: string
  masterRev: number
  onDecide: (decision: 'attach' | 'discard') => void
}) {
  const resolved = conflict.resolution
  return (
    <Card size="small" className={`conflict-card ${resolved ? 'resolved' : ''}`} style={{ marginBottom: 10 }}>
      <div className="rev-row-head">
        <Tag color="volcano">冲突</Tag>
        <b>段落 {conflict.paragraphId}</b>
        <Tag>离线依据 rev {conflict.offlineBaseRev}</Tag>
        <Tag color="blue">合订稿 rev {masterRev}</Tag>
        {resolved && <Tag color={resolved === 'attached' ? 'green' : 'default'}>
          {resolved === 'attached' ? '已并入' : '已丢弃'} · {formatTime(conflict.resolvedAt)}
        </Tag>}
      </div>
      <div className="conflict-sides">
        <div className="conflict-side master-side">
          <small>合订稿现版（不动正文）</small>
          <p>{masterText}</p>
        </div>
        <div className="conflict-side offline-side">
          <small>离线引用片段</small>
          <p>“{conflict.offlineQuote}”</p>
          <small>已合并的批注（{conflict.memberIds.length} 条并为一条）</small>
          <pre>{conflict.mergedBody}</pre>
        </div>
      </div>
      {!resolved && (
        <Space style={{ marginTop: 8 }}>
          <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={() => onDecide('attach')}>
            以现版为准并入批注（rev {masterRev} → {masterRev + 1}）
          </Button>
          <Button size="small" danger icon={<ReloadOutlined />} onClick={() => onDecide('discard')}>
            丢弃批注，保留合订稿
          </Button>
        </Space>
      )}
    </Card>
  )
}

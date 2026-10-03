import type { Paragraph } from '../types'

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export interface RemotePatch {
  accepted: boolean
  paragraphId: string
  remoteText: string
  remoteAuthor: string
  serverRevision: number
}

export const submitRemotePatch = async (paragraph: Paragraph): Promise<RemotePatch> => {
  await wait(650)
  const remoteText = paragraph.text.includes('然而')
    ? paragraph.text.replace('然而', '但是')
    : `${paragraph.text.replace(/。$/, '')}。作者补充：该结论仅适用于本次样本。`
  return {
    accepted: true,
    paragraphId: paragraph.id,
    remoteText,
    remoteAuthor: '协作者 · 王教授',
    serverRevision: Math.floor(Date.now() / 1000),
  }
}

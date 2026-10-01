/** Sketch 草图 */
export interface Sketch {
  id: string
  segmentId: string
  /** 草图编号 */
  code: string
  /** 坐标纸格数 */
  gridCount: number
  /** 缩放比例（1:N 的 N，如 200 表示 1:200） */
  scale: number
  /** 绘制人 */
  author: string
  /** 图幅拼合顺序号 */
  mergeOrder: number
  /** 桩号对齐锚点 */
  anchorStake: string
  /** 图片数据说明 */
  imageNote: string
}

/** 图幅确认状态：pending 待核（对账中/待制图组确认）/ confirmed 已确认入正式拼合 */
export type SheetStatus = 'pending' | 'confirmed'

/** 图幅来源：legacy 旧版数据升级转入的初始图幅 / manual 制图组新建 */
export type SheetSource = 'legacy' | 'manual'

/**
 * Sheet 图幅：制图侧的拼合成果，独立于测量侧桩号数据。
 * 测量组复测改动洞段桩号只落 segments 表；制图侧的偏移、吸附、确认状态只落本表，
 * 两侧互不写对方的字段。对账时以快照形式记录拼合所依据的桩号，
 * 桩号漂移或长度对不上的图幅留在 pending 待核，由制图组逐张确认。
 */
export interface Sheet {
  id: string
  caveId: string
  sketchId: string
  /** 来源：legacy 旧版升级转入 / manual 新建 */
  source: SheetSource
  /** 拼合横向偏移（px） */
  offset: number
  /** 是否吸附到相邻图幅边缘 */
  snapped: boolean
  /** 待核 / 已确认入正式拼合 */
  status: SheetStatus
  /** 对账快照：拼合时依据的草图锚点桩号（制图侧） */
  anchorStakeSnapshot: string
  /** 对账快照：拼合时依据的测量侧洞段起讫桩号 */
  segmentStartSnapshot: string
  segmentEndSnapshot: string
  /** 最近一次对账失败原因（空串 = 通过） */
  mismatchReason: string
  /** 已确认图幅的快照是否已落后于测量侧当前桩号（仅提示，不自动回退） */
  stale: boolean
  /** 确认入正式拼合的时间（ISO 字符串），未确认则为 null */
  confirmedAt: string | null
  createdAt: string
}

/** 图幅拼合对齐结果（轻量结构，落库时使用 Sheet） */
export interface MergeItem {
  sketchId: string
  /** 对齐后的横向偏移（单位：格） */
  offset: number
  /** 是否已吸附到锚点 */
  snapped: boolean
}

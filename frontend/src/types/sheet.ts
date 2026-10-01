/** 图幅状态：待核（含升级产生的待确认初始图幅）/ 已认过（正式拼合） */
export type SheetStatus = 'pending' | 'confirmed'

/** 图幅对账不上的条目 */
export interface SheetIssue {
  /** 对账维度：桩号 / 洞段长度 */
  kind: 'stake' | 'length'
  /** 制图侧（本侧）当前值说明 */
  sideText: string
  /** 测量侧（对侧）新桩号推算值说明 */
  otherText: string
  /** 差值（米） */
  delta: number
  message: string
}

/**
 * MapSheet 制图组图幅（制图侧自持，不与测量侧洞段记录共享字段）。
 * 测量组复测挪动洞段起止桩号时，只更新测量侧；这里的桩号快照/偏移/吸附
 * 由制图组按新桩号重新对账后自行认账，任一侧改动只落在本侧。
 */
export interface MapSheet {
  id: string
  caveId: string
  /** 图幅编号，如 T-01 */
  code: string
  /** 归属洞段（制图组登记，便于对账时定位测量侧洞段） */
  segmentId: string
  /** 归入本图幅的草图 id 列表（旧草图不丢，只改归属） */
  sketchIds: string[]

  // —— 以下为制图侧自持的拼合依据，测量侧改桩号不会回写此处 ——
  /** 制图侧存底的起点桩号（旧桩号 / 认账后更新为新桩号） */
  startStake: string
  /** 制图侧存底的止点桩号 */
  endStake: string
  /** 对齐后的横向偏移（单位：px，沿用拼合台画布约定） */
  offset: number
  /** 是否已吸附到桩号锚点 */
  snapped: boolean
  /** 正式拼合顺序号 */
  mergeOrder: number

  /** 待核 / 已认过；只有已认过的图幅才进正式拼合 */
  status: SheetStatus
  /** 待核原因：对账不上时逐条留底；制图组强制认账时保留留痕 */
  issues: SheetIssue[]

  /** 升级迁移标记：旧数据没有拼合记录，归入一张待确认初始图幅 */
  isLegacyInitial: boolean
  /** 认图制图人（逐张认账留名） */
  acknowledgedBy: string
  /** 认图时间（ISO） */
  acknowledgedAt: string
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
}

export type MapSheetDraft = Omit<
  MapSheet,
  'id' | 'status' | 'issues' | 'isLegacyInitial' | 'acknowledgedBy' | 'acknowledgedAt' | 'createdAt' | 'updatedAt'
>

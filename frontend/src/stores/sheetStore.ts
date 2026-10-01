import { createStore } from 'zustand/vanilla'
import type { Sheet } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'
import { PX_PER_METER, reconcileSheet } from '@/utils/reconcile'
import { stakeToNumber } from '@/utils/survey'

export interface SheetState {
  sheets: Sheet[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (sheet: Sheet) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 按测量侧当前桩号对某洞穴的图幅重新对账：待核图幅更新对账结果与快照，已确认图幅只标记落后、不回退 */
  reconcileAll: (caveId: string) => Promise<void>
  /** 对账失败后按制图组这侧重来：按当前桩号重算拼合偏移并吸附，快照刷新为新桩号，状态仍待制图组确认 */
  resetFromMappingSide: (sheetId: string) => Promise<void>
  /** 逐张确认入正式拼合（认过的图幅不随对账回退） */
  confirm: (sheetId: string) => Promise<void>
  /** 制图组主动撤销确认（非对账回退） */
  unconfirm: (sheetId: string) => Promise<void>
}

export const sheetStore = createStore<SheetState>((set, get) => ({
  sheets: [],
  loaded: false,
  hydrate: async () => {
    const sheets = await syncAll<Sheet>(db.sheets)
    set({ sheets, loaded: true })
  },
  save: async (sheet) => {
    await syncPut<Sheet>(db.sheets, sheet)
    await get().hydrate()
  },
  remove: async (id) => {
    await db.sheets.delete(id)
    await get().hydrate()
  },
  reconcileAll: async (caveId) => {
    const [sheets, sketches, segments] = await Promise.all([
      db.sheets.where('caveId').equals(caveId).toArray(),
      db.sketches.toArray(),
      db.segments.toArray()
    ])
    for (const sheet of sheets) {
      const sketch = sketches.find((item) => item.id === sheet.sketchId)
      const segment = segments.find((item) => item.id === sketch?.segmentId)
      const result = reconcileSheet(sheet, sketch, segment)
      if (sheet.status === 'pending') {
        // 待核图幅：对账结果落在本侧，快照按新桩号刷新；对不上的写明原因，仍留待核
        sheet.mismatchReason = result.ok ? '' : result.reason
        sheet.anchorStakeSnapshot = sketch?.anchorStake ?? ''
        sheet.segmentStartSnapshot = segment?.startStake ?? ''
        sheet.segmentEndSnapshot = segment?.endStake ?? ''
        sheet.stale = false
      } else {
        // 已确认图幅：认过不回退、不改状态，仅标记快照是否已落后于测量侧
        sheet.stale = result.stale
      }
      await syncPut<Sheet>(db.sheets, sheet)
    }
    await get().hydrate()
  },
  resetFromMappingSide: async (sheetId) => {
    const sheet = get().sheets.find((item) => item.id === sheetId)
    if (!sheet) return
    const [sketches, segments] = await Promise.all([db.sketches.toArray(), db.segments.toArray()])
    const sketch = sketches.find((item) => item.id === sheet.sketchId)
    if (!sketch) return
    // 以该洞穴全部待核图幅的最小锚点桩号为原点，按新桩号差重算拼合偏移
    const siblings = get().sheets.filter(
      (item) => item.caveId === sheet.caveId && item.status === 'pending' && item.id !== sheetId
    )
    const base = Math.min(
      ...[...siblings, sheet].map((item) => {
        const target = sketches.find((sk) => sk.id === item.sketchId)
        return stakeToNumber(target?.anchorStake ?? '')
      })
    )
    sheet.offset = Math.round((stakeToNumber(sketch.anchorStake) - base) * PX_PER_METER)
    sheet.snapped = true
    const segment = segments.find((item) => item.id === sketch.segmentId)
    // 先把快照刷新为当前桩号（重来即按新桩号重算），再对账：
    // 桩号漂移随之消解，只保留锚点越界、长度不符等真实对不上的项
    sheet.anchorStakeSnapshot = sketch.anchorStake
    sheet.segmentStartSnapshot = segment?.startStake ?? ''
    sheet.segmentEndSnapshot = segment?.endStake ?? ''
    const result = reconcileSheet(sheet, sketch, segment)
    sheet.mismatchReason = result.ok ? '' : result.reason
    sheet.stale = false
    await syncPut<Sheet>(db.sheets, sheet)
    await get().hydrate()
  },
  confirm: async (sheetId) => {
    const sheet = get().sheets.find((item) => item.id === sheetId)
    if (!sheet || sheet.status !== 'pending') return
    sheet.status = 'confirmed'
    sheet.confirmedAt = new Date().toISOString()
    sheet.mismatchReason = ''
    await syncPut<Sheet>(db.sheets, sheet)
    await get().hydrate()
  },
  unconfirm: async (sheetId) => {
    const sheet = get().sheets.find((item) => item.id === sheetId)
    if (!sheet || sheet.status !== 'confirmed') return
    sheet.status = 'pending'
    sheet.confirmedAt = null
    await syncPut<Sheet>(db.sheets, sheet)
    await get().hydrate()
  }
}))

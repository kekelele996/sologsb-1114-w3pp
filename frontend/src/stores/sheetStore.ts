import { createStore } from 'zustand/vanilla'
import type { MapSheet, Segment, SheetIssue } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { reconcileSheets } from '@/utils/reconcile'

export interface SheetState {
  sheets: MapSheet[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (sheet: MapSheet) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 图幅里的草图被删除后，从本侧归属列表中摘掉（只动制图侧，不删草图以外的东西） */
  detachSketch: (sketchId: string) => Promise<void>
  /** 调整正式拼合顺序（只动制图侧本侧） */
  reorder: (orderedIds: string[]) => Promise<void>

  /**
   * 按测量侧新桩号重新对账：只处理待核图幅，对不上的留在待核并写回 issue；
   * 已认过的图幅绝不跟着回退。返回本次对账结果统计。
   */
  reconcile: (segments: Segment[]) => Promise<{ updated: number; matched: number; mismatch: number }>
  /** 认用新桩号：用测量侧洞段桩号覆盖本侧存底，吸附偏移由调用方给入 */
  adoptSurvey: (
    sheetId: string,
    patch: { startStake: string; endStake: string; offset: number; snapped: boolean }
  ) => Promise<void>
  /** 制图组逐张认过：无论是否对得上，以制图侧这张为准进入正式拼合；保留留痕 */
  acknowledge: (sheetId: string, by: string, issues: SheetIssue[]) => Promise<void>
  /** 撤销认账（制图组主动操作才允许，对账永不自动回退） */
  unacknowledge: (sheetId: string) => Promise<void>
}

function touch(sheet: MapSheet): MapSheet {
  return { ...sheet, updatedAt: new Date().toISOString() }
}

export const sheetStore = createStore<SheetState>((set, get) => ({
  sheets: [],
  loaded: false,
  hydrate: async () => {
    const sheets = await syncAll<MapSheet>(db.sheets)
    sheets.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
      return a.mergeOrder - b.mergeOrder
    })
    set({ sheets, loaded: true })
  },
  save: async (sheet) => {
    await syncPut<MapSheet>(db.sheets, touch(sheet))
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete(db.sheets, id)
    await get().hydrate()
  },
  detachSketch: async (sketchId) => {
    await Promise.all(
      get()
        .sheets.filter((sheet) => sheet.sketchIds.includes(sketchId))
        .map((sheet) => syncPut<MapSheet>(db.sheets, touch({ ...sheet, sketchIds: sheet.sketchIds.filter((id) => id !== sketchId) })))
    )
    await get().hydrate()
  },
  reorder: async (orderedIds) => {
    const all = get().sheets
    await Promise.all(
      orderedIds.map((id, index) => {
        const target = all.find((item) => item.id === id)
        return target ? syncPut<MapSheet>(db.sheets, touch({ ...target, mergeOrder: index + 1 })) : Promise.resolve()
      })
    )
    await get().hydrate()
  },

  reconcile: async (segments) => {
    const pending = get().sheets.filter((sheet) => sheet.status === 'pending')
    const results = reconcileSheets(pending, segments)
    let matched = 0
    let mismatch = 0
    await Promise.all(
      results.map((result) => {
        const target = get().sheets.find((sheet) => sheet.id === result.sheetId)
        if (!target) return Promise.resolve()
        if (result.matched) matched += 1
        else mismatch += 1
        // 只把对账结论写回待核图幅；confirmed 图幅压根不在本批，天然不回退
        return syncPut<MapSheet>(db.sheets, touch({ ...target, issues: result.issues }))
      })
    )
    await get().hydrate()
    return { updated: pending.length, matched, mismatch }
  },
  adoptSurvey: async (sheetId, patch) => {
    const target = get().sheets.find((sheet) => sheet.id === sheetId)
    if (!target) return
    await syncPut<MapSheet>(
      db.sheets,
      touch({
        ...target,
        startStake: patch.startStake,
        endStake: patch.endStake,
        offset: patch.offset,
        snapped: patch.snapped,
        issues: []
      })
    )
    await get().hydrate()
  },
  acknowledge: async (sheetId, by, issues) => {
    const target = get().sheets.find((sheet) => sheet.id === sheetId)
    if (!target) return
    const now = new Date().toISOString()
    await syncPut<MapSheet>(
      db.sheets,
      touch({
        ...target,
        status: 'confirmed',
        issues,
        acknowledgedBy: by.trim(),
        acknowledgedAt: now
      })
    )
    await get().hydrate()
  },
  unacknowledge: async (sheetId) => {
    const target = get().sheets.find((sheet) => sheet.id === sheetId)
    if (!target) return
    await syncPut<MapSheet>(
      db.sheets,
      touch({ ...target, status: 'pending', acknowledgedBy: '', acknowledgedAt: '' })
    )
    await get().hydrate()
  }
}))

import { createStore } from 'zustand/vanilla'
import type { Sketch } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { sheetStore } from '@/stores/sheetStore'

export interface SketchState {
  sketches: Sketch[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (sketch: Sketch) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    sketches.sort((a, b) => a.mergeOrder - b.mergeOrder)
    set({ sketches, loaded: true })
  },
  save: async (sketch) => {
    await syncPut<Sketch>(db.sketches, sketch)
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete(db.sketches, id)
    // 制图侧图幅依附草图存在，草图删除时连带清理对应图幅
    await db.sheets.where('sketchId').equals(id).delete()
    await Promise.all([get().hydrate(), sheetStore.getState().hydrate()])
  },
  reorder: async (orderedIds) => {
    const all = get().sketches
    await Promise.all(
      orderedIds.map((id, index) => {
        const target = all.find((item) => item.id === id)
        return target ? syncPut<Sketch>(db.sketches, { ...target, mergeOrder: index + 1 }) : Promise.resolve()
      })
    )
    await get().hydrate()
  }
}))

import { onUnmounted, reactive } from 'vue'
import type { StoreApi } from 'zustand/vanilla'
import Dexie, { type Table } from 'dexie'
import type { Cave, MapSheet, Segment, Sketch, Station } from '@/types'
import { computeHorizontal, computeVertical, stakeToNumber } from '@/utils/survey'

/** IndexedDB 数据结构版本号（升级迁移时使用） */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：洞穴 / 洞段 / 测点 / 草图（测量侧 + 原始草图）/ 图幅（制图侧）+ 元数据表 */
class CaveSurveyDb extends Dexie {
  caves!: Table<Cave, string>
  segments!: Table<Segment, string>
  stations!: Table<Station, string>
  sketches!: Table<Sketch, string>
  sheets!: Table<MapSheet, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbcavesurvey')
    this.version(1).stores({
      caves: 'id, name, region',
      segments: 'id, caveId, code',
      stations: 'id, segmentId, code',
      sketches: 'id, segmentId, code',
      meta: 'key'
    })
    // v2：旧版测点记录缺少水平距/垂距，迁移时由斜距 + 倾角补齐
    this.version(2)
      .stores({
        caves: 'id, name, region, archived',
        segments: 'id, caveId, code, type',
        stations: 'id, segmentId, code, date',
        sketches: 'id, segmentId, code, mergeOrder',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Station, string>('stations')
          .toCollection()
          .modify((station) => {
            if (!Number.isFinite(station.horizontalDistance)) {
              station.horizontalDistance = computeHorizontal(station.dip, station.slopeDistance)
            }
            if (!Number.isFinite(station.verticalDistance)) {
              station.verticalDistance = computeVertical(station.dip, station.slopeDistance)
            }
          })
      })
    // v3：新增制图侧自持的「图幅」表。旧数据没有拼合记录，
    // 把每张洞穴下的旧草图归到一张待确认的初始图幅里，草图原记录保留不丢。
    this.version(SCHEMA_VERSION)
      .stores({
        caves: 'id, name, region, archived',
        segments: 'id, caveId, code, type',
        stations: 'id, segmentId, code, date',
        sketches: 'id, segmentId, code, mergeOrder',
        sheets: 'id, caveId, segmentId, status, mergeOrder',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        const [segments, sketches] = await Promise.all([
          tx.table<Segment, string>('segments').toArray(),
          tx.table<Sketch, string>('sketches').toArray()
        ])
        const groups = new Map<string, Sketch[]>()
        for (const sketch of sketches) {
          const segment = segments.find((item) => item.id === sketch.segmentId)
          const caveId = segment?.caveId ?? '__legacy_orphan__'
          groups.set(caveId, [...(groups.get(caveId) ?? []), sketch])
        }

        const now = new Date().toISOString()
        let order = 0
        const legacySheets: MapSheet[] = []
        for (const [caveId, grouped] of groups) {
          order += 1
          const ordered = [...grouped].sort((a, b) => a.mergeOrder - b.mergeOrder)
          const anchorValues = ordered.map((sketch) => stakeToNumber(sketch.anchorStake))
          const start = Math.min(...anchorValues)
          const end = Math.max(...anchorValues)
          legacySheets.push({
            id: `sheet_legacy_${caveId === '__legacy_orphan__' ? 'orphan' : caveId}`,
            caveId: caveId === '__legacy_orphan__' ? '' : caveId,
            code: `初始图幅-${String(order).padStart(2, '0')}`,
            segmentId: ordered[0]?.segmentId ?? '',
            sketchIds: ordered.map((sketch) => sketch.id),
            // 旧草图只登记了锚点，起止桩号以锚点最小/最大值兜底存底，交给制图组认账
            startStake: anchorToStake(start),
            endStake: anchorToStake(end),
            offset: 0,
            snapped: false,
            mergeOrder: order,
            status: 'pending',
            issues: [],
            isLegacyInitial: true,
            acknowledgedBy: '',
            acknowledgedAt: '',
            note: '由旧版草图自动归入的待确认初始图幅，需制图组逐张认过后才进正式拼合',
            createdAt: now,
            updatedAt: now
          })
        }
        if (legacySheets.length > 0) {
          await tx.table<MapSheet, string>('sheets').bulkPut(legacySheets)
        }
      })
  }
}

/** 旧草图锚点数值回写成桩号文本（Kx+xxx） */
function anchorToStake(value: number): string {
  const km = Math.floor(Math.max(0, value) / 1000)
  const m = Math.max(0, value) % 1000
  return `K${km}+${String(Math.floor(m)).padStart(3, '0')}`
}


export const db = new CaveSurveyDb()

/** 记录当前数据结构版本号，便于后续升级判断 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取表内全部记录 */
export async function syncAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入（新增或更新）一条记录 */
export async function syncPut<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function syncDelete<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** 按条件统计记录数 */
export async function countBy<T extends object>(table: Table<T, string>, predicate: (row: T) => boolean): Promise<number> {
  const rows = await table.toArray()
  return rows.filter(predicate).length
}

/**
 * 把 Zustand 的 vanilla store 桥接到 Vue 响应式状态。
 * store 变化时同步到 reactive 对象，组件卸载时取消订阅。
 */
export function useStore<T extends object>(store: StoreApi<T>): T {
  const state = reactive({ ...store.getState() }) as T
  const unsubscribe = store.subscribe((next: T) => {
    Object.assign(state, next)
  })
  onUnmounted(() => unsubscribe())
  return state
}

/**
 * 首次打开时写入一套示例洞穴数据，保证各页面进入即有事可做。
 * 只在四张表都为空时执行一次。
 */
export async function seedDemoData(): Promise<void> {
  const caveCount = await db.caves.count()
  if (caveCount > 0) return

  const caveId = 'cave_demo_001'
  const segmentA = 'seg_demo_001'
  const segmentB = 'seg_demo_002'

  const today = new Date().toISOString().slice(0, 10)

  await db.caves.put({
    id: caveId,
    name: '青龙背斜溶洞',
    region: '黔南州 · 平塘县',
    longitude: 107.2136,
    latitude: 25.8123,
    altitude: 986.4,
    layer: '二叠系下统栖霞组灰岩',
    knownLength: 195,
    startDate: today,
    surveyor: '陆昀',
    climateNote: '洞内 16.2℃，相对湿度 94%，中段有滴水',
    archived: false,
    createdAt: new Date().toISOString()
  })

  await db.segments.bulkPut([
    {
      id: segmentA,
      caveId,
      code: 'C-01',
      startStake: 'K0+000',
      endStake: 'K0+120',
      type: '廊道',
      avgWidth: 2.4,
      avgHeight: 3.1,
      slopeTrend: '缓升 3°',
      closed: false,
      sketchNo: 'S-01'
    },
    {
      id: segmentB,
      caveId,
      code: 'C-02',
      startStake: 'K0+120',
      endStake: 'K0+195',
      type: '竖井',
      avgWidth: 1.6,
      avgHeight: 12.5,
      slopeTrend: '陡降 68°',
      closed: true,
      sketchNo: 'S-02'
    }
  ])

  await db.stations.bulkPut([
    {
      id: 'st_demo_001',
      segmentId: segmentA,
      code: 'P1',
      bearing: 118.5,
      dip: -2.5,
      slopeDistance: 12.4,
      horizontalDistance: computeHorizontal(-2.5, 12.4),
      verticalDistance: computeVertical(-2.5, 12.4),
      instrumentNo: 'SOKKIA-2',
      surveyor: '陆昀',
      date: today,
      isClosurePoint: false,
      note: '入口段，左壁有崩塌堆积'
    },
    {
      id: 'st_demo_002',
      segmentId: segmentA,
      code: 'P2',
      bearing: 121.2,
      dip: -1.8,
      slopeDistance: 15.8,
      horizontalDistance: computeHorizontal(-1.8, 15.8),
      verticalDistance: computeVertical(-1.8, 15.8),
      instrumentNo: 'SOKKIA-2',
      surveyor: '陆昀',
      date: today,
      isClosurePoint: true,
      note: '本段末站，已与 C-02 起点核对'
    }
  ])

  await db.sketches.bulkPut([
    {
      id: 'sk_demo_001',
      segmentId: segmentA,
      code: 'S-01',
      gridCount: 48,
      scale: 200,
      author: '陆昀',
      mergeOrder: 1,
      anchorStake: 'K0+000',
      imageNote: '平面展开草图，坐标纸 48 格，含左壁支护标注'
    },
    {
      id: 'sk_demo_002',
      segmentId: segmentB,
      code: 'S-02',
      gridCount: 30,
      scale: 200,
      author: '覃羽',
      mergeOrder: 2,
      anchorStake: 'K0+120',
      imageNote: '竖井剖面草图，标注三处锚点'
    }
  ])

  // 制图侧两张图幅均已认过：自持桩号/偏移/吸附，测量侧再复测也不回退这两张
  const now = new Date().toISOString()
  await db.sheets.bulkPut([
    {
      id: 'sheet_demo_001',
      caveId,
      code: 'T-01',
      segmentId: segmentA,
      sketchIds: ['sk_demo_001'],
      startStake: 'K0+000',
      endStake: 'K0+120',
      offset: 0,
      snapped: true,
      mergeOrder: 1,
      status: 'confirmed',
      issues: [],
      isLegacyInitial: false,
      acknowledgedBy: '覃羽',
      acknowledgedAt: now,
      note: '入口廊道图幅',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'sheet_demo_002',
      caveId,
      code: 'T-02',
      segmentId: segmentB,
      sketchIds: ['sk_demo_002'],
      startStake: 'K0+120',
      endStake: 'K0+195',
      offset: Math.round(120 * 1.6),
      snapped: true,
      mergeOrder: 2,
      status: 'confirmed',
      issues: [],
      isLegacyInitial: false,
      acknowledgedBy: '覃羽',
      acknowledgedAt: now,
      note: '竖井剖面图幅',
      createdAt: now,
      updatedAt: now
    }
  ])
}

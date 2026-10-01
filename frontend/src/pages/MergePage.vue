<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { Sheet, Sketch } from '@/types'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import GridCanvas from '@/components/common/GridCanvas.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { sheetStore } from '@/stores/sheetStore'
import { downloadCsv } from '@/utils/export'
import {
  PX_PER_METER,
  reconcileLengths,
  reconcileSheet,
  sketchLengthMeters,
  type SheetReconcile
} from '@/utils/reconcile'
import { stakeToNumber } from '@/utils/survey'

const CANVAS_W = 780
const CANVAS_H = 300
const SNAP_PX = 12

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)
const sheetState = useStore(sheetStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const draggingId = ref<string | null>(null)
const dragStartX = ref(0)
const dragOriginOffset = ref(0)
const snapLog = ref<string[]>([])

/** 拼合偏移/吸附只落在制图侧图幅上，按 sheet.id 索引 */
const offsets = reactive<Record<string, number>>({})
const snapped = reactive<Record<string, boolean>>({})

const caveSegments = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)

const caveSheets = computed(() =>
  sheetState.sheets.filter((sheet) => sheet.caveId === selectedCaveId.value)
)

const pendingSheets = computed<Sheet[]>(() =>
  caveSheets.value
    .filter((sheet) => sheet.status === 'pending')
    .sort((a, b) => mergeOrderOf(a) - mergeOrderOf(b))
)

const confirmedSheets = computed<Sheet[]>(() =>
  caveSheets.value
    .filter((sheet) => sheet.status === 'confirmed')
    .sort((a, b) => mergeOrderOf(a) - mergeOrderOf(b))
)

/** 待核图幅（含关联草图），供拼合台拖动对齐 */
const pendingItems = computed(() =>
  pendingSheets.value
    .map((sheet) => ({ sheet, sketch: sketchOf(sheet) }))
    .filter((item): item is { sheet: Sheet; sketch: Sketch } => Boolean(item.sketch))
    .sort((a, b) => a.sketch.mergeOrder - b.sketch.mergeOrder)
)

function sketchOf(sheet: Sheet): Sketch | undefined {
  return sketchState.sketches.find((item) => item.id === sheet.sketchId)
}

function mergeOrderOf(sheet: Sheet): number {
  return sketchOf(sheet)?.mergeOrder ?? 0
}

function segmentOf(sheet: Sheet): string {
  const sketch = sketchOf(sheet)
  const segment = segmentState.segments.find((item) => item.id === sketch?.segmentId)
  return segment ? segment.code : '未归属'
}

function segmentNameOf(sheet: Sheet): string {
  const sketch = sketchOf(sheet)
  const segment = segmentState.segments.find((item) => item.id === sketch?.segmentId)
  return segment ? `${segment.code} ${segment.startStake} → ${segment.endStake}` : '—'
}

function widthOf(sketch: Sketch): number {
  return Math.max(88, Math.round(sketch.gridCount * (200 / Math.max(10, sketch.scale)) * 4))
}

/** 单张图幅实时对账（测量侧当前桩号 vs 拼合快照） */
function sheetCheck(sheet: Sheet): SheetReconcile {
  const sketch = sketchOf(sheet)
  const segment = segmentState.segments.find((item) => item.id === sketch?.segmentId)
  return reconcileSheet(sheet, sketch, segment)
}

const failedCount = computed(
  () => pendingSheets.value.filter((sheet) => !sheetCheck(sheet).ok).length
)

const totalWidth = computed(() =>
  pendingItems.value.reduce((sum, item) => sum + widthOf(item.sketch) + 10, 0)
)

/** 洞穴两侧总长对账：制图侧拼合总长 vs 测量侧实测总长 vs 已知总长 */
const lengthReconcile = computed(() => {
  const cave = caveState.caves.find((item) => item.id === selectedCaveId.value)
  return reconcileLengths(
    caveSegments.value,
    confirmedSheets.value,
    sketchState.sketches,
    cave?.knownLength ?? 0
  )
})

// IndexedDB 异步水合完成后自动选中第一条洞穴
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

// 图幅偏移以落库值为准初始化
watch(
  pendingItems,
  (list) => {
    list.forEach(({ sheet }) => {
      if (offsets[sheet.id] === undefined) offsets[sheet.id] = sheet.offset
      if (snapped[sheet.id] === undefined) snapped[sheet.id] = sheet.snapped
    })
  },
  { immediate: true }
)

/** 洞段测点闭合差（拼合视图复用闭合差徽标） */
const caveStations = computed(() =>
  stationState.stations.filter((station) =>
    caveSegments.value.some((segment) => segment.id === station.segmentId)
  )
)
const { result: closureResult } = useClosureCheck(caveStations)

async function persistSheet(sheet: Sheet, patch: Partial<Sheet>): Promise<void> {
  await sheetStore.getState().save({ ...sheet, ...patch })
}

/** 按桩号锚点自动吸附（仅待核图幅）：以最小锚点桩号为原点，按桩号差换算横向偏移 */
async function autoAlign(): Promise<void> {
  const list = pendingItems.value
  if (list.length === 0) {
    ElMessage.warning('当前洞穴暂无可拼合的待核图幅')
    return
  }
  const base = Math.min(...list.map(({ sketch }) => stakeToNumber(sketch.anchorStake)))
  const logs: string[] = []
  for (const { sheet, sketch } of list) {
    const stake = stakeToNumber(sketch.anchorStake)
    const target = Math.round((stake - base) * PX_PER_METER)
    offsets[sheet.id] = target
    snapped[sheet.id] = true
    await persistSheet(sheet, { offset: target, snapped: true })
    logs.push(`${sketch.code} 锚点 ${sketch.anchorStake} → 偏移 ${target}px`)
  }
  snapLog.value = logs
  ElMessage.success(`已按桩号锚点吸附 ${list.length} 张待核图幅`)
}

function onMouseDown(sheet: Sheet, event: MouseEvent): void {
  draggingId.value = sheet.id
  dragStartX.value = event.clientX
  dragOriginOffset.value = offsets[sheet.id] ?? sheet.offset
}

function onMouseMove(event: MouseEvent): void {
  if (!draggingId.value) return
  const current = pendingItems.value.find((item) => item.sheet.id === draggingId.value)
  if (!current) return
  const delta = event.clientX - dragStartX.value
  const raw = Math.max(-200, Math.min(CANVAS_W - 60, dragOriginOffset.value + delta))
  let value = Math.round(raw)
  let snapTarget: string | null = null
  const others = pendingItems.value.filter((item) => item.sheet.id !== draggingId.value)
  for (const other of others) {
    const otherRight = (offsets[other.sheet.id] ?? 0) + widthOf(other.sketch)
    if (Math.abs(value - otherRight) <= SNAP_PX) {
      value = otherRight
      snapTarget = other.sketch.code
      break
    }
  }
  offsets[draggingId.value] = value
  snapped[draggingId.value] = snapTarget !== null
  if (snapTarget) {
    snapLog.value = [`${current.sketch.code} 吸附到 ${snapTarget} 右边缘（偏移 ${value}px）`]
  }
}

async function onMouseUp(): Promise<void> {
  const id = draggingId.value
  draggingId.value = null
  if (!id) return
  const sheet = pendingSheets.value.find((item) => item.id === id)
  if (sheet) {
    // 拖动结果只落制图侧图幅，不写测量侧任何数据
    await persistSheet(sheet, { offset: offsets[id] ?? 0, snapped: snapped[id] ?? false })
  }
}

/** 按测量侧新桩号重新对账：待核图幅更新对账结果，已确认图幅不回退 */
async function reconcileAll(): Promise<void> {
  if (!selectedCaveId.value) return
  await sheetStore.getState().reconcileAll(selectedCaveId.value)
  const failed = pendingSheets.value.filter((sheet) => !sheetCheck(sheet).ok).length
  if (failed > 0) {
    ElMessage.warning(`重新对账完成：${failed} 张图幅对不上桩号，已留在待核`)
  } else {
    ElMessage.success('重新对账完成：待核图幅全部对得上新桩号')
  }
}

/** 对账失败后按制图组这侧重来：按当前桩号重算偏移并吸附，不碰测量侧数据 */
async function resetSheet(sheet: Sheet): Promise<void> {
  await sheetStore.getState().resetFromMappingSide(sheet.id)
  const fresh = sheetState.sheets.find((item) => item.id === sheet.id)
  if (fresh) {
    offsets[sheet.id] = fresh.offset
    snapped[sheet.id] = fresh.snapped
  }
  ElMessage.success('已按制图组这侧重来：偏移按当前桩号重算并吸附，仍需逐张确认')
}

/** 逐张确认入正式拼合 */
async function confirmSheet(sheet: Sheet): Promise<void> {
  const check = sheetCheck(sheet)
  if (!check.ok) {
    ElMessage.warning('对账未通过，请先「按制图组这侧重来」或重新对账')
    return
  }
  await sheetStore.getState().confirm(sheet.id)
  ElMessage.success(`${sketchOf(sheet)?.code ?? '图幅'} 已确认入正式拼合`)
}

/** 制图组主动撤销确认（认过的图幅不随对账回退，这是制图组自己的操作） */
async function unconfirmSheet(sheet: Sheet): Promise<void> {
  await sheetStore.getState().unconfirm(sheet.id)
  ElMessage.info(`${sketchOf(sheet)?.code ?? '图幅'} 已退回待核`)
}

/** 正式拼合顺序表（已确认图幅） */
interface MergeRow {
  order: number
  code: string
  segment: string
  anchorStake: string
  offset: number
  snapped: boolean
  confirmedAt: string
}

const mergeRows = computed<MergeRow[]>(() =>
  confirmedSheets.value.map((sheet, index) => ({
    order: index + 1,
    code: sketchOf(sheet)?.code ?? '—',
    segment: segmentOf(sheet),
    anchorStake: sketchOf(sheet)?.anchorStake ?? '—',
    offset: sheet.offset,
    snapped: sheet.snapped,
    confirmedAt: sheet.confirmedAt ? new Date(sheet.confirmedAt).toLocaleString('zh-CN') : '—'
  }))
)

async function move(index: number, direction: -1 | 1): Promise<void> {
  const list = confirmedSheets.value.map((sheet) => sketchOf(sheet)).filter((s): s is Sketch => Boolean(s))
  const target = index + direction
  if (target < 0 || target >= list.length) return
  const temp = list[index]
  list[index] = list[target]
  list[target] = temp
  await sketchStore.getState().reorder(list.map((sketch) => sketch.id))
}

function exportMergeTable(): void {
  downloadCsv(
    '图幅拼合顺序表.csv',
    mergeRows.value as unknown as Record<string, unknown>[],
    [
      { key: 'order', label: '拼合顺序' },
      { key: 'code', label: '草图编号' },
      { key: 'segment', label: '洞段' },
      { key: 'anchorStake', label: '锚点桩号' },
      { key: 'offset', label: '对齐偏移(px)' },
      { key: 'snapped', label: '是否吸附' },
      { key: 'confirmedAt', label: '确认入正式拼合时间' }
    ]
  )
  ElMessage.success('拼合顺序表已导出')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">图幅拼合视图</h2>
        <p class="page-sub">
          测量组复测改动洞段桩号只落测量侧；制图侧的拼合偏移、吸附与确认状态独立持有。
          图幅按新桩号重新对账，对不上的留在待核，由制图组逐张认过才进正式拼合。
        </p>
      </div>
      <div class="head-actions">
        <el-button type="primary" plain @click="reconcileAll">按新桩号重新对账</el-button>
        <el-button @click="exportMergeTable">导出拼合顺序表</el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">待核图幅 {{ pendingSheets.length }} 张</el-tag>
      <el-tag v-if="failedCount > 0" type="danger" effect="plain">对账对不上 {{ failedCount }} 张</el-tag>
      <el-tag type="success" effect="plain">已入正式拼合 {{ confirmedSheets.length }} 张</el-tag>
      <el-tag effect="plain">待核台总宽 {{ totalWidth }} px</el-tag>
      <div class="seg-tags">
        <SegmentTag
          v-for="segment in caveSegments"
          :key="segment.id"
          :type="segment.type"
          :code="segment.code"
          :closed="segment.closed"
          size="small"
        />
      </div>
    </div>

    <!-- 两侧总长对账：制图侧拼合总长 vs 测量侧实测总长 vs 已知总长 -->
    <div class="length-bar" :class="{ over: lengthReconcile.over }">
      <div class="length-item">
        <span class="length-label">图幅拼合总长</span>
        <b>{{ lengthReconcile.mergeLength }} m</b>
        <span class="muted">（已确认 {{ confirmedSheets.length }} 张 · 按图幅比例）</span>
      </div>
      <div class="length-item">
        <span class="length-label">洞段实测总长</span>
        <b>{{ lengthReconcile.surveyLength }} m</b>
        <span class="muted">（测量侧桩号累计）</span>
      </div>
      <div class="length-item">
        <span class="length-label">洞穴已知总长</span>
        <b>{{ lengthReconcile.knownLength }} m</b>
      </div>
      <div v-if="lengthReconcile.over" class="length-warn">
        拼合总长与实测总长相差 {{ lengthReconcile.diff }} m（超阈值），请按新桩号重新对账
      </div>
      <div v-else class="length-ok">总长对账一致</div>
    </div>

    <h3 class="section-title">
      待核图幅
      <span class="muted small">（对账通过并逐张确认后才进正式拼合；认过的图幅不随对账回退）</span>
    </h3>

    <div v-if="pendingItems.length === 0" class="empty-hint">
      该洞穴暂无待核图幅。旧版数据升级转入的初始图幅会出现在这里；新建草图后也会生成待核图幅。
    </div>

    <div v-else class="merge-row">
      <div class="canvas-wrap" @mousemove="onMouseMove" @mouseup="onMouseUp" @mouseleave="onMouseUp">
        <GridCanvas
          :width="CANVAS_W"
          :height="CANVAS_H"
          :grid-size="20"
          :meters-per-grid="1"
          title="待核图幅拼合台（拖动对齐 / 锚点吸附，结果只落制图侧）"
        >
          <g
            v-for="{ sheet, sketch } in pendingItems"
            :key="sheet.id"
            class="sheet-group"
            @mousedown.prevent="onMouseDown(sheet, $event)"
          >
            <rect
              :x="offsets[sheet.id] ?? 0"
              :y="40"
              :width="widthOf(sketch)"
              height="96"
              rx="6"
              :fill="sheetCheck(sheet).ok ? 'rgba(143,211,199,0.28)' : 'rgba(231,76,60,0.16)'"
              :stroke="sheetCheck(sheet).ok ? '#1f8a70' : '#c0392b'"
              stroke-width="1.6"
            />
            <text :x="(offsets[sheet.id] ?? 0) + 8" :y="62" font-size="12" fill="#1f3a4d">
              {{ sketch.code }}
              <tspan v-if="sheet.source === 'legacy'" fill="#8a6d3b"> · 初始图幅</tspan>
            </text>
            <text :x="(offsets[sheet.id] ?? 0) + 8" :y="80" font-size="11" fill="#4a5b6b">
              锚点 {{ sketch.anchorStake }}
            </text>
            <text :x="(offsets[sheet.id] ?? 0) + 8" :y="96" font-size="11" fill="#7a8896">
              1:{{ sketch.scale }} · {{ sketch.gridCount }} 格 · {{ sketchLengthMeters(sketch) }} m
            </text>
            <line
              :x1="offsets[sheet.id] ?? 0"
              :y1="136"
              :x2="(offsets[sheet.id] ?? 0) + 14"
              :y2="136"
              stroke="#c98a1b"
              stroke-width="2"
            />
          </g>
          <text
            v-if="pendingItems.length === 0"
            :x="CANVAS_W / 2 - 110"
            :y="CANVAS_H / 2"
            font-size="13"
            fill="#8a97a3"
          >
            暂无待核图幅
          </text>
          <template #legend>
            <span>拖动图幅可移动（仅待核图幅）</span>
            <span>绿框 = 对账通过</span>
            <span>红框 = 对账对不上，留在待核</span>
            <span>橙色短划 = 锚点桩号位置</span>
          </template>
        </GridCanvas>
      </div>

      <div class="side">
        <ClosureBadge
          :closure="closureResult.closure"
          :threshold="closureResult.threshold"
          :level="closureResult.level"
          :detail="closureResult.detail"
          :count="caveStations.length"
        />
        <el-card shadow="never" class="log-card">
          <template #header>吸附记录</template>
          <ul class="log">
            <li v-for="(line, index) in snapLog" :key="index">{{ line }}</li>
            <li v-if="snapLog.length === 0" class="muted">
              拖动图幅或点击「按桩号锚点吸附」后显示结果；吸附结果只落制图侧图幅。
            </li>
          </ul>
        </el-card>
        <el-button type="primary" plain @click="autoAlign">按桩号锚点吸附（待核图幅）</el-button>
      </div>
    </div>

    <el-table :data="pendingSheets" border stripe class="sheet-table">
      <el-table-column label="草图编号" width="130">
        <template #default="{ row }: { row: Sheet }">
          {{ sketchOf(row)?.code ?? '—' }}
          <el-tag v-if="row.source === 'legacy'" type="warning" effect="plain" size="small">初始图幅</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="归属洞段" width="200">
        <template #default="{ row }: { row: Sheet }">{{ segmentNameOf(row) }}</template>
      </el-table-column>
      <el-table-column label="锚点桩号" width="130">
        <template #default="{ row }: { row: Sheet }">
          <span class="mono">{{ sketchOf(row)?.anchorStake ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="图幅长度" width="110">
        <template #default="{ row }: { row: Sheet }">{{ sketchLengthMeters(sketchOf(row)) }} m</template>
      </el-table-column>
      <el-table-column label="对账状态" min-width="260">
        <template #default="{ row }: { row: Sheet }">
          <template v-if="sheetCheck(row).ok">
            <el-tag type="success" effect="plain" size="small">对账通过，待制图组确认</el-tag>
          </template>
          <template v-else>
            <el-tag type="danger" effect="plain" size="small">对不上，留待核</el-tag>
            <div class="muted reason">{{ sheetCheck(row).reason }}</div>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="拼合偏移" width="110">
        <template #default="{ row }: { row: Sheet }">
          {{ offsets[row.id] ?? row.offset }} px
          <el-tag v-if="snapped[row.id] ?? row.snapped" type="info" effect="plain" size="small">已吸附</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }: { row: Sheet }">
          <el-button link type="warning" size="small" @click="resetSheet(row)">按制图组这侧重来</el-button>
          <el-button link type="primary" size="small" :disabled="!sheetCheck(row).ok" @click="confirmSheet(row)">
            确认入拼合
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <h3 class="section-title">正式拼合图幅 <span class="muted small">（已逐张确认，锁定不回退）</span></h3>
    <el-table :data="confirmedSheets" border stripe class="sheet-table">
      <el-table-column label="拼合顺序" width="100">
        <template #default="{ $index }: { $index: number }">{{ $index + 1 }}</template>
      </el-table-column>
      <el-table-column label="草图编号" width="120">
        <template #default="{ row }: { row: Sheet }">{{ sketchOf(row)?.code ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="归属洞段" width="200">
        <template #default="{ row }: { row: Sheet }">{{ segmentNameOf(row) }}</template>
      </el-table-column>
      <el-table-column label="锚点桩号" width="130">
        <template #default="{ row }: { row: Sheet }">
          <span class="mono">{{ sketchOf(row)?.anchorStake ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="offset" label="对齐偏移" width="100">
        <template #default="{ row }: { row: Sheet }">{{ row.offset }} px</template>
      </el-table-column>
      <el-table-column label="吸附" width="90">
        <template #default="{ row }: { row: Sheet }">
          <el-tag :type="row.snapped ? 'success' : 'info'" size="small" effect="plain">
            {{ row.snapped ? '已吸附' : '未吸附' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="确认时间" width="180">
        <template #default="{ row }: { row: Sheet }">
          {{ row.confirmedAt ? new Date(row.confirmedAt).toLocaleString('zh-CN') : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="状态" min-width="200">
        <template #default="{ row }: { row: Sheet }">
          <el-tag type="success" effect="dark" size="small">已入正式拼合</el-tag>
          <el-tag v-if="sheetCheck(row).stale" type="warning" effect="plain" size="small">
            测量侧桩号已变更（不回退）
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="调整顺序" width="180">
        <template #default="{ $index }: { $index: number }">
          <el-button link type="primary" size="small" :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="$index === confirmedSheets.length - 1"
            @click="move($index, 1)"
          >
            下移
          </el-button>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }: { row: Sheet }">
          <el-button link type="info" size="small" @click="unconfirmSheet(row)">撤销确认</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.seg-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.canvas-wrap {
  display: inline-flex;
}
.merge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 320px;
}
.log-card {
  border-radius: 12px;
}
.log {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #4a5b6b;
  line-height: 1.8;
}
.sheet-group {
  cursor: grab;
}
.length-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 24px;
  margin: 12px 0;
  padding: 12px 16px;
  border: 1px solid #d7e0e8;
  border-radius: 12px;
  background: #f5f8fb;
  font-size: 13px;
}
.length-bar.over {
  border-color: #e6b3ac;
  background: #fdf0ee;
}
.length-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: #4a5b6b;
}
.length-item b {
  font-size: 16px;
  color: #1f3a4d;
}
.length-warn {
  color: #c0392b;
  font-weight: 600;
}
.length-ok {
  color: #1f8a70;
  font-weight: 600;
}
.empty-hint {
  padding: 16px;
  border: 1px dashed #c3cfda;
  border-radius: 12px;
  color: #7a8896;
  font-size: 13px;
  background: #fafbfc;
}
.sheet-table {
  margin-bottom: 24px;
}
.reason {
  margin-top: 4px;
  color: #c0392b;
}
.small {
  font-size: 12px;
  font-weight: 400;
}
.mono {
  font-family: 'SFMono-Regular', Consolas, monospace;
}
</style>

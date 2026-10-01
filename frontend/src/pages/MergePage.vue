<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MapSheet, Segment, SheetIssue } from '@/types'
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
  alignOffset,
  baseStakeOf,
  reconcileSheets,
  sheetSpan,
  summarizeCave,
  LENGTH_TOLERANCE
} from '@/utils/reconcile'

const CANVAS_W = 780
const CANVAS_H = 300
const SNAP_PX = 12
const PX_PER_METER = 1.6

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

// 制图侧拼合偏移/吸附状态（本侧自持，与测量侧洞段记录完全分离）
const offsets = reactive<Record<string, number>>({})

const selectedCave = computed(() => caveState.caves.find((cave) => cave.id === selectedCaveId.value))

const caveSegments = computed<Segment[]>(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)

const caveSheets = computed<MapSheet[]>(() =>
  sheetState.sheets.filter((sheet) => sheet.caveId === selectedCaveId.value)
)

const pendingSheets = computed(() =>
  caveSheets.value.filter((sheet) => sheet.status === 'pending').sort((a, b) => a.mergeOrder - b.mergeOrder)
)
const confirmedSheets = computed(() =>
  caveSheets.value.filter((sheet) => sheet.status === 'confirmed').sort((a, b) => a.mergeOrder - b.mergeOrder)
)

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

/** 图幅当前偏移：拖动时取本侧暂存，落库后以制图侧存底 sheet.offset 为准 */
function offsetOf(sheet: MapSheet): number {
  return offsets[sheet.id] ?? sheet.offset
}

// —— 按测量侧新桩号实时对账（只读比对，不改图幅）——
const reconciliationMap = computed(() => {
  const results = reconcileSheets(pendingSheets.value, caveSegments.value)
  return new Map(results.map((result) => [result.sheetId, result]))
})

const summary = computed(() => summarizeCave(caveSheets.value, caveSegments.value, selectedCave.value))

function issuesOf(sheet: MapSheet): SheetIssue[] {
  return reconciliationMap.value.get(sheet.id)?.issues ?? sheet.issues
}

function surveySegmentOf(sheet: MapSheet): Segment | undefined {
  return caveSegments.value.find((segment) => segment.id === sheet.segmentId)
}

function segmentCode(segmentId: string): string {
  return segmentState.segments.find((segment) => segment.id === segmentId)?.code ?? '未归属'
}

function sketchesOf(sheet: MapSheet) {
  return sketchState.sketches.filter((sketch) => sheet.sketchIds.includes(sketch.id))
}

function widthOf(sheet: MapSheet): number {
  const grids = sketchesOf(sheet).reduce((sum, sketch) => sum + sketch.gridCount, 0)
  return Math.max(120, Math.round(grids * 2))
}

const totalWidth = computed(() =>
  confirmedSheets.value.reduce((sum, sheet) => sum + widthOf(sheet) + 10, 0)
)

/** 洞段测点闭合差（拼合视图复用闭合差徽标） */
const caveStations = computed(() =>
  stationState.stations.filter((station) =>
    caveSegments.value.some((segment) => segment.id === station.segmentId)
  )
)
const { result: closureResult } = useClosureCheck(caveStations)

/** 按新桩号重新对账：只处理待核图幅，对不上的留在待核，已认过的不回退 */
async function runReconcile(): Promise<void> {
  const stats = await sheetStore.getState().reconcile(caveSegments.value)
  if (stats.updated === 0) {
    ElMessage.info('当前洞穴没有待核图幅（已认过的图幅不参与对账回退）')
    return
  }
  ElMessage.warning(`对账完成：共 ${stats.updated} 张待核，对得上 ${stats.matched} 张，对不上 ${stats.mismatch} 张留在待核`)
}

/** 认用新桩号：采用测量侧洞段桩号，重排本侧吸附偏移，仍需制图组再认过 */
async function adoptNewStakes(sheet: MapSheet): Promise<void> {
  const segment = surveySegmentOf(sheet)
  if (!segment) {
    ElMessage.warning('测量侧已无此洞段，无法认用新桩号，请按制图侧现状认账或删除图幅')
    return
  }
  const base = baseStakeOf(caveSheets.value)
  const offset = alignOffset(segment.startStake, base, PX_PER_METER)
  await sheetStore.getState().adoptSurvey(sheet.id, {
    startStake: segment.startStake,
    endStake: segment.endStake,
    offset,
    snapped: true
  })
  snapLog.value = [`${sheet.code} 认用新桩号 ${segment.startStake} ~ ${segment.endStake}，偏移重排为 ${offset}px`]
  ElMessage.success('已认用测量侧新桩号，请核对后逐张认过')
}

/** 逐张认过：以制图侧这张为准进入正式拼合；对不上也可认，留痕 */
async function acknowledge(sheet: MapSheet): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `确认图幅「${sheet.code}」对账结果并认过？认过后进入正式拼合，测量侧再复测改动也不会使其回退。`,
      '制图组逐张认图',
      {
        confirmButtonText: '认过并入正式拼合',
        cancelButtonText: '取消',
        inputPlaceholder: '认图制图人签名',
        inputValidator: (input) => (input && input.trim() ? true : '请填写认图制图人')
      }
    )
    // 认账保留对账留痕（含强制认账时对不上的条目），不抹历史
    await sheetStore.getState().acknowledge(sheet.id, value, issuesOf(sheet))
    ElMessage.success(`图幅「${sheet.code}」已认过，进入正式拼合`)
  } catch {
    /* 取消认图 */
  }
}

/** 撤销认账：仅制图组主动操作才允许 */
async function unacknowledge(sheet: MapSheet): Promise<void> {
  await ElMessageBox.confirm(`确认把图幅「${sheet.code}」撤回到待核？`, '撤销认账', { type: 'warning' })
  await sheetStore.getState().unacknowledge(sheet.id)
  ElMessage.info('已撤回到待核')
}

async function removeSheet(sheet: MapSheet): Promise<void> {
  await ElMessageBox.confirm(`确认删除图幅「${sheet.code}」？归入的草图保留不删。`, '删除图幅', { type: 'warning' })
  await sheetStore.getState().remove(sheet.id)
  ElMessage.success('图幅已删除，草图仍保留在草图工作台')
}

/** 正式拼合台：已认过图幅按新桩号锚点吸附（制图侧本侧重排，不回退状态） */
async function autoAlign(): Promise<void> {
  const list = confirmedSheets.value
  if (list.length === 0) {
    ElMessage.warning('还没有已认过的图幅，请先在待核区逐张认过')
    return
  }
  const base = baseStakeOf(list)
  const logs: string[] = []
  await Promise.all(
    list.map((sheet) => {
      const target = alignOffset(sheet.startStake, base, PX_PER_METER)
      delete offsets[sheet.id]
      logs.push(`${sheet.code} 锚点 ${sheet.startStake} → 偏移 ${target}px`)
      return sheetStore.getState().save({ ...sheet, offset: target, snapped: true })
    })
  )
  snapLog.value = logs
  ElMessage.success(`已按新桩号重新吸附 ${list.length} 张已认过图幅`)
}

function onMouseDown(sheet: MapSheet, event: MouseEvent): void {
  draggingId.value = sheet.id
  dragStartX.value = event.clientX
  dragOriginOffset.value = offsetOf(sheet)
}

function onMouseMove(event: MouseEvent): void {
  if (!draggingId.value) return
  const sheet = confirmedSheets.value.find((item) => item.id === draggingId.value)
  if (!sheet) return
  const delta = event.clientX - dragStartX.value
  const raw = Math.max(-200, Math.min(CANVAS_W - 60, dragOriginOffset.value + delta))
  const list = confirmedSheets.value
  let value = Math.round(raw)
  let snapTarget: string | null = null
  for (const other of list.filter((item) => item.id !== draggingId.value)) {
    const otherRight = offsetOf(other) + widthOf(other)
    if (Math.abs(value - otherRight) <= SNAP_PX) {
      value = otherRight
      snapTarget = other.code
      break
    }
  }
  offsets[sheet.id] = value
  if (snapTarget) snapLog.value = [`${sheet.code} 吸附到 ${snapTarget} 右边缘（偏移 ${value}px）`]
}

async function onMouseUp(): Promise<void> {
  const id = draggingId.value
  draggingId.value = null
  if (id === null) return
  const sheet = sheetState.sheets.find((item) => item.id === id)
  if (!sheet || sheet.status !== 'confirmed') return
  const value = offsets[id] ?? sheet.offset
  if (value !== sheet.offset) {
    await sheetStore.getState().save({ ...sheet, offset: value })
  }
  delete offsets[id]
}

/** 正式拼合顺序表（仅已认过图幅） */
interface MergeRow {
  order: number
  code: string
  segment: string
  startStake: string
  endStake: string
  length: number
  offset: number
  snapped: boolean
  acknowledgedBy: string
}

const mergeRows = computed<MergeRow[]>(() =>
  confirmedSheets.value.map((sheet, index) => ({
    order: index + 1,
    code: sheet.code,
    segment: segmentCode(sheet.segmentId),
    startStake: sheet.startStake,
    endStake: sheet.endStake,
    length: sheetSpan(sheet),
    offset: offsetOf(sheet),
    snapped: sheet.snapped,
    acknowledgedBy: sheet.acknowledgedBy
  }))
)

async function move(index: number, direction: -1 | 1): Promise<void> {
  const list = [...confirmedSheets.value]
  const target = index + direction
  if (target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target], list[index]]
  await sheetStore.getState().reorder(list.map((sheet) => sheet.id))
}

function exportMergeTable(): void {
  if (mergeRows.value.length === 0) {
    ElMessage.warning('暂无可导出的正式拼合图幅')
    return
  }
  downloadCsv(
    '图幅正式拼合表.csv',
    mergeRows.value as unknown as Record<string, unknown>[],
    [
      { key: 'order', label: '拼合顺序' },
      { key: 'code', label: '图幅编号' },
      { key: 'segment', label: '洞段' },
      { key: 'startStake', label: '起点桩号' },
      { key: 'endStake', label: '止点桩号' },
      { key: 'length', label: '段长(m)' },
      { key: 'offset', label: '对齐偏移(px)' },
      { key: 'snapped', label: '是否吸附' },
      { key: 'acknowledgedBy', label: '认图人' }
    ]
  )
  ElMessage.success('正式拼合表已导出')
}

function issueTagType(issue: SheetIssue): 'danger' | 'warning' {
  return issue.kind === 'stake' ? 'danger' : 'warning'
}

function deltaText(value: number): string {
  return Math.abs(value) <= LENGTH_TOLERANCE ? '一致' : `差 ${Math.abs(value)} m`
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">图幅拼合与对账</h2>
        <p class="page-sub">
          图幅由制图侧自持桩号/偏移；按测量侧新桩号重新对账，对不上的留待核，制图组逐张认过后才进正式拼合，认过的不随复测回退。
        </p>
      </div>
      <div class="head-actions">
        <el-button type="warning" plain @click="runReconcile">按新桩号重新对账</el-button>
        <el-button type="primary" @click="autoAlign">已认图幅重新吸附</el-button>
        <el-button @click="exportMergeTable">导出正式拼合表</el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">待核 {{ summary.pendingCount }} 张</el-tag>
      <el-tag type="success" effect="plain">已认过 {{ summary.confirmedCount }} 张</el-tag>
      <el-tag effect="plain">正式拼合总宽 {{ totalWidth }} px</el-tag>
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

    <!-- 三方总长对账 -->
    <el-alert
      :closable="false"
      show-icon
      :type="summary.totalsMatch ? 'success' : 'error'"
      class="total-alert"
      :title="
        summary.totalsMatch
          ? `三方总长对得上：正式拼合 ${summary.mergedLength} m ＝ 洞段实测 ${summary.surveyedLength} m ＝ 洞穴实测 ${summary.caveLength} m`
          : `三方总长对不上：正式拼合 ${summary.mergedLength} m / 洞段实测 ${summary.surveyedLength} m（${deltaText(summary.mergedVsSurveyed)}）/ 洞穴实测 ${summary.caveLength} m（${deltaText(summary.surveyedVsCave)}）`
      "
    >
      <template #default>
        <span>
          正式拼合总长（已认过图幅段长和）vs 洞段实测总长：<b>{{ deltaText(summary.mergedVsSurveyed) }}</b>；
          洞段实测总长 vs 洞穴实测总长：<b>{{ deltaText(summary.surveyedVsCave) }}</b>。
          待核图幅不计入正式拼合总长。
        </span>
      </template>
    </el-alert>

    <!-- 待核图幅：对不上的留在这，制图组逐张认过 -->
    <h3 class="section-title">待核图幅（{{ pendingSheets.length }}）</h3>
    <el-table :data="pendingSheets" border stripe row-key="id">
      <el-table-column type="expand">
        <template #default="{ row }: { row: MapSheet }">
          <div class="issue-box">
            <div v-if="row.isLegacyInitial" class="legacy-tip">
              旧版数据没有拼合记录，本张是升级时把旧草图自动归入的「待确认初始图幅」，原草图均已保留。
            </div>
            <template v-if="issuesOf(row).length > 0">
              <div v-for="(issue, i) in issuesOf(row)" :key="i" class="issue-line">
                <el-tag :type="issueTagType(issue)" size="small" effect="dark">
                  {{ issue.kind === 'stake' ? '桩号不符' : '长度不符' }}
                </el-tag>
                <span class="issue-msg">{{ issue.message }}</span>
                <span class="issue-vals">制图侧 {{ issue.sideText }} ｜ 测量侧 {{ issue.otherText }}</span>
              </div>
            </template>
            <div v-else class="issue-ok">按新桩号对账一致，可直接认过。</div>
            <div class="sketch-list">
              归入草图：
              <el-tag v-for="sketch in sketchesOf(row)" :key="sketch.id" size="small" effect="plain" class="sketch-tag">
                {{ sketch.code }}（锚点 {{ sketch.anchorStake }}）
              </el-tag>
              <span v-if="sketchesOf(row).length === 0" class="muted">无（草图可能已被删除）</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="code" label="图幅编号" width="150">
        <template #default="{ row }: { row: MapSheet }">
          {{ row.code }}
          <el-tag v-if="row.isLegacyInitial" type="info" size="small" effect="plain">初始</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="洞段" width="100">
        <template #default="{ row }: { row: MapSheet }">{{ segmentCode(row.segmentId) }}</template>
      </el-table-column>
      <el-table-column label="制图侧存底桩号" width="200">
        <template #default="{ row }: { row: MapSheet }">{{ row.startStake }} ~ {{ row.endStake }}</template>
      </el-table-column>
      <el-table-column label="测量侧新桩号" width="210">
        <template #default="{ row }: { row: MapSheet }">
          <template v-if="surveySegmentOf(row)">
            {{ surveySegmentOf(row)!.startStake }} ~ {{ surveySegmentOf(row)!.endStake }}
          </template>
          <el-tag v-else type="danger" size="small">洞段缺失</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="对账结果" width="180">
        <template #default="{ row }: { row: MapSheet }">
          <el-tag v-if="issuesOf(row).length === 0" type="success" size="small">对得上</el-tag>
          <el-tag v-for="(issue, i) in issuesOf(row)" :key="i" :type="issueTagType(issue)" size="small" class="issue-tag">
            {{ issue.kind === 'stake' ? '桩号' : '长度' }} {{ issue.delta }}m
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="制图组处理" width="300">
        <template #default="{ row }: { row: MapSheet }">
          <el-button link type="primary" size="small" :disabled="!surveySegmentOf(row)" @click="adoptNewStakes(row)">
            认用新桩号
          </el-button>
          <el-button link type="success" size="small" @click="acknowledge(row)">逐张认过</el-button>
          <el-button link type="danger" size="small" @click="removeSheet(row)">删除图幅</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="merge-row">
      <div class="canvas-wrap" @mousemove="onMouseMove" @mouseup="onMouseUp" @mouseleave="onMouseUp">
        <GridCanvas
          :width="CANVAS_W"
          :height="CANVAS_H"
          :grid-size="20"
          :meters-per-grid="1"
          title="正式拼合台（仅已认过图幅，拖动微调 / 锚点吸附）"
        >
          <g
            v-for="(sheet, index) in confirmedSheets"
            :key="sheet.id"
            class="sheet-group"
            @mousedown.prevent="onMouseDown(sheet, $event)"
          >
            <rect
              :x="offsetOf(sheet) ?? 0"
              :y="40 + (index % 2) * 10"
              :width="widthOf(sheet)"
              height="96"
              rx="6"
              fill="rgba(47,111,143,0.22)"
              stroke="#2f6f8f"
              stroke-width="1.6"
            />
            <text :x="(offsetOf(sheet) ?? 0) + 8" :y="62 + (index % 2) * 10" font-size="12" fill="#1f3a4d">
              {{ sheet.code }}
            </text>
            <text :x="(offsetOf(sheet) ?? 0) + 8" :y="80 + (index % 2) * 10" font-size="11" fill="#4a5b6b">
              {{ sheet.startStake }} ~ {{ sheet.endStake }}
            </text>
            <text :x="(offsetOf(sheet) ?? 0) + 8" :y="96 + (index % 2) * 10" font-size="11" fill="#7a8896">
              {{ sheetSpan(sheet) }} m · 认图 {{ sheet.acknowledgedBy }}
            </text>
            <line
              :x1="offsetOf(sheet) ?? 0"
              :y1="136 + (index % 2) * 10"
              :x2="(offsetOf(sheet) ?? 0) + 14"
              :y2="136 + (index % 2) * 10"
              stroke="#c98a1b"
              stroke-width="2"
            />
          </g>
          <text
            v-if="confirmedSheets.length === 0"
            :x="CANVAS_W / 2 - 160"
            :y="CANVAS_H / 2"
            font-size="13"
            fill="#8a97a3"
          >
            还没有已认过的图幅：请先在上方待核表逐张认过
          </text>
          <template #legend>
            <span>蓝框 = 已认过正式图幅</span>
            <span>橙划 = 新桩号锚点</span>
            <span>待核图幅不上拼合台</span>
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
            <li v-if="snapLog.length === 0" class="muted">认过图幅后点「已认图幅重新吸附」，或在拼合台拖动微调</li>
          </ul>
        </el-card>
      </div>
    </div>

    <h3 class="section-title">正式拼合顺序表（仅已认过图幅）</h3>
    <el-table :data="mergeRows" border stripe>
      <el-table-column prop="order" label="拼合顺序" width="90" />
      <el-table-column prop="code" label="图幅编号" width="110" />
      <el-table-column prop="segment" label="洞段" width="100" />
      <el-table-column label="认账后桩号" width="190">
        <template #default="{ row }: { row: MergeRow }">{{ row.startStake }} ~ {{ row.endStake }}</template>
      </el-table-column>
      <el-table-column prop="length" label="段长(m)" width="100" />
      <el-table-column label="对齐偏移" width="110">
        <template #default="{ row }: { row: MergeRow }">{{ row.offset }} px</template>
      </el-table-column>
      <el-table-column label="吸附" width="80">
        <template #default="{ row }: { row: MergeRow }">
          <el-tag :type="row.snapped ? 'success' : 'info'" size="small" effect="plain">
            {{ row.snapped ? '已吸附' : '未吸附' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="acknowledgedBy" label="认图人" width="100" />
      <el-table-column label="顺序 / 撤回" width="200">
        <template #default="{ $index }: { row: MergeRow; $index: number }">
          <el-button link type="primary" size="small" :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="$index === mergeRows.length - 1"
            @click="move($index, 1)"
          >
            下移
          </el-button>
          <el-button
            link
            type="warning"
            size="small"
            @click="unacknowledge(confirmedSheets[$index])"
          >
            撤回认账
          </el-button>
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
.total-alert {
  margin: 12px 0 4px;
}
.canvas-wrap {
  display: inline-flex;
}
.merge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
  margin-top: 16px;
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
.issue-box {
  padding: 10px 16px;
  background: #f7fafc;
}
.legacy-tip {
  color: #8a6d3b;
  background: #fcf8e3;
  border: 1px solid #faebcc;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  margin-bottom: 8px;
}
.issue-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}
.issue-msg {
  color: #a94442;
}
.issue-vals {
  color: #5b6b7a;
}
.issue-ok {
  color: #1f8a70;
  font-size: 12px;
  padding: 3px 0;
}
.sketch-list {
  margin-top: 8px;
  font-size: 12px;
  color: #4a5b6b;
}
.sketch-tag {
  margin: 0 4px 4px 0;
}
.issue-tag {
  margin-left: 4px;
}
.muted {
  color: #9aa7b3;
}
</style>

import type { Segment, Sheet, Sketch } from '@/types'
import { segmentLength } from '@/types'
import { round, stakeToNumber } from '@/utils/survey'

/** 拼合台横向比例：1 米实地距离对应的像素数（与拼合台口径一致） */
export const PX_PER_METER = 1.6

/** 总长对账容差：2 m 或 5%，取大值 */
export const LENGTH_TOLERANCE_METERS = 2
export const LENGTH_TOLERANCE_RATIO = 0.05

/** 长度对账容差（米）：绝对容差与比例容差取大值，避免短洞段误报 */
export function lengthTolerance(surveyLength: number): number {
  return Math.max(LENGTH_TOLERANCE_METERS, Math.abs(surveyLength) * LENGTH_TOLERANCE_RATIO)
}

/**
 * 图幅按比例代表的实地长度（米）。
 * 与拼合台 widthOf 同一口径：图上格数 × (200 / 比例) × 4 px，再按 PX_PER_METER 换算。
 */
export function sketchLengthMeters(sketch: Sketch | undefined): number {
  if (!sketch) return 0
  const widthPx = Math.max(88, Math.round(sketch.gridCount * (200 / Math.max(10, sketch.scale)) * 4))
  return widthPx / PX_PER_METER
}

export interface SheetReconcile {
  /** 对账是否通过 */
  ok: boolean
  /** 已确认图幅的快照是否已落后于测量侧当前桩号（仅提示，不回退） */
  stale: boolean
  /** 对账失败原因（空串 = 通过） */
  reason: string
}

/**
 * 按测量侧当前桩号对一张图幅重新对账。
 * 对账项：
 * 1. 草图 / 归属洞段是否仍存在；
 * 2. 草图锚点桩号是否落在洞段当前桩号区间内；
 * 3. 拼合快照所依据的桩号是否漂移（测量组复测改桩号后，旧拼合压在旧桩号上）；
 * 4. 图幅代表长度与洞段实测长度是否一致。
 */
export function reconcileSheet(
  sheet: Sheet,
  sketch: Sketch | undefined,
  segment: Segment | undefined
): SheetReconcile {
  if (!sketch) {
    return { ok: false, stale: false, reason: '草图记录已缺失，无法对账' }
  }
  if (!segment) {
    return { ok: false, stale: false, reason: '草图归属洞段已删除，无法对账' }
  }

  const reasons: string[] = []

  // 锚点桩号必须落在洞段当前桩号区间内
  const anchor = stakeToNumber(sketch.anchorStake)
  const start = stakeToNumber(segment.startStake)
  const end = stakeToNumber(segment.endStake)
  if (anchor < start || anchor > end) {
    reasons.push(`锚点桩号 ${sketch.anchorStake} 不在当前洞段区间 ${segment.startStake} → ${segment.endStake} 内`)
  }

  // 图幅代表长度与洞段实测长度对账
  const sketchLen = sketchLengthMeters(sketch)
  const segLen = segmentLength(segment)
  if (Math.abs(sketchLen - segLen) > lengthTolerance(segLen)) {
    reasons.push(`图幅代表长度 ${round(sketchLen, 1)} m 与洞段实测长度 ${round(segLen, 1)} m 不符`)
  }

  // 拼合快照桩号漂移：测量侧复测改桩号后，制图组的拼合仍压在旧桩号上
  const segmentStale =
    sheet.segmentStartSnapshot !== segment.startStake || sheet.segmentEndSnapshot !== segment.endStake
  const anchorStale = sheet.anchorStakeSnapshot !== sketch.anchorStake
  if (segmentStale) {
    reasons.push(
      `洞段桩号已复测变更（${sheet.segmentStartSnapshot || '?'} → ${segment.startStake}），拼合快照压在旧桩号上`
    )
  } else if (anchorStale) {
    reasons.push(`草图锚点桩号已变更（${sheet.anchorStakeSnapshot || '?'} → ${sketch.anchorStake}）`)
  }

  return { ok: reasons.length === 0, stale: segmentStale || anchorStale, reason: reasons.join('；') }
}

/** 洞穴总长对账结果 */
export interface LengthReconcile {
  /** 图幅拼合总长（已确认图幅按比例累计，米） */
  mergeLength: number
  /** 洞段实测总长（测量侧桩号推算，米） */
  surveyLength: number
  /** 洞穴已知总长（米） */
  knownLength: number
  /** 拼合总长与实测总长之差（米） */
  diff: number
  /** 是否超阈值对不上 */
  over: boolean
}

/** 汇总洞穴两侧总长：制图侧拼合总长 vs 测量侧实测总长 vs 已知总长 */
export function reconcileLengths(
  segments: Segment[],
  confirmedSheets: Sheet[],
  sketches: Sketch[],
  knownLength: number
): LengthReconcile {
  const surveyLength = round(segments.reduce((sum, seg) => sum + segmentLength(seg), 0), 1)
  const mergeLength = round(
    confirmedSheets.reduce((sum, sheet) => {
      const sketch = sketches.find((item) => item.id === sheet.sketchId)
      return sum + sketchLengthMeters(sketch)
    }, 0),
    1
  )
  const diff = round(mergeLength - surveyLength, 1)
  return {
    mergeLength,
    surveyLength,
    knownLength,
    diff,
    over: Math.abs(diff) > lengthTolerance(surveyLength)
  }
}

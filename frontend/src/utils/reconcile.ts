import type { Cave, MapSheet, Segment, SheetIssue } from '@/types'
import { segmentLength } from '@/types/segment'
import { round, stakeToNumber } from './survey'

/** 长度对账容差（米）：桩号换算的差值在此范围内视为一致 */
export const LENGTH_TOLERANCE = 0.1

/** 制图侧图幅自报长度 = 自持起止桩号之差（米） */
export function sheetSpan(sheet: Pick<MapSheet, 'startStake' | 'endStake'>): number {
  return round(Math.max(0, stakeToNumber(sheet.endStake) - stakeToNumber(sheet.startStake)), 3)
}

/** 测量侧洞段实测长度（按洞段起止桩号推算） */
export function surveySpan(segment: Pick<Segment, 'startStake' | 'endStake'>): number {
  return segmentLength(segment)
}

export interface SheetReconciliation {
  sheetId: string
  /** 是否与测量侧新桩号对得上 */
  matched: boolean
  issues: SheetIssue[]
  surveySegment?: Segment
}

/**
 * 单张图幅按测量侧新桩号重新对账。
 * 对账是只读比对：不修改图幅，结果交给制图组逐张认账。
 */
export function reconcileSheet(sheet: MapSheet, segment: Segment | undefined): SheetReconciliation {
  const issues: SheetIssue[] = []

  if (!segment) {
    issues.push({
      kind: 'stake',
      sideText: `${sheet.startStake} ~ ${sheet.endStake}`,
      otherText: '测量侧已无此洞段',
      delta: 0,
      message: '测量侧找不到对应洞段，可能已被复测调整或删除'
    })
    return { sheetId: sheet.id, matched: false, issues }
  }

  const startDelta = round(stakeToNumber(sheet.startStake) - stakeToNumber(segment.startStake), 3)
  const endDelta = round(stakeToNumber(sheet.endStake) - stakeToNumber(segment.endStake), 3)
  if (Math.abs(startDelta) > LENGTH_TOLERANCE || Math.abs(endDelta) > LENGTH_TOLERANCE) {
    issues.push({
      kind: 'stake',
      sideText: `${sheet.startStake} ~ ${sheet.endStake}`,
      otherText: `${segment.startStake} ~ ${segment.endStake}`,
      delta: round(Math.max(Math.abs(startDelta), Math.abs(endDelta)), 3),
      message: '图幅存底桩号与测量侧新桩号不一致（复测后已挪动洞段起止桩号）'
    })
  }

  const sheetLength = sheetSpan(sheet)
  const surveyLength = surveySpan(segment)
  const lengthDelta = round(sheetLength - surveyLength, 3)
  if (Math.abs(lengthDelta) > LENGTH_TOLERANCE) {
    issues.push({
      kind: 'length',
      sideText: `${sheetLength} m`,
      otherText: `${surveyLength} m`,
      delta: Math.abs(lengthDelta),
      message: '图幅推算段长与洞段实测长度对不上'
    })
  }

  return { sheetId: sheet.id, matched: issues.length === 0, issues, surveySegment: segment }
}

/** 对账一批图幅（传入测量侧当前洞段，按 segmentId 索引） */
export function reconcileSheets(sheets: MapSheet[], segments: Segment[]): SheetReconciliation[] {
  const segmentMap = new Map(segments.map((segment) => [segment.id, segment]))
  return sheets.map((sheet) => reconcileSheet(sheet, segmentMap.get(sheet.segmentId)))
}

export interface CaveReconcileSummary {
  /** 制图侧正式拼合总长（已认过图幅段长之和） */
  mergedLength: number
  /** 测量侧洞段实测总长 */
  surveyedLength: number
  /** 洞穴实测总长（洞穴登记） */
  caveLength: number
  /** 正式拼合总长 vs 洞段实测总长 */
  mergedVsSurveyed: number
  /** 洞段实测总长 vs 洞穴实测总长 */
  surveyedVsCave: number
  /** 三个总长是否互相对得上 */
  totalsMatch: boolean
  pendingCount: number
  confirmedCount: number
}

/** 洞穴级总长对账：拼合总长 / 洞段实测总长 / 洞穴实测总长 三方核对 */
export function summarizeCave(sheets: MapSheet[], segments: Segment[], cave: Cave | undefined): CaveReconcileSummary {
  const caveSheets = sheets.filter((sheet) => sheet.caveId === cave?.id)
  const caveSegments = segments.filter((segment) => segment.caveId === cave?.id)

  const mergedLength = round(
    caveSheets
      .filter((sheet) => sheet.status === 'confirmed')
      .reduce((sum, sheet) => sum + sheetSpan(sheet), 0),
    3
  )
  const surveyedLength = round(caveSegments.reduce((sum, segment) => sum + surveySpan(segment), 0), 3)
  const caveLength = round(cave?.knownLength ?? 0, 3)

  const mergedVsSurveyed = round(mergedLength - surveyedLength, 3)
  const surveyedVsCave = round(surveyedLength - caveLength, 3)
  const totalsMatch =
    Math.abs(mergedVsSurveyed) <= LENGTH_TOLERANCE && Math.abs(surveyedVsCave) <= LENGTH_TOLERANCE

  return {
    mergedLength,
    surveyedLength,
    caveLength,
    mergedVsSurveyed,
    surveyedVsCave,
    totalsMatch,
    pendingCount: caveSheets.filter((sheet) => sheet.status === 'pending').length,
    confirmedCount: caveSheets.filter((sheet) => sheet.status === 'confirmed').length
  }
}

/**
 * 以最小起点桩号为原点，按桩号差换算横向吸附偏移（沿用拼合台 PX_PER_METER）。
 * 制图组认用新桩号后，用它把本侧偏移重新排到新桩号上。
 */
export function alignOffset(startStake: string, baseStakeValue: number, pxPerMeter: number): number {
  return Math.round((stakeToNumber(startStake) - baseStakeValue) * pxPerMeter)
}

/** 计算一批图幅的原点桩号（最小起点桩号） */
export function baseStakeOf(sheets: Pick<MapSheet, 'startStake'>[]): number {
  if (sheets.length === 0) return 0
  return Math.min(...sheets.map((sheet) => stakeToNumber(sheet.startStake)))
}

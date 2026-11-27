import type { VerdictKey } from '../types/ecg';
import { clamp } from './timing';

export type ConductionMode =
  | 'normal'
  | 'lbbb'
  | 'rbbb'
  | 'incomplete_lbbb'
  | 'incomplete_rbbb'
  | 'ivcd';

export interface ConductionTimingInput {
  /** Normalized cycle position in [0, 1), where 0 = onset of P wave (or start of beat cycle) */
  cyclePhase: number;
  rrMs: number;
  prMs?: number | null;
  qrsMs?: number | null;
  qtMs?: number | null;
  mode: ConductionMode;
}

export interface ConductionFrame {
  /** 0 = rest, 1 = SA/atria (P), 2 = AV delay (PR), 3 = His/branches (QRS), 4 = Purkinje/ventricles, 5 = Repolarization (T) */
  step: 0 | 1 | 2 | 3 | 4 | 5;
  /** Progress along atrial pathways [0..1], or null when inactive */
  atriaProg: number | null;
  /** Intensity of SA node glow [0..1] */
  saGlow: number;
  /** Intensity of AV node glow [0..1] */
  avGlow: number;
  /** Progress along Bundle of His [0..1], or null */
  hisProg: number | null;
  /** Progress along Right Bundle Branch + RV Purkinje [0..1], or null */
  rbbProg: number | null;
  /** Progress along Left Bundle Branch + LV Purkinje [0..1], or null */
  lbbProg: number | null;
  /** Slow trans-septal myocardial bypass wave progress [0..1] when one branch is blocked */
  bypassProg: number | null;
  bypassDir: 'rv-to-lv' | 'lv-to-rv' | null;
  /** Chamber electrical/mechanical activation levels [0..1] */
  raGlow: number;
  laGlow: number;
  rvGlow: number;
  lvGlow: number;
  /** Ventricular mechanical squeeze factor [0..1] */
  rvSqueeze: number;
  lvSqueeze: number;
  /** Repolarization wave glow [0..1] (T wave) */
  repolGlow: number;
  /** Normalized fraction of cycle where QRS onset occurs (for ECG cursor alignment) */
  qrsStartFrac: number;
  qrsEndFrac: number;
  tEndFrac: number;
}

export function verdictToConductionMode(key?: VerdictKey): ConductionMode {
  switch (key) {
    case 'lbbb':
      return 'lbbb';
    case 'rbbb':
      return 'rbbb';
    case 'incomplete_lbbb':
      return 'incomplete_lbbb';
    case 'incomplete_rbbb':
      return 'incomplete_rbbb';
    case 'ivcd':
      return 'ivcd';
    default:
      return 'normal';
  }
}

function windowProgress(t: number, start: number, end: number): number | null {
  if (end <= start || t < start || t > end) return null;
  return clamp((t - start) / (end - start), 0, 1);
}

function pulseBell(t: number, start: number, end: number): number {
  const p = windowProgress(t, start, end);
  if (p === null) return 0;
  return Math.sin(p * Math.PI);
}

/**
 * Computes the exact anatomical depolarization & repolarization state at any
 * instant of the cardiac cycle, aligned so the electrical impulse visibly
 * initiates atrial & ventricular contraction in real time.
 *
 * Beat phase mapping:
 *  - `beatPhase = 0` corresponds to QRS onset (R-R interval anchor).
 *  - Internally we shift so the P wave precedes QRS by PR ms (wrapping cleanly
 *    across the end of the previous cycle, just like a real ECG strip).
 */
export function computeConductionFrame(
  beatPhase: number,
  rrMsInput: number,
  opts: {
    prMs?: number | null;
    qrsMs?: number | null;
    qtMs?: number | null;
    mode: ConductionMode;
  }
): ConductionFrame {
  const rrMs = clamp(rrMsInput || 833, 350, 2000);
  const prMs = clamp(opts.prMs ?? 160, 80, Math.min(340, rrMs * 0.42));
  const defaultQrs =
    opts.mode === 'lbbb' || opts.mode === 'rbbb' || opts.mode === 'ivcd'
      ? 140
      : opts.mode === 'incomplete_lbbb' || opts.mode === 'incomplete_rbbb'
        ? 114
        : 92;
  const qrsMs = clamp(opts.qrsMs ?? defaultQrs, 60, Math.min(220, rrMs * 0.35));
  const qtMs = clamp(opts.qtMs ?? 380, qrsMs + 120, rrMs * 0.72);

  // Convert beatPhase (0 = QRS onset) to cycle time relative to P onset = 0
  // P onset sits at t = 0, QRS onset sits at t = prMs, T end sits at t = prMs + qtMs
  const pOffset = prMs / rrMs;
  const shiftedPhase = (((beatPhase + pOffset) % 1) + 1) % 1;
  const tMs = shiftedPhase * rrMs;

  const pDur = Math.min(100, prMs * 0.62);
  const avStart = pDur * 0.65;
  const avEnd = prMs;
  const qrsStart = prMs;
  const hisDur = Math.min(28, qrsMs * 0.25);
  const hisEnd = qrsStart + hisDur;
  const qrsEnd = qrsStart + qrsMs;
  const tStart = qrsEnd + Math.max(30, (qtMs - qrsMs) * 0.28);
  const tEnd = qrsStart + qtMs;

  const atriaProg = windowProgress(tMs, 0, pDur);
  const saGlow = pulseBell(tMs, 0, Math.max(45, pDur * 0.55));
  const avGlow = pulseBell(tMs, avStart, avEnd + 18);
  const hisProg = windowProgress(tMs, qrsStart, hisEnd);

  const branchSpan = Math.max(35, qrsEnd - hisEnd);
  let rbbProg: number | null = null;
  let lbbProg: number | null = null;
  let bypassProg: number | null = null;
  let bypassDir: 'rv-to-lv' | 'lv-to-rv' | null = null;

  let rvGlow = 0;
  let lvGlow = 0;
  let rvSqueeze = 0;
  let lvSqueeze = 0;

  if (opts.mode === 'lbbb') {
    // RBB conducts briskly; LBB stops at the proximal block (~26% along path)
    const rbbEnd = hisEnd + branchSpan * 0.45;
    rbbProg = windowProgress(tMs, hisEnd, rbbEnd);
    const lbbBlockedRaw = windowProgress(tMs, hisEnd, hisEnd + branchSpan * 0.28);
    lbbProg = lbbBlockedRaw !== null ? lbbBlockedRaw * 0.26 : null;
    // Slow cell-to-cell wave from RV across septum into LV
    bypassDir = 'rv-to-lv';
    bypassProg = windowProgress(tMs, hisEnd + branchSpan * 0.28, qrsEnd + 18);

    rvGlow = pulseBell(tMs, hisEnd + 10, rbbEnd + 55);
    lvGlow = pulseBell(tMs, hisEnd + branchSpan * 0.45, qrsEnd + 65);
    rvSqueeze = pulseBell(tMs, hisEnd + 18, qrsStart + qtMs * 0.72);
    lvSqueeze = pulseBell(tMs, hisEnd + branchSpan * 0.5, qrsStart + qtMs * 0.85);
  } else if (opts.mode === 'rbbb') {
    // LBB conducts briskly; RBB stops at proximal block (~26% along path)
    const lbbEnd = hisEnd + branchSpan * 0.45;
    lbbProg = windowProgress(tMs, hisEnd, lbbEnd);
    const rbbBlockedRaw = windowProgress(tMs, hisEnd, hisEnd + branchSpan * 0.28);
    rbbProg = rbbBlockedRaw !== null ? rbbBlockedRaw * 0.26 : null;
    bypassDir = 'lv-to-rv';
    bypassProg = windowProgress(tMs, hisEnd + branchSpan * 0.28, qrsEnd + 18);

    lvGlow = pulseBell(tMs, hisEnd + 10, lbbEnd + 55);
    rvGlow = pulseBell(tMs, hisEnd + branchSpan * 0.45, qrsEnd + 65);
    lvSqueeze = pulseBell(tMs, hisEnd + 18, qrsStart + qtMs * 0.72);
    rvSqueeze = pulseBell(tMs, hisEnd + branchSpan * 0.5, qrsStart + qtMs * 0.85);
  } else if (opts.mode === 'incomplete_lbbb') {
    const rbbEnd = hisEnd + branchSpan * 0.62;
    rbbProg = windowProgress(tMs, hisEnd, rbbEnd);
    lbbProg = windowProgress(tMs, hisEnd + 10, qrsEnd);
    rvGlow = pulseBell(tMs, hisEnd + 10, rbbEnd + 50);
    lvGlow = pulseBell(tMs, hisEnd + 24, qrsEnd + 55);
    rvSqueeze = pulseBell(tMs, hisEnd + 18, qrsStart + qtMs * 0.75);
    lvSqueeze = pulseBell(tMs, hisEnd + 34, qrsStart + qtMs * 0.82);
  } else if (opts.mode === 'incomplete_rbbb') {
    const lbbEnd = hisEnd + branchSpan * 0.62;
    lbbProg = windowProgress(tMs, hisEnd, lbbEnd);
    rbbProg = windowProgress(tMs, hisEnd + 10, qrsEnd);
    lvGlow = pulseBell(tMs, hisEnd + 10, lbbEnd + 50);
    rvGlow = pulseBell(tMs, hisEnd + 24, qrsEnd + 55);
    lvSqueeze = pulseBell(tMs, hisEnd + 18, qrsStart + qtMs * 0.75);
    rvSqueeze = pulseBell(tMs, hisEnd + 34, qrsStart + qtMs * 0.82);
  } else {
    // Normal or IVCD (both branches conduct symmetrically; IVCD just has wider qrsMs)
    rbbProg = windowProgress(tMs, hisEnd, qrsEnd);
    lbbProg = windowProgress(tMs, hisEnd, qrsEnd);
    const vGlow = pulseBell(tMs, hisEnd + 12, qrsEnd + 50);
    rvGlow = vGlow;
    lvGlow = vGlow;
    const sq = pulseBell(tMs, hisEnd + 20, qrsStart + qtMs * 0.76);
    rvSqueeze = sq;
    lvSqueeze = sq;
  }

  const raGlow = pulseBell(tMs, 0, pDur * 1.05);
  const laGlow = pulseBell(tMs, pDur * 0.18, pDur * 1.18);
  const repolGlow = pulseBell(tMs, tStart, tEnd);

  let step: ConductionFrame['step'] = 0;
  if (tMs < pDur) step = 1;
  else if (tMs < qrsStart) step = 2;
  else if (tMs < hisEnd + branchSpan * 0.4) step = 3;
  else if (tMs <= qrsEnd + 25) step = 4;
  else if (tMs >= tStart && tMs <= tEnd) step = 5;

  return {
    step,
    atriaProg,
    saGlow,
    avGlow,
    hisProg,
    rbbProg,
    lbbProg,
    bypassProg,
    bypassDir,
    raGlow,
    laGlow,
    rvGlow,
    lvGlow,
    rvSqueeze,
    lvSqueeze,
    repolGlow,
    qrsStartFrac: qrsStart / rrMs,
    qrsEndFrac: qrsEnd / rrMs,
    tEndFrac: Math.min(0.98, tEnd / rrMs),
  };
}

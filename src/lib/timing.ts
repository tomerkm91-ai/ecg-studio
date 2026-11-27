/**
 * Pure ECG beat timing, phase interpolation, and manual paper calibration math.
 */

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function sanitizeBeats(values: readonly number[]): number[] {
  return values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b)
    .filter((v, i, arr) => i === 0 || v > arr[i - 1]);
}

export interface PhaseSample {
  wrappedTime: number;
  phase: number; // [0, 1) within current R-R interval
  rrSec: number;
  bpm: number;
  beatIndex: number;
}

export function sampleBeatPhase(
  beats: readonly number[],
  rawTime: number
): PhaseSample {
  const begin = beats[0];
  const end = beats[beats.length - 1];
  const span = Math.max(1e-6, end - begin);
  const wrappedTime = begin + ((((rawTime - begin) % span) + span) % span);

  let next = 1;
  while (next < beats.length - 1 && beats[next] <= wrappedTime) {
    next++;
  }
  const prev = beats[next - 1];
  const rrSec = Math.max(1e-6, beats[next] - prev);
  const phase = clamp((wrappedTime - prev) / rrSec, 0, 0.9999);
  return {
    wrappedTime,
    phase,
    rrSec,
    bpm: Math.round(60 / rrSec),
    beatIndex: next - 1,
  };
}

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Projects manually clicked QRS points onto the calibration axis [A -> B]
 * to produce monotonically increasing beat times in seconds starting at 0.
 */
export function calibrateManualBeats(
  points: readonly Point2D[],
  calSeconds: number
): number[] {
  if (points.length < 4 || !(calSeconds > 0 && calSeconds <= 60)) {
    throw new Error('יש להשלים שתי נקודות כיול ולסמן לפחות שתי פעימות.');
  }
  const [a, b] = points;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dd = dx * dx + dy * dy;
  if (dx <= 0 || dd < 25) {
    throw new Error('יש לכייל משמאל לימין עם מרחק ברור בין נקודות הכיול.');
  }
  const projected = points
    .slice(2)
    .map((p) => (((p.x - a.x) * dx + (p.y - a.y) * dy) / dd) * calSeconds);
  const beats = projected.map((t) => t - projected[0]);
  for (let i = 1; i < beats.length; i++) {
    if (beats[i] <= beats[i - 1]) {
      throw new Error('סימוני ה־QRS חייבים להתקדם משמאל לימין לאורך רצועה רציפה אחת.');
    }
  }
  return beats;
}

import { DEMO_FS_HZ, DEMO_LEAD_II_UV } from '../data/demoSignal';
import type { BeatComparisonRow, BeatComparisonState } from '../types/ecg';

export const BEAT_REVIEW_LABELS = [
  '',
  'שינוי מורפולוגי חשוד',
  'רעש או ארטיפקט',
  'דומה לייחוס',
  'סימון פעימה שגוי',
  'לא ניתן להכריע',
] as const;

/**
 * Computes leave-one-out median waveform reference and baseline-corrected RMS
 * deviation for every complete beat in [-160 ms, +320 ms] around its marker.
 */
export function buildBeatComparison(
  mv: readonly number[],
  fs: number,
  markersSec: readonly number[],
  sourceName: string
): BeatComparisonState | null {
  if (!fs || fs <= 0 || !Array.isArray(mv) || mv.length === 0) return null;

  const pre = Math.round(0.16 * fs);
  const post = Math.round(0.32 * fs);
  const n = pre + 1 + post;
  if (n > 2000) return null;

  const rawRows: Array<{ timeSec: number; values: number[] }> = [];
  const baseLen = Math.max(1, Math.round(0.035 * fs));

  for (const at of markersSec.slice(0, 500)) {
    if (!Number.isFinite(at)) continue;
    const center = Math.round(at * fs);
    const start = center - pre;
    if (start < 0 || center + post >= mv.length) continue;

    const slice = mv.slice(start, start + n);
    if (!slice.every(Number.isFinite)) continue;

    const baseline = slice.slice(0, baseLen).sort((a, b) => a - b);
    const offset = baseline[Math.floor(baseline.length / 2)];
    rawRows.push({
      timeSec: at,
      values: slice.map((x) => x - offset),
    });
  }

  if (rawRows.length < 3) return null;

  // Pre-sort each sample column for O(N) leave-one-out median queries
  const orderedColumns: number[][] = Array.from({ length: n }, (_, sampleIdx) =>
    rawRows.map((row) => row.values[sampleIdx]).sort((a, b) => a - b)
  );

  function medianWithout(sampleIdx: number, excludeValue: number): number {
    const list = orderedColumns[sampleIdx];
    const skipIdx = list.indexOf(excludeValue);
    const count = list.length - 1;
    const mid = Math.floor(count / 2);
    const at = (j: number) => list[j + (skipIdx <= j ? 1 : 0)];
    return count % 2 ? at(mid) : (at(mid) + at(mid - 1)) / 2;
  }

  const rows: BeatComparisonRow[] = rawRows.map((row, index) => {
    const reference = row.values.map((val, sampleIdx) =>
      medianWithout(sampleIdx, val)
    );
    let sqSum = 0;
    for (let i = 0; i < n; i++) {
      const diff = row.values[i] - reference[i];
      sqSum += diff * diff;
    }
    return {
      index,
      timeSec: row.timeSec,
      values: row.values,
      reference,
      rmsMv: Math.sqrt(sqSum / n),
      label: '',
    };
  });

  let topIndex = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].rmsMv > rows[topIndex].rmsMv) topIndex = i;
  }

  return {
    sourceName,
    fs,
    preSamples: pre,
    rows,
    topIndex,
  };
}

/**
 * Builds the built-in synthetic Lead II demo with an injected morphological
 * perturbation on beat #4 so the user can inspect the comparator immediately.
 */
export function buildDemoBeatComparison(): BeatComparisonState {
  const mv = DEMO_LEAD_II_UV.map((v, i) => {
    const t = i / DEMO_FS_HZ;
    const anomaly = 0.46 * Math.exp(-((t - 2.88) ** 2) / 0.0018);
    return v / 1000 + anomaly;
  });
  const beats: number[] = [];
  for (let k = 0; k < 7; k++) beats.push(0.353 + 0.8 * k);

  const state = buildBeatComparison(
    mv,
    DEMO_FS_HZ,
    beats,
    'דוגמה סינתטית · שינוי מלאכותי נוסף לפעימה הרביעית'
  );
  if (!state) throw new Error('Demo beat comparison failed to build');
  return state;
}

export function serializeBeatReview(state: BeatComparisonState): string {
  return JSON.stringify(
    {
      source: state.sourceName,
      method: 'leave-one-out median; baseline-corrected RMS, -160 to +320 ms',
      sampling_hz: state.fs,
      exported_at: new Date().toISOString(),
      review: state.rows.map((r) => ({
        beat_number: r.index + 1,
        time_s: Number(r.timeSec.toFixed(3)),
        rms_mv: Number(r.rmsMv.toFixed(4)),
        reader_label: r.label,
      })),
    },
    null,
    2
  );
}

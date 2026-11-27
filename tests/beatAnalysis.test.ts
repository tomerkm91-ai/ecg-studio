import { describe, expect, it } from 'vitest';
import {
  buildBeatComparison,
  buildDemoBeatComparison,
  serializeBeatReview,
} from '../src/lib/beatAnalysis';

describe('beatAnalysis', () => {
  it('flags beat #4 as the largest morphological outlier in the synthetic demo', () => {
    const comp = buildDemoBeatComparison();
    expect(comp.rows.length).toBeGreaterThanOrEqual(5);
    // Beat #4 (0-indexed: 3) has the injected +0.46 mV Gaussian perturbation at t=2.88s
    expect(comp.topIndex).toBe(3);
    expect(comp.rows[3].rmsMv).toBeGreaterThan(comp.rows[0].rmsMv * 2);
  });

  it('returns null when fewer than 3 complete beats fit inside the strip', () => {
    const shortSignal = new Array(80).fill(0);
    expect(buildBeatComparison(shortSignal, 100, [0.2, 0.5], 'short')).toBeNull();
  });

  it('serializes reader labels and RMS metrics into valid JSON', () => {
    const comp = buildDemoBeatComparison();
    comp.rows[comp.topIndex].label = 'שינוי מורפולוגי חשוד';
    const parsed = JSON.parse(serializeBeatReview(comp));
    expect(parsed.sampling_hz).toBe(100);
    expect(parsed.review[comp.topIndex].reader_label).toBe('שינוי מורפולוגי חשוד');
    expect(parsed.review[comp.topIndex].rms_mv).toBeGreaterThan(0);
  });
});

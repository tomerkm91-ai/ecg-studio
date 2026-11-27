import { describe, expect, it } from 'vitest';
import {
  calibrateManualBeats,
  sampleBeatPhase,
  sanitizeBeats,
} from '../src/lib/timing';

describe('timing utilities', () => {
  it('sanitizes, sorts, and deduplicates beat timestamps', () => {
    expect(sanitizeBeats([2.0, NaN, 0.5, 1.2, 1.2, Infinity])).toEqual([0.5, 1.2, 2.0]);
  });

  it('interpolates beat phase and wraps cleanly across the strip loop', () => {
    const beats = [1.0, 1.8, 2.6];
    const mid = sampleBeatPhase(beats, 1.4);
    expect(mid.phase).toBeCloseTo(0.5, 3);
    expect(mid.rrSec).toBeCloseTo(0.8, 3);
    expect(mid.bpm).toBe(75);

    const wrapped = sampleBeatPhase(beats, 3.0); // 1.0 + (2.0 % 1.6) = 1.4
    expect(wrapped.wrappedTime).toBeCloseTo(1.4, 3);
  });

  it('projects manually calibrated QRS clicks into beat times in seconds', () => {
    // Calibration: A=(100, 200), B=(300, 200) -> 200 px = 1.0 s
    const beats = calibrateManualBeats(
      [
        { x: 100, y: 200 },
        { x: 300, y: 200 },
        { x: 120, y: 205 },
        { x: 280, y: 205 },
        { x: 440, y: 205 },
      ],
      1.0
    );
    expect(beats).toHaveLength(3);
    expect(beats[0]).toBeCloseTo(0, 4);
    expect(beats[1]).toBeCloseTo(0.8, 4);
    expect(beats[2]).toBeCloseTo(1.6, 4);
  });

  it('rejects non-monotonic or right-to-left calibration clicks', () => {
    expect(() =>
      calibrateManualBeats(
        [
          { x: 300, y: 200 },
          { x: 100, y: 200 },
          { x: 120, y: 200 },
          { x: 200, y: 200 },
        ],
        1.0
      )
    ).toThrow();
  });
});

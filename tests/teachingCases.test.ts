import { describe, expect, it } from 'vitest';
import { TEACHING_PRESETS } from '../src/data/teachingCases';
import { buildBeatComparison } from '../src/lib/beatAnalysis';

describe('teaching presets', () => {
  it('provides 3 valid interactive teaching presets with beat sync and beat comparison support', () => {
    expect(TEACHING_PRESETS.length).toBe(3);
    for (const preset of TEACHING_PRESETS) {
      expect(preset.result.ok).toBe(true);
      expect(preset.result.conduction?.verdict).toBeTruthy();
      expect(preset.teachingGoal.length).toBeGreaterThan(10);
      const tr = preset.result.trace;
      expect(tr?.mv?.length).toBeGreaterThan(200);
      expect(tr?.beats_s.length).toBeGreaterThanOrEqual(5);

      const comp = buildBeatComparison(tr!.mv!, tr!.fs!, tr!.beats_s, preset.title);
      expect(comp).not.toBeNull();
      expect(comp!.rows.length).toBeGreaterThanOrEqual(3);
    }
  });
});

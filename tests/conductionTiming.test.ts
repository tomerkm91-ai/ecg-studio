import { describe, expect, it } from 'vitest';
import {
  computeConductionFrame,
  verdictToConductionMode,
} from '../src/lib/conductionTiming';

describe('conductionTiming', () => {
  it('maps verdict keys to electrical conduction modes', () => {
    expect(verdictToConductionMode('lbbb')).toBe('lbbb');
    expect(verdictToConductionMode('rbbb')).toBe('rbbb');
    expect(verdictToConductionMode('incomplete_lbbb')).toBe('incomplete_lbbb');
    expect(verdictToConductionMode('incomplete_rbbb')).toBe('incomplete_rbbb');
    expect(verdictToConductionMode('ivcd')).toBe('ivcd');
    expect(verdictToConductionMode('normal')).toBe('normal');
    expect(verdictToConductionMode(undefined)).toBe('normal');
  });

  it('progresses through SA/Atria (1) -> AV (2) -> His/Branches (3) -> Ventricles (4) -> T (5) in normal rhythm', () => {
    const rrMs = 1000;
    const opts = { prMs: 160, qrsMs: 90, qtMs: 380, mode: 'normal' as const };

    // Recall: beatPhase = 0 is QRS onset; P onset sits at beatPhase = 1 - 0.16 = 0.84
    const pPhase = computeConductionFrame(0.86, rrMs, opts); // +20 ms after P onset
    expect(pPhase.step).toBe(1);
    expect(pPhase.atriaProg).not.toBeNull();
    expect(pPhase.raGlow).toBeGreaterThan(0);

    const avPhase = computeConductionFrame(0.97, rrMs, opts); // 130 ms after P onset (in PR)
    expect(avPhase.step).toBe(2);
    expect(avPhase.avGlow).toBeGreaterThan(0);

    const hisPhase = computeConductionFrame(0.01, rrMs, opts); // +10 ms after QRS onset
    expect(hisPhase.step).toBe(3);
    expect(hisPhase.hisProg).not.toBeNull();

    const branchPhase = computeConductionFrame(0.055, rrMs, opts); // +55 ms inside QRS
    expect(branchPhase.rbbProg).not.toBeNull();
    expect(branchPhase.lbbProg).not.toBeNull();
    expect(branchPhase.rbbProg).toBeCloseTo(branchPhase.lbbProg!, 5);

    const tPhase = computeConductionFrame(0.24, rrMs, opts); // +240 ms (T wave)
    expect(tPhase.step).toBe(5);
    expect(tPhase.repolGlow).toBeGreaterThan(0);
  });

  it('caps LBB progress at the proximal block and activates slow RV->LV bypass in LBBB', () => {
    const rrMs = 1000;
    const opts = { prMs: 160, qrsMs: 150, qtMs: 420, mode: 'lbbb' as const };

    // Early branch phase (+35 ms into QRS)
    const early = computeConductionFrame(0.035, rrMs, opts);
    expect(early.lbbProg).not.toBeNull();
    expect(early.lbbProg!).toBeLessThanOrEqual(0.26);
    expect(early.rbbProg).toBeGreaterThan(0);

    // Late QRS phase (+110 ms into QRS): RV already activated, LV activated via bypass
    const late = computeConductionFrame(0.11, rrMs, opts);
    expect(late.bypassDir).toBe('rv-to-lv');
    expect(late.bypassProg).not.toBeNull();
    expect(late.bypassProg!).toBeGreaterThan(0);
    expect(late.lvGlow).toBeGreaterThan(0);
  });

  it('caps RBB progress at the proximal block and activates slow LV->RV bypass in RBBB', () => {
    const rrMs = 1000;
    const opts = { prMs: 160, qrsMs: 145, qtMs: 410, mode: 'rbbb' as const };

    const early = computeConductionFrame(0.035, rrMs, opts);
    expect(early.rbbProg).not.toBeNull();
    expect(early.rbbProg!).toBeLessThanOrEqual(0.26);
    expect(early.lbbProg).toBeGreaterThan(0);

    const late = computeConductionFrame(0.105, rrMs, opts);
    expect(late.bypassDir).toBe('lv-to-rv');
    expect(late.bypassProg).not.toBeNull();
    expect(late.bypassProg!).toBeGreaterThan(0);
    expect(late.rvGlow).toBeGreaterThan(0);
  });
});

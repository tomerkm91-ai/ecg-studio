import { DEMO_FS_HZ, DEMO_LEAD_II_UV } from './demoSignal';
import type { AnalysisResult } from '../types/ecg';

export interface TeachingPreset {
  id: string;
  title: string;
  subtitle: string;
  teachingGoal: string;
  result: AnalysisResult;
}

function makePeriodicTrace(
  rrSec: number,
  nBeats: number,
  opts: { qrsWidthFactor?: number; invertAtBeat?: number; polarity?: number } = {}
): { mv: number[]; fs: number; beats_s: number[]; qrs_s: [number, number][] } {
  const fs = 200;
  const duration = Math.max(6, rrSec * nBeats + 0.6);
  const n = Math.round(duration * fs);
  const mv = new Array<number>(n).fill(0);
  const beats_s: number[] = [];
  const qrs_s: [number, number][] = [];
  const w = opts.qrsWidthFactor ?? 1.0;
  const pol = opts.polarity ?? 1;

  for (let b = 0; b < nBeats; b++) {
    const rTime = 0.45 + b * rrSec;
    if (rTime + 0.45 >= duration) break;
    beats_s.push(Number(rTime.toFixed(3)));
    qrs_s.push([
      Number((rTime - 0.045 * w).toFixed(3)),
      Number((rTime + 0.055 * w).toFixed(3)),
    ]);

    const extraAnomaly = opts.invertAtBeat === b ? 1 : 0;

    for (let i = 0; i < n; i++) {
      const dt = i / fs - rTime;
      if (Math.abs(dt) > 0.48) continue;

      // P wave
      const pWave = 0.14 * Math.exp(-(((dt + 0.16) / 0.032) ** 2));
      // Q wave
      const qWave = -0.1 * pol * Math.exp(-(((dt + 0.03 * w) / (0.012 * w)) ** 2));
      // R peak (with optional notch for wide BBB)
      const rMain =
        (extraAnomaly ? 0.65 : 1.05) *
        pol *
        Math.exp(-((dt / (0.018 * w)) ** 2));
      const rNotch =
        w > 1.3
          ? 0.48 * pol * Math.exp(-(((dt - 0.035 * w) / (0.018 * w)) ** 2))
          : 0;
      // S wave
      const sWave =
        -0.25 * pol * Math.exp(-(((dt - 0.042 * w) / (0.016 * w)) ** 2));
      // T wave (discordant in BBB or PVC-like anomaly)
      const tSign = extraAnomaly ? -1 : w > 1.3 ? -0.75 * pol : 1;
      const tWave =
        0.28 * tSign * Math.exp(-(((dt - 0.24) / 0.062) ** 2));

      mv[i] += pWave + qWave + rMain + rNotch + sWave + tWave;
    }
  }

  return {
    mv: mv.map((v) => Number(v.toFixed(3))),
    fs,
    beats_s,
    qrs_s,
  };
}

const normalDemoMv = DEMO_LEAD_II_UV.map((v) => Number((v / 1000).toFixed(3)));
const normalDemoBeats = [0.39, 1.19, 1.99, 2.79, 3.59, 4.39, 5.19];

export const TEACHING_PRESETS: TeachingPreset[] = [
  {
    id: 'normal-sinus',
    title: 'קצב סינוס תקין (NSR)',
    subtitle: '75 bpm · QRS 88 ms · ציר +52°',
    teachingGoal:
      'זיהוי ערכי ייחוס תקינים: דופק 60–100, PR תקין (120–200 ms), QRS צר (<120 ms), ציר תקין והיעדר סטיות ST.',
    result: {
      ok: true,
      elapsedSec: 0.1,
      meta: {
        layout: '3x4+1',
        lead_order: 'standard',
        rotate_deg: 0,
        deskew_deg: 0,
        px_per_mm: 10,
        scale_from: 'דוגמת הוראה מובנית',
        gain_mm_per_mv: 10,
        rows_detected: 4,
        duration_s: 6,
      },
      measurements: {
        hr_bpm: 75,
        rr_cv: 0.012,
        regular: true,
        n_beats: 7,
        qrs_beats_used: 7,
        qrs_ms: 88,
        pr_ms: 158,
        p_ms: 92,
        p_amp_ii_mm: 1.5,
        p_axis_deg: 55,
        p_waves_per_qrs: 1,
        ptf_v1_mm_s: -0.012,
        qt_ms: 382,
        qtc_bazett_ms: 427,
        qtc_fridericia_ms: 411,
        axis_deg: 52,
        axis_uncertain: false,
        st_late_point: 'J+60ms',
        st_j_mm: {
          I: 0.0, II: 0.1, III: 0.0, aVR: -0.1, aVL: 0.0, aVF: 0.1,
          V1: 0.1, V2: 0.4, V3: 0.3, V4: 0.1, V5: 0.0, V6: 0.0,
        },
        st_j60_mm: {
          I: 0.0, II: 0.1, III: 0.0, aVR: -0.1, aVL: 0.0, aVF: 0.0,
          V1: 0.1, V2: 0.4, V3: 0.3, V4: 0.1, V5: 0.0, V6: 0.0,
        },
        t_amp_mm: {
          I: 2.0, II: 3.0, III: 1.1, aVR: -2.5, aVL: 0.6, aVF: 2.2,
          V1: -0.4, V2: 2.4, V3: 3.6, V4: 3.2, V5: 2.5, V6: 2.1,
        },
      },
      conduction: {
        verdict: 'QRS צר (88 ms) — קצב סינוס תקין, ללא חסם צרור.',
        verdict_key: 'normal',
        qrs_ms: 88,
        qrs_band_ms: [71, 105],
        lbbb: [
          { criterion: 'QRS ≥ 120 ms', met: false, detail: '88 ms (טווח 71–105)' },
          { criterion: 'V1: QS או rS, בלי R סופי', met: true, detail: 'שטח נטו שלילי, תקין ב־V1' },
          { criterion: 'I / V5 / V6: ללא גל q', met: false, detail: 'גל q ספטלי קטן תקין (16 ms)' },
          { criterion: 'V6: זמן שיא R > 60 ms', met: false, detail: '34 ms' },
          { criterion: 'חריץ באמצע ה־QRS ב־2 לידים לפחות (Strauss)', met: false, detail: '0 לידים' },
        ],
        rbbb: [
          { criterion: 'QRS ≥ 120 ms', met: false, detail: '88 ms (טווח 71–105)' },
          { criterion: "V1: R סופי (rsR' / rSR')", met: false, detail: 'ללא R סופי' },
          { criterion: 'V1: זמן שיא R > 50 ms', met: false, detail: '22 ms' },
          { criterion: 'I ו־V6: גל S רחב מ־40 ms', met: false, detail: 'I 14 ms, V6 10 ms' },
        ],
        fascicular: null,
      },
      flags: [],
      notes: [
        'דוגמת הוראה מובנית: כל הערכים נמצאים בטווח התקין לצורך השוואה בשיעור.',
      ],
      trace: {
        lead: 'II (דוגמת הוראה · סינוס תקין)',
        fs: DEMO_FS_HZ,
        t0_s: 0,
        mv: normalDemoMv,
        beats_s: normalDemoBeats,
        qrs_s: normalDemoBeats.map((t) => [Number((t - 0.04).toFixed(3)), Number((t + 0.05).toFixed(3))]),
      },
      disclaimer:
        'כלי הוראה ולמידה בלבד — מיועד להדגמה ולתרגול קריאת אק״ג ואינו משמש לאבחון או לטיפול רפואי.',
    },
  },
  {
    id: 'complete-lbbb',
    title: 'חסם צרור שמאלי (LBBB)',
    subtitle: '68 bpm · QRS 146 ms · ציר -22°',
    teachingGoal:
      'הדגמת קריטריוני LBBB ו־Strauss: QRS רחב ≥120 ms, חריץ (notching) בלידים צדיים, היעדר q ב־I/V5/V6 ו־QS עמוק ב־V1.',
    result: {
      ok: true,
      elapsedSec: 0.1,
      meta: {
        layout: '3x4+1',
        lead_order: 'standard',
        rotate_deg: 0,
        deskew_deg: 0,
        px_per_mm: 10,
        scale_from: 'דוגמת הוראה מובנית',
        gain_mm_per_mv: 10,
        rows_detected: 4,
        duration_s: 7.5,
      },
      measurements: {
        hr_bpm: 68,
        rr_cv: 0.018,
        regular: true,
        n_beats: 8,
        qrs_beats_used: 8,
        qrs_ms: 146,
        pr_ms: 174,
        p_ms: 104,
        p_amp_ii_mm: 1.4,
        p_axis_deg: 48,
        p_waves_per_qrs: 1,
        qt_ms: 438,
        qtc_bazett_ms: 466,
        qtc_fridericia_ms: 456,
        axis_deg: -22,
        axis_uncertain: false,
        st_late_point: 'J+60ms',
        st_j_mm: {
          I: -0.9, II: 0.1, III: 0.7, aVR: 0.5, aVL: -1.1, aVF: 0.4,
          V1: 1.6, V2: 2.1, V3: 1.4, V4: 0.2, V5: -0.8, V6: -1.2,
        },
        st_j60_mm: {
          I: -1.1, II: 0.1, III: 0.8, aVR: 0.6, aVL: -1.2, aVF: 0.4,
          V1: 1.8, V2: 2.2, V3: 1.5, V4: 0.2, V5: -1.0, V6: -1.3,
        },
        t_amp_mm: {
          I: -2.4, II: 0.8, III: 1.8, aVR: 1.4, aVL: -2.8, aVF: 1.2,
          V1: 3.1, V2: 4.0, V3: 2.6, V4: 0.5, V5: -2.2, V6: -2.9,
        },
      },
      conduction: {
        verdict: 'דפוס תואם חסם צרור שמאלי (LBBB), QRS 146 ms.',
        verdict_key: 'lbbb',
        qrs_ms: 146,
        qrs_band_ms: [129, 163],
        lbbb: [
          { criterion: 'QRS ≥ 120 ms', met: true, detail: '146 ms (טווח 129–163)' },
          { criterion: 'V1: QS או rS, בלי R סופי', met: true, detail: 'שטח נטו -48.2 mV·ms, סוף שלילי' },
          { criterion: 'I: ללא גל q', met: true, detail: 'q של 0 ms' },
          { criterion: 'V5 / V6: ללא גל q', met: true, detail: 'q של 0 ms' },
          { criterion: 'V6: זמן שיא R > 60 ms', met: true, detail: '84 ms' },
          { criterion: 'חריץ באמצע ה־QRS ב־2 לידים לפחות (Strauss)', met: true, detail: '4 לידים: I, aVL, V5, V6' },
        ],
        rbbb: [
          { criterion: 'QRS ≥ 120 ms', met: true, detail: '146 ms (טווח 129–163)' },
          { criterion: "V1: R סופי (rsR' / rSR')", met: false, detail: 'סוף הקומפלקס שלילי (-0.34 mV)' },
          { criterion: 'V1: זמן שיא R > 50 ms', met: false, detail: '12 ms' },
          { criterion: 'I ו־V6: גל S רחב מ־40 ms', met: false, detail: 'I 0 ms, V6 0 ms' },
        ],
        fascicular: null,
      },
      flags: [
        'QRS רחב (≥120 ms)',
        'צניחת ST והיפוך T דיסקורדנטיים בלידים צדיים (I, aVL, V5, V6) — צפוי ב־LBBB',
        'עליית ST דיסקורדנטית ב־V1–V3 — ב־LBBB יש לבחון דיסקורדנטיות פרופורציונלית (Sgarbossa)',
      ],
      notes: [
        'דוגמת הוראה מובנית: שימו לב לדיסקורדנטיות התקינה בין כיוון ה־QRS לכיוון ST–T בחסם צרור שמאלי.',
      ],
      trace: {
        lead: 'V6 (דוגמת הוראה · LBBB)',
        ...makePeriodicTrace(0.88, 8, { qrsWidthFactor: 1.75 }),
      },
      disclaimer:
        'כלי הוראה ולמידה בלבד — מיועד להדגמה ולתרגול קריאת אק״ג ואינו משמש לאבחון או לטיפול רפואי.',
    },
  },
  {
    id: 'complete-rbbb',
    title: 'חסם צרור ימני (RBBB)',
    subtitle: '82 bpm · QRS 138 ms · ציר +68°',
    teachingGoal:
      "הדגמת קריטריוני RBBB: תבנית rSR' (אוזני ארנב) ב־V1 עם זמן שיא R מאוחר וגל S רחב ומשוך (slurred) ב־I וב־V6.",
    result: {
      ok: true,
      elapsedSec: 0.1,
      meta: {
        layout: '3x4+1',
        lead_order: 'standard',
        rotate_deg: 0,
        deskew_deg: 0,
        px_per_mm: 10,
        scale_from: 'דוגמת הוראה מובנית',
        gain_mm_per_mv: 10,
        rows_detected: 4,
        duration_s: 7.0,
      },
      measurements: {
        hr_bpm: 82,
        rr_cv: 0.015,
        regular: true,
        n_beats: 8,
        qrs_beats_used: 8,
        qrs_ms: 138,
        pr_ms: 164,
        p_ms: 96,
        p_amp_ii_mm: 1.6,
        p_axis_deg: 60,
        p_waves_per_qrs: 1,
        qt_ms: 396,
        qtc_bazett_ms: 463,
        qtc_fridericia_ms: 439,
        axis_deg: 68,
        axis_uncertain: false,
        st_late_point: 'J+60ms',
        st_j_mm: {
          I: 0.0, II: 0.0, III: 0.0, aVR: 0.0, aVL: 0.0, aVF: 0.0,
          V1: -0.7, V2: -0.6, V3: -0.2, V4: 0.0, V5: 0.0, V6: 0.0,
        },
        st_j60_mm: {
          I: 0.0, II: 0.0, III: 0.0, aVR: 0.0, aVL: 0.0, aVF: 0.0,
          V1: -0.8, V2: -0.6, V3: -0.2, V4: 0.0, V5: 0.0, V6: 0.0,
        },
        t_amp_mm: {
          I: 2.1, II: 2.6, III: 0.8, aVR: -2.0, aVL: 0.7, aVF: 1.9,
          V1: -2.2, V2: -1.6, V3: 1.2, V4: 2.6, V5: 2.4, V6: 2.1,
        },
      },
      conduction: {
        verdict: 'דפוס תואם חסם צרור ימני (RBBB), QRS 138 ms.',
        verdict_key: 'rbbb',
        qrs_ms: 138,
        qrs_band_ms: [121, 155],
        lbbb: [
          { criterion: 'QRS ≥ 120 ms', met: true, detail: '138 ms (טווח 121–155)' },
          { criterion: 'V1: QS או rS, בלי R סופי', met: false, detail: "R' סופי חיובי (+0.42 mV)" },
          { criterion: 'I / V5 / V6: ללא גל q', met: false, detail: 'גל q ספטלי שמור (18 ms)' },
          { criterion: 'V6: זמן שיא R > 60 ms', met: false, detail: '38 ms' },
        ],
        rbbb: [
          { criterion: 'QRS ≥ 120 ms', met: true, detail: '138 ms (טווח 121–155)' },
          { criterion: "V1: R סופי (rsR' / rSR')", met: true, detail: 'סוף חיובי (+0.42 mV), שיא אחרון ב־94 ms' },
          { criterion: 'V1: זמן שיא R > 50 ms', met: true, detail: '94 ms' },
          { criterion: 'I ו־V6: גל S רחב מ־40 ms', met: true, detail: 'I 58 ms, V6 62 ms' },
        ],
        fascicular: null,
      },
      flags: [
        'QRS רחב (≥120 ms)',
        'היפוך גל T וצניחת ST משנית ב־V1–V2 — דפוס צפוי בחסם צרור ימני',
      ],
      notes: [
        "דוגמת הוראה מובנית: בחסם צרור ימני ההפעלה הראשונית של המחיצה תקינה, והחלק המאוחר של ה־QRS מוארך (R' ב־V1 ו־S רחב ב־I/V6).",
      ],
      trace: {
        lead: 'V1 (דוגמת הוראה · RBBB)',
        ...makePeriodicTrace(0.73, 8, { qrsWidthFactor: 1.65, invertAtBeat: 4 }),
      },
      disclaimer:
        'כלי הוראה ולמידה בלבד — מיועד להדגמה ולתרגול קריאת אק״ג ואינו משמש לאבחון או לטיפול רפואי.',
    },
  },
];

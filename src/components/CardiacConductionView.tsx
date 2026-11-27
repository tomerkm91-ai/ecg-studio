import React, { useEffect, useRef } from 'react';
import {
  computeConductionFrame,
  type ConductionFrame,
  type ConductionMode,
} from '../lib/conductionTiming';

interface CardiacConductionViewProps {
  /** Ref providing live [0, 1) beat phase (0 = QRS onset) & current RR in ms from the shared rAF clock */
  clockRef: React.MutableRefObject<{ phase: number; rrMs: number }>;
  mode: ConductionMode;
  onChangeMode: (mode: ConductionMode) => void;
  prMs?: number | null;
  qrsMs?: number | null;
  qtMs?: number | null;
  visible: boolean;
}

const MODE_LABELS: Array<{ id: ConductionMode; label: string }> = [
  { id: 'normal', label: 'הולכה תקינה' },
  { id: 'lbbb', label: 'LBBB מלא' },
  { id: 'rbbb', label: 'RBBB מלא' },
  { id: 'incomplete_lbbb', label: 'LBBB חלקי' },
  { id: 'incomplete_rbbb', label: 'RBBB חלקי' },
  { id: 'ivcd', label: 'IVCD איטי' },
];

const STEPS = [
  { id: 1, title: 'קשר SA ודפולריזציה עלייתית', wave: 'גל P' },
  { id: 2, title: 'השהיה פיזיולוגית בקשר AV', wave: 'מקטע PR' },
  { id: 3, title: 'צרור היס וענפי ההולכה (RBB / LBB)', wave: 'תחילת QRS' },
  { id: 4, title: 'סיבי פורקינייה והתכווצות החדרים', wave: 'שיא וסוף QRS' },
  { id: 5, title: 'רה־פולריזציה והתאוששות השריר', wave: 'גל T' },
] as const;

// SVG path definitions (anatomical view: viewer left = Right Heart, viewer right = Left Heart)
const PATH_SA_TO_AV = 'M 108 110 C 122 132, 134 150, 152 162';
const PATH_BACHMANN = 'M 108 110 C 148 92, 198 96, 224 128';
const PATH_HIS = 'M 152 162 L 156 188';
const PATH_RBB = 'M 156 188 C 146 218, 136 258, 128 286 C 110 296, 86 270, 82 222';
const PATH_LBB = 'M 156 188 C 172 216, 188 260, 196 292 C 224 294, 246 254, 242 204';
const PATH_BYPASS_RV_LV = 'M 128 272 C 154 278, 178 276, 218 250 C 232 238, 240 220, 238 206';
const PATH_BYPASS_LV_RV = 'M 192 276 C 166 280, 140 274, 104 252 C 92 242, 86 226, 86 216';

function setOrbAt(
  pathEl: SVGPathElement | null,
  orbEl: SVGCircleElement | null,
  haloEl: SVGCircleElement | null,
  prog: number | null
) {
  if (!pathEl || !orbEl || !haloEl) return;
  if (prog === null) {
    orbEl.style.opacity = '0';
    haloEl.style.opacity = '0';
    return;
  }
  const len = pathEl.getTotalLength();
  const pt = pathEl.getPointAtLength(len * prog);
  orbEl.setAttribute('cx', String(pt.x));
  orbEl.setAttribute('cy', String(pt.y));
  haloEl.setAttribute('cx', String(pt.x));
  haloEl.setAttribute('cy', String(pt.y));
  orbEl.style.opacity = '1';
  haloEl.style.opacity = '0.85';
}

function drawMiniEcgWave(
  cv: HTMLCanvasElement,
  frame: ConductionFrame,
  shiftedPhase: number,
  mode: ConductionMode
) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const w = cv.width;
  const h = cv.height;
  ctx.clearRect(0, 0, w, h);

  // Subtle ECG grid
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 28) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  const baseY = h * 0.64;
  const qStart = frame.qrsStartFrac;
  const qEnd = frame.qrsEndFrac;
  const qMid = (qStart + qEnd) / 2;
  const qWidth = Math.max(0.06, qEnd - qStart);
  const pMid = qStart * 0.36;
  const tMid = (qEnd + frame.tEndFrac) / 2;
  const isWide = mode === 'lbbb' || mode === 'rbbb' || mode === 'ivcd';

  const waveAt = (u: number): number => {
    const p = 0.2 * Math.exp(-(((u - pMid) / Math.max(0.028, qStart * 0.22)) ** 2));
    const q = -0.14 * Math.exp(-(((u - (qStart + qWidth * 0.16)) / (qWidth * 0.12)) ** 2));
    const r =
      0.95 * Math.exp(-(((u - (qStart + qWidth * 0.42)) / (qWidth * 0.18)) ** 2)) +
      (isWide
        ? 0.55 * Math.exp(-(((u - (qStart + qWidth * 0.72)) / (qWidth * 0.2)) ** 2))
        : 0);
    const s = isWide
      ? -0.18 * Math.exp(-(((u - (qEnd - qWidth * 0.08)) / (qWidth * 0.12)) ** 2))
      : -0.28 * Math.exp(-(((u - (qMid + qWidth * 0.24)) / (qWidth * 0.14)) ** 2));
    const tSign = mode === 'lbbb' ? -0.35 : 0.34;
    const t = tSign * Math.exp(-(((u - tMid) / Math.max(0.045, (frame.tEndFrac - qEnd) * 0.26)) ** 2));
    return p + q + r + s + t;
  };

  // Full dimmed reference trace
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const u = px / w;
    const py = baseY - waveAt(u) * (h * 0.52);
    if (px === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Illuminated trace up to current phase
  const curX = Math.max(1, Math.min(w - 1, Math.round(shiftedPhase * w)));
  ctx.strokeStyle = '#fde047';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  for (let px = 0; px <= curX; px++) {
    const u = px / w;
    const py = baseY - waveAt(u) * (h * 0.52);
    if (px === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Glowing live dot on the ECG wave
  const curY = baseY - waveAt(shiftedPhase) * (h * 0.52);
  ctx.fillStyle = 'rgba(253, 224, 71, 0.35)';
  ctx.beginPath();
  ctx.arc(curX, curY, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fef08a';
  ctx.beginPath();
  ctx.arc(curX, curY, 4, 0, Math.PI * 2);
  ctx.fill();

  // Wave labels (P, QRS, T)
  ctx.direction = 'ltr';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('P', pMid * w, h - 5);
  ctx.fillText('QRS', qMid * w, h - 5);
  ctx.fillText('T', tMid * w, h - 5);
}

export const CardiacConductionView: React.FC<CardiacConductionViewProps> = ({
  clockRef,
  mode,
  onChangeMode,
  prMs,
  qrsMs,
  qtMs,
  visible,
}) => {
  const modeRef = useRef(mode);
  const visibleRef = useRef(visible);
  const intervalsRef = useRef({ prMs, qrsMs, qtMs });
  modeRef.current = mode;
  visibleRef.current = visible;
  intervalsRef.current = { prMs, qrsMs, qtMs };

  // SVG DOM refs updated directly in rAF (60 fps, zero React re-renders)
  const saAvPathRef = useRef<SVGPathElement>(null);
  const bachPathRef = useRef<SVGPathElement>(null);
  const hisPathRef = useRef<SVGPathElement>(null);
  const rbbPathRef = useRef<SVGPathElement>(null);
  const lbbPathRef = useRef<SVGPathElement>(null);
  const bypassRvLvRef = useRef<SVGPathElement>(null);
  const bypassLvRvRef = useRef<SVGPathElement>(null);

  const orbAtria1Ref = useRef<SVGCircleElement>(null);
  const haloAtria1Ref = useRef<SVGCircleElement>(null);
  const orbAtria2Ref = useRef<SVGCircleElement>(null);
  const haloAtria2Ref = useRef<SVGCircleElement>(null);
  const orbHisRef = useRef<SVGCircleElement>(null);
  const haloHisRef = useRef<SVGCircleElement>(null);
  const orbRbbRef = useRef<SVGCircleElement>(null);
  const haloRbbRef = useRef<SVGCircleElement>(null);
  const orbLbbRef = useRef<SVGCircleElement>(null);
  const haloLbbRef = useRef<SVGCircleElement>(null);
  const orbBypassRef = useRef<SVGCircleElement>(null);
  const haloBypassRef = useRef<SVGCircleElement>(null);

  const saNodeRef = useRef<SVGCircleElement>(null);
  const avNodeRef = useRef<SVGCircleElement>(null);
  const raChamberRef = useRef<SVGPathElement>(null);
  const laChamberRef = useRef<SVGPathElement>(null);
  const rvChamberRef = useRef<SVGPathElement>(null);
  const lvChamberRef = useRef<SVGPathElement>(null);
  const heartGroupRef = useRef<SVGGElement>(null);
  const miniEcgRef = useRef<HTMLCanvasElement>(null);
  const stepElsRef = useRef<Array<HTMLLIElement | null>>([]);
  const phaseLabelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let rafId = 0;
    let lastStep = -1;

    const animate = () => {
      if (visibleRef.current) {
        const { phase, rrMs } = clockRef.current;
        const { prMs: pr, qrsMs: qrs, qtMs: qt } = intervalsRef.current;
        const m = modeRef.current;

        const frame = computeConductionFrame(phase, rrMs, {
          prMs: pr,
          qrsMs: qrs,
          qtMs: qt,
          mode: m,
        });

        // Move glowing light orbs along the anatomical conduction pathways
        setOrbAt(saAvPathRef.current, orbAtria1Ref.current, haloAtria1Ref.current, frame.atriaProg);
        setOrbAt(bachPathRef.current, orbAtria2Ref.current, haloAtria2Ref.current, frame.atriaProg);
        setOrbAt(hisPathRef.current, orbHisRef.current, haloHisRef.current, frame.hisProg);
        setOrbAt(rbbPathRef.current, orbRbbRef.current, haloRbbRef.current, frame.rbbProg);
        setOrbAt(lbbPathRef.current, orbLbbRef.current, haloLbbRef.current, frame.lbbProg);

        const bypassPath =
          frame.bypassDir === 'rv-to-lv'
            ? bypassRvLvRef.current
            : frame.bypassDir === 'lv-to-rv'
              ? bypassLvRvRef.current
              : null;
        setOrbAt(bypassPath, orbBypassRef.current, haloBypassRef.current, frame.bypassProg);

        // Node pulses
        if (saNodeRef.current) {
          saNodeRef.current.setAttribute('r', String(7 + frame.saGlow * 5.5));
          saNodeRef.current.style.opacity = String(0.55 + frame.saGlow * 0.45);
        }
        if (avNodeRef.current) {
          avNodeRef.current.setAttribute('r', String(6.5 + frame.avGlow * 5.5));
          avNodeRef.current.style.opacity = String(0.5 + frame.avGlow * 0.5);
        }

        // Chamber depolarization & repolarization fills
        if (raChamberRef.current) {
          raChamberRef.current.style.fill = `rgba(250, 204, 21, ${(0.08 + frame.raGlow * 0.38).toFixed(2)})`;
        }
        if (laChamberRef.current) {
          laChamberRef.current.style.fill = `rgba(250, 204, 21, ${(0.08 + frame.laGlow * 0.38).toFixed(2)})`;
        }
        if (rvChamberRef.current) {
          const dep = frame.rvGlow * 0.42;
          const rep = frame.repolGlow * 0.25;
          rvChamberRef.current.style.fill =
            dep >= rep
              ? `rgba(56, 189, 248, ${(0.1 + dep).toFixed(2)})`
              : `rgba(192, 132, 252, ${(0.1 + rep).toFixed(2)})`;
        }
        if (lvChamberRef.current) {
          const dep = frame.lvGlow * 0.44;
          const rep = frame.repolGlow * 0.25;
          lvChamberRef.current.style.fill =
            dep >= rep
              ? `rgba(244, 114, 182, ${(0.1 + dep).toFixed(2)})`
              : `rgba(192, 132, 252, ${(0.1 + rep).toFixed(2)})`;
        }

        // Subtle mechanical contraction driven by the electrical depolarization wave
        if (heartGroupRef.current) {
          const avgSq = (frame.rvSqueeze + frame.lvSqueeze) * 0.5;
          const scaleX = 1 - avgSq * 0.045;
          const scaleY = 1 - avgSq * 0.032;
          heartGroupRef.current.setAttribute(
            'transform',
            `translate(160 195) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(-160 -195)`
          );
        }

        // Synchronized mini-ECG waveform
        if (miniEcgRef.current) {
          const pOffset = frame.qrsStartFrac;
          const shifted = (((phase + pOffset) % 1) + 1) % 1;
          drawMiniEcgWave(miniEcgRef.current, frame, shifted, m);
        }

        // Highlight active conduction step
        if (frame.step !== lastStep) {
          lastStep = frame.step;
          stepElsRef.current.forEach((el, idx) => {
            if (el) el.classList.toggle('active', idx + 1 === frame.step);
          });
          if (phaseLabelRef.current) {
            const cur = STEPS.find((s) => s.id === frame.step);
            phaseLabelRef.current.textContent = cur
              ? `${cur.title} (${cur.wave})`
              : 'מנוחה דיאסטולית (קו איזואלקטרי)';
          }
        }
      }

      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [clockRef]);

  return (
    <div className="conduction-panel">
      <div className="conduction-top">
        <div>
          <h3>מסלול ההולכה החשמלי החי</h3>
          <p className="muted small">
            נקודת האור רצה מקשר ה־SA דרך קשר ה־AV, צרור היס וסיבי פורקינייה — ומנחה את התכווצות החדרים בסנכרון מלא לאק״ג.
          </p>
        </div>
        <label className="field-inline">
          <span>מסלול</span>
          <select
            value={mode}
            onChange={(e) => onChangeMode(e.target.value as ConductionMode)}
            aria-label="דפוס הולכה חשמלית"
          >
            {MODE_LABELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="conduction-stage">
        <svg
          viewBox="0 0 320 350"
          className="conduction-svg"
          role="img"
          aria-label="הדמיית מסלול ההולכה החשמלי בלב"
        >
          <defs>
            <filter id="elecGlow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <radialGradient id="orbHalo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fef08a" stopOpacity="0.95" />
              <stop offset="55%" stopColor="#facc15" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#facc15" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="bypassHalo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fdba74" stopOpacity="0.95" />
              <stop offset="55%" stopColor="#f97316" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
            </radialGradient>
          </defs>

          <g ref={heartGroupRef}>
            {/* Great Vessels (SVC, Aorta) */}
            <path
              d="M 96 76 L 96 34 C 96 26, 118 26, 118 34 L 118 82"
              fill="rgba(56, 189, 248, 0.15)"
              stroke="rgba(148, 163, 184, 0.35)"
              strokeWidth="2"
            />
            <path
              d="M 146 92 C 142 42, 198 30, 214 68 L 194 78 C 186 56, 166 62, 166 94"
              fill="rgba(244, 114, 182, 0.16)"
              stroke="rgba(148, 163, 184, 0.35)"
              strokeWidth="2"
            />

            {/* Outer Myocardial Silhouette */}
            <path
              d="M 156 84
                 C 108 66, 56 96, 56 154
                 C 56 226, 102 296, 158 326
                 C 216 300, 266 232, 266 156
                 C 266 98, 212 68, 156 84 Z"
              fill="rgba(20, 32, 46, 0.92)"
              stroke="rgba(148, 163, 184, 0.45)"
              strokeWidth="2.5"
            />

            {/* Four Chambers (viewer left = Right Heart, viewer right = Left Heart) */}
            <path
              ref={raChamberRef}
              d="M 152 94 C 110 82, 70 106, 70 148 C 70 166, 98 176, 150 172 Z"
              fill="rgba(250, 204, 21, 0.08)"
              stroke="rgba(148, 163, 184, 0.3)"
              strokeWidth="1.5"
            />
            <path
              ref={laChamberRef}
              d="M 160 94 C 204 82, 248 106, 248 148 C 248 166, 216 176, 162 172 Z"
              fill="rgba(250, 204, 21, 0.08)"
              stroke="rgba(148, 163, 184, 0.3)"
              strokeWidth="1.5"
            />
            <path
              ref={rvChamberRef}
              d="M 72 178 C 72 240, 108 290, 150 310 L 152 178 Z"
              fill="rgba(56, 189, 248, 0.1)"
              stroke="rgba(148, 163, 184, 0.3)"
              strokeWidth="1.5"
            />
            <path
              ref={lvChamberRef}
              d="M 162 178 L 164 310 C 212 292, 250 240, 250 178 Z"
              fill="rgba(244, 114, 182, 0.1)"
              stroke="rgba(148, 163, 184, 0.3)"
              strokeWidth="1.5"
            />

            {/* Chamber Labels */}
            <g className="chamber-labels" fontSize="11" fontWeight="700" fill="rgba(226, 232, 240, 0.55)">
              <text x="92" y="148" textAnchor="middle">RA</text>
              <text x="226" y="148" textAnchor="middle">LA</text>
              <text x="108" y="236" textAnchor="middle">RV</text>
              <text x="212" y="236" textAnchor="middle">LV</text>
            </g>

            {/* Conduction Pathways */}
            <g fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path ref={saAvPathRef} d={PATH_SA_TO_AV} stroke="rgba(250, 204, 21, 0.45)" strokeWidth="2.5" strokeDasharray="4 4" />
              <path ref={bachPathRef} d={PATH_BACHMANN} stroke="rgba(250, 204, 21, 0.4)" strokeWidth="2.2" strokeDasharray="4 4" />
              <path ref={hisPathRef} d={PATH_HIS} stroke="rgba(253, 224, 71, 0.7)" strokeWidth="3.5" />
              <path
                ref={rbbPathRef}
                d={PATH_RBB}
                stroke={
                  mode === 'rbbb'
                    ? 'rgba(248, 113, 113, 0.4)'
                    : mode === 'incomplete_rbbb'
                      ? 'rgba(251, 191, 36, 0.65)'
                      : 'rgba(56, 189, 248, 0.65)'
                }
                strokeWidth="3"
                strokeDasharray={mode === 'rbbb' ? '5 5' : undefined}
              />
              <path
                ref={lbbPathRef}
                d={PATH_LBB}
                stroke={
                  mode === 'lbbb'
                    ? 'rgba(248, 113, 113, 0.4)'
                    : mode === 'incomplete_lbbb'
                      ? 'rgba(251, 191, 36, 0.65)'
                      : 'rgba(244, 114, 182, 0.7)'
                }
                strokeWidth="3"
                strokeDasharray={mode === 'lbbb' ? '5 5' : undefined}
              />

              {/* Slow trans-septal cell-to-cell bypass guides when blocked */}
              <path
                ref={bypassRvLvRef}
                d={PATH_BYPASS_RV_LV}
                stroke="rgba(249, 115, 22, 0.35)"
                strokeWidth="2"
                strokeDasharray="3 5"
                style={{ opacity: mode === 'lbbb' ? 1 : 0 }}
              />
              <path
                ref={bypassLvRvRef}
                d={PATH_BYPASS_LV_RV}
                stroke="rgba(249, 115, 22, 0.35)"
                strokeWidth="2"
                strokeDasharray="3 5"
                style={{ opacity: mode === 'rbbb' ? 1 : 0 }}
              />
            </g>

            {/* Red Block Cut Markers for LBBB / RBBB */}
            {mode === 'lbbb' && (
              <g transform="translate(173 218)" stroke="#ef4444" strokeWidth="3.5" strokeLinecap="round">
                <line x1="-8" y1="-8" x2="8" y2="8" />
                <line x1="8" y1="-8" x2="-8" y2="8" />
              </g>
            )}
            {mode === 'rbbb' && (
              <g transform="translate(144 218)" stroke="#ef4444" strokeWidth="3.5" strokeLinecap="round">
                <line x1="-8" y1="-8" x2="8" y2="8" />
                <line x1="8" y1="-8" x2="-8" y2="8" />
              </g>
            )}

            {/* SA & AV Nodes */}
            <circle ref={saNodeRef} cx="108" cy="110" r="8" fill="#fde047" filter="url(#elecGlow)" />
            <text x="86" y="102" fontSize="10.5" fontWeight="700" fill="#fef08a">SA</text>

            <circle ref={avNodeRef} cx="152" cy="162" r="7" fill="#fb923c" filter="url(#elecGlow)" />
            <text x="165" y="159" fontSize="10.5" fontWeight="700" fill="#fdba74">AV</text>

            {/* Animated Glowing Light Pulses */}
            <g>
              <circle ref={haloAtria1Ref} r="14" fill="url(#orbHalo)" style={{ opacity: 0 }} />
              <circle ref={orbAtria1Ref} r="5" fill="#fef9c3" filter="url(#elecGlow)" style={{ opacity: 0 }} />

              <circle ref={haloAtria2Ref} r="13" fill="url(#orbHalo)" style={{ opacity: 0 }} />
              <circle ref={orbAtria2Ref} r="4.5" fill="#fef9c3" filter="url(#elecGlow)" style={{ opacity: 0 }} />

              <circle ref={haloHisRef} r="15" fill="url(#orbHalo)" style={{ opacity: 0 }} />
              <circle ref={orbHisRef} r="5.5" fill="#ffffff" filter="url(#elecGlow)" style={{ opacity: 0 }} />

              <circle ref={haloRbbRef} r="15" fill="url(#orbHalo)" style={{ opacity: 0 }} />
              <circle ref={orbRbbRef} r="5.5" fill="#e0f2fe" filter="url(#elecGlow)" style={{ opacity: 0 }} />

              <circle ref={haloLbbRef} r="15" fill="url(#orbHalo)" style={{ opacity: 0 }} />
              <circle ref={orbLbbRef} r="5.5" fill="#fce7f3" filter="url(#elecGlow)" style={{ opacity: 0 }} />

              <circle ref={haloBypassRef} r="16" fill="url(#bypassHalo)" style={{ opacity: 0 }} />
              <circle ref={orbBypassRef} r="5.5" fill="#ffedd5" filter="url(#elecGlow)" style={{ opacity: 0 }} />
            </g>
          </g>
        </svg>
      </div>

      {/* Synchronized Live P-QRS-T Waveform */}
      <div className="mini-ecg-wrap" dir="ltr">
        <canvas
          ref={miniEcgRef}
          width={360}
          height={68}
          className="mini-ecg-canvas"
          aria-label="גל אק״ג חי המסונכרן לנקודת האור"
        />
      </div>
      <div ref={phaseLabelRef} className="phase-readout">
        מנוחה דיאסטולית
      </div>

      {/* Highlighted 5-Step Teaching Legend */}
      <ol className="conduction-steps">
        {STEPS.map((s, idx) => (
          <li
            key={s.id}
            ref={(el) => {
              stepElsRef.current[idx] = el;
            }}
          >
            <span>{s.title}</span>
            <span className="step-wave">{s.wave}</span>
          </li>
        ))}
      </ol>
    </div>
  );
};

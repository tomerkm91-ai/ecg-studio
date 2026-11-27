import React, { useEffect, useRef, useState } from 'react';
import { Download, Sparkles } from 'lucide-react';
import { BEAT_REVIEW_LABELS, serializeBeatReview } from '../lib/beatAnalysis';
import type { BeatComparisonState } from '../types/ecg';

interface BeatCompareTabProps {
  comparison: BeatComparisonState;
  onLabelChange: (beatIndex: number, label: string) => void;
}

export const BeatCompareTab: React.FC<BeatCompareTabProps> = ({
  comparison,
  onLabelChange,
}) => {
  const [selectedIdx, setSelectedIdx] = useState<number>(comparison.topIndex);
  const cvRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setSelectedIdx(comparison.topIndex);
  }, [comparison.sourceName, comparison.topIndex]);

  const current = comparison.rows[selectedIdx] ?? comparison.rows[0];

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv || !current) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = 860;
    const H = 265;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);

    // Background
    g.fillStyle = '#0e1620';
    g.fillRect(0, 0, W, H);

    const padL = 62;
    const padR = 24;
    const padT = 22;
    const padB = 38;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const minV = Math.min(-0.15, ...current.values, ...current.reference);
    const maxV = Math.max(0.15, ...current.values, ...current.reference);
    const rangeV = Math.max(0.05, maxV - minV);

    const x = (i: number) => padL + (plotW * i) / (current.values.length - 1);
    const y = (v: number) => padT + plotH - ((v - minV) / rangeV) * plotH;

    // Grid lines
    g.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const gy = padT + (plotH * k) / 4;
      g.beginPath();
      g.moveTo(padL, gy);
      g.lineTo(W - padR, gy);
      g.stroke();
    }

    // Zero voltage line
    if (minV < 0 && maxV > 0) {
      g.strokeStyle = 'rgba(148, 163, 184, 0.3)';
      g.beginPath();
      g.moveTo(padL, y(0));
      g.lineTo(W - padR, y(0));
      g.stroke();
    }

    // Beat marker dashed line (t = 0)
    const x0 = x(comparison.preSamples);
    g.setLineDash([5, 4]);
    g.strokeStyle = 'rgba(148, 163, 184, 0.65)';
    g.beginPath();
    g.moveTo(x0, padT);
    g.lineTo(x0, padT + plotH);
    g.stroke();
    g.setLineDash([]);

    // Shaded difference area between selected beat and reference
    g.fillStyle = 'rgba(192, 132, 252, 0.14)';
    g.beginPath();
    current.values.forEach((val, i) => {
      if (i === 0) g.moveTo(x(i), y(val));
      else g.lineTo(x(i), y(val));
    });
    for (let i = current.reference.length - 1; i >= 0; i--) {
      g.lineTo(x(i), y(current.reference[i]));
    }
    g.closePath();
    g.fill();

    // Leave-one-out median reference curve (teal/green)
    g.strokeStyle = '#2dd4bf';
    g.lineWidth = 2.2;
    g.beginPath();
    current.reference.forEach((val, i) => {
      if (i === 0) g.moveTo(x(i), y(val));
      else g.lineTo(x(i), y(val));
    });
    g.stroke();

    // Selected beat curve (violet/magenta)
    g.strokeStyle = '#c084fc';
    g.lineWidth = 2.6;
    g.beginPath();
    current.values.forEach((val, i) => {
      if (i === 0) g.moveTo(x(i), y(val));
      else g.lineTo(x(i), y(val));
    });
    g.stroke();

    // Axis labels
    g.direction = 'ltr';
    g.fillStyle = '#94a3b8';
    g.font = '12px ui-monospace, SFMono-Regular, monospace';
    g.textAlign = 'left';
    g.fillText(`${maxV.toFixed(2)} mV`, 6, padT + 6);
    g.fillText(`${minV.toFixed(2)} mV`, 6, padT + plotH);

    const preMs = Math.round((comparison.preSamples / comparison.fs) * 1000);
    const postMs = Math.round(
      ((current.values.length - comparison.preSamples - 1) / comparison.fs) * 1000
    );
    g.textAlign = 'left';
    g.fillText(`-${preMs} ms`, padL, H - 12);
    g.textAlign = 'center';
    g.fillText('0 ms', x0, H - 12);
    g.textAlign = 'right';
    g.fillText(`+${postMs} ms`, W - padR, H - 12);
  }, [current, comparison]);

  const handleExport = () => {
    const json = serializeBeatReview(comparison);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'beat-review.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const ranked = comparison.rows
    .slice()
    .sort((a, b) => b.rmsMv - a.rmsMv);
  const maxRms = Math.max(0.001, ranked[0]?.rmsMv ?? 1);

  return (
    <div className="tab-stack">
      <div className="card">
        <div className="card-header-row">
          <div>
            <h2>השוואה מורפולוגית בין פעימות</h2>
            <p className="muted">
              כל פעימה מושווית לצורה החציונית של שאר הפעימות ברצועה (Leave-One-Out Median, חלון ‎-160 עד ‎+320 ms).
              שינוי צורה, רעש או תזמון שגוי מעלים את מדד ה־RMS.
            </p>
          </div>
          <button type="button" className="btn ghost sm" onClick={handleExport}>
            <Download size={15} />
            ייצוא תיוגים (JSON)
          </button>
        </div>

        <div className="source-chip">{comparison.sourceName}</div>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <label className="field-inline">
            <span>פעימה לבדיקה</span>
            <select
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
            >
              {comparison.rows.map((r) => (
                <option key={r.index} value={r.index}>
                  פעימה {r.index + 1} · {r.timeSec.toFixed(2)} s (RMS {r.rmsMv.toFixed(3)} mV)
                  {r.label ? ` · ${r.label}` : ''}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="btn secondary sm"
            onClick={() => setSelectedIdx(comparison.topIndex)}
          >
            <Sparkles size={15} />
            קפוץ לחריגה הגדולה ביותר (#{comparison.topIndex + 1})
          </button>

          <label className="field-inline push-end">
            <span>תיוג הקורא</span>
            <select
              value={current?.label ?? ''}
              onChange={(e) => onLabelChange(current.index, e.target.value)}
            >
              {BEAT_REVIEW_LABELS.map((lbl) => (
                <option key={lbl} value={lbl}>
                  {lbl || 'טרם נבדק'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Overlay Plot */}
      <div className="card">
        <canvas
          ref={cvRef}
          className="beat-plot-canvas"
          aria-label="השוואת הפעימה הנבחרת מול ייחוס חציוני"
        />
        <div className="legend-row">
          <span>
            <i className="swatch swatch-beat" /> הפעימה הנבחרת (#{current.index + 1})
          </span>
          <span>
            <i className="swatch swatch-ref" /> ייחוס חציוני (שאר הרצועה)
          </span>
          <span className="num push-end">
            הפרש RMS: <b>{current.rmsMv.toFixed(3)} mV</b> · זמן: {current.timeSec.toFixed(2)} s
          </span>
        </div>
      </div>

      {/* Ranked Beat Outlier List */}
      <div className="card">
        <h3>דירוג כל הפעימות לפי חריגה מורפולוגית ({comparison.rows.length})</h3>
        <div className="beat-rank-grid">
          {ranked.map((r) => {
            const pct = Math.max(4, Math.round((r.rmsMv / maxRms) * 100));
            const active = r.index === current.index;
            return (
              <button
                key={r.index}
                type="button"
                className={`beat-rank-item ${active ? 'active' : ''}`}
                onClick={() => setSelectedIdx(r.index)}
              >
                <div className="beat-rank-top">
                  <strong>
                    פעימה #{r.index + 1}
                    {r.index === comparison.topIndex && (
                      <span className="pill pill-ivcd" style={{ marginInlineStart: 6 }}>
                        שיא חריגה
                      </span>
                    )}
                  </strong>
                  <span className="num">{r.rmsMv.toFixed(3)} mV</span>
                </div>
                <div className="beat-rank-bar">
                  <div className="beat-rank-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="beat-rank-meta muted">
                  <span className="num">{r.timeSec.toFixed(2)} s</span>
                  <span>{r.label || 'לא מתויג'}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

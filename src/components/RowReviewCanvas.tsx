import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, Trash2 } from 'lucide-react';
import type { InspectOptions, InspectResult, LeadOrder } from '../types/ecg';

interface RowReviewCanvasProps {
  data: InspectResult;
  disabled: boolean;
  onRelayout: (opts: InspectOptions) => void;
  onAnalyze: (opts: InspectOptions) => void;
}

const MAX_AUTO_SHOWN = 14;

export const RowReviewCanvas: React.FC<RowReviewCanvasProps> = ({
  data,
  disabled,
  onRelayout,
  onAnalyze,
}) => {
  const layouts = data.layouts || {};
  const initialRows = (() => {
    const sorted = (data.rows || []).slice().sort((a, b) => a - b);
    if (!data.ok && !data.layout && sorted.length > MAX_AUTO_SHOWN) return [];
    return sorted;
  })();

  const [rows, setRows] = useState<number[]>(initialRows);
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const [imgLoaded, setImgLoaded] = useState(false);

  const layout = data.layout || '';
  const order: LeadOrder = data.lead_order || 'standard';
  const sc = data.preview_scale || 1;
  const pageH = data.page_h || 1000;

  const cvRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ active: boolean; idx: number }>({ active: false, idx: -1 });

  // Reset rows whenever inspect payload changes
  useEffect(() => {
    const sorted = (data.rows || []).slice().sort((a, b) => a - b);
    setRows(!data.ok && !data.layout && sorted.length > MAX_AUTO_SHOWN ? [] : sorted);
    setSelectedIdx(-1);
  }, [data]);

  // Load preview image
  useEffect(() => {
    setImgLoaded(false);
    if (!data.preview) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = data.preview;
  }, [data.preview]);

  const wanted = layouts[layout]?.n_rows ?? 0;
  const labels = layouts[layout]?.labels?.[order] ?? [];
  const countMatches = Boolean(layout && rows.length === wanted);

  const draw = useCallback(() => {
    const cv = cvRef.current;
    const img = imgRef.current;
    if (!cv || !img || !img.width) return;

    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(img, 0, 0);

    const k = cv.width / 700;
    const fs = Math.round(15 * k);
    const pad = Math.round(5 * k);
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.font = `700 ${fs}px system-ui, -apple-system, sans-serif`;

    const tags = rows.map((_, i) => (countMatches && labels[i] ? labels[i] : String(i + 1)));
    const maxW = Math.max(...tags.map((t) => ctx.measureText(t).width), 1);

    rows.forEach((y, i) => {
      const vy = y * sc;
      const isSel = i === selectedIdx;
      ctx.lineWidth = Math.max(1.6, (isSel ? 3.2 : 2) * k);
      ctx.strokeStyle = isSel ? '#ffb020' : countMatches ? '#2bd4a8' : '#ff6b6b';
      ctx.beginPath();
      ctx.moveTo(0, vy);
      ctx.lineTo(cv.width, vy);
      ctx.stroke();

      const w = ctx.measureText(tags[i]).width + 2 * pad;
      const h = fs + pad;
      const ty = Math.max(h, vy - pad);
      const x = pad + (i % 2) * (maxW + 3 * pad);

      ctx.fillStyle = 'rgba(8, 13, 20, 0.85)';
      ctx.fillRect(x, ty - h, w, h);
      ctx.fillStyle = isSel ? '#ffb020' : '#edf4fa';
      ctx.fillText(tags[i], x + pad, ty - pad * 0.78);
    });
  }, [rows, selectedIdx, countMatches, labels, sc]);

  useEffect(() => {
    if (imgLoaded) draw();
  }, [imgLoaded, draw]);

  const toPageY = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const cv = cvRef.current;
    if (!cv) return 0;
    const r = cv.getBoundingClientRect();
    return Math.round(((e.clientY - r.top) * (cv.height / r.height)) / sc);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.preventDefault();
    const py = Math.max(0, Math.min(pageH - 1, toPageY(e)));

    let grab = 16 / sc;
    if (rows.length > 2) {
      const gaps = rows
        .slice(1)
        .map((y, idx) => y - rows[idx])
        .sort((a, b) => a - b);
      grab = Math.min(grab, 0.4 * gaps[Math.floor(gaps.length / 2)]);
    }

    let bestIdx = -1;
    let bestDist = Infinity;
    rows.forEach((y, i) => {
      const d = Math.abs(y - py);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });

    if (bestIdx >= 0 && bestDist <= grab) {
      setSelectedIdx(bestIdx);
      dragRef.current = { active: true, idx: bestIdx };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      const next = [...rows, py].sort((a, b) => a - b);
      setRows(next);
      setSelectedIdx(next.indexOf(py));
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current.active || dragRef.current.idx < 0) return;
    const py = Math.max(0, Math.min(pageH - 1, toPageY(e)));
    const idx = dragRef.current.idx;
    setRows((prev) => {
      const copy = prev.slice();
      copy[idx] = py;
      return copy;
    });
  };

  const finishDrag = () => {
    if (!dragRef.current.active) return;
    const idx = dragRef.current.idx;
    dragRef.current = { active: false, idx: -1 };
    setRows((prev) => {
      const y = prev[idx];
      const sorted = prev.slice().sort((a, b) => a - b);
      setSelectedIdx(sorted.indexOf(y));
      return sorted;
    });
  };

  const handleDeleteSelected = () => {
    if (selectedIdx < 0) return;
    setRows((prev) => prev.filter((_, i) => i !== selectedIdx));
    setSelectedIdx(-1);
  };

  const handleReset = () => {
    setRows(initialRows);
    setSelectedIdx(-1);
  };

  const rotateReq = String(data.rotate_req ?? 'auto');

  const handleAnalyzeClick = () => {
    if (layout && rows.length !== wanted) {
      const ok = window.confirm(
        `מספר השורות (${rows.length}) אינו תואם לפריסה ${layout} (${wanted}). להמשיך בכל זאת?`
      );
      if (!ok) return;
    }
    onAnalyze({
      rows: rows.slice().sort((a, b) => a - b),
      layout: layout || null,
      lead_order: order,
      rotate: String(data.rotate_deg ?? 0),
    });
  };

  const m = data.meta || {};
  const scaleSrcMap: Record<string, string> = {
    grid: 'מהרשת',
    'grid (5 mm boxes)': 'מהרשת (משבצות 5 מ״מ)',
    'calibration pulse': 'מפולס הכיול',
  };
  const anchorSrcMap: Record<string, string> = {
    baselines: 'קווי בסיס',
    components: 'רכיבים מחוברים',
    caller: 'ידני',
  };

  const matchingLayouts = Object.keys(layouts).filter(
    (k) => layouts[k].n_rows === rows.length
  );

  return (
    <div className={`card review-card ${disabled ? 'is-disabled' : ''}`}>
      <div className="review-head">
        <h3>בדיקת שורות התרשים לפני הניתוח</h3>
        <p className="muted">
          גררו קו כדי להזיז אותו, הקישו על אזור פנוי כדי להוסיף שורה, או בחרו קו ולחצו ״מחק״.
          חשוב שיהיה <b>קו אחד על כל עקומה בסדר הנכון</b>.
        </p>
      </div>

      {!data.ok && data.error && (
        <div className="error-box">
          <b>הזיהוי האוטומטי נכשל:</b> {data.error}
          <div className="muted" style={{ marginTop: 4 }}>
            הקווים למטה הם ניחוש ראשוני. בחרו פריסה מתאימה, תקנו את הקווים ולחצו ״נתח תרשים״.
          </div>
        </div>
      )}

      <div className="review-canvas-wrap">
        <canvas
          ref={cvRef}
          className="review-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        />
      </div>

      <div className="review-toolbar">
        <label className="field-inline">
          <span>פריסה</span>
          <select
            value={layout}
            disabled={disabled}
            onChange={(e) =>
              onRelayout({
                layout: e.target.value || null,
                lead_order: order,
                rotate: rotateReq,
              })
            }
          >
            <option value="">אוטומטי</option>
            {Object.keys(layouts).map((k) => (
              <option key={k} value={k}>
                {k} ({layouts[k].n_rows} שורות)
              </option>
            ))}
          </select>
        </label>

        <label className="field-inline">
          <span>סדר לידים</span>
          <select
            value={order}
            disabled={disabled}
            onChange={(e) =>
              onRelayout({
                layout: layout || null,
                lead_order: e.target.value as LeadOrder,
                rotate: rotateReq,
              })
            }
          >
            <option value="standard">תקני</option>
            <option value="norav">Norav</option>
          </select>
        </label>

        <button
          type="button"
          className="btn ghost"
          disabled={disabled || selectedIdx < 0}
          onClick={handleDeleteSelected}
        >
          <Trash2 size={15} />
          מחק שורה
        </button>

        <button
          type="button"
          className="btn ghost"
          disabled={disabled}
          onClick={handleReset}
        >
          <RotateCcw size={15} />
          איפוס
        </button>

        <button
          type="button"
          className="btn accent push-end"
          disabled={disabled || rows.length < 3}
          onClick={handleAnalyzeClick}
        >
          <Play size={16} />
          נתח תרשים
        </button>
      </div>

      <div className="review-meta">
        <div className={countMatches ? 'muted' : 'status-warn'}>
          {!layout
            ? rows.length
              ? `זוהו ${rows.length} שורות. בחרו פריסה כדי להציג את שמות החיבורים.`
              : 'בחרו פריסה או הניחו קווים על העקומות.'
            : countMatches
              ? `${rows.length} שורות — תואם לפריסה ${layout}.`
              : `${rows.length} שורות, אבל ${layout} מצפה ל־${wanted}.${
                  matchingLayouts.length
                    ? ` פריסות מתאימות: ${matchingLayouts.join(', ')}.`
                    : ''
                }`}
        </div>

        {data.ok && m.px_per_mm && (
          <div className="muted">
            קנה מידה {m.px_per_mm} px/mm ({scaleSrcMap[m.scale_from || ''] || m.scale_from}) · הגבר{' '}
            {m.gain_mm_per_mv} mm/mV · אורך שורה {m.duration_s} שניות · עוגנים:{' '}
            {anchorSrcMap[m.rows_from || ''] || m.rows_from}
            {m.gain_note && (
              <div className="status-warn" style={{ marginTop: 4 }}>
                ⚠ פולס הכיול לא נקרא בדף זה; ההגבר נלקח כתקן 10 mm/mV לפי הרשת.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

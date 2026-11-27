import React, { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, RotateCcw, Undo2 } from 'lucide-react';
import { prepareEcgPhoto } from '../lib/photoPrepare';
import { calibrateManualBeats, type Point2D } from '../lib/timing';

interface ManualBeatMarkerProps {
  photoFile: File | null;
  onApplyBeats: (beats: number[]) => void;
}

export const ManualBeatMarker: React.FC<ManualBeatMarkerProps> = ({
  photoFile,
  onApplyBeats,
}) => {
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [points, setPoints] = useState<Point2D[]>([]);
  const [calSeconds, setCalSeconds] = useState<number>(1);
  const [status, setStatus] = useState<string>(
    'בחרו צילום אק״ג (או השתמשו בצילום שנטען למעלה). עובד באופן מלא גם ללא אינטרנט.'
  );
  const [error, setError] = useState<string | null>(null);
  const [imgReady, setImgReady] = useState(false);

  const activeFile = localFile ?? photoFile;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalFile(null);
  }, [photoFile]);

  useEffect(() => {
    let cancelled = false;
    setPoints([]);
    setError(null);
    setImgReady(false);
    imgRef.current = null;

    if (!activeFile) {
      setStatus('בחרו צילום אק״ג לסימון ידני.');
      return;
    }

    (async () => {
      try {
        setStatus('טוען את הצילום לסימון…');
        const prepared = await prepareEcgPhoto(activeFile);
        if (cancelled) return;
        const url = URL.createObjectURL(prepared);
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('לא ניתן לפתוח את הצילום.'));
          img.src = url;
        });
        URL.revokeObjectURL(url);
        if (cancelled) return;
        imgRef.current = img;
        setImgReady(true);
        setStatus('שלב 1: סמנו את נקודת הכיול הראשונה (A) על רצועת הקצב.');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'הצילום לא נפתח.');
          setStatus('');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeFile]);

  useEffect(() => {
    const cv = cvRef.current;
    const img = imgRef.current;
    if (!cv || !img || !imgReady) return;

    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const radius = Math.max(5, cv.width * 0.0055);

    // Draw calibration baseline segment between A and B
    if (points.length >= 2) {
      ctx.strokeStyle = '#00a8b5';
      ctx.lineWidth = Math.max(2, radius * 0.4);
      ctx.setLineDash([radius * 1.4, radius]);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      ctx.lineTo(points[1].x, points[1].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.direction = 'ltr';
    ctx.font = `700 ${Math.round(radius * 2.2)}px system-ui, Arial, sans-serif`;

    points.forEach((p, idx) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = idx < 2 ? '#00a8b5' : '#9c4dff';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, radius * 0.25);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      const label = idx < 2 ? 'AB'[idx] : String(idx - 1);
      ctx.fillStyle = '#0c1218';
      ctx.fillText(label, p.x + radius * 1.1 + 1, p.y - radius * 0.6 + 1);
      ctx.fillStyle = idx < 2 ? '#00d9ea' : '#d2a8ff';
      ctx.fillText(label, p.x + radius * 1.1, p.y - radius * 0.6);
    });

    if (points.length === 0) {
      setStatus('שלב 1: סמנו את נקודת הכיול הראשונה (A).');
    } else if (points.length === 1) {
      setStatus('שלב 2: סמנו את נקודת הכיול השנייה (B) מימין ל־A בהפרש הזמן שבחרתם.');
    } else {
      setStatus(`סומנו ${points.length - 2} פעימות QRS. סמנו לפחות שתיים ולחצו ״הפעל סנכרון״.`);
    }
  }, [points, imgReady]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = cvRef.current;
    if (!cv) return;
    setError(null);
    const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) * cv.width) / r.width;
    const y = ((e.clientY - r.top) * cv.height) / r.height;
    setPoints((prev) => [...prev, { x, y }]);
  };

  const handleApply = () => {
    setError(null);
    try {
      const beats = calibrateManualBeats(points, calSeconds);
      onApplyBeats(beats);
      setStatus(`המודל התלת־ממדי מסונכרן כעת לפי ${beats.length} פעימות ידניות.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה בכיול הסימונים.');
    }
  };

  return (
    <div className="manual-box">
      <p className="muted">
        על אותה רצועת קצב רציפה סמנו שתי נקודות כיול משמאל לימין שהפרש הזמן ביניהן ידוע (ב־25 מ״מ לשנייה, 5 ריבועים גדולים = שנייה אחת), ולאחר מכן סמנו את תחילת כל QRS לפי הסדר.
      </p>

      <div className="btn-row">
        <button
          type="button"
          className="btn secondary sm"
          onClick={() => pickerRef.current?.click()}
        >
          <FolderOpen size={15} />
          בחירת צילום אחר
        </button>
        <input
          ref={pickerRef}
          type="file"
          accept="image/*,.heic,.heif"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) setLocalFile(f);
          }}
        />

        <label className="field-inline">
          <span>שניות בין A ל־B</span>
          <input
            type="number"
            min={0.01}
            max={60}
            step={0.01}
            value={calSeconds}
            onChange={(e) => setCalSeconds(Number(e.target.value))}
            style={{ width: 78 }}
          />
        </label>

        <button
          type="button"
          className="btn ghost sm"
          disabled={points.length === 0}
          onClick={() => setPoints((p) => p.slice(0, -1))}
        >
          <Undo2 size={15} />
          בטל אחרון
        </button>

        <button
          type="button"
          className="btn ghost sm"
          disabled={points.length === 0}
          onClick={() => {
            setPoints([]);
            setError(null);
          }}
        >
          <RotateCcw size={15} />
          נקה
        </button>

        <button
          type="button"
          className="btn accent sm push-end"
          disabled={points.length < 4}
          onClick={handleApply}
        >
          <Check size={15} />
          הפעל סנכרון
        </button>
      </div>

      {status && (
        <p className="status-line" role="status">
          {status}
        </p>
      )}
      {error && <p className="status-warn">{error}</p>}

      {imgReady && (
        <div className="paper-canvas-wrap">
          <canvas
            ref={cvRef}
            className="paper-canvas"
            onClick={handleCanvasClick}
          />
        </div>
      )}
    </div>
  );
};

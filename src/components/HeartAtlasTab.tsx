import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Box,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Zap,
} from 'lucide-react';
import {
  type ConductionMode,
  verdictToConductionMode,
} from '../lib/conductionTiming';
import { clamp, sampleBeatPhase } from '../lib/timing';
import type { ActiveBeatSync, VerdictKey } from '../types/ecg';
import { CardiacConductionView } from './CardiacConductionView';
import { ManualBeatMarker } from './ManualBeatMarker';

interface SketchfabApi {
  start: () => void;
  play: () => void;
  pause: () => void;
  addEventListener: (event: string, cb: () => void) => void;
  getAnimations: (
    cb: (err: unknown, clips?: Array<[string, string, number]>) => void
  ) => void;
  setCurrentAnimationByUID: (uid: string, cb: (err: unknown) => void) => void;
  seekTo: (sec: number, cb: (err: unknown) => void) => void;
}

declare global {
  interface Window {
    Sketchfab?: new (iframe: HTMLIFrameElement) => {
      init: (
        uid: string,
        opts: {
          autostart: number;
          ui_animations: number;
          success: (api: SketchfabApi) => void;
          error: () => void;
        }
      ) => void;
    };
  }
}

const MODEL_UID = '168b474fba564f688048212e99b4159d';
const SKETCHFAB_SCRIPT = 'https://static.sketchfab.com/api/sketchfab-viewer-1.12.1.js';
const DEFAULT_RR_MS = 833; // ~72 bpm pacemaker when no ECG strip is loaded yet

type HeartViewLayout = 'both' | 'electrical' | '3d';

interface HeartAtlasTabProps {
  visible: boolean;
  beatSync: ActiveBeatSync | null;
  photoFile: File | null;
  openManualSignal: number;
  onApplyManualBeats: (beats: number[]) => void;
  conductionVerdict?: VerdictKey;
  prMs?: number | null;
  qrsMs?: number | null;
  qtMs?: number | null;
}

function loadSketchfabScript(): Promise<void> {
  if (window.Sketchfab) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SKETCHFAB_SCRIPT}"]`
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('load failed')), {
        once: true,
      });
      return;
    }
    const script = document.createElement('script');
    script.src = SKETCHFAB_SCRIPT;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('load failed'));
    document.head.appendChild(script);
  });
}

export const HeartAtlasTab: React.FC<HeartAtlasTabProps> = ({
  visible,
  beatSync,
  photoFile,
  openManualSignal,
  onApplyManualBeats,
  conductionVerdict,
  prMs,
  qrsMs,
  qtMs,
}) => {
  const [modelState, setModelState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelMsg, setModelMsg] = useState('טוען את מודל הלב התלת־ממדי של Doctor Jana…');
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(1);
  const [cycles, setCycles] = useState<number>(1);
  const [offsetPct, setOffsetPct] = useState<number>(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [viewLayout, setViewLayout] = useState<HeartViewLayout>('both');
  const [conductionMode, setConductionMode] = useState<ConductionMode>(() =>
    verdictToConductionMode(conductionVerdict)
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const traceCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const readingRef = useRef<HTMLOutputElement>(null);
  const manualDetailsRef = useRef<HTMLDetailsElement>(null);

  const apiRef = useRef<SketchfabApi | null>(null);
  const clipDurRef = useRef<number>(0);
  const stripTimeRef = useRef<number>(0);
  const freePhaseRef = useRef<number>(0);
  const clockRef = useRef<{ phase: number; rrMs: number }>({
    phase: 0,
    rrMs: DEFAULT_RR_MS,
  });

  const playingRef = useRef<boolean>(playing);
  const speedRef = useRef<number>(speed);
  const cyclesRef = useRef<number>(cycles);
  const offsetRef = useRef<number>(offsetPct);
  const visibleRef = useRef<boolean>(visible);
  const beatSyncRef = useRef<ActiveBeatSync | null>(beatSync);
  const viewLayoutRef = useRef<HeartViewLayout>(viewLayout);
  const seekBusyRef = useRef<boolean>(false);
  const lastSeekRef = useRef<number>(-1);
  const lastReqRef = useRef<number>(0);
  const attemptRef = useRef<number>(0);

  playingRef.current = playing;
  speedRef.current = speed;
  cyclesRef.current = cycles;
  offsetRef.current = offsetPct;
  visibleRef.current = visible;
  beatSyncRef.current = beatSync;
  viewLayoutRef.current = viewLayout;

  // Sync electrical conduction mode automatically when a new ECG verdict arrives
  useEffect(() => {
    setConductionMode(verdictToConductionMode(conductionVerdict));
  }, [conductionVerdict]);

  useEffect(() => {
    if (openManualSignal > 0) {
      setManualOpen(true);
      setTimeout(() => {
        manualDetailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
  }, [openManualSignal]);

  const configureModelMode = useCallback(() => {
    const api = apiRef.current;
    const dur = clipDurRef.current;
    if (!api || !dur) return;
    if (beatSyncRef.current && beatSyncRef.current.beats.length >= 2) {
      api.pause();
      setModelMsg(
        'הניגון מסונכרן למרווחי QRS ולמהלך ההולכה החשמלית. ניתן לכייל פאזה ומספר פעימות למטה.'
      );
    } else {
      if (playingRef.current) api.play();
      else api.pause();
      setModelMsg(
        'המודל פועל בקצב בסיס של 72 פעימות לדקה. לאחר ניתוח אק״ג או סימון ידני הוא יסתנכרן לרצועה.'
      );
    }
  }, []);

  // Keep Sketchfab play/pause in sync with `playing` in free-running mode
  useEffect(() => {
    const api = apiRef.current;
    const dur = clipDurRef.current;
    if (!api || !dur) return;
    if (!beatSync || beatSync.beats.length < 2) {
      if (playing) api.play();
      else api.pause();
    }
  }, [playing, beatSync]);

  const startModelLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const attempt = ++attemptRef.current;
    apiRef.current = null;
    clipDurRef.current = 0;
    setModelState('loading');
    setModelMsg('טוען את מודל הלב מ־Sketchfab…');

    const fail = () => {
      if (attempt !== attemptRef.current || clipDurRef.current > 0) return;
      attemptRef.current++;
      setModelState('error');
      setModelMsg(
        'נגן הלב התלת־ממדי לא נטען (נדרש חיבור ל־Sketchfab). ההדמיה החשמלית ממשיכה לפעול כרגיל.'
      );
    };

    const timer = window.setTimeout(fail, 25000);

    loadSketchfabScript()
      .then(() => {
        if (attempt !== attemptRef.current || !window.Sketchfab) return fail();
        new window.Sketchfab(iframe).init(MODEL_UID, {
          autostart: 1,
          ui_animations: 0,
          success: (api) => {
            api.addEventListener('viewerready', () => {
              api.getAnimations((err, clips) => {
                if (attempt !== attemptRef.current) return;
                const clip = clips?.find((c) => c[2] > 0);
                if (err || !clip) return fail();
                api.setCurrentAnimationByUID(clip[0], (e2) => {
                  if (attempt !== attemptRef.current) return;
                  if (e2) return fail();
                  window.clearTimeout(timer);
                  apiRef.current = api;
                  clipDurRef.current = clip[2];
                  setModelState('ready');
                  configureModelMode();
                });
              });
            });
            api.start();
          },
          error: fail,
        });
      })
      .catch(fail);
  }, [configureModelMode]);

  // Auto-load Sketchfab once when tab first becomes visible (if 3D is shown)
  useEffect(() => {
    if (visible && viewLayout !== 'electrical' && modelState === 'idle') {
      startModelLoad();
    }
  }, [visible, viewLayout, modelState, startModelLoad]);

  // Reconfigure playback whenever beatSync changes
  useEffect(() => {
    if (beatSync && beatSync.beats.length >= 2) {
      stripTimeRef.current = beatSync.beats[0];
      lastSeekRef.current = -1;
      setPlaying(true);
    }
    configureModelMode();
  }, [beatSync, configureModelMode]);

  // Paint ECG strip canvas whenever beatSync updates
  useEffect(() => {
    const cv = traceCanvasRef.current;
    if (!cv || !beatSync || beatSync.beats.length < 2) return;

    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const w = cv.width;
    const h = cv.height;
    const beats = beatSync.beats;
    const first = beats[0];
    const last = beats[beats.length - 1];
    const span = Math.max(1e-6, last - first);
    const toX = (t: number) => ((t - first) * w) / span;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(130, 160, 175, 0.14)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 35) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(168, 85, 247, 0.45)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (const b of beats) {
      const bx = toX(b);
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, h);
    }
    ctx.stroke();

    if (beatSync.mv && beatSync.fs && beatSync.fs > 0) {
      const mv = beatSync.mv;
      const fs = beatSync.fs;
      const startIdx = Math.max(0, Math.floor(first * fs));
      const endIdx = Math.min(mv.length - 1, Math.ceil(last * fs));

      let low = Infinity;
      let high = -Infinity;
      for (let i = startIdx; i <= endIdx; i++) {
        if (Number.isFinite(mv[i])) {
          low = Math.min(low, mv[i]);
          high = Math.max(high, mv[i]);
        }
      }
      const range = Math.max(0.01, high - low);

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let penUp = true;
      for (let i = startIdx; i <= endIdx; i++) {
        if (!Number.isFinite(mv[i])) {
          penUp = true;
          continue;
        }
        const px = toX(i / fs);
        const py = h - 10 - ((mv[i] - low) / range) * (h - 20);
        if (penUp) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        penUp = false;
      }
      ctx.stroke();
    }

    if (seekRef.current) {
      seekRef.current.min = String(first);
      seekRef.current.max = String(last);
      seekRef.current.value = String(first);
    }
  }, [beatSync]);

  // Shared master rAF clock driving BOTH the electrical light pulse and the 3D Sketchfab model
  useEffect(() => {
    let rafId = 0;
    let prevNow = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.15, (now - prevNow) / 1000);
      prevNow = now;

      const sync = beatSyncRef.current;
      if (sync && sync.beats.length >= 2) {
        if (playingRef.current) {
          stripTimeRef.current += dt * speedRef.current;
        }
        const sample = sampleBeatPhase(sync.beats, stripTimeRef.current);
        stripTimeRef.current = sample.wrappedTime;
        clockRef.current = {
          phase: sample.phase,
          rrMs: sample.rrSec * 1000,
        };

        if (visibleRef.current) {
          const first = sync.beats[0];
          const last = sync.beats[sync.beats.length - 1];
          const pct = ((sample.wrappedTime - first) / Math.max(1e-6, last - first)) * 100;

          if (cursorRef.current) cursorRef.current.style.left = `${pct}%`;
          if (seekRef.current) seekRef.current.value = String(sample.wrappedTime);
          if (readingRef.current) {
            readingRef.current.textContent = `${sample.wrappedTime.toFixed(2)} s · RR ${Math.round(
              sample.rrSec * 1000
            )} ms (${sample.bpm} bpm)`;
          }

          const api = apiRef.current;
          const dur = clipDurRef.current;
          if (
            viewLayoutRef.current !== 'electrical' &&
            api &&
            dur > 0 &&
            !seekBusyRef.current &&
            now - lastReqRef.current > 30
          ) {
            const c = clamp(cyclesRef.current || 1, 1, 30);
            const off = clamp(offsetRef.current || 0, 0, 99) / 100;
            const sec = (((sample.phase + off) % 1) * dur) / c;
            if (Math.abs(sec - lastSeekRef.current) > 0.001) {
              seekBusyRef.current = true;
              lastReqRef.current = now;
              lastSeekRef.current = sec;
              api.seekTo(sec, () => {
                seekBusyRef.current = false;
              });
            }
          }
        }
      } else {
        // Free-running 72 bpm pacemaker so the electrical light dot guides the beat immediately
        if (playingRef.current) {
          freePhaseRef.current =
            (freePhaseRef.current + (dt * speedRef.current) / (DEFAULT_RR_MS / 1000)) % 1;
        }
        clockRef.current = {
          phase: freePhaseRef.current,
          rrMs: DEFAULT_RR_MS,
        };
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const hasSync = Boolean(beatSync && beatSync.beats.length >= 2);

  return (
    <div className="tab-stack">
      <div className="card">
        <div className="card-header-row">
          <div>
            <h2>הולכה חשמלית והלב בתנועה</h2>
            <p className="muted">
              {hasSync
                ? beatSync!.manual
                  ? 'תזמון משותף לפי סימוני הפעימות הידניים — נקודת האור והלב התלת־ממדי פועמים לפי כל מרווח R-R.'
                  : `תזמון משותף לפי הפעימות שחולצו מהאק״ג${
                      beatSync!.lead ? ` (${beatSync!.lead})` : ''
                    }. נקודת האור מדגימה את הגירוי החשמלי שמנחה כל התכווצות.`
                : 'נקודת האור מדגימה בזמן אמת את התקדמות האות החשמלי מקשר SA עד סיבי פורקינייה. האטו ל־¼× להסבר בכיתה.'}
            </p>
          </div>

          <div className="view-toggle" role="group" aria-label="פריסת תצוגת הלב">
            <button
              type="button"
              className={`btn sm ${viewLayout === 'both' ? 'primary' : 'ghost'}`}
              onClick={() => setViewLayout('both')}
            >
              <Activity size={14} />
              משולב
            </button>
            <button
              type="button"
              className={`btn sm ${viewLayout === 'electrical' ? 'primary' : 'ghost'}`}
              onClick={() => setViewLayout('electrical')}
            >
              <Zap size={14} />
              חשמלי בלבד
            </button>
            <button
              type="button"
              className={`btn sm ${viewLayout === '3d' ? 'primary' : 'ghost'}`}
              onClick={() => setViewLayout('3d')}
            >
              <Box size={14} />
              3D בלבד
            </button>
          </div>
        </div>

        {/* Always-available playback & slow-motion controls for teaching */}
        <div className="btn-row transport-controls" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
            {playing ? 'השהיה' : 'ניגון'}
          </button>

          <label className="field-inline">
            <span>מהירות הוראה</span>
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              <option value={0.25}>¼× (איטי להדגמה)</option>
              <option value={0.5}>½×</option>
              <option value={1}>1× (קצב אמת)</option>
            </select>
          </label>

          {!hasSync && (
            <span className="muted small push-end num">
              קצב הדגמה: 72 bpm (ללא רצועת אק״ג)
            </span>
          )}
          {hasSync && (
            <output ref={readingRef} className="transport-reading num" dir="ltr" />
          )}
        </div>

        {/* Side-by-side or single-pane Heart Stage */}
        <div className={`heart-dual-grid layout-${viewLayout}`}>
          {viewLayout !== '3d' && (
            <CardiacConductionView
              clockRef={clockRef}
              mode={conductionMode}
              onChangeMode={setConductionMode}
              prMs={prMs}
              qrsMs={qrsMs}
              qtMs={qtMs}
              visible={visible}
            />
          )}

          {viewLayout !== 'electrical' && (
            <div className="heart-3d-pane">
              <div className="sketchfab-wrap">
                <iframe
                  ref={iframeRef}
                  title="הלב התלת־ממדי המונפש של Doctor Jana"
                  className="sketchfab-frame"
                  style={{ display: modelState === 'error' ? 'none' : 'block' }}
                  allow="autoplay; fullscreen"
                  allowFullScreen
                />
                {modelState === 'error' && (
                  <div className="sketchfab-fallback">
                    <p>{modelMsg}</p>
                    <button type="button" className="btn primary" onClick={startModelLoad}>
                      <RefreshCw size={15} />
                      ניסיון טעינה נוסף
                    </button>
                  </div>
                )}
              </div>

              <div className="card-footer-row">
                <span className="muted small" role="status">
                  {modelMsg}
                </span>
                <a
                  href={`https://sketchfab.com/models/${MODEL_UID}/embed`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-inline"
                >
                  פתיחה ב־Sketchfab <ExternalLink size={13} />
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Synchronized ECG Strip Scrubber when ECG beats are loaded */}
        {hasSync && (
          <div className="transport-box">
            <div className="trace-viewport" dir="ltr">
              <canvas
                ref={traceCanvasRef}
                width={1050}
                height={115}
                className="trace-canvas"
                aria-label="רצועת אק״ג וסימוני פעימות"
              />
              <div ref={cursorRef} className="trace-cursor" />
            </div>

            <input
              ref={seekRef}
              type="range"
              step={0.001}
              className="range-full"
              dir="ltr"
              aria-label="זמן ברצועת האק״ג"
              onChange={(e) => {
                if (!beatSync) return;
                setPlaying(false);
                stripTimeRef.current = Math.min(
                  Number(e.target.value),
                  beatSync.beats[beatSync.beats.length - 1] - 0.0001
                );
              }}
            />

            <details className="cal-details">
              <summary>כיול מחזור האנימציה של מודל ה־3D</summary>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <label className="field-inline">
                  <span>פעימות בקליפ</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={cycles}
                    onChange={(e) => setCycles(Number(e.target.value))}
                    style={{ width: 68 }}
                  />
                </label>
                <label className="field-inline">
                  <span>היסט במחזור (%)</span>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={offsetPct}
                    onChange={(e) => setOffsetPct(Number(e.target.value))}
                    style={{ width: 68 }}
                  />
                </label>
              </div>
            </details>
          </div>
        )}
      </div>

      {/* Offline Manual Beat Marking */}
      <details
        ref={manualDetailsRef}
        className="card manual-details"
        open={manualOpen}
        onToggle={(e) => setManualOpen(e.currentTarget.open)}
      >
        <summary className="manual-summary">
          <SlidersHorizontal size={16} />
          <b>סימון פעימות ידני מצילום אק״ג · עובד גם ללא אינטרנט</b>
        </summary>
        <ManualBeatMarker
          photoFile={photoFile}
          onApplyBeats={(beats) => {
            onApplyManualBeats(beats);
          }}
        />
      </details>
    </div>
  );
};

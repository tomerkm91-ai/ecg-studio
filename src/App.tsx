import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Heart, Moon, ScanLine, Sun } from 'lucide-react';
import { AnalyzerTab } from './components/AnalyzerTab';
import { BeatCompareTab } from './components/BeatCompareTab';
import { HeartAtlasTab } from './components/HeartAtlasTab';
import { PhotoEntryBar } from './components/PhotoEntryBar';
import type { TeachingPreset } from './data/teachingCases';
import {
  buildBeatComparison,
  buildDemoBeatComparison,
} from './lib/beatAnalysis';
import { prepareEcgPhoto, validateRawPhoto } from './lib/photoPrepare';
import { ecgClient, type EngineStatus } from './lib/pyodideClient';
import { sanitizeBeats } from './lib/timing';
import type {
  ActiveBeatSync,
  AnalysisResult,
  BeatComparisonState,
  InspectOptions,
  InspectResult,
  LeadOrder,
  RotateOption,
} from './types/ecg';

type TabId = 'analyzer' | 'heart' | 'beats';
type ThemeMode = 'dark' | 'light';

export const App: React.FC = () => {
  const [tab, setTab] = useState<TabId>('analyzer');
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  });

  // Photo state
  const [rawPhoto, setRawPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoStatus, setPhotoStatus] = useState<string>('');
  const preparedPhotoRef = useRef<Promise<File> | null>(null);
  const epochRef = useRef<number>(0);

  // Pyodide analyzer state
  const [engineStatus, setEngineStatus] = useState<EngineStatus>(() =>
    ecgClient.getStatus()
  );
  const [layoutOpt, setLayoutOpt] = useState<string>('');
  const [rotateOpt, setRotateOpt] = useState<RotateOption>('auto');
  const [orderOpt, setOrderOpt] = useState<LeadOrder>('standard');
  const [busyPhase, setBusyPhase] = useState<'inspect' | 'run' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [inspectResult, setInspectResult] = useState<InspectResult | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [activePreset, setActivePreset] = useState<TeachingPreset | null>(null);
  const [classroomQuizMode, setClassroomQuizMode] = useState<boolean>(false);

  // Shared beat sync (drives 3D heart) & beat comparison state
  const [beatSync, setBeatSync] = useState<ActiveBeatSync | null>(null);
  const [beatComparison, setBeatComparison] = useState<BeatComparisonState>(() =>
    buildDemoBeatComparison()
  );
  const [openManualSignal, setOpenManualSignal] = useState<number>(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    return ecgClient.subscribe(setEngineStatus);
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Register Service Worker & consume PWA Web Share Target if present
  const handleSelectFile = useCallback((file: File) => {
    const err = validateRawPhoto(file);
    if (err) {
      setPhotoStatus(err);
      return;
    }

    epochRef.current++;
    preparedPhotoRef.current = null;
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setRawPhoto(file);
    setActivePreset(null);
    setInspectResult(null);
    setAnalysisResult(null);
    setErrorMsg(null);
    setBusyPhase(null);
    setBeatSync(null);
    setBeatComparison(buildDemoBeatComparison());
    setPhotoStatus(
      `נבחר ${file.name || 'צילום'} (${(file.size / 1_048_576).toFixed(1)} MiB). לחצו על ״ניתוח אק״ג אוטומטי״ או ״סימון פעימות ידני״.`
    );
  }, []);

  useEffect(() => {
    if (
      !/^https?:$/.test(window.location.protocol) ||
      !('serviceWorker' in navigator)
    ) {
      return;
    }
    navigator.serviceWorker
      .register('./sw.js')
      .then(async () => {
        const token = new URL(window.location.href).searchParams.get('shared');
        if (!token || !/^[a-f0-9-]{36}$/.test(token)) return;
        const cache = await caches.open('stage21-inbox');
        const key = new URL('./share-item/' + token, window.location.href);
        const res = await cache.match(key);
        if (res) {
          await cache.delete(key);
          const blob = await res.blob();
          const ext = blob.type.split('/')[1] || 'jpg';
          handleSelectFile(new File([blob], `shared-ecg.${ext}`, { type: blob.type }));
        } else {
          setPhotoStatus('התמונה המשותפת אינה זמינה עוד. ניתן לבחור אותה מהגלריה.');
        }
        window.history.replaceState({}, '', window.location.pathname);
      })
      .catch(() => {
        if (window.location.search.includes('shared=')) {
          setPhotoStatus('ניתן לבחור את הצילום ישירות מהגלריה.');
        }
      });
  }, [handleSelectFile]);

  const getPreparedPhoto = useCallback(async (): Promise<File | null> => {
    if (!rawPhoto) return null;
    const epoch = epochRef.current;
    if (!preparedPhotoRef.current) {
      preparedPhotoRef.current = prepareEcgPhoto(rawPhoto);
    }
    try {
      const f = await preparedPhotoRef.current;
      if (epoch !== epochRef.current) return null;
      return f;
    } catch (err) {
      if (epoch === epochRef.current) {
        preparedPhotoRef.current = null;
        const msg = err instanceof Error ? err.message : String(err);
        setPhotoStatus(msg);
        setErrorMsg(msg);
      }
      return null;
    }
  }, [rawPhoto]);

  const handleRequestPreview = useCallback(async () => {
    if (previewUrl) return;
    const f = await getPreparedPhoto();
    if (f) {
      setPreviewUrl(URL.createObjectURL(f));
    }
  }, [previewUrl, getPreparedPhoto]);

  const handleStartInspect = useCallback(async () => {
    if (!rawPhoto || busyPhase) return;
    const epoch = epochRef.current;
    setTab('analyzer');
    setBusyPhase('inspect');
    setErrorMsg(null);
    setAnalysisResult(null);
    setPhotoStatus('מכין את הצילום וקורא את גאומטריית הדף…');

    try {
      const prepared = await getPreparedPhoto();
      if (!prepared || epoch !== epochRef.current) return;
      const bytes = await prepared.arrayBuffer();
      if (epoch !== epochRef.current) return;

      const res = await ecgClient.inspect(
        {
          layout: layoutOpt || null,
          rotate: rotateOpt,
          lead_order: orderOpt,
        },
        bytes
      );
      if (epoch !== epochRef.current) return;

      if (res.kind === 'image' || (!res.ok && !res.preview)) {
        setInspectResult(null);
        setErrorMsg(res.error || 'לא ניתן לפתוח את הקובץ כתמונה.');
        setPhotoStatus('קריאת הצילום נעצרה.');
      } else {
        setInspectResult(res);
        setPhotoStatus(
          res.ok
            ? 'השורות זוהו. בדקו את הקווים ולחצו ״נתח תרשים״.'
            : 'נדרש תיקון ידני של הפריסה והשורות לפני הניתוח.'
        );
      }
    } catch (err) {
      if (epoch === epochRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        setPhotoStatus('הבדיקה נעצרה.');
      }
    } finally {
      if (epoch === epochRef.current) setBusyPhase(null);
    }
  }, [rawPhoto, busyPhase, getPreparedPhoto, layoutOpt, rotateOpt, orderOpt]);

  const handleRelayout = useCallback(async (opts: InspectOptions) => {
    const epoch = epochRef.current;
    setBusyPhase('inspect');
    setErrorMsg(null);
    setAnalysisResult(null);
    try {
      const res = await ecgClient.inspect(opts);
      if (epoch !== epochRef.current) return;
      if (res.kind === 'image' || (!res.ok && !res.preview)) {
        setErrorMsg(res.error || 'שגיאה בזיהוי הפריסה.');
      } else {
        setInspectResult(res);
      }
    } catch (err) {
      if (epoch === epochRef.current) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (epoch === epochRef.current) setBusyPhase(null);
    }
  }, []);

  const handleRunAnalysis = useCallback(async (opts: InspectOptions) => {
    const epoch = epochRef.current;
    setBusyPhase('run');
    setErrorMsg(null);
    setAnalysisResult(null);
    setPhotoStatus('מנתח את התרשים מקומית…');
    const t0 = performance.now();

    try {
      const res = await ecgClient.run(opts);
      if (epoch !== epochRef.current) return;
      if (!res.ok) {
        setErrorMsg(
          res.error ||
            'הכלי מסרב לנחש — תקנו את קווי השורות, בחרו פריסה אחרת או צלמו מלמעלה ומקביל לנייר.'
        );
        setPhotoStatus('הניתוח נעצר.');
        return;
      }

      const elapsedSec = (performance.now() - t0) / 1000;
      const enriched: AnalysisResult = { ...res, elapsedSec };
      setActivePreset(null);
      setAnalysisResult(enriched);
      setPhotoStatus(`הניתוח הושלם (${elapsedSec.toFixed(1)} שניות). הלב התלת־ממדי והשוואת הפעימות עודכנו.`);

      // Feed extracted trace into 3D Heart Sync & Beat Comparator
      if (res.trace) {
        const peaks = sanitizeBeats(res.trace.beats_s || []);
        const qrsOnsets = sanitizeBeats((res.trace.qrs_s || []).map((w) => w[0]));
        const syncBeats = peaks.length >= 2 ? peaks : qrsOnsets;
        if (syncBeats.length >= 2) {
          setBeatSync({
            beats: syncBeats,
            manual: false,
            lead: res.trace.lead,
            mv: res.trace.mv,
            fs: res.trace.fs,
          });
        } else {
          setBeatSync(null);
        }

        if (res.trace.mv && res.trace.fs) {
          const markers = qrsOnsets.length >= 3 ? qrsOnsets : peaks;
          const comp = buildBeatComparison(
            res.trace.mv,
            res.trace.fs,
            markers,
            `האות שחולץ מהצילום · ${res.trace.lead || 'רצועת קצב'}`
          );
          if (comp) setBeatComparison(comp);
        }
      }
    } catch (err) {
      if (epoch === epochRef.current) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPhotoStatus('הניתוח נכשל.');
      }
    } finally {
      if (epoch === epochRef.current) setBusyPhase(null);
    }
  }, []);

  const handleCancel = useCallback(() => {
    epochRef.current++;
    ecgClient.cancel();
    setBusyPhase(null);
    setPhotoStatus('הבדיקה הופסקה. הצילום זמין לבדיקה חוזרת או לסימון ידני.');
  }, []);

  const handleClearPhoto = useCallback(() => {
    epochRef.current++;
    if (busyPhase) ecgClient.cancel();
    preparedPhotoRef.current = null;
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setRawPhoto(null);
    setActivePreset(null);
    setInspectResult(null);
    setAnalysisResult(null);
    setErrorMsg(null);
    setBusyPhase(null);
    setBeatSync(null);
    setBeatComparison(buildDemoBeatComparison());
    setPhotoStatus('');
  }, [busyPhase]);

  const handleApplyManualBeats = useCallback((beats: number[]) => {
    setBeatSync({
      beats,
      manual: true,
    });
    setPhotoStatus(`מודל הלב מסונכרן לפי ${beats.length} פעימות שסומנו ידנית.`);
  }, []);

  const handleLoadTeachingPreset = useCallback((preset: TeachingPreset) => {
    epochRef.current++;
    setActivePreset(preset);
    setInspectResult(null);
    setErrorMsg(null);
    setBusyPhase(null);
    setAnalysisResult(preset.result);
    setPhotoStatus(`נטענה דוגמת ההוראה: ${preset.title}. גם הלב התלת־ממדי והשוואת הפעימות עודכנו.`);

    const tr = preset.result.trace;
    if (tr) {
      const peaks = sanitizeBeats(tr.beats_s || []);
      if (peaks.length >= 2) {
        setBeatSync({
          beats: peaks,
          manual: false,
          lead: tr.lead,
          mv: tr.mv,
          fs: tr.fs,
        });
      }
      if (tr.mv && tr.fs && peaks.length >= 3) {
        const comp = buildBeatComparison(
          tr.mv,
          tr.fs,
          peaks,
          `דוגמת הוראה · ${preset.title}`
        );
        if (comp) setBeatComparison(comp);
      }
    }
  }, []);

  const handleBeatLabelChange = useCallback((beatIndex: number, label: string) => {
    setBeatComparison((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.index === beatIndex ? { ...r, label } : r)),
    }));
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">ECG STUDIO · אפליקציית הוראה ותרגול</span>
          <h1>לימוד אק״ג והלב בתנועה</h1>
        </div>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          aria-label="החלפת ערכת נושא"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          {theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}
        </button>
      </header>

      <div className="teaching-banner">
        <b>סביבת הוראה ותרגול אק״ג</b> — מיועדת ללמידה, להדגמה בכיתה ולתרגול קריאת תרשימים, ואינה משמשת לאבחון רפואי.
      </div>

      <PhotoEntryBar
        rawPhoto={rawPhoto}
        previewUrl={previewUrl}
        statusMessage={photoStatus}
        isBusy={busyPhase !== null}
        onSelectFile={handleSelectFile}
        onStartAnalyze={handleStartInspect}
        onStopAnalyze={handleCancel}
        onOpenManualMark={() => {
          setTab('heart');
          setOpenManualSignal((n) => n + 1);
        }}
        onClearPhoto={handleClearPhoto}
        onRequestPreview={handleRequestPreview}
      />

      <nav className="tabs-nav" aria-label="מודולי עבודה">
        <button
          type="button"
          className={`tab-btn ${tab === 'analyzer' ? 'active' : ''}`}
          aria-pressed={tab === 'analyzer'}
          onClick={() => setTab('analyzer')}
        >
          <ScanLine size={16} />
          מנתח אק״ג והולכה
        </button>

        <button
          type="button"
          className={`tab-btn ${tab === 'heart' ? 'active' : ''}`}
          aria-pressed={tab === 'heart'}
          onClick={() => setTab('heart')}
        >
          <Heart size={16} />
          לב תלת־ממדי מסונכרן
          {beatSync && <span className="dot-live" title="מסונכרן לפעימות" />}
        </button>

        <button
          type="button"
          className={`tab-btn ${tab === 'beats' ? 'active' : ''}`}
          aria-pressed={tab === 'beats'}
          onClick={() => setTab('beats')}
        >
          <Activity size={16} />
          השוואת פעימות
        </button>
      </nav>

      <main className="app-main">
        <section hidden={tab !== 'analyzer'}>
          <AnalyzerTab
            engineStatus={engineStatus}
            layoutOpt={layoutOpt}
            rotateOpt={rotateOpt}
            orderOpt={orderOpt}
            onChangeLayoutOpt={setLayoutOpt}
            onChangeRotateOpt={setRotateOpt}
            onChangeOrderOpt={setOrderOpt}
            onPreloadEngine={() => {
              ecgClient.ensureReady().catch(() => {});
            }}
            busyPhase={busyPhase}
            errorMsg={errorMsg}
            inspectResult={inspectResult}
            analysisResult={analysisResult}
            activePreset={activePreset}
            classroomQuizMode={classroomQuizMode}
            onToggleClassroomQuiz={() => setClassroomQuizMode((v) => !v)}
            onSelectPreset={handleLoadTeachingPreset}
            onRelayout={handleRelayout}
            onAnalyze={handleRunAnalysis}
            onCancel={handleCancel}
            onJumpToHeart={() => setTab('heart')}
            onJumpToBeats={() => setTab('beats')}
          />
        </section>

        <section hidden={tab !== 'heart'}>
          <HeartAtlasTab
            visible={tab === 'heart'}
            beatSync={beatSync}
            photoFile={rawPhoto}
            openManualSignal={openManualSignal}
            onApplyManualBeats={handleApplyManualBeats}
            conductionVerdict={analysisResult?.conduction?.verdict_key}
            prMs={analysisResult?.measurements?.pr_ms}
            qrsMs={analysisResult?.measurements?.qrs_ms}
            qtMs={analysisResult?.measurements?.qt_ms}
          />
        </section>

        <section hidden={tab !== 'beats'}>
          <BeatCompareTab
            comparison={beatComparison}
            onLabelChange={handleBeatLabelChange}
          />
        </section>
      </main>
    </div>
  );
};

export default App;

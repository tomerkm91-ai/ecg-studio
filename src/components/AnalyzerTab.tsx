import React from 'react';
import { BookOpen, Cpu, GraduationCap, Loader2, RefreshCw } from 'lucide-react';
import { TEACHING_PRESETS, type TeachingPreset } from '../data/teachingCases';
import type { EngineStatus } from '../lib/pyodideClient';
import type {
  AnalysisResult,
  InspectOptions,
  InspectResult,
  LeadOrder,
  RotateOption,
} from '../types/ecg';
import { ResultsDashboard } from './ResultsDashboard';
import { RowReviewCanvas } from './RowReviewCanvas';

interface AnalyzerTabProps {
  engineStatus: EngineStatus;
  layoutOpt: string;
  rotateOpt: RotateOption;
  orderOpt: LeadOrder;
  onChangeLayoutOpt: (v: string) => void;
  onChangeRotateOpt: (v: RotateOption) => void;
  onChangeOrderOpt: (v: LeadOrder) => void;
  onPreloadEngine: () => void;
  busyPhase: 'inspect' | 'run' | null;
  errorMsg: string | null;
  inspectResult: InspectResult | null;
  analysisResult: AnalysisResult | null;
  activePreset: TeachingPreset | null;
  classroomQuizMode: boolean;
  onToggleClassroomQuiz: () => void;
  onSelectPreset: (preset: TeachingPreset) => void;
  onRelayout: (opts: InspectOptions) => void;
  onAnalyze: (opts: InspectOptions) => void;
  onCancel: () => void;
  onJumpToHeart: () => void;
  onJumpToBeats: () => void;
}

export const AnalyzerTab: React.FC<AnalyzerTabProps> = ({
  engineStatus,
  layoutOpt,
  rotateOpt,
  orderOpt,
  onChangeLayoutOpt,
  onChangeRotateOpt,
  onChangeOrderOpt,
  onPreloadEngine,
  busyPhase,
  errorMsg,
  inspectResult,
  analysisResult,
  activePreset,
  classroomQuizMode,
  onToggleClassroomQuiz,
  onSelectPreset,
  onRelayout,
  onAnalyze,
  onCancel,
  onJumpToHeart,
  onJumpToBeats,
}) => {
  const isBooting =
    engineStatus.phase === 'pyodide' ||
    engineStatus.phase === 'packages' ||
    engineStatus.phase === 'modules';

  return (
    <div className="tab-stack">
      {/* Instant Classroom Teaching Presets */}
      <div className="card">
        <div className="card-header-row">
          <div>
            <h3>
              <GraduationCap size={18} />
              דוגמאות מוכנות לשיעור ולהדגמה מיידית
            </h3>
            <p className="muted">
              פתחו מקרה לימודי בלחיצה אחת כדי להדגים בכיתה קריאת מרווחים, קריטריוני הולכה, סנכרון לב 3D והשוואת פעימות — או העלו צילום אק״ג אמיתי למעלה.
            </p>
          </div>
        </div>

        <div className="preset-grid">
          {TEACHING_PRESETS.map((preset) => {
            const isActive = activePreset?.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={`preset-card ${isActive ? 'active' : ''}`}
                onClick={() => onSelectPreset(preset)}
              >
                <div className="preset-title">
                  <BookOpen size={15} />
                  <strong>{preset.title}</strong>
                </div>
                <span className="preset-sub num">{preset.subtitle}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Engine & Pre-scan Options for Uploaded Photos */}
      <div className="card">
        <div className="card-header-row">
          <div>
            <h2>ניתוח תרשים אק״ג מצילום</h2>
            <p className="muted">
              עיבוד מקומי מלא במכשיר (OpenCV + SciPy ב־WebAssembly) עם עריכת שורות אינטראקטיבית לדיוק בהדגמה.
            </p>
          </div>
          <div className="engine-pill-wrap">
            <span className={`engine-badge phase-${engineStatus.phase}`}>
              <Cpu size={14} />
              {engineStatus.phase === 'ready'
                ? 'מנוע מוכן'
                : engineStatus.phase === 'error'
                  ? 'שגיאת מנוע'
                  : isBooting
                    ? `טוען (${engineStatus.pct}%)`
                    : 'טעינה לפי דרישה'}
            </span>
            {(engineStatus.phase === 'idle' || engineStatus.phase === 'error') && (
              <button type="button" className="btn ghost sm" onClick={onPreloadEngine}>
                <RefreshCw size={14} />
                טען מנוע מראש
              </button>
            )}
          </div>
        </div>

        {isBooting && (
          <div className="boot-progress">
            <div className="muted">{engineStatus.message}</div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${engineStatus.pct}%` }} />
            </div>
            <div className="muted small">
              בטעינה ראשונה יורדים numpy, scipy ו־OpenCV לדפדפן (נדרש חיבור אינטרנט ראשוני).
            </div>
          </div>
        )}

        {engineStatus.phase === 'error' && (
          <div className="error-box" style={{ marginTop: 10 }}>
            {engineStatus.message}
          </div>
        )}

        <div className="opts-bar">
          <label className="field-inline">
            <span>פריסת ברירת מחדל</span>
            <select value={layoutOpt} onChange={(e) => onChangeLayoutOpt(e.target.value)}>
              <option value="">זיהוי אוטומטי</option>
              <option value="3x4">3x4</option>
              <option value="3x4+1">3x4+1</option>
              <option value="6x2">6x2</option>
              <option value="6x2+1">6x2+1</option>
              <option value="6x1">6x1 (גפיים)</option>
              <option value="6x1V">6x1V (חזה)</option>
              <option value="12x1">12x1</option>
              <option value="12x1+1">12x1+1</option>
            </select>
          </label>

          <label className="field-inline">
            <span>סיבוב</span>
            <select
              value={rotateOpt}
              onChange={(e) => onChangeRotateOpt(e.target.value as RotateOption)}
            >
              <option value="auto">אוטומטי</option>
              <option value="0">0°</option>
              <option value="90">90°</option>
              <option value="180">180°</option>
              <option value="270">270°</option>
            </select>
          </label>

          <label className="field-inline">
            <span>סדר חיבורים</span>
            <select
              value={orderOpt}
              onChange={(e) => onChangeOrderOpt(e.target.value as LeadOrder)}
            >
              <option value="standard">תקני</option>
              <option value="norav">Norav</option>
            </select>
          </label>
        </div>
      </div>

      {/* Busy Indicator */}
      {busyPhase && (
        <div className="card busy-card">
          <Loader2 size={18} className="spin-icon" />
          <span>
            {busyPhase === 'inspect'
              ? 'קורא את גאומטריית הדף ומאתר שורות…'
              : 'מריץ דיגיטציה, מדידות והערכת הולכה על המכשיר…'}
          </span>
          <button type="button" className="btn ghost sm push-end" onClick={onCancel}>
            עצירת הבדיקה
          </button>
        </div>
      )}

      {/* Error Box */}
      {errorMsg && (
        <div className="error-box">
          <b>לא ניתן להשלים את הקריאה</b>
          <div style={{ marginTop: 4 }}>{errorMsg}</div>
        </div>
      )}

      {/* Interactive Row Review Editor */}
      {inspectResult && inspectResult.preview && (
        <RowReviewCanvas
          data={inspectResult}
          disabled={busyPhase !== null}
          onRelayout={onRelayout}
          onAnalyze={onAnalyze}
        />
      )}

      {/* Full Results Dashboard */}
      {analysisResult && analysisResult.ok && (
        <ResultsDashboard
          result={analysisResult}
          teachingGoal={activePreset?.teachingGoal}
          quizHidden={classroomQuizMode}
          onToggleQuizHidden={onToggleClassroomQuiz}
          onJumpToHeart={onJumpToHeart}
          onJumpToBeats={onJumpToBeats}
        />
      )}
    </div>
  );
};

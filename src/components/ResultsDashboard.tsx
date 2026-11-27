import React from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  Download,
  Eye,
  EyeOff,
  GraduationCap,
  Heart,
  HelpCircle,
  X,
} from 'lucide-react';
import type { AnalysisResult, ConductionCriterion, VerdictKey } from '../types/ecg';

interface ResultsDashboardProps {
  result: AnalysisResult;
  teachingGoal?: string;
  quizHidden: boolean;
  onToggleQuizHidden: () => void;
  onJumpToHeart: () => void;
  onJumpToBeats: () => void;
}

const VERDICT_PILL: Record<VerdictKey, { label: string; cls: string }> = {
  lbbb: { label: 'LBBB', cls: 'pill-lbbb' },
  rbbb: { label: 'RBBB', cls: 'pill-rbbb' },
  incomplete_lbbb: { label: 'LBBB חלקי', cls: 'pill-lbbb' },
  incomplete_rbbb: { label: 'RBBB חלקי', cls: 'pill-rbbb' },
  ivcd: { label: 'IVCD', cls: 'pill-ivcd' },
  uncertain: { label: 'לא מוכרע', cls: 'pill-unc' },
  no_complete_block: { label: 'אין חסם מלא', cls: 'pill-ok' },
  conflict: { label: 'סתירה', cls: 'pill-unc' },
  normal: { label: 'תקין', cls: 'pill-ok' },
};

const HEART_CONDUCTION_NOTE: Partial<Record<VerdictKey, string>> = {
  rbbb: 'הענף הימני חסום: החדר השמאלי מופעל בזמן, והימני מופעל באיחור דרך שריר הלב — לכן ה־QRS רחב.',
  lbbb: 'הענף השמאלי חסום: החדר הימני מופעל בזמן, והשמאלי מופעל באיחור דרך שריר הלב — לכן ה־QRS רחב.',
  incomplete_rbbb: 'חסם חלקי: הענף הימני מוליך אך באיטיות, ולכן החדר הימני מופעל באיחור קל.',
  incomplete_lbbb: 'חסם חלקי: הענף השמאלי מוליך אך באיטיות, ולכן החדר השמאלי מופעל באיחור קל.',
  ivcd: 'ההולכה התוך־חדרית איטית ללא דפוס אופייני של ענף יחיד.',
  uncertain: 'רוחב ה־QRS חוצה את סף 120 ms בטווח השגיאה — הזדמנות מצוינת למדוד ידנית על התרשים.',
  conflict: 'קריטריוני שני הענפים סותרים זה את זה — יש לבדוק את שיוך השורות בצילום.',
};

const LEAD_DISPLAY_ORDER = [
  'I', 'II', 'III', 'aVR', 'aVL', 'aVF',
  'V1', 'V2', 'V3', 'V4', 'V5', 'V6',
];

function fmt(val: number | string | null | undefined, unit = ''): string {
  if (val === null || val === undefined) return '—';
  return unit ? `${val} ${unit}` : String(val);
}

const CriterionTable: React.FC<{ title: string; items: ConductionCriterion[] }> = ({
  title,
  items,
}) => (
  <div className="card">
    <h3>{title}</h3>
    <table className="crit-table">
      <tbody>
        {items.map((c, idx) => (
          <tr key={idx}>
            <td className="crit-icon">
              {c.met === true ? (
                <Check size={16} className="mark-yes" />
              ) : c.met === false ? (
                <X size={16} className="mark-no" />
              ) : (
                <HelpCircle size={16} className="mark-q" />
              )}
            </td>
            <td className="crit-name">{c.criterion}</td>
            <td className="crit-detail num muted">{c.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const ResultsDashboard: React.FC<ResultsDashboardProps> = ({
  result,
  teachingGoal,
  quizHidden,
  onToggleQuizHidden,
  onJumpToHeart,
  onJumpToBeats,
}) => {
  const m = result.measurements || {};
  const c = result.conduction;
  const meta = result.meta || {};
  const flags = result.flags || [];
  const notes = result.notes || [];

  const pill = c?.verdict_key ? VERDICT_PILL[c.verdict_key] : null;
  const condNote = c?.verdict_key ? HEART_CONDUCTION_NOTE[c.verdict_key] : null;
  const band = c?.qrs_band_ms ? `${c.qrs_band_ms[0]}–${c.qrs_band_ms[1]} ms` : '—';

  const stLate = m.st_j60_mm || m.st_j40_mm || {};
  const stJ = m.st_j_mm || {};
  const tAmp = m.t_amp_mm || {};
  const stLeads = LEAD_DISPLAY_ORDER.filter(
    (k) => k in stLate || k in stJ || k in tAmp
  );

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ecg-lesson-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div className="results-stack">
      <div className="results-meta-bar">
        <span className="muted">
          {result.elapsedSec !== undefined && result.elapsedSec > 0.2
            ? `הניתוח הושלם מקומית תוך ${result.elapsedSec.toFixed(1)} שניות.`
            : 'תוצאות לימודיות מוכנות לדיון בכיתה'}
        </span>
        <div className="btn-row">
          <button
            type="button"
            className={`btn sm ${quizHidden ? 'accent' : 'secondary'}`}
            onClick={onToggleQuizHidden}
          >
            {quizHidden ? <Eye size={15} /> : <EyeOff size={15} />}
            {quizHidden ? 'חשוף פענוח בכיתה' : 'מצב תרגול (הסתר פענוח)'}
          </button>
          <button type="button" className="btn secondary sm" onClick={onJumpToHeart}>
            <Heart size={15} />
            לב 3D מסונכרן
          </button>
          <button type="button" className="btn secondary sm" onClick={onJumpToBeats}>
            <Activity size={15} />
            השוואת פעימות
          </button>
          <button type="button" className="btn ghost sm" onClick={exportJson}>
            <Download size={15} />
            ייצוא JSON
          </button>
        </div>
      </div>

      {/* Key KPI Strip with Normal Reference Ranges for Teaching */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">דופק</span>
          <strong className="kpi-val num">{fmt(m.hr_bpm, 'bpm')}</strong>
          <span className="kpi-sub">
            {m.regular === undefined
              ? '—'
              : m.regular
                ? `סדיר (CV ${m.rr_cv ?? '—'})`
                : `לא סדיר (CV ${m.rr_cv ?? '—'})`}
          </span>
          <span className="kpi-ref">ייחוס תקין: 60–100 bpm</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">רוחב QRS</span>
          <strong className="kpi-val num">{fmt(m.qrs_ms, 'ms')}</strong>
          <span className="kpi-sub">טווח מדידה {band}</span>
          <span className="kpi-ref">ייחוס תקין: &lt;120 ms</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">מרווח PR</span>
          <strong className="kpi-val num">{fmt(m.pr_ms, 'ms')}</strong>
          <span className="kpi-sub">
            גל P: {fmt(m.p_ms, 'ms')} · {fmt(m.p_amp_ii_mm, 'mm')}
          </span>
          <span className="kpi-ref">ייחוס תקין: 120–200 ms</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">QT / QTc</span>
          <strong className="kpi-val num">{fmt(m.qt_ms, 'ms')}</strong>
          <span className="kpi-sub">
            B: {fmt(m.qtc_bazett_ms)} / F: {fmt(m.qtc_fridericia_ms)}
          </span>
          <span className="kpi-ref">ייחוס QTc: &lt;450/460 ms</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">ציר חזיתי</span>
          <strong className="kpi-val num">{fmt(m.axis_deg, '°')}</strong>
          <span className="kpi-sub">
            {m.axis_uncertain
              ? `אי־הסכמה ${m.axis_methods_differ_deg}°`
              : `${fmt(m.n_beats)} פעימות (${fmt(m.qrs_beats_used)} נמדדו)`}
          </span>
          <span className="kpi-ref">ייחוס תקין: ‎-30° עד ‎+90°</span>
        </div>
      </div>

      {/* Classroom Quiz Mode Curtain OR Full Interpretation */}
      {quizHidden ? (
        <div className="card quiz-hidden-card">
          <h3>
            <GraduationCap size={18} />
            מצב תרגול בכיתה פעיל — הפענוח מוסתר
          </h3>
          <p className="muted">
            עברו עם הסטודנטים על המדידות למעלה ועל טבלת ה־ST/T למטה: מהו הדופק, האם הקצב סדיר, האם ה־QRS רחב, ואיזה דפוס הולכה מתאים?
          </p>
          <button
            type="button"
            className="btn accent"
            style={{ marginTop: 10 }}
            onClick={onToggleQuizHidden}
          >
            <Eye size={16} />
            חשוף פענוח, קריטריונים ודגלים
          </button>
        </div>
      ) : (
        <>
          {/* Verdict Card */}
          {c && (
            <div className="card verdict-card">
              <div className="verdict-title">
                <span>{c.verdict}</span>
                {pill && <span className={`pill ${pill.cls}`}>{pill.label}</span>}
              </div>
              <p className="muted">
                רוחב QRS שנמדד: <b>{fmt(c.qrs_ms, 'ms')}</b> · טווח מדידה: <b>{band}</b> · להמחשה לימודית ולהשוואה מול הקריאה הידנית בתרשים.
              </p>
              {teachingGoal && (
                <div className="teaching-goal-box">
                  <b>מטרת הוראה:</b> {teachingGoal}
                </div>
              )}
              {condNote && <div className="conduction-note">{condNote}</div>}
              {c.fascicular && (
                <p className="muted" style={{ marginTop: 8 }}>
                  {c.fascicular.name ? (
                    <>
                      חסם פסיקולרי אפשרי: <b>{c.fascicular.name}</b> — {c.fascicular.note}
                    </>
                  ) : (
                    c.fascicular.note
                  )}
                </p>
              )}
            </div>
          )}

          {/* Flags */}
          {flags.length > 0 && (
            <div className="card flags-card">
              <h3>
                <AlertTriangle size={17} />
                ממצאים ונקודות לדיון ({flags.length})
              </h3>
              <ul className="flags-list">
                {flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {/* LBBB & RBBB Criteria */}
          {c && (c.lbbb?.length || c.rbbb?.length) ? (
            <div className="two-col">
              {c.lbbb && <CriterionTable title="קריטריונים לחסם צרור שמאלי (LBBB)" items={c.lbbb} />}
              {c.rbbb && <CriterionTable title="קריטריונים לחסם צרור ימני (RBBB)" items={c.rbbb} />}
            </div>
          ) : null}
        </>
      )}

      {/* Per-lead ST & T Table (kept visible in both modes so students can inspect raw lead values) */}
      {stLeads.length > 0 && (
        <div className="card">
          <h3>סטיית ST ומשרעת גל T לפי חיבור (מ״מ)</h3>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>חיבור</th>
                  <th>ST ב־{m.st_late_point || 'J+60ms'}</th>
                  <th>ST בנקודת J</th>
                  <th>גל T</th>
                </tr>
              </thead>
              <tbody>
                {stLeads.map((lead) => {
                  const lateVal = stLate[lead];
                  const isElevated =
                    lateVal !== undefined &&
                    lateVal >= (lead === 'V2' || lead === 'V3' ? 1.5 : 1.0);
                  const isDepressed = lateVal !== undefined && lateVal <= -0.5;
                  const tVal = tAmp[lead];
                  const isTInv = lead !== 'aVR' && tVal !== undefined && tVal <= -1.0;

                  return (
                    <tr key={lead}>
                      <td className="lead-cell">{lead}</td>
                      <td
                        className={`num ${
                          !quizHidden && isElevated
                            ? 'val-high'
                            : !quizHidden && isDepressed
                              ? 'val-low'
                              : ''
                        }`}
                      >
                        {lateVal !== undefined
                          ? `${lateVal > 0 ? '+' : ''}${lateVal.toFixed(2)}`
                          : '—'}
                      </td>
                      <td className="num muted">
                        {stJ[lead] !== undefined
                          ? `${stJ[lead] > 0 ? '+' : ''}${stJ[lead].toFixed(2)}`
                          : '—'}
                      </td>
                      <td className={`num ${!quizHidden && isTInv ? 'val-low' : ''}`}>
                        {tVal !== undefined ? `${tVal > 0 ? '+' : ''}${tVal.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Digitization Diagnostics */}
      <div className="card">
        <h3>פרטי הקריאה והכיול</h3>
        <div className="meta-grid">
          <div>
            <span className="muted">פריסה:</span> <b>{meta.layout || '—'}</b>
          </div>
          <div>
            <span className="muted">קנה מידה:</span>{' '}
            <b className="num">{fmt(meta.px_per_mm, 'px/mm')}</b> ({meta.scale_from || '—'})
          </div>
          <div>
            <span className="muted">הגבר:</span>{' '}
            <b className="num">{fmt(meta.gain_mm_per_mv, 'mm/mV')}</b>
          </div>
          <div>
            <span className="muted">סיבוב / יישור:</span>{' '}
            <b className="num">
              {meta.rotate_deg ?? 0}° / {meta.deskew_deg ?? 0}°
            </b>
          </div>
          <div>
            <span className="muted">שורות שזוהו:</span>{' '}
            <b className="num">{fmt(meta.rows_detected)}</b>
          </div>
          {m.ptf_v1_mm_s !== undefined && (
            <div>
              <span className="muted">PTFV1 (Morris):</span>{' '}
              <b className="num">{m.ptf_v1_mm_s} mm·s</b>
            </div>
          )}
          {m.p_axis_deg !== undefined && (
            <div>
              <span className="muted">ציר P:</span>{' '}
              <b className="num">{m.p_axis_deg}°</b>
            </div>
          )}
        </div>

        {meta.gain_note && <p className="status-warn">⚠ {meta.gain_note}</p>}

        {m.leads_unusable && Object.keys(m.leads_unusable).length > 0 && (
          <p className="status-warn">
            ⚠ חיבורים שנפסלו (עקומה אבדה בצילום):{' '}
            {Object.entries(m.leads_unusable)
              .map(([k, v]) => `${k} (${v} mV)`)
              .join(', ')}
          </p>
        )}

        {notes.length > 0 && (
          <ul className="notes-list muted">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

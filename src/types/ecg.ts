export type LeadOrder = 'standard' | 'norav';
export type RotateOption = 'auto' | '0' | '90' | '180' | '270';

export interface LayoutSpec {
  n_rows: number;
  cols: number;
  extra: string | null;
  labels: Record<string, string[]>;
}

export interface EcgMeta {
  layout?: string;
  lead_order?: LeadOrder;
  rotate_deg?: number;
  deskew_deg?: number;
  px_per_mm?: number;
  scale_from?: string;
  px_per_mv?: number[];
  gain_mm_per_mv?: number;
  rows_detected?: number;
  rows_from?: string;
  pulse_side?: string | null;
  row_y?: number[];
  row_bounds?: number[];
  duration_s?: number;
  extra_row?: string | null;
  gain_note?: string | null;
}

export interface InspectResult {
  ok: boolean;
  error?: string;
  kind?: 'digitize' | 'image' | 'internal';
  preview?: string;
  preview_scale?: number;
  page_w?: number;
  page_h?: number;
  rows?: number[];
  bounds?: number[];
  rotate_deg?: number;
  rotate_req?: string;
  deskew_deg?: number;
  layout?: string | null;
  lead_order?: LeadOrder;
  lead_of_row?: string[];
  layouts?: Record<string, LayoutSpec>;
  meta?: EcgMeta;
}

export interface ConductionCriterion {
  criterion: string;
  met: boolean | null;
  detail: string;
}

export type VerdictKey =
  | 'lbbb'
  | 'rbbb'
  | 'incomplete_lbbb'
  | 'incomplete_rbbb'
  | 'ivcd'
  | 'uncertain'
  | 'no_complete_block'
  | 'conflict'
  | 'normal';

export interface ConductionResult {
  verdict: string;
  verdict_key?: VerdictKey;
  qrs_ms?: number | null;
  qrs_band_ms?: [number, number] | null;
  width_class?: string;
  lbbb?: ConductionCriterion[];
  rbbb?: ConductionCriterion[];
  lbbb_pattern?: boolean;
  rbbb_pattern?: boolean;
  fascicular?: { name: string | null; note: string } | null;
}

export interface EcgMeasurements {
  hr_bpm?: number;
  rr_cv?: number;
  regular?: boolean;
  n_beats?: number;
  qrs_beats_used?: number;
  qrs_ms?: number;
  pr_ms?: number;
  pr_spread_ms?: number;
  p_ms?: number;
  p_amp_ii_mm?: number;
  p_axis_deg?: number;
  p_beats_used?: number;
  p_waves_per_qrs?: number;
  ptf_v1_mm_s?: number;
  qt_ms?: number;
  qt_leads_used?: string[];
  qtc_bazett_ms?: number;
  qtc_fridericia_ms?: number;
  axis_deg?: number;
  axis_from?: string;
  axis_area_deg?: number;
  axis_methods_differ_deg?: number;
  axis_uncertain?: boolean;
  axis_note?: string;
  st_j_mm?: Record<string, number>;
  st_j60_mm?: Record<string, number>;
  st_j40_mm?: Record<string, number>;
  st_late_point?: string;
  st_beats_per_lead?: number;
  t_amp_mm?: Record<string, number>;
  t_peak_ms?: Record<string, number>;
  beats_from?: string;
  leads_unusable?: Record<string, number>;
}

export interface TracePayload {
  lead?: string;
  fs?: number;
  t0_s?: number;
  mv?: number[];
  beats_s: number[];
  qrs_s?: [number, number][];
}

export interface AnalysisResult {
  ok: boolean;
  error?: string;
  kind?: 'digitize' | 'image' | 'internal';
  meta?: EcgMeta;
  measurements?: EcgMeasurements;
  flags?: string[];
  notes?: string[];
  conduction?: ConductionResult;
  trace?: TracePayload;
  disclaimer?: string;
  elapsedSec?: number;
}

export interface ActiveBeatSync {
  beats: number[];
  manual: boolean;
  lead?: string;
  mv?: number[];
  fs?: number;
}

export interface InspectOptions {
  layout?: string | null;
  rotate?: RotateOption | string;
  lead_order?: LeadOrder;
  rows?: number[] | null;
}

export interface BeatComparisonRow {
  index: number;
  timeSec: number;
  values: number[];
  reference: number[];
  rmsMv: number;
  label: string;
}

export interface BeatComparisonState {
  sourceName: string;
  fs: number;
  preSamples: number;
  rows: BeatComparisonRow[];
  topIndex: number;
}

"""Measurements from digitized leads: HR, rhythm regularity, PR, QRS duration, frontal axis.

Standard 12-lead printouts are simultaneous: column c of the 3x4 grid covers seconds
[2.5c, 2.5c+2.5) of the same 10 s that the rhythm strip shows. So for every beat we can
combine the rhythm strip with the 3 leads printed at that time ("global" onset/offset).
"""
import numpy as np
from scipy import signal

import clinical

QRS_THR = 0.05          # onset/offset threshold, as a fraction of the peak combined slope.
                        # Centre of a measured plateau: 0.03-0.06 all give a QRS-width MAE
                        # of 3.6-5.2 ms on clean synthetic signals. The previous first/last-
                        # above-threshold rule had no plateau at all (274 ms at 0.03, 68 ms
                        # at 0.05) because a low threshold there let the T wave in.
QRS_NOISE_K = 4.0       # ...but never closer than this many MADs to the inter-beat slope
QRS_BRIDGE_S = 0.020    # slope gaps shorter than this are inside one complex, not between two
QRS_MIN_S, QRS_MAX_S = 0.040, 0.200   # a measured width outside this is not a QRS
AXIS_PRE_S, AXIS_POST_S = 0.06, 0.09  # net-deflection window around the R peak
AXIS_DISAGREE_DEG = 25  # above this the two axis derivations are reported as unreliable
LEAD_PP_MAX_MV = 4.5    # a lead swinging more than this is not an ECG, it is a reading error
COLUMNS = [["I", "II", "III"], ["aVR", "aVL", "aVF"], ["V1", "V2", "V3"], ["V4", "V5", "V6"]]
SEG_S = 2.5


def _filt(x, fs, lo=0.5, hi=40):
    if len(x) < 30:
        return x
    b, a = signal.butter(2, [lo / (fs / 2), hi / (fs / 2)], "band")
    return signal.filtfilt(b, a, x)


def _detect_r(x, fs):
    b, a = signal.butter(2, [5 / (fs / 2), 18 / (fs / 2)], "band")
    e = np.convolve(np.diff(signal.filtfilt(b, a, x)) ** 2, np.ones(int(0.12 * fs)) / (0.12 * fs), "same")
    pk, _ = signal.find_peaks(e, distance=int(0.25 * fs), height=0.25 * np.percentile(e, 99.5))
    w = int(0.06 * fs)
    return np.array([max(p - w, 0) + np.argmax(np.abs(x[max(p - w, 0):p + w])) for p in pk], int)


def _vel(x, fs):
    return np.abs(np.gradient(_filt(x, fs, 0.5, 60))) * fs  # mV/s


def _unusable(d):
    """Leads whose extracted trace cannot be an ECG, by peak-to-peak amplitude.

    Where a crease, a shadow or a stamp loses the trace, the extractor latches onto
    whatever else is in the row and produces square excursions far larger than any real
    deflection. On a photograph of a folded printout, aVF came out swinging 6.3 mV and
    V6 5.3 mV against 0.6-2.3 mV for every intact lead. Those two rows alone dominated
    the summed slope -- the edge of a square block is an enormous slope -- and drove the
    reported rate to 140 bpm where the machine printed 69. Dropping them gives 76.
    The gate has a plateau: anything from 3.5 to 6.0 mV drops the same two leads."""
    out = {}
    for k, x in d["leads"].items():
        x = np.asarray(x, float)
        if len(x) and np.isfinite(x).any():
            pp = float(np.nanmax(x) - np.nanmin(x))
            if pp > LEAD_PP_MAX_MV:
                out[k] = round(pp, 2)
    return out


def _global_velocity(d, n, skip=()):
    fs, L = d["fs"], d["leads"]
    v = np.zeros(n)
    if d["rhythm"] is not None:
        r = _vel(d["rhythm"], fs)[:n]
        v[: len(r)] += r
    for k, sig in L.items():
        if k in skip:
            continue
        a = int(round(clinical.offset_of(d, k) * fs))
        if a < 0:
            continue
        x = _vel(sig, fs)
        m = min(len(x), n - a)
        if m > 0:
            v[a:a + m] += x[:m]
    return np.convolve(v, np.ones(5) / 5, "same")


def _runs(m):
    """[(start, stop), ...] of the True runs in a boolean array; stop is exclusive."""
    e = np.diff(np.concatenate(([0], m.astype(np.int8), [0])))
    return list(zip(np.flatnonzero(e > 0).tolist(), np.flatnonzero(e < 0).tolist()))


def _bridge(m, gap):
    """Fill gaps of fewer than `gap` False samples between True runs."""
    r = _runs(m)
    out = m.copy()
    for (_, end), (start, _) in zip(r, r[1:]):
        if start - end < gap:
            out[end:start] = True
    return out


def _noise_floor(v, fs, peaks):
    """Median and MAD of the combined slope between the beats, i.e. off every QRS."""
    keep = np.ones(len(v), bool)
    for p in peaks:
        keep[max(0, p - int(0.12 * fs)):p + int(0.16 * fs)] = False
    s = v[keep] if keep.sum() > int(0.5 * fs) else v
    med = float(np.median(s))
    return med, float(np.median(np.abs(s - med)))


def _bounds(v, fs, peaks):
    """QRS onset/offset from the combined slope envelope of every simultaneous lead.

    The complex is the CONTIGUOUS stretch of raised slope that contains the R peak --
    not the first and last raised sample anywhere in a fixed window, which is what the
    previous rule measured. That rule let a T wave sitting inside the 320 ms window set
    the offset: on a real page it stretched the QRS to 166 ms and, because the frontal
    axis was an integral over that same window, reversed the sign of the axis.

    Short gaps are bridged before the run is taken, because |dx/dt| falls to zero at
    every peak and every notch INSIDE the complex itself, so an un-bridged run would
    end at the R peak. The threshold is a fraction of the peak slope but is never
    allowed below the inter-beat noise floor, so a noisy photo cannot drag it down into
    the noise and collect everything in the window. A width outside QRS_MIN_S..QRS_MAX_S
    is not reported at all -- measure() exposes how many beats were dropped that way.
    """
    med, mad = _noise_floor(v, fs, peaks)
    gap = max(1, int(round(QRS_BRIDGE_S * fs)))
    out = []
    for p in peaks:
        a, b = p - int(0.14 * fs), p + int(0.18 * fs)
        if a < 0 or b >= len(v):
            continue
        seg = v[a:b]
        thr = max(med + QRS_THR * (float(seg.max()) - med), med + QRS_NOISE_K * mad)
        rs = _runs(_bridge(seg > thr, gap))
        if not rs:
            continue
        i = p - a
        r = next((q for q in rs if q[0] <= i < q[1]),
                 min(rs, key=lambda q: abs((q[0] + q[1]) / 2.0 - i)))
        on, off = a + r[0], a + r[1] - 1
        if QRS_MIN_S <= (off - on) / fs <= QRS_MAX_S:
            out.append((on, off))
    return out


def _net_deflection(x, fs, idx):
    """Net QRS deflection: largest positive plus largest negative excursion from the
    pre-QRS baseline, in a FIXED window around the R peak (the classic manual method).

    This needs the R peak only, never the QRS boundaries, so the frontal axis derived
    from it does not inherit the onset/offset error at all.
    """
    pre, post, base_n = (int(round(AXIS_PRE_S * fs)), int(round(AXIS_POST_S * fs)),
                         int(round(0.04 * fs)))
    vals = []
    for i in idx:
        a, b = int(i) - pre, int(i) + post
        if a - base_n < 0 or b >= len(x):
            continue
        w = x[a:b] - float(np.median(x[a - base_n:a]))
        vals.append(float(w.max() + w.min()))
    return float(np.median(vals)) if vals else None


R_ENV_THR = 0.45        # candidate gate, as a fraction of the 98th percentile slope
R_ENV_KEEP = 0.50       # ...then keep only peaks this tall relative to the page's beats
VOTE_FRAC = 0.30        # a beat needs this share of the leads covering that instant
VOTE_TOL_S = 0.05       # per-lead peaks this close together are one beat


def _detect_r_env(v, fs):
    """Beats from the summed slope envelope of every lead.

    Without a rhythm strip the old code looked for R waves in lead II alone -- on a 6x2
    page that is one noisy 5 s fragment, and missing every other beat there halves the
    reported rate. The envelope already sums every lead that was printed at that moment,
    so a beat has to be invisible in all of them to be missed.

    Candidates are gated against a global percentile, which is not enough on its own: a
    T wave is slower than a QRS but at a SLOW rate it still clears a fixed fraction of
    that percentile. On one annotated Holter page (61.6 bpm) the gate alone returned 21
    beats where 9 were due and reported 174 bpm. The second pass refers the threshold to
    the median height of the taller half of the candidates, i.e. to this page's own
    beats, and the T waves fall away: the peak heights there were 445-559 for the
    complexes, then 182-320 for everything else.

    Swept against the 265 annotated beats of a real 24 h Holter report (19 pages):
    0.45-0.70 is a plateau at a total beat-count error of 14-16, and the WORST page goes
    from 12 beats wrong to 2. Two pages stop being exact, which is the price."""
    pk, props = signal.find_peaks(v, distance=int(0.25 * fs),
                                  height=R_ENV_THR * np.percentile(v, 98))
    h = props["peak_heights"]
    if len(h) >= 3:
        ref = float(np.median(np.sort(h)[len(h) // 2:]))
        pk = pk[h >= R_ENV_KEEP * ref]
    return np.asarray(pk, int)


def _detect_vote(d, skip=(), frac=VOTE_FRAC, tol_s=VOTE_TOL_S):
    """Beats each lead finds on its own, then a vote among the leads covering that moment.

    The summed envelope this replaces adds every lead into one signal, so a lead that is
    loud for the wrong reason carries the whole page with it. Here every lead runs the
    same two-pass detector on its own slope, and a candidate is kept only if enough of
    the leads that were printing at that instant also saw it. A broken lead gets one
    vote and is outvoted instead of deciding.

    The vote is over the leads COVERING that time, not over twelve. On a 3x4 page each
    lead exists for two and a half seconds of the ten, so at any instant only one column
    is present; requiring a share of all twelve would reject every beat on the page.

    Measured against the 265 annotated beats of a real Holter report (19 pages), against
    the summed envelope: every fraction from 0.20 to 0.40 beats it, and 0.30 is the only
    one that beats it on all six measures at once --

        envelope   253 beats, count error 14, exact on 6/19, RR 10.9/29.3 ms, HR MAE 1.19
        0.20-0.25  258 beats, count error 11, exact on 9/19, RR 11.0/32.9 ms, HR MAE 1.04
        0.30       252 beats, count error 13, exact on 7/19, RR 10.1/26.1 ms, HR MAE 0.98
        0.35-0.40  251 beats, count error 14, exact on 6/19, RR 10.1/26.1 ms, HR MAE 0.94
        0.45-0.55  250 beats, count error 15, exact on 5/19, RR 10.1/38.1 ms, HR MAE 1.26

    so the counting optimum (0.20-0.25) and the timing optimum (0.35-0.40) sit on either
    side of it. Above 0.45 it falls off: real beats that two or three leads happen to
    miss start being voted out."""
    fs, L = d["fs"], d["leads"]
    votes, cover = [], {}
    for k, sig in L.items():
        if k in skip:
            continue
        a = int(round(clinical.offset_of(d, k) * fs))
        if a < 0:
            continue
        x = np.nan_to_num(np.asarray(sig, float))
        if not x.any():
            continue
        cover[k] = (a, a + len(x))
        votes.extend((a + int(p), k) for p in _detect_r_env(_vel(x, fs), fs))
    if len(cover) < 3 or not votes:
        return None                       # too few leads to outvote anything
    votes.sort()
    tol = tol_s * fs
    groups, cur = [], [votes[0]]
    for t, k in votes[1:]:
        if t - cur[-1][0] <= tol:
            cur.append((t, k))
        else:
            groups.append(cur)
            cur = [(t, k)]
    groups.append(cur)
    out = []
    for g in groups:
        t = int(np.median([p for p, _ in g]))
        n_cov = sum(1 for a, b in cover.values() if a <= t < b)
        need = 1 if n_cov <= 2 else max(2, int(np.ceil(frac * n_cov)))
        if len({k for _, k in g}) >= need:
            out.append(t)
    return np.asarray(sorted(out), int)


def detect(d):
    """The beat and QRS-boundary stage on its own, so a caller that needs the parts
    (the conduction assessment needs the per-beat windows) does not have to
    reimplement it and drift away from what measure() actually ran."""
    fs, L = d["fs"], d["leads"]
    rhythm = d["rhythm"] if d["rhythm"] is not None else L["II"]
    rx = _filt(rhythm, fs)
    span = max([int(round(clinical.offset_of(d, k) * fs)) + len(x) for k, x in L.items()]
               + [len(rx)])
    bad = _unusable(d)
    v_all = _global_velocity(d, span, skip=set(bad))
    if d["rhythm"] is not None:
        r, src = _detect_r(rx, fs), "rhythm strip"
    else:
        r = _detect_vote(d, skip=set(bad))
        src = "per-lead vote"
        if r is None or len(r) < 2:
            r, src = _detect_r_env(v_all, fs), "summed lead envelope"
    return dict(rx=rx, span=span, bad=bad, vel=v_all, beats=r, qb=_bounds(v_all, fs, r),
                source=src)


def measure(d):
    fs, L = d["fs"], d["leads"]
    res = {}
    st = detect(d)
    rx, span, bad, v_all, r = st["rx"], st["span"], st["bad"], st["vel"], st["beats"]
    # beats are indexed on the whole record; lead II may be one segment inside it
    rx_shift = 0 if d["rhythm"] is not None else int(round(clinical.offset_of(d, "II") * fs))
    if bad:
        res["leads_unusable"] = bad          # lead -> its peak-to-peak in mV
    res["beats_from"] = st["source"]
    rr = np.diff(r) / fs
    res["n_beats"] = int(len(r))
    if len(rr):
        res["hr_bpm"] = int(round(60 / np.median(rr)))
        res["rr_cv"] = round(float(np.std(rr) / np.mean(rr)), 3)
        res["regular"] = bool(res["rr_cv"] < 0.08)

    v = v_all
    qb = st["qb"]
    res["qrs_beats_used"] = int(len(qb))
    if qb:
        res["qrs_ms"] = int(round(np.median([(b - a) / fs * 1000 for a, b in qb])))

    rr_med = float(np.median(rr)) if len(rr) else 1.0
    # PR and P-wave morphology both live in clinical.p_wave; see the note there.

    # Frontal axis, two independent derivations:
    #   amplitude -- net deflection in a fixed window around R; needs the peak only.
    #   area      -- net QRS integral over the detected onset..offset; inherits _bounds.
    # The amplitude one is reported because a wrong boundary cannot reach it. The area
    # one is kept as a cross-check: when the two disagree, that IS the warning that the
    # boundary detection failed on this page, and no axis flag should be raised.
    def net_area(k):
        x = _filt(L[k], fs)
        sh = int(round(clinical.offset_of(d, k) * fs))
        vals = []
        for on, off in qb:
            on2, off2 = on - sh, off - sh
            if on2 > int(0.05 * fs) and off2 < len(x):
                vals.append(np.sum(x[on2:off2] - np.median(x[on2 - int(0.05 * fs):on2])))
        return float(np.median(vals)) if vals else None

    def net_ampl(k):
        sh = int(round(clinical.offset_of(d, k) * fs))
        return _net_deflection(_filt(L[k], fs), fs, [p - sh for p in r])

    def axis_from(f):
        i, f_ = f("I"), f("aVF")
        if i is None or f_ is None or (abs(i) < 1e-9 and abs(f_) < 1e-9):
            return None
        return int(round(float(np.degrees(np.arctan2(f_, i)))))

    if bad.keys() & {"I", "aVF"}:
        # The frontal axis is I against aVF. If either of them is the lead that failed to
        # extract, there is no axis to report -- on one photograph both derivations used
        # the same broken aVF, agreed with each other to within 24 degrees, and were both
        # 143 degrees wrong. Agreement between two derivations cannot catch a bad INPUT.
        res["axis_note"] = ("לא חושב ציר: " +
                            ", ".join(sorted(bad.keys() & {"I", "aVF"})) + " לא נקרא כראוי")
    elif "aVF" in L and "I" in L:
        ax_a, ax_q = axis_from(net_ampl), axis_from(net_area)
        if ax_a is not None:
            res["axis_deg"] = ax_a
            res["axis_from"] = "net deflection (R-S) in I and aVF"
        elif ax_q is not None:
            res["axis_deg"], res["axis_from"] = ax_q, "net QRS area in I and aVF"
        if ax_q is not None:
            res["axis_area_deg"] = ax_q
        if ax_a is not None and ax_q is not None:
            gapd = abs((ax_a - ax_q + 180) % 360 - 180)
            res["axis_methods_differ_deg"] = int(gapd)
            res["axis_uncertain"] = bool(gapd > AXIS_DISAGREE_DEG)

    # stage 2: QT/QTc, ST deviation and P-wave morphology. These hang off qb, so they
    # carry the QRS-bound error with them; test_synth.py quantifies how much.
    res.update(clinical.all_measures(d, qb, rr_med, res.get("hr_bpm")))
    return res

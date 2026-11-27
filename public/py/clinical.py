"""Stage-2 clinical measurements: QT/QTc, ST deviation, P-wave morphology.

All three are anchored on the global QRS onset/offset that measure._bounds() produces,
so they inherit its error. That inheritance is measured, not assumed -- see the
"QRS-bound propagation" section of test_synth.py for the current numbers.

Filtering: these measurements deliberately use a LOW-PASS ONLY filter. The 0.5 Hz
high-pass that is fine for R-peak detection shifts the ST level and drags the tail of
the T wave, which is exactly what is being measured here. Baseline wander is removed
instead by referencing every beat to its own PR segment, which is also what the
measurement is clinically defined against.

Time alignment: in a 3x4 printout column c holds seconds [2.5c, 2.5c+2.5) of the same
10 s the rhythm strip shows, so a beat at global sample g appears at g - c*seg inside
the three leads of column c, and at g inside the rhythm strip.
"""
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy import signal

SEG_S = 2.5
COLUMNS = [["I", "II", "III"], ["aVR", "aVL", "aVF"], ["V1", "V2", "V3"], ["V4", "V5", "V6"]]
RHYTHM = "II*"          # the 10 s rhythm strip, kept distinct from lead II of column 0
T_MIN_MV = 0.08         # a T wave flatter than this has no usable tangent
P_MIN_MV = 0.04
P_EDGE = 0.15           # P onset/offset at 15% of P peak (matches synth's p_ms convention)
ISO_A, ISO_B = 0.05, 0.01   # PR-segment reference window before QRS onset, seconds
MM_PER_MV = 10.0        # the standard printout gain; the digitizer already returns mV


def _lp(x, fs, hi=30.0):
    x = np.asarray(x, float)
    if len(x) < 30:
        return x
    b, a = signal.butter(2, min(hi / (fs / 2.0), 0.95), "low")
    return signal.filtfilt(b, a, x)


def prep(d):
    """Low-pass every trace once; returns name -> filtered signal."""
    fs = d["fs"]
    out = {k: _lp(v, fs) for k, v in d["leads"].items()}
    if d.get("rhythm") is not None:
        out[RHYTHM] = _lp(d["rhythm"], fs)
    return out


def offset_of(d, lead):
    """When this lead's printed segment starts, in seconds from the top of the record.

    digitize() measures it from the page, so one rule covers every layout: 3x4 puts a
    lead in one 2.5 s column, 6x2 in one half, and a 12x1 Holter page gives every lead
    the whole strip (offset 0 for all twelve). Falls back to the 3x4 convention for a
    dict that predates the field."""
    off = d.get("offsets")
    if off and lead in off:
        return float(off[lead])
    for c, col in enumerate(COLUMNS):
        if lead in col:
            return c * SEG_S
    return 0.0


def _views(d, on):
    """(lead, offset_to_local) for every trace that was printed during this beat."""
    fs = d["fs"]
    out = []
    if d.get("rhythm") is not None:
        out.append((RHYTHM, 0))
    for k, x in d["leads"].items():
        sh = int(round(offset_of(d, k) * fs))
        if 0 <= on - sh < len(x):
            out.append((k, sh))
    return out


def _flat_iso(seg, fs, win_ms=20, with_noise=False):
    """Isoelectric level of a segment: the median of its flattest 20 ms stretch.

    A fixed reference does not survive both ends of the rate range. The PR segment is
    the natural choice, but a long P wave spills into it; the TP segment at the start of
    the search window is the natural alternative, but at fast rates the window is short
    and the P has already begun there. Picking the flattest stretch finds whichever of
    the two is actually isoelectric in this beat. Measured over P widths 80-160 ms and
    rates 45-150 bpm: 2.9 ms mean error, against 8.5 ms for a fixed PR reference."""
    n = max(int(win_ms / 1000.0 * fs), 5)
    if len(seg) < n + 2:
        v = float(np.median(seg))
        return (v, float(np.std(seg))) if with_noise else v
    sw = sliding_window_view(seg, n)
    i = int(np.argmin(sw.max(1) - sw.min(1)))
    v = float(np.median(sw[i]))
    return (v, float(np.std(sw[i]))) if with_noise else v


def _iso(x, on, fs):
    """Isoelectric level from the PR segment immediately before QRS onset."""
    a, b = on - int(ISO_A * fs), on - int(ISO_B * fs)
    if a < 0 or b <= a or b > len(x):
        return None
    return float(np.median(x[a:b]))


# --------------------------------------------------------------------------- QT / QTc

def _t_end(x, fs, j, stop, iso):
    """Tangent (Lepeschkin) T offset: the tangent at the steepest point of the T wave's
    return limb, extended to the isoelectric line.

    Returns (fractional sample index of the T offset or None, signed T amplitude in mV
    or None, ms from j to the T peak or None). The amplitude is returned even when no
    usable tangent exists, because a flat or inverted T is itself a finding; the peak
    position is what tells an ST reading at J+60 apart from the T wave it may be
    standing on."""
    s0 = j + int(0.04 * fs)                 # step over the J / ST shoulder
    stop = int(min(stop, len(x)))
    if stop - s0 < int(0.08 * fs) or s0 < 0:
        return None, None, None
    w = x[s0:stop] - iso
    k = int(np.argmax(np.abs(w)))           # T peak
    amp = float(w[k])
    pk_ms = (s0 + k - j) / fs * 1000.0
    if abs(amp) < T_MIN_MV or k >= len(w) - 4:
        return None, amp, pk_ms
    dv = np.convolve(np.gradient(w), np.ones(5) / 5.0, "same")
    tail = dv[k:]
    m = k + (int(np.argmin(tail)) if amp > 0 else int(np.argmax(tail)))
    slope = dv[m]
    if slope == 0 or np.sign(slope) == np.sign(amp):
        return None, amp, pk_ms             # not a return limb
    end = m - w[m] / slope                  # tangent crosses zero here
    if not (k < end < len(w) + 0.08 * fs):  # a small extrapolation past the window is fine
        return None, amp, pk_ms
    return s0 + float(end), amp, pk_ms


def qt(d, qb, prep_, rr_s):
    """QT/QTc plus the per-lead T amplitude.

    QT runs from the global QRS onset to the median tangent T offset across the leads that
    were printed during that beat. Median (not latest) keeps one noisy lead from setting
    the result; commercial machines using a latest-offset rule read a little longer."""
    fs = d["fs"]
    per_beat, used, tamp, tpk = [], set(), {}, {}
    t_end_global = {}
    for i, (on, off) in enumerate(qb):
        stop_g = on + int(min(0.62 * rr_s, 0.58) * fs)
        if i + 1 < len(qb):
            stop_g = min(stop_g, qb[i + 1][0] - int(0.05 * fs))
        ends = []
        for k, shift in _views(d, on):
            x = prep_.get(k)
            if x is None:
                continue
            lon, loff, lstop = on - shift, off - shift, stop_g - shift
            if lon < 0 or loff >= len(x):
                continue
            iso = _iso(x, lon, fs)
            if iso is None:
                continue
            e, amp, pk = _t_end(x, fs, loff, lstop, iso)
            if amp is not None and k != RHYTHM:
                tamp.setdefault(k, []).append(amp)
                if pk is not None:
                    tpk.setdefault(k, []).append(pk)
            if e is not None:
                ends.append(e - lon)
                used.add("II" if k == RHYTHM else k)
        if ends:
            per_beat.append(float(np.median(ends)))
            t_end_global[i] = on + float(np.median(ends))
    res = {"_t_end": t_end_global}
    if tamp:
        res["t_amp_mm"] = {k: round(float(np.median(v)) * MM_PER_MV, 2) for k, v in tamp.items()}
    if tpk:
        res["t_peak_ms"] = {k: int(round(float(np.median(v)))) for k, v in tpk.items()}
    if not per_beat:
        return res
    qt_s = float(np.median(per_beat)) / fs
    res["qt_ms"] = int(round(qt_s * 1000))
    res["qt_leads_used"] = sorted(used)
    if rr_s > 0:
        res["qtc_bazett_ms"] = int(round(qt_s / np.sqrt(rr_s) * 1000))
        res["qtc_fridericia_ms"] = int(round(qt_s / rr_s ** (1.0 / 3.0) * 1000))
    return res


# ------------------------------------------------------------------------------ ST

def st(d, qb, prep_, hr):
    """ST deviation per lead, in mm, referenced to the PR segment.

    Reported at the J point and at J+60 ms (J+40 ms above 100 bpm, where the T wave
    crowds J+60). Only the three leads of each beat's own column are used, so every
    lead is measured over a comparable number of beats.

    Which of the two to trust: against synthetic ground truth the J+60 value is accurate
    to 0.03 mm (worst lead 0.16 mm), while the J value is off by 0.34 mm on average and
    up to 0.94 mm, because measure._bounds() returns one QRS offset for all leads and it
    lands inside the terminal deflection of any individual lead. A per-lead J refinement
    was tried and removed: it improved the J value to 0.23 mm but degraded J+60 and still
    left a worst case near the 1 mm decision threshold. So J+60 is what the flags use,
    and the J value is reported for information only. Fixing the QRS offset -- the known
    weak point of measure._bounds() -- is what would make the J value usable."""
    fs = d["fs"]
    late_ms = 60 if (hr is None or hr < 100) else 40
    late = int(late_ms / 1000.0 * fs)
    acc = {}
    for on, off in qb:
        for k, shift in _views(d, on):
            if k == RHYTHM:
                continue
            x = prep_.get(k)
            if x is None:
                continue
            lon, loff = on - shift, off - shift
            if lon < 0 or loff + late >= len(x):
                continue
            iso = _iso(x, lon, fs)
            if iso is None:
                continue
            acc.setdefault(k, []).append((x[loff] - iso, x[loff + late] - iso))
    if not acc:
        return {}
    j_mm = {k: round(float(np.median([a for a, _ in v])) * MM_PER_MV, 2) for k, v in acc.items()}
    l_mm = {k: round(float(np.median([b for _, b in v])) * MM_PER_MV, 2) for k, v in acc.items()}
    return {"st_j_mm": j_mm, f"st_j{late_ms}_mm": l_mm, "st_late_point": f"J+{late_ms}ms",
            "st_beats_per_lead": int(np.median([len(v) for v in acc.values()]))}


# ----------------------------------------------------------------------------- P wave

def _p_window(x, fs, on, earliest):
    """P onset/offset by a 15%-of-peak rule, searching back from the QRS onset.

    The isoelectric reference comes from _flat_iso over the search window rather than
    from the PR segment used elsewhere: with a long P and a normal PR interval the PR
    window falls inside the P wave itself, which lifts the reference and clips both edges.

    Returns (window start, P onset, P offset, signed amplitude in mV), all in samples."""
    a = max(int(earliest), on - int(0.34 * fs))
    b = on - int(0.015 * fs)
    if a < 0 or b - a < int(0.06 * fs) or b > len(x):
        return None
    seg = x[a:b]
    iso, noise = _flat_iso(seg, fs, with_noise=True)
    w = seg - iso
    k = int(np.argmax(np.abs(w)))
    amp = float(w[k])
    if abs(amp) < max(P_MIN_MV, 3.0 * noise):
        return None
    # Floor the edge threshold at the noise. A small P wave -- 0.05 mV is ordinary on a
    # photographed trace -- puts 15% of its peak BELOW the noise, so the walk back to
    # the onset never terminates and runs to the edge of the search window, which is
    # reported as a PR of 300-340 ms.
    thr = max(P_EDGE * abs(amp), 2.0 * noise)
    i = k
    while i > 0 and abs(w[i]) > thr:
        i -= 1
    j = k
    while j < len(w) - 1 and abs(w[j]) > thr:
        j += 1
    return a, a + i, a + j, amp


def p_wave(d, qb, prep_, rr_s, t_ends=None):
    """P duration and amplitude (lead II), terminal force in V1 (Morris index) and P axis.

    The P boundaries are found once per beat on lead II -- in global time -- and then
    applied to the other leads, because a small P in a single lead is not a reliable
    place to put an onset. Every lead takes its own TP reference from the same window."""
    fs = d["fs"]
    ref, ref_shift = prep_.get(RHYTHM), 0
    if ref is None:
        ref = prep_.get("II")
        ref_shift = int(round(offset_of(d, "II") * fs)) if ref is not None else 0
    if ref is None:
        return {}
    # keep the search out of the previous T wave, but never past 60% of the cycle: at
    # 140 bpm the Bazett-style guard alone starts after the P has already begun
    guard = int(min(0.40 * np.sqrt(rr_s) + 0.04, 0.60 * rr_s) * fs)
    w_end = int(0.015 * fs)

    wins, durs, amps = [], [], []
    for i, (on, _) in enumerate(qb):
        lon = on - ref_shift
        if lon < 0 or lon >= len(ref):
            continue
        pw = _p_window(ref, fs, lon, qb[i - 1][0] - ref_shift + guard if i > 0 else 0)
        if pw is None:
            continue
        wa, p0, p1, amp = pw
        wa, p0, p1 = wa + ref_shift, p0 + ref_shift, p1 + ref_shift   # back to global time
        wins.append((on, wa, p0, p1))
        durs.append((p1 - p0) / fs * 1000.0)
        amps.append(amp)
    if not wins:
        return {}

    res = {"p_ms": int(round(float(np.median(durs)))),
           "p_amp_ii_mm": round(float(np.median(amps)) * MM_PER_MV, 2),
           "p_beats_used": len(wins)}
    # PR comes from the same P onset this function already located, instead of a second,
    # weaker search: on a noisy trace a 400 ms look-back latches onto the previous T wave
    # and reports a PR of 300 ms. The window here is anchored to the flat-stretch
    # reference and bounded by the previous beat.
    prs = [(on - p0) / fs * 1000.0 for on, _, p0, _ in wins]
    # Report PR only when the beats agree. On a photographed trace with a 0.05 mV P the
    # detector sometimes locks onto the tail of the previous T instead, and the beats
    # then disagree by hundreds of milliseconds. A median of that is a number, not a
    # measurement, and it fires a false "prolonged PR" flag.
    if len(prs) >= 3:
        spread = float(np.percentile(prs, 75) - np.percentile(prs, 25))
        if spread <= 60.0:
            res["pr_ms"] = int(round(float(np.median(prs))))
        else:
            res["pr_spread_ms"] = int(round(spread))
    elif prs:
        res["pr_spread_ms"] = -1          # too few beats to judge
    res["p_waves_per_qrs"] = round(len(wins) / max(len(qb), 1), 2)

    def lead_view(on, k, wa, g0, g1):
        """(signal, iso, P onset, P offset) for lead k at this beat, with the same
        flattest-stretch reference taken inside this lead's own search window."""
        shift = next((sh for kk, sh in _views(d, on) if kk == k), None)
        x = prep_.get(k)
        if shift is None or x is None:
            return None
        a, b = g0 - shift, g1 - shift
        w0, w1 = wa - shift, on - shift - w_end
        if w0 < 0 or a < 0 or b > len(x) or b - a < 3 or w1 > len(x) or w1 - w0 < 10:
            return None
        return x, _flat_iso(x[w0:w1], fs), a, b

    # net P area per lead over the same global window -> frontal P axis
    area = {}
    for on, wa, g0, g1 in wins:
        for k, _ in _views(d, on):
            if k == RHYTHM:
                continue
            v = lead_view(on, k, wa, g0, g1)
            if v is None:
                continue
            x, iso, a, b = v
            area.setdefault(k, []).append(float(np.sum(x[a:b] - iso)) / fs)
    med = {k: float(np.median(v)) for k, v in area.items()}
    if "I" in med and "aVF" in med and (abs(med["I"]) > 1e-6 or abs(med["aVF"]) > 1e-6):
        res["p_axis_deg"] = int(round(float(np.degrees(np.arctan2(med["aVF"], med["I"])))))

    # PTFV1 (Morris): depth x duration of the terminal negative part of P in V1, mm*s
    ptf = []
    for on, wa, g0, g1 in wins:
        v = lead_view(on, "V1", wa, g0, g1)
        if v is None:
            continue
        x, iso, a, b = v
        w = x[a:b] - iso
        if w[-1] >= 0:
            ptf.append(0.0)
            continue
        i = len(w) - 1
        while i > 0 and w[i - 1] < 0:
            i -= 1
        ptf.append(-abs(float(w[i:].min())) * MM_PER_MV * (len(w) - i) / fs)
    if ptf:
        res["ptf_v1_mm_s"] = round(float(np.median(ptf)), 3)
    return res


def all_measures(d, qb, rr_s, hr):
    if not qb:
        return {}
    p = prep(d)
    out = {}
    q = qt(d, qb, p, rr_s)
    t_ends = q.pop("_t_end", {})
    out.update(q)
    out.update(st(d, qb, p, hr))
    out.update(p_wave(d, qb, p, rr_s, t_ends))
    return out

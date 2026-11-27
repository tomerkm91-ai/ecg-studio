"""Bundle branch block and fascicular block assessment from the digitized leads.

The classification follows the AHA/ACCF/HRS 2009 recommendations for the
standardization and interpretation of the electrocardiogram (part III,
intraventricular conduction disturbances), with the Strauss 2011 refinement
reported alongside as a separate, stricter read.

NOTHING HERE IS A DIAGNOSIS. Every criterion is returned with the number that
was measured for it, so the reader can see what the verdict rests on and
overrule it. The gate for every complete block is QRS >= 120 ms, and on a
PHOTOGRAPH of paper this project's QRS has been measured against two printed
machine references at -17 and +7 ms. A QRS reported as 112 could be 129 and a
QRS reported as 130 could be 113, so whenever the uncertainty band crosses a
threshold the band is reported and the verdict is withheld rather than guessed.
"""
import numpy as np

QRS_COMPLETE_MS = 120          # complete block gate
QRS_INCOMPLETE_MS = 110        # incomplete block gate
QRS_ERR_MS = 17                # worst signed error measured against a printed reference
RPT_V1_MS = 50                 # R peak time above this in V1 supports RBBB
RPT_V6_MS = 60                 # R peak time above this in V5/V6 supports LBBB
S_WIDE_MS = 40                 # an S wave wider than this in I/V6 supports RBBB
NOTCH_FRAC = 0.05              # a notch must be this fraction of the QRS peak-to-peak
NOTCH_MIN_MV = 0.05
LAD_DEG, RAD_DEG = -45, 100    # fascicular block axis gates


def _beat_windows(d, qb, lead, pre_ms=40):
    """Baseline-corrected QRS windows for one lead, one array per beat."""
    import clinical
    fs = d["fs"]
    x = np.asarray(d["leads"][lead], float)
    sh = int(round(clinical.offset_of(d, lead) * fs))
    pre = int(round(pre_ms / 1000 * fs))
    out = []
    for on, off in qb:
        a, b = on - sh, off - sh
        if a - pre < 0 or b >= len(x) or b <= a:
            continue
        base = float(np.median(x[a - pre:a]))
        out.append(x[a:b + 1] - base)
    return out, fs


def _features(w, fs):
    """Morphology of one QRS complex, in the terms the block criteria use."""
    n = len(w)
    if n < 4:
        return None
    t_ms = np.arange(n) / fs * 1000.0
    pp = float(w.max() - w.min())
    f = {"dur_ms": float(t_ms[-1]), "pp_mv": pp,
         "net_mv": float(np.trapezoid(w) / fs * 1000.0)}

    # initial q wave: a negative run starting at the onset, before any positive
    first_pos = next((i for i in range(n) if w[i] > 0.05 * pp), None)
    neg0 = next((i for i in range(n) if w[i] < -0.05 * pp), None)
    if neg0 is not None and (first_pos is None or neg0 < first_pos):
        end = first_pos if first_pos is not None else n
        f["q_ms"] = float(t_ms[end - 1] - t_ms[neg0]) if end > neg0 else 0.0
        f["q_mv"] = float(abs(w[neg0:end].min()))
    else:
        f["q_ms"], f["q_mv"] = 0.0, 0.0

    # R peak time (intrinsicoid deflection): onset to the LAST positive peak
    pos = np.where(w > 0.10 * pp)[0]
    f["r_peak_ms"] = float(t_ms[int(pos[np.argmax(w[pos])])]) if len(pos) else 0.0
    if len(pos):
        # the last distinct positive peak, which is R' when there is one
        last = pos[-1]
        while last > 0 and w[last - 1] >= w[last]:
            last -= 1
        f["r_last_ms"] = float(t_ms[last])
    else:
        f["r_last_ms"] = 0.0

    # S wave: the negative excursion that follows the main positive one
    if len(pos):
        after = w[pos[-1]:]
        s_idx = int(np.argmin(after))
        f["s_mv"] = float(abs(min(after[s_idx], 0.0)))
        below = np.where(after < -0.05 * pp)[0]
        f["s_ms"] = float(len(below) / fs * 1000.0)
    else:
        f["s_mv"] = float(abs(w.min()))
        f["s_ms"] = float(np.sum(w < -0.05 * pp) / fs * 1000.0)

    # terminal 40 ms: positive there is the R' of an rSR'
    k = max(1, int(round(0.040 * fs)))
    f["terminal_mv"] = float(np.mean(w[-k:]))
    f["terminal_positive"] = bool(f["terminal_mv"] > 0.05 * pp)
    f["qs_or_rs"] = bool(f["net_mv"] < 0 and not f["terminal_positive"])

    # mid-QRS notching/slurring: turning points inside the middle half
    lo, hi = int(0.25 * n), int(0.75 * n)
    mid = w[lo:hi]
    notches = 0
    if len(mid) > 4:
        dv = np.diff(mid)
        sign_change = np.where(np.diff(np.sign(dv)) != 0)[0]
        for i in sign_change:
            j = i + 1
            local = mid[max(0, j - 6):j + 7]
            if len(local) and (local.max() - local.min()) > max(NOTCH_FRAC * pp, NOTCH_MIN_MV):
                notches += 1
    f["notches"] = int(notches)
    return f


def lead_features(d, qb):
    """Median morphology per lead, over the beats that fit inside that lead."""
    out = {}
    for k in d["leads"]:
        ws, fs = _beat_windows(d, qb, k)
        fe = [x for x in (_features(w, fs) for w in ws) if x]
        if not fe:
            continue
        out[k] = {key: float(np.median([x[key] for x in fe])) if not isinstance(fe[0][key], bool)
                  else bool(np.median([float(x[key]) for x in fe]) >= 0.5)
                  for key in fe[0]}
        out[k]["beats"] = len(fe)
    return out


def _crit(name, ok, detail):
    return {"criterion": name, "met": None if ok is None else bool(ok), "detail": detail}


def assess(d, qb, res):
    """Criteria-by-criteria conduction assessment. Returns a dict, never a bare label."""
    F = lead_features(d, qb)
    q = res.get("qrs_ms")
    out = {"lead_features": F, "qrs_ms": q,
           "qrs_band_ms": None if q is None else [q - QRS_ERR_MS, q + QRS_ERR_MS]}

    if q is None:
        out["verdict"] = "לא ניתן להעריך: רוחב QRS לא נמדד"
        return out

    lo, hi = q - QRS_ERR_MS, q + QRS_ERR_MS
    # Which gate does the measurement band straddle? Saying "uncertain" for a band
    # that never reaches 120 ms throws away a real answer: it settles the COMPLETE
    # block question even while leaving the incomplete one open.
    if hi < QRS_INCOMPLETE_MS:
        width = "narrow"                 # below both gates for certain
    elif lo >= QRS_COMPLETE_MS:
        width = "complete"               # above the complete gate for certain
    elif lo < QRS_COMPLETE_MS <= hi:
        width = "uncertain"              # the band straddles 120: cannot be decided
    elif lo >= QRS_INCOMPLETE_MS:
        width = "incomplete"             # between the gates for certain
    else:
        width = "narrow_or_incomplete"   # under 120 for certain, 110 still open
    out["width_class"] = width

    g = lambda k, f, dflt=0.0: float(F.get(k, {}).get(f, dflt))
    b = lambda k, f: bool(F.get(k, {}).get(f, False))
    have = lambda *ks: all(k in F for k in ks)

    # ---------------------------------------------------------------- LBBB
    lb = []
    lb.append(_crit("QRS ≥ 120 ms",
                    None if width == "uncertain" else width == "complete",
                    f"{q} ms (טווח מדידה {lo:.0f}–{hi:.0f})"))
    if have("V1"):
        lb.append(_crit("V1: QS או rS, בלי R סופי", b("V1", "qs_or_rs"),
                        f"שטח נטו {g('V1','net_mv'):+.2f} mV·ms, "
                        f"סוף הקומפלקס {g('V1','terminal_mv'):+.2f} mV"))
    for k in ("I", "V5", "V6"):
        if k in F:
            lb.append(_crit(f"{k}: ללא גל q", g(k, "q_ms") < 10,
                            f"q של {g(k,'q_ms'):.0f} ms, {g(k,'q_mv'):.2f} mV"))
    for k in ("V5", "V6"):
        if k in F:
            lb.append(_crit(f"{k}: זמן שיא R > {RPT_V6_MS} ms",
                            g(k, "r_peak_ms") > RPT_V6_MS, f"{g(k,'r_peak_ms'):.0f} ms"))
    notch_leads = [k for k in ("I", "aVL", "V1", "V2", "V5", "V6")
                   if k in F and F[k]["notches"] >= 1]
    lb.append(_crit("חריץ באמצע ה-QRS ב-2 לידים לפחות (Strauss)",
                    len(notch_leads) >= 2,
                    f"{len(notch_leads)} לידים: {', '.join(notch_leads) or '—'}"))
    out["lbbb"] = lb

    # ---------------------------------------------------------------- RBBB
    rb = []
    rb.append(_crit("QRS ≥ 120 ms",
                    None if width == "uncertain" else width == "complete",
                    f"{q} ms (טווח מדידה {lo:.0f}–{hi:.0f})"))
    if have("V1"):
        rb.append(_crit("V1: R סופי (rsR' / rSR')", b("V1", "terminal_positive"),
                        f"סוף הקומפלקס {g('V1','terminal_mv'):+.2f} mV, "
                        f"שיא R אחרון ב-{g('V1','r_last_ms'):.0f} ms"))
        rb.append(_crit(f"V1: זמן שיא R > {RPT_V1_MS} ms",
                        g("V1", "r_peak_ms") > RPT_V1_MS, f"{g('V1','r_peak_ms'):.0f} ms"))
    wide_s = [k for k in ("I", "V6") if k in F and g(k, "s_ms") > S_WIDE_MS]
    if have("I") or have("V6"):
        rb.append(_crit(f"I ו-V6: גל S רחב מ-{S_WIDE_MS} ms", len(wide_s) >= 1,
                        ", ".join(f"{k} {g(k,'s_ms'):.0f} ms" for k in ("I", "V6") if k in F)))
    out["rbbb"] = rb

    # -------------------------------------------------------------- verdict
    req_l = [c["met"] for c in lb[1:4] if c["met"] is not None]
    req_r = [c["met"] for c in rb[1:] if c["met"] is not None]
    l_ok = bool(req_l) and all(req_l[:2])
    r_ok = bool(req_r) and req_r[0] and (len(req_r) < 3 or req_r[-1])
    out["lbbb_pattern"], out["rbbb_pattern"] = l_ok, r_ok

    if width == "uncertain":
        out["verdict"] = ("לא מוכרע: רוחב ה-QRS חוצה את סף 120 ms בתוך טווח שגיאת המדידה "
                          f"({lo:.0f}–{hi:.0f} ms). צריך קריאה בתרשים המקורי.")
        out["verdict_key"] = "uncertain"
    elif width == "narrow_or_incomplete":
        pat = "שמאלי" if l_ok else ("ימני" if r_ok else None)
        out["verdict"] = (f"אין חסם צרור מלא — ה-QRS מתחת ל-120 ms גם בקצה העליון של טווח "
                          f"המדידה ({lo:.0f}–{hi:.0f} ms). "
                          + (f"המורפולוגיה היא של צד {pat}, וייתכן חסם חלקי."
                             if pat else "האבחנה בין תקין לחסם חלקי אינה מוכרעת."))
        out["verdict_key"] = "no_complete_block"
    elif width == "narrow":
        out["verdict"] = f"QRS צר ({q} ms) — אין חסם צרור מלא ואין חלקי."
        out["verdict_key"] = "normal"
    elif width == "incomplete":
        pat = "שמאלי" if l_ok else ("ימני" if r_ok else None)
        out["verdict"] = (f"QRS {q} ms עם מורפולוגיה של חסם {pat} — דפוס של חסם חלקי."
                          if pat else f"QRS {q} ms בלי מורפולוגיה אופיינית — הפרעת הולכה לא ספציפית.")
        out["verdict_key"] = ("incomplete_lbbb" if pat == "שמאלי"
                              else "incomplete_rbbb" if pat == "ימני" else "ivcd")
    elif l_ok and not r_ok:
        out["verdict"] = f"דפוס תואם חסם צרור שמאלי (LBBB), QRS {q} ms."
        out["verdict_key"] = "lbbb"
    elif r_ok and not l_ok:
        out["verdict"] = f"דפוס תואם חסם צרור ימני (RBBB), QRS {q} ms."
        out["verdict_key"] = "rbbb"
    elif l_ok and r_ok:
        out["verdict"] = ("הקריטריונים של שני הצדדים התקיימו — זה לא קורה בחסם אמיתי "
                          "ומעיד על קריאה שגויה של הלידים. לא מוכרע.")
        out["verdict_key"] = "conflict"
    else:
        out["verdict"] = (f"QRS רחב ({q} ms) בלי מורפולוגיה של חסם שמאלי או ימני — "
                          "הפרעת הולכה תוך-חדרית לא ספציפית (IVCD).")
        out["verdict_key"] = "ivcd"

    # ------------------------------------------------- fascicular, axis-based
    ax = res.get("axis_deg")
    fas = None
    if res.get("axis_uncertain") or ax is None:
        fas = {"name": None, "note": res.get("axis_note") or "הציר אינו אמין — לא נבדק חסם פסיקולרי"}
    elif width in ("narrow", "incomplete"):
        if ax <= LAD_DEG:
            fas = {"name": "LAFB", "note": f"ציר {ax}° (סף ≤ {LAD_DEG}°) עם QRS לא רחב"}
        elif ax >= RAD_DEG:
            fas = {"name": "LPFB", "note": f"ציר {ax}° (סף ≥ {RAD_DEG}°) — אבחנת שלילה בלבד"}
    out["fascicular"] = fas
    return out

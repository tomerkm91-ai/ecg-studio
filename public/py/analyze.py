"""CLI: python3 analyze.py <ecg_image> [--plot out.png]  -> JSON + Hebrew summary."""
import argparse, json
import cv2
import numpy as np
import digitize, measure

DISCLAIMER = ("כלי הוראה ולמידה בלבד. מיועד להדגמה ולתרגול קריאת אק״ג, "
              "ואינו משמש מכשיר רפואי, לאבחון או לקבלת החלטות קליניות.")

# contiguous lead groups, for ST criteria that require two neighbouring leads
ST_GROUPS = [("תחתוניים (II, III, aVF)", ["II", "III", "aVF"]),
             ("צדיים גבוהים (I, aVL)", ["I", "aVL"]),
             ("קדמיים-ספטליים (V1, V2)", ["V1", "V2"]),
             ("קדמיים (V3, V4)", ["V3", "V4"]),
             ("צדיים (V5, V6)", ["V5", "V6"])]
# elevation threshold in mm; V2-V3 depend on sex and age (2.0 / 2.5 / 1.5) and the most
# sensitive of the three is used here because neither is known from the image
ST_UP, ST_UP_V = 1.0, 1.5
ST_DOWN = -0.5
T_INV = -1.0        # a T deeper than this counts as inverted; aVR is excluded (normally so)
T_NEAR_MS = 40      # a T peak this close to the ST sampling point contaminates the reading


def flags(m, meta=None):
    f = []
    hr = m.get("hr_bpm")
    if hr and hr < 60: f.append("ברדיקרדיה")
    if hr and hr > 100: f.append("טכיקרדיה")
    if m.get("regular") is False: f.append("קצב לא סדיר")
    if m.get("pr_ms", 0) > 200: f.append("PR מוארך (מתאים לחסם AV דרגה 1 אם כל P מועבר)")
    if 0 < m.get("pr_ms", 999) < 120: f.append("PR קצר")
    q = m.get("qrs_ms", 0)
    if q >= 120: f.append("QRS רחב (≥120 ms)")
    elif q >= 110: f.append("QRS גבולי (110-119 ms)")
    ax = m.get("axis_deg")
    if m.get("axis_uncertain"):
        # The two derivations disagree, which means the QRS boundaries failed on this
        # page. An axis flag raised on top of that would be a confident wrong answer,
        # so the number is still reported but no deviation is called.
        f.append(f"הציר אינו אמין בצילום הזה: שתי שיטות הגזירה נחלקות ב-"
                 f"{m.get('axis_methods_differ_deg')}° (אמפליטודה {ax}°, שטח "
                 f"{m.get('axis_area_deg')}°) — לא מוכרז עליו דגל")
    elif ax is not None:
        if -90 <= ax < -30: f.append("סטיית ציר שמאלית")
        elif 90 < ax <= 180: f.append("סטיית ציר ימנית")
        elif ax < -90: f.append("ציר קיצוני")
    if m.get("p_waves_per_qrs", 1) < 0.5: f.append("לא זוהו גלי P בעקביות")

    # --- QTc -------------------------------------------------------------------
    qb_, qf_ = m.get("qtc_bazett_ms"), m.get("qtc_fridericia_ms")
    if qb_ is not None:
        if qb_ >= 500: f.append(f"QTc מוארך מאוד ({qb_} ms, Bazett) — סיכון מוגבר ל-torsades")
        elif qb_ >= 460: f.append(f"QTc מוארך ({qb_} ms, Bazett)")
        elif qb_ >= 450: f.append(f"QTc גבולי ({qb_} ms) — מוארך לגברים, תקין-גבולי לנשים")
        elif qb_ < 340: f.append(f"QTc קצר ({qb_} ms, Bazett)")
        if qf_ is not None and abs(qb_ - qf_) > 25:
            f.append(f"תיקון הקצב ל-QT אינו יציב בדופק הזה (Bazett {qb_} מול Fridericia {qf_} ms)")

    # --- ST and T --------------------------------------------------------------
    st = m.get("st_j60_mm") or m.get("st_j40_mm") or {}
    tamp = m.get("t_amp_mm") or {}
    tpk = m.get("t_peak_ms") or {}
    at = m.get("st_late_point", "J+60ms")
    at_ms = 40 if "40" in at else 60

    def on_the_t(leads):
        """True when the ST sampling point is sitting on the T wave in these leads,
        which a fixed J+offset rule cannot tell apart from a real ST shift."""
        near = [k for k in leads if k in tpk and abs(tpk[k] - at_ms) < T_NEAR_MS]
        return len(near) >= max(1, len(leads) - 1)
    for label, leads in ST_GROUPS:
        vals = [(k, st[k]) for k in leads if k in st]
        up = [k for k, v in vals if v >= (ST_UP_V if k in ("V2", "V3") else ST_UP)]
        dn = [k for k, v in vals if v <= ST_DOWN]
        if len(up) >= 2:
            txt = (f"עליית ST ב-{label} ב-{at}: " +
                   ", ".join(f"{k} {st[k]:+.1f} mm" for k in up) +
                   (" (סף V2/V3 תלוי מין וגיל)" if any(k in ("V2", "V3") for k in up) else ""))
            if on_the_t(up):
                txt += " — שיא גל T סמוך לנקודת המדידה, ייתכן שהערך משקף את גל T ולא את מקטע ST"
            f.append(txt)
        if len(dn) >= 2:
            txt = f"צניחת ST ב-{label} ב-{at}: " + ", ".join(f"{k} {st[k]:+.1f} mm" for k in dn)
            # a fixed J+60 offset samples the leading edge of an inverted T, so say so
            # rather than present it as an ST-segment finding
            if all(tamp.get(k, 1.0) < 0 for k in dn) or on_the_t(dn):
                txt += " — גל T הפוך או סמוך לנקודת המדידה, ייתכן שהערך משקף את גל T ולא את מקטע ST"
            f.append(txt)
        inv = [k for k in leads if tamp.get(k, 1.0) <= T_INV]
        if len(inv) >= 2:
            note = ""
            if set(inv) <= {"V1", "V2"}: note = " (הפוך ב-V1 שכיח כווריאנט תקין)"
            elif set(inv) <= {"III", "aVF"}: note = " (הפוך ב-III שכיח כווריאנט תקין)"
            f.append(f"היפוך גל T ב-{label}: " +
                     ", ".join(f"{k} {tamp[k]:+.1f} mm" for k in inv) + note)

    # --- P wave ----------------------------------------------------------------
    pm = m.get("p_ms")
    if pm is not None and pm >= 120:
        f.append(f"גל P רחב ({pm} ms) — מתאים להפרעת פרוזדור שמאל")
    pa = m.get("p_amp_ii_mm")
    if pa is not None and pa >= 2.5:
        f.append(f"גל P גבוה ב-II ({pa} mm) — מתאים להעמסת פרוזדור ימין (P pulmonale)")
    ptf = m.get("ptf_v1_mm_s")
    if ptf is not None and ptf <= -0.04:
        f.append(f"כוח סופי שלילי ב-V1 ({ptf} mm·s) — מתאים להפרעת פרוזדור שמאל (Morris)")
    pax = m.get("p_axis_deg")
    if pax is not None and not (0 <= pax <= 75):
        f.append(f"ציר P חריג ({pax}°) — ייתכן קצב פרוזדורי אקטופי ולא סינוס")
    return f


def notes(m, meta):
    n = []
    meta = meta or {}
    if meta.get("layout"):
        n.append(f"פריסה: {meta['layout']}, סדר לידים: {meta.get('lead_order','standard')}. "
                 f"סדר הלידים אינו קריא מהתמונה — אם הוא שגוי, לידים יוחלפו בשקט "
                 f"(אפשר לכפות עם --lead-order).")
    if m.get("pr_spread_ms") is not None:
        sp = m["pr_spread_ms"]
        n.append("PR לא דווח: " + ("פחות מ-3 פעימות עם גל P ברור."
                 if sp < 0 else f"הפעימות לא מסכימות (פיזור {sp} ms) — גל P קטן מדי ביחס לרעש."))
    if m.get("beats_from") == "summed lead envelope":
        n.append("אין רצועת קצב: הפעימות זוהו מסכום כל הלידים. הדופק והסדירות אמינים פחות, "
                 "ו-PR נמדד רק מהפעימות שנפלו בקטע של ליד II.")
    if meta.get("gain_note"):
        n.append("פולס הכיול לא נקרא; ההגבר נלקח כתקן 10 mm/mV על סמך הרשת.")
    if meta.get("scale_from", "").startswith("calibration"):
        n.append("קנה המידה נגזר מפולס הכיול ולא מהרשת — שגיאת קצב של כמה אחוזים אפשרית.")
    if (meta or {}).get("layout") == "3x4":
        n.append("אין רצועת קצב: הדופק, הסדירות ו-QT חושבו מ-2.5 שניות בלבד (2-3 פעימות).")
    if m.get("st_j_mm") is not None:
        n.append("ST בנקודת J מדווח לידיעה בלבד — מיקום J יורש את שגיאת גבול ה-QRS "
                 "(שגיאה ממוצעת 0.34 mm). הדגלים מבוססים על " +
                 m.get("st_late_point", "J+60ms") + ".")
    if m.get("st_beats_per_lead", 9) < 2:
        n.append("פחות משתי פעימות לליד — ערכי ST לא יציבים.")
    if m.get("qrs_ms") is not None:
        n.append("רוחב ה-QRS נמדד בחסר שיטתי (~20 ms על אותות סינתטיים); "
                 "QT נמדד מאותו גבול ולכן קצר באותו סדר גודל.")
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--plot")
    ap.add_argument("--layout", choices=sorted(digitize.LAYOUTS),
                    help="כפיית פריסה במקום זיהוי אוטומטי")
    ap.add_argument("--lead-order", default="standard", choices=sorted(digitize.LEAD_ORDERS),
                    help="סדר לידי הגפיים בשורות (norav מדפיס aVL לפני aVR)")
    ap.add_argument("--rotate", default="auto",
                    help="auto (ברירת מחדל) או 0/90/180/270 מעלות נגד כיוון השעון")
    a = ap.parse_args()
    # Not cv2.imread: on Windows OpenCV opens the path through the narrow-character API,
    # so a photo in a folder named in Hebrew comes back as None. Reading the bytes in
    # Python and decoding them works for any path, and is what core.run already does.
    try:
        img = cv2.imdecode(np.fromfile(a.image, dtype=np.uint8), cv2.IMREAD_COLOR)
    except OSError:
        img = None
    if img is None:
        raise SystemExit("לא ניתן לקרוא את הקובץ")
    try:
        d = digitize.digitize(img, layout=a.layout, lead_order=a.lead_order, rotate=a.rotate)
    except digitize.DigitizeError as e:
        raise SystemExit(f"קריאת התרשים נכשלה: {e}")
    m = measure.measure(d)
    out = dict(meta=d["meta"], measurements=m, flags=flags(m, d["meta"]),
               notes=notes(m, d["meta"]), disclaimer=DISCLAIMER)
    print(json.dumps(out, ensure_ascii=False, indent=2, default=float))
    if a.plot:
        import matplotlib; matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        order = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]
        fig, ax = plt.subplots(13, 1, figsize=(10, 16), sharex=False)
        for i, k in enumerate(order):
            x = d["leads"][k]; ax[i].plot(np.arange(len(x)) / d["fs"], x, lw=0.8); ax[i].set_ylabel(k, rotation=0)
        r = d["rhythm"] if d["rhythm"] is not None else []
        ax[12].plot(np.arange(len(r)) / d["fs"], r, lw=0.8); ax[12].set_ylabel("II", rotation=0)
        fig.suptitle("Digitized signals"); fig.tight_layout(); fig.savefig(a.plot, dpi=80)


if __name__ == "__main__":
    main()

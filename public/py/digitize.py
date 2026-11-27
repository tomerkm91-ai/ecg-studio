"""ECG image -> digital signals.

Pipeline: masks (ink / grid / trace) -> deskew -> rotation -> row (lead) detection ->
layout -> scale (px/mm, px/mV) -> per-column trace extraction -> resample to 500 Hz.

Colour independence. Nothing here looks for a red grid, because real printouts come on
red, orange, grey, green and blue paper, from screens, and with no grid at all. Instead:
  ink   = anything darker than the local paper background (a morphological closing),
          so uneven lighting and paper tint drop out before any threshold is chosen.
  grid  = the runs inside that ink which stay straight across at least 30% of the page.
          A grid line spans the sheet; an ECG baseline is broken by a QRS every second
          and a QRS spike is at most ~20 mm tall, so neither survives that opening.
  trace = the strong half of the ink (Otsu, computed on the ink itself) minus the grid.

Scale. px/mm comes from the grid when there is one, and otherwise from the 1 mV
calibration pulse, which is 10 mm tall by definition. px/mV always comes from the pulse.

Layouts. The number of lead rows is read from the row-projection autocorrelation (the
first lag whose multiples also peak, so a harmonic cannot pass as the fundamental) and
snapped to a known layout. Auto-detection got 5 of 6 real photos right in testing, so
`layout=` overrides it, and `lead_order=` overrides the row-to-lead mapping, which no
image carries in a machine-readable form.
"""
import numpy as np
import cv2
from scipy import ndimage, signal

FS = 500
LIMB = ["I", "II", "III", "aVR", "aVL", "aVF"]
CHEST = ["V1", "V2", "V3", "V4", "V5", "V6"]

# Row order varies by vendor: Norav's Holter prints aVL before aVR, which silently swaps
# two leads (and the axis with them) for anything that assumes the standard order.
LEAD_ORDERS = {
    "standard": ["I", "II", "III", "aVR", "aVL", "aVF"],
    "norav":    ["I", "II", "III", "aVL", "aVR", "aVF"],
}

LAYOUTS = {
    # rows x columns of the printed grid of traces; `extra` is a trailing row that is not
    # a lead at normal scale (a rhythm strip, or a compressed full-disclosure strip)
    "3x4":    dict(rows=3,  cols=4, extra=None),
    "3x4+1":  dict(rows=3,  cols=4, extra="rhythm"),
    # half a 6x2 page: one photo that caught only the limb column, or only the chest one
    "6x1":    dict(rows=6, cols=1, extra=None, half="limb"),
    "6x1V":   dict(rows=6, cols=1, extra=None, half="chest"),
    "6x2":    dict(rows=6,  cols=2, extra=None),
    "6x2+1":  dict(rows=6,  cols=2, extra="rhythm"),
    "12x1":   dict(rows=12, cols=1, extra=None),
    "12x1+1": dict(rows=12, cols=1, extra="compressed"),
}
ROWS_TO_LAYOUT = {3: "3x4", 4: "3x4+1", 6: "6x2", 7: "6x2+1", 12: "12x1", 13: "12x1+1"}


class DigitizeError(Exception):
    pass


def lead_grid(name, order="standard"):
    """Which lead sits in each (row, column) of a layout."""
    spec = LAYOUTS[name]
    limb = LEAD_ORDERS.get(order, LEAD_ORDERS["standard"])
    if spec["cols"] == 4:        # 3x4: limb | augmented | V1-V3 | V4-V6
        return [[limb[0], limb[3], CHEST[0], CHEST[3]],
                [limb[1], limb[4], CHEST[1], CHEST[4]],
                [limb[2], limb[5], CHEST[2], CHEST[5]]]
    if spec["cols"] == 2:        # 6x2: the six limb leads beside the six chest leads
        return [[limb[i], CHEST[i]] for i in range(6)]
    half = spec.get("half")
    if half == "limb":
        return [[k] for k in limb]
    if half == "chest":
        return [[k] for k in CHEST]
    return [[k] for k in limb + CHEST]        # 12x1: one lead per row, full duration


# ------------------------------------------------------------------ masks and geometry

def _masks(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = g.shape
    k = max(15, (min(h, w) // 50) | 1)
    bg = cv2.morphologyEx(g, cv2.MORPH_CLOSE,
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    ink_v = cv2.subtract(bg, g)
    mad = float(np.median(np.abs(ink_v.astype(float) - np.median(ink_v))))
    lo = max(6.0, 4.0 * mad)
    any_ink = (ink_v > lo).astype(np.uint8)
    if int(any_ink.sum()) < 500:
        raise DigitizeError("לא נמצא דיו על הדף — התמונה בהירה או ריקה מדי")
    lw, lh = max(40, int(0.30 * w)), max(40, int(0.30 * h))
    gap = max(3, min(h, w) // 400)
    def lines(m):
        # Close along each axis before opening. Plenty of ECG paper prints a DOTTED
        # grid rather than ruled lines, and a run of dots has no continuous stretch for
        # the opening to keep -- without this the grid mask comes back completely empty
        # on that paper, however dark the dots are.
        hor = cv2.morphologyEx(m, cv2.MORPH_CLOSE,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (gap, 1)))
        hor = cv2.morphologyEx(hor, cv2.MORPH_OPEN,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (lw, 1)))
        ver = cv2.morphologyEx(m, cv2.MORPH_CLOSE,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (1, gap)))
        ver = cv2.morphologyEx(ver, cv2.MORPH_OPEN,
                               cv2.getStructuringElement(cv2.MORPH_RECT, (1, lh)))
        return ((hor | ver) > 0).astype(np.uint8)
    grid = lines(any_ink)
    ink = any_ink
    # Split ink into trace and grid by darkness -- but compute the threshold only off the
    # lattice. On black or grey paper the 5 mm lines are as dark as the trace, and an
    # Otsu taken over all the ink drags the threshold down until those lines count as
    # trace. Excluding the lattice from the histogram (not from the image) fixes it
    # without assuming any particular ink colour.
    off = (any_ink > 0) & (grid == 0)
    sample = ink_v[off] if off.sum() > 200 else ink_v[any_ink > 0]
    t, _ = cv2.threshold(sample, 0, 255, cv2.THRESH_OTSU)
    strong = (ink_v > max(float(t), lo)).astype(np.uint8)
    # Remove only the dark grid lines that survived the Otsu split, and do not dilate
    # them: a dilated line erases the trace wherever the two cross, which chops a lead
    # into one fragment per millimetre. The small closing afterwards repairs the 1-2 px
    # the line itself took out, so the trace stays one connected component.
    # subtract the WHOLE lattice, not just the lines dark enough to pass Otsu: on black
    # or grey paper the 5 mm lines are as dark as the trace, and Otsu then keeps them.
    # The repair closing is kept at 3x3 because anything wider thickens the trace, and a
    # thicker trace blurs exactly the features the P-wave and ST measurements read.
    trace = (strong & (1 - lines(strong))).astype(np.uint8)
    trace = cv2.morphologyEx(trace, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return trace, grid, ink, ink_v


def _deskew_angle(m):
    small = cv2.resize(m * 255, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA).astype(float)
    def score(a):
        rot = ndimage.rotate(small, a, reshape=False, order=1)
        return np.var(rot.sum(1)) + np.var(rot.sum(0))
    coarse = np.arange(-8, 8.01, 0.5)
    a0 = coarse[int(np.argmax([score(a) for a in coarse]))]
    fine = np.arange(a0 - 0.5, a0 + 0.51, 0.05)
    return float(fine[int(np.argmax([score(a) for a in fine]))])


def _grid_period(ink_v, w, h):
    """Millimetre period of the grid, in px, from the periodicity of the ink itself.

    Not from a binary line mask: plenty of paper prints a DOTTED grid whose dots sit at
    the photo's noise floor (measured: dots at ink 8-17 against a noise floor of 12), so
    no mask of it survives -- but project thousands of those pixels onto one axis and
    the periodicity is still plainly there.

    The search is restricted to the lags a 150-450 mm page allows. That restriction is
    what settles the real difficulty: an unconstrained autocorrelation flips between the
    1 mm fundamental and its 5 mm harmonic (5 / 10 / 56 / 193 px across two photos of
    one printout), and being wrong by 5x makes every measurement wrong by 5x."""
    found = []
    for axis, n in ((0, w), (1, h)):
        v = np.clip(ink_v.astype(float), 0, 30)   # flatten the trace, keep grid-level ink
        prof = v.sum(axis)
        prof = prof - ndimage.uniform_filter1d(prof, 101)
        ac = np.correlate(prof, prof, "full")[len(prof) - 1:]
        if not np.isfinite(ac[0]) or ac[0] <= 0:
            continue
        ac = ac / ac[0]
        lo, hi = max(3, int(n / 450)), int(n / 150) + 1
        peaks, _ = signal.find_peaks(ac[:min(len(ac), 6 * hi)])
        cand = [p for p in peaks if lo <= p <= hi and ac[p] > 0.08]
        if not cand:
            continue
        # a true 1 mm period has the 5 mm box as a harmonic; prefer a candidate with one
        ranked = sorted(cand, key=lambda q: (0 if any(abs(r - 5 * q) <= 3 for r in peaks) else 1,
                                             -ac[q]))
        found.append((float(ranked[0]), float(ac[ranked[0]])))
    if not found:
        return None
    return max(found, key=lambda t: t[1])[0]


def _refine_period(ink_v, p, axis=1):
    """Sub-pixel period, by locking onto the 5 mm box rather than the 1 mm one."""
    v = np.clip(ink_v.astype(float), 0, 30)
    prof = v.sum(axis)
    prof = prof - prof.mean()
    lags = np.arange(max(2, int(4.5 * p)), int(5.5 * p) + 1)
    if not len(lags) or lags[-1] >= len(prof):
        return float(p)
    ac = [float(np.dot(prof[:-l], prof[l:])) for l in lags]
    out = float(lags[int(np.argmax(ac))]) / 5.0
    # A nudge only. On a clean ruled grid this buys sub-pixel accuracy; on a dotted one
    # the 5 mm lag is noisy and an unbounded refinement walks the period off by 10%,
    # which is a 10% error in every rate and interval that follows.
    return out if abs(out - p) <= 0.04 * p else float(p)


def _rows_from_components(trace, frac=0.20):
    """Vertical centre of every mark that crosses at least `frac` of the page."""
    h, w = trace.shape
    n, lab, st, _ = cv2.connectedComponentsWithStats(trace, connectivity=8)
    segs = []
    for i in range(1, n):
        if st[i, cv2.CC_STAT_WIDTH] > frac * w:
            top = int(st[i, cv2.CC_STAT_TOP])
            segs.append((top, top + int(st[i, cv2.CC_STAT_HEIGHT])))
    if len(segs) < 3:
        return None
    segs.sort()
    merged = [list(segs[0])]
    for a, b in segs[1:]:
        # Merge only on a SUBSTANTIAL overlap. Two adjacent leads whose excursions just
        # graze each other -- three pixels was enough on a real printout -- are one lead
        # under a touch-based rule, and the row count comes out one short.
        ov = min(b, merged[-1][1]) - max(a, merged[-1][0])
        if ov > 0.40 * min(b - a, merged[-1][1] - merged[-1][0]):
            merged[-1][1] = max(merged[-1][1], b)
            merged[-1][0] = min(merged[-1][0], a)
        else:
            merged.append([a, max(b, merged[-1][1]) if a <= merged[-1][1] else b])
    if len(merged) < 3:
        return None
    return np.array([(a + b) // 2 for a, b in merged], int)


def _wide_only(trace, frac=0.20):
    """Keep the long components: a lead trace crosses most of the page, text does not."""
    n, lab, st, _ = cv2.connectedComponentsWithStats(trace, connectivity=8)
    keep = np.zeros(n, bool)
    keep[1:] = st[1:, cv2.CC_STAT_WIDTH] > frac * trace.shape[1]
    return keep[lab].astype(np.uint8)


def _baselines(trace):
    """Row anchors read off the printed baselines: the flat ink each lead rests on.

    `_rows_from_components` reads a row as one connected mark running across the page.
    That is right when the rows are evenly spaced and the marks do not touch. It breaks
    on a printer that gives each channel vertical room in proportion to its amplitude --
    a Fukuda FX-8400 page measured 61 px between II/III/aVR and 113 px between V4/V5/V6 --
    because neighbouring marks merge and split: on that page the last four anchors came
    out 35, 75, 110 and 216 px below the true baselines, and the twelfth landed on the
    timing line at the foot of the page. The leads were still extracted, from the wrong
    strips of paper, and the result was a confident, wrong ECG.

    The baseline survives that, because it is the one part of a lead that is flat.
    Opening the mask with a short horizontal kernel keeps near-horizontal runs and
    deletes everything steep, leaving one sharp peak per row at the pen's rest position.
    Returns (peaks, flatness profile) or (None, None)."""
    h, w = trace.shape
    k = max(7, int(round(w / 300.0)))        # ~1 mm of paper; a QRS limb never lasts that
    m = cv2.dilate(trace, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3)))
    flat = cv2.morphologyEx(m, cv2.MORPH_OPEN,
                            cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))
    prof = ndimage.uniform_filter1d(flat.sum(1).astype(float), 5)
    if prof.max() <= 0:
        return None, None
    sep = max(8, int(round(0.004 * w)))
    pk, _ = signal.find_peaks(prof, distance=sep, height=0.12 * prof.max())
    if len(pk) >= 3:
        # Re-filter at a separation derived from the rows actually found, so a long ST
        # plateau a few millimetres off the baseline is not counted as a row of its own.
        gap = float(np.median(np.diff(pk)))
        sep2 = max(sep, int(round(0.40 * gap)))
        if sep2 > sep:
            pk, _ = signal.find_peaks(prof, distance=sep2, height=0.12 * prof.max())
        # A lead needs room for its excursions on both sides, so a peak closer to an
        # edge of the photograph than half a row cannot be one. This is what throws out
        # the header text at the top and the dark edge of the table the paper was lying
        # on: the latter is as flat as any baseline and carries more ink than a
        # small-amplitude limb lead, so on one page it was kept as the twelfth row and
        # lead II was dropped in its place.
        m = max(8, int(round(0.5 * gap)))
        pk = pk[(pk >= m) & (pk <= h - m)]
    return (np.asarray(pk, int), prof) if len(pk) else (None, None)


def _reanchor(rows, trace, want):
    """Move the row anchors onto the printed baselines when every row has one.

    Only the anchors change, never the count: the layout has already been settled from
    the component count by the time this runs. Returns (rows, source)."""
    pk, prof = _baselines(trace)
    if pk is None or len(pk) < want:
        return rows, "components"
    return _pick_rows(pk, trace, want, prof=prof), "baselines"


def _row_pitch(prof):
    """Spacing of the lead rows: the first autocorrelation lag whose multiples also peak."""
    n = len(prof)
    p = prof - ndimage.uniform_filter1d(prof, max(31, n // 6))
    ac = np.correlate(p, p, "full")[n - 1:]
    if not np.isfinite(ac[0]) or ac[0] <= 0:
        return None
    ac = ac / ac[0]
    hi = n // 2
    peaks, _ = signal.find_peaks(ac[:hi])
    peaks = peaks[peaks >= max(8, n // 40)]
    if not len(peaks):
        return None
    for c in peaks:
        if ac[c] < 0.05:
            continue
        need = [m for m in (2, 3) if m * c < hi]
        if not need or all(any(abs(q - m * c) <= max(3, 0.08 * c) for q in peaks) for m in need):
            return int(c)
    return int(peaks[int(np.argmax(ac[peaks]))])


def _rows_of(trace, want=None):
    """(row centres, pitch, row count).

    A printed lead is one connected mark running most of the way across the page, so the
    rows are read off the components themselves rather than off peaks in the row
    projection. The projection peaks sit at each lead's baseline rather than at the
    middle of its excursion, and on a creased page the rows are not evenly spaced
    (measured: 207-241 px on a page whose nominal pitch is 222), so neither a peak
    picker nor an evenly spaced comb lands the bands in the right place."""
    rows = _rows_from_components(trace)
    if rows is not None and (want is None or abs(len(rows) - want) <= 1):
        pitch = int(np.median(np.diff(rows))) if len(rows) > 1 else None
        return rows, pitch, len(rows)
    wide = _wide_only(trace)
    prof = ndimage.uniform_filter1d(wide.sum(1).astype(float), 3)
    if prof.max() <= 0:
        return None, None, 0
    pitch = _row_pitch(prof)
    if pitch is None:
        return None, None, 0
    peaks, _ = signal.find_peaks(prof, distance=int(0.7 * pitch), height=0.15 * prof.max())
    if len(peaks) < 2:
        return peaks, pitch, len(peaks)
    est = int(round((peaks[-1] - peaks[0]) / pitch)) + 1
    return peaks, pitch, est


def _longest_run(col):
    """Longest unbroken stretch of ink in one column.

    Not the top-to-bottom span: a lead label printed above the trace shares columns
    with it, and the span from the top of the text to the trace reads as a deflection
    far taller than the calibration pulse."""
    ys = np.flatnonzero(col)
    if not len(ys):
        return 0
    brk = np.flatnonzero(np.diff(ys) > 1)
    starts = np.concatenate(([0], brk + 1))
    ends = np.concatenate((brk, [len(ys) - 1]))
    return int((ys[ends] - ys[starts]).max()) + 1


def _pulse_component(band, x_lo, x_hi, span):
    """Height of the 1 mV pulse when it is printed as a mark of its own.

    Two things break the per-column measurement below on real printouts: the pulse is
    often detached from the trace and drawn ABOVE the lead's baseline rather than on it,
    and on a photo of a creased page its risers are not exactly vertical -- a single
    column then catches a few pixels of a 10 mm riser instead of all of it. A bounding
    box does not care about tilt. Only marks about 2-10 mm wide and taller than they are
    wide qualify, so a trace that runs the width of the row is not mistaken for a pulse.
    Returns (height px, x where the mark starts, x where it ends) or three Nones."""
    sub = band[:, x_lo:x_hi]
    if sub.size == 0 or not sub.any():
        return None, None, None
    n, lab, st, _ = cv2.connectedComponentsWithStats(sub, connectivity=8)
    w_lo, w_hi = 0.008 * span, 0.040 * span
    best = None
    for i in range(1, n):
        bw, bh = int(st[i, cv2.CC_STAT_WIDTH]), int(st[i, cv2.CC_STAT_HEIGHT])
        if w_lo <= bw <= w_hi and bh > 1.2 * bw:
            if best is None or bh > best[0]:
                left = int(x_lo + st[i, cv2.CC_STAT_LEFT])
                best = (bh, left, left + bw)
    return best if best else (None, None, None)


def _pulse_scale(band, x_lo, x_hi, ppm=None, side="left"):
    """Height in px of the 1 mV calibration pulse at the start of a row band.

    The pulse is drawn as an outline, not a filled block, so its full height appears
    only in the two riser columns -- looking for a wide plateau finds nothing. What
    keeps a tall QRS from being measured instead is the window (the pulse sits in the
    first centimetre, before the trace begins) plus a sanity check against the grid:
    a 1 mV pulse is 10 mm tall, so anything outside 5-18 mm is not one.
    `side` says which edge of the pulse to report: the trace starts after a pulse
    printed at the head of the row and stops before one printed at its foot.
    Returns (height px, that edge) or (None, None)."""
    if x_hi <= x_lo + 2:
        return None, None
    ext = np.array([_longest_run(band[:, x]) for x in range(x_lo, x_hi)], float)
    if not len(ext) or ext.max() <= 0:
        return None, None
    h = float(ext.max())
    if ppm and not (5.0 <= h / ppm <= 18.0):
        return None, None           # not a 1 mV pulse: wrong height for this paper
    tall = np.where(ext > 0.6 * h)[0]
    if len(tall) < 2:
        return None, None
    return h, int(x_lo + (tall[-1] if side == "left" else tall[0]))


def _agreeing(vals, tol=0.12, keep=0.25):
    """The per-row pulse heights that agree with each other, or None when they do not.

    Every row of a printout is recorded at the same gain, so a real calibration pulse
    measures the same height in all of them: a clean 12-lead page gives [103, 103, 103].
    Two different things break that, and the remedy is the same for both, so they are
    not separated here:
      * there is no pulse at that end of the row. What gets measured instead is a QRS --
        tall in V3 and V4, tiny in aVL: [16, 54, 25, 17, 42, 39, 40, 45, 90, 100, 53, 39].
      * there is one, but a crease or a shadow loses it in some rows. A photograph of
        folded paper gave [50, 56, 68, 7, 68, 28] where the true gain is the 68s.
    Either way the pulse cannot set the gain, so the caller assumes 10 mm/mV and says
    the measurements disagree rather than claiming which case it is.

    Telling the two apart needs the pulse's SHAPE, not its height: it is a rectangle, so
    its top is a bar spanning the mark, while a QRS reaches its apex in a column or two.
    Measured as the fraction of columns whose topmost ink is at the mark's top, the
    Holter rows give a median of 0.24 against 0.60 for a real pulse -- promising, but on
    one positive sample, and the cleanest pulse of the three never reaches that code path
    at all. Not enough to decide on, so it is not used."""
    good = [v for v in vals if v]
    if len(good) < 3:
        return None
    med = float(np.median(good))
    if med <= 0 or float(np.median([abs(v - med) for v in good])) > tol * med:
        return None
    return [v for v in good if abs(v - med) <= keep * med]


def _row_bounds(rows, trace):
    """Where to cut between the rows, and where the first and last row end.

    Two things a plain midpoint gets wrong:

    * The anchors may be baselines rather than mark centres, and a baseline is not the
      middle of its lead -- V5 rests near the bottom of its strip and reaches a long way
      up. Cutting half way between two baselines then slices the taller lead's R wave
      off and reports it short. The cut goes at the quietest row of pixels between the
      two anchors instead, which is the white gap the printer left, wherever it is. The
      search is held to the middle 60% of the gap so that two leads which genuinely
      overlap still get a band each.
    * The first band ran from the top of the image and the last to the bottom, so a
      header, a footer or a timing line was read as part of a lead. They are mirrored
      from the neighbouring gap instead, and never wider than half the row spacing."""
    H = trace.shape[0]
    rows = [int(r) for r in rows]
    if len(rows) < 2:
        return [0, H]
    prof = ndimage.uniform_filter1d(trace.sum(1).astype(float), 5)
    cuts = []
    for a, b in zip(rows[:-1], rows[1:]):
        lo, hi = a + int(0.20 * (b - a)), b - int(0.20 * (b - a))
        cuts.append(int(lo + np.argmin(prof[lo:hi])) if hi > lo else (a + b) // 2)
    half = int(round(float(np.median(np.diff(rows))) / 2.0))
    top = max(0, rows[0] - min(cuts[0] - rows[0], half))
    bot = min(H, rows[-1] + min(rows[-1] - cuts[-1], half))
    return [top] + cuts + [bot]


# ------------------------------------------------------------------------- main entry

def _rescue_fragments(lab, st, keep, bounds, n, frac=0.6):
    """Put back the small marks that are filling a hole in a lead rather than sitting
    beside it.

    The size filter above exists to drop lead labels and dust, and it also eats the tips
    of complexes. Where faint printing or a fold breaks a thin trace, the bottom of a QRS
    survives as a mark of its own: on one photograph three of V1's QS complexes came
    through as 6x5, 8x10 and 8x17 px fragments, all below both thresholds, and were
    deleted. The extracted lead went flat for 1.7 seconds in the middle of a regular
    rhythm, the beats there were never found, and the rate came out of a series with a
    1722 ms hole in it -- on a page where every lead is a clean train of complexes.

    What separates the two cases is not size but what else is in the same columns. A
    label shares its columns with the trace, so after the filter those columns still
    carry ink. A fragment that is the only ink its column has inside the row IS the
    trace there. That is the test."""
    clean = keep[lab].astype(np.uint8)
    cy = st[:, cv2.CC_STAT_TOP] + st[:, cv2.CC_STAT_HEIGHT] / 2.0
    for i in range(1, n):
        if keep[i]:
            continue
        r = next((j for j in range(len(bounds) - 1)
                  if bounds[j] <= cy[i] < bounds[j + 1]), None)
        if r is None:
            continue
        y0, y1 = bounds[r], bounds[r + 1]
        x0 = int(st[i, cv2.CC_STAT_LEFT])
        x1 = x0 + int(st[i, cv2.CC_STAT_WIDTH])
        band = clean[y0:y1, x0:x1]
        if band.size and float(np.mean(~band.any(axis=0))) >= frac:
            keep[i] = True
    return keep


def page_and_rows(img, rot_deg=0):
    """The deskewed page plus the row anchors, without reading a single lead.

    The review screen needs these even when digitize() refuses, because refusing is
    exactly when the user has to see what the thing thought it was looking at."""
    if rot_deg:
        img = cv2.rotate(img, {90: cv2.ROTATE_90_COUNTERCLOCKWISE,
                               180: cv2.ROTATE_180,
                               270: cv2.ROTATE_90_CLOCKWISE}[rot_deg % 360])
    trace, grid, ink, ink_v = _masks(img)
    angle = _deskew_angle(ink)
    if abs(angle) > 0.05:
        h, w = trace.shape
        M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        img = cv2.warpAffine(img, M, (w, h), borderValue=(255, 255, 255))
        trace, grid, ink, ink_v = _masks(img)
    pk, _ = _baselines(trace)
    if pk is None:
        pk, _, _ = _rows_of(trace)
    return img, ([int(r) for r in pk] if pk is not None else []), round(-angle, 2)


def digitize(img, layout=None, lead_order="standard", rotate="auto", rows=None):
    """Read an ECG photo. `layout` is a key of LAYOUTS (None = auto-detect from the row
    count); `lead_order` picks the limb-lead row order; `rotate` is "auto", 0, 90, 180
    or 270 degrees counter-clockwise.

    `rows` overrides the row anchors with a list of y positions. They are read in the
    coordinates of the DESKEWED page -- the same image `meta["row_y"]` refers to and the
    one the review screen draws -- so a caller that corrects the rows must also pin
    `rotate` to the value that produced them."""
    if rows is not None and rotate == "auto":
        raise DigitizeError("עם rows= חובה לקבע rotate לערך שממנו הן נמדדו")
    cands = [0, 90] if rotate == "auto" else [int(rotate)]
    best, err = None, None
    for rot in cands:
        try:
            out = _digitize_one(img, rot, layout, lead_order, rows)
        except DigitizeError as e:
            err = err or e
            continue
        if best is None or out["_rows"] > best["_rows"]:
            best = out
        if layout is None and out["meta"]["layout"] in LAYOUTS:
            break
    if best is None:
        raise err if err else DigitizeError("לא ניתן לקרוא את התרשים")
    best.pop("_rows", None)
    return best


def _digitize_one(img, rot_deg, layout, lead_order, rows=None):
    if rot_deg:
        img = cv2.rotate(img, {90: cv2.ROTATE_90_COUNTERCLOCKWISE,
                               180: cv2.ROTATE_180,
                               270: cv2.ROTATE_90_CLOCKWISE}[rot_deg % 360])
    trace, grid, ink, ink_v = _masks(img)
    # deskew on ALL the ink, not on the grid mask: the grid mask is built from runs that
    # are straight along an axis, so on a page that is 2.5 degrees off it is empty -- the
    # one case the deskew exists to fix
    angle = _deskew_angle(ink)
    if abs(angle) > 0.05:
        h, w = trace.shape
        M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        img = cv2.warpAffine(img, M, (w, h), borderValue=(255, 255, 255))
        trace, grid, ink, ink_v = _masks(img)

    want_rows = None
    if layout:
        sp = LAYOUTS[layout]
        want_rows = sp["rows"] + (1 if sp["extra"] else 0)
    if rows is not None:
        base_rows = np.array(sorted(int(r) for r in rows), int)
        if len(base_rows) < 3:
            raise DigitizeError("צריך לפחות 3 שורות")
        pitch, n_rows = int(np.median(np.diff(base_rows))), len(base_rows)
    else:
        base_rows, pitch, n_rows = _rows_of(trace, want_rows)
    if base_rows is None or n_rows < 3:
        raise DigitizeError("לא זוהו שורות לידים בתמונה")
    g = _page_gutter(trace)
    if g:
        raise DigitizeError(
            f"נראה שיש יותר מתרשים אחד בתמונה (רצועה ריקה ברוחב {g[1]} px סביב x={g[0]}). "
            f"יש לחתוך לתרשים אחד")
    if layout is None:
        snapped = min(ROWS_TO_LAYOUT, key=lambda r: abs(r - n_rows))
        if abs(snapped - n_rows) > 2:
            raise DigitizeError(
                f"פריסה לא מזוהה: נספרו {n_rows} שורות (נתמך 3/4/6/7/12/13). "
                f"אפשר לכפות עם layout=")
        layout = ROWS_TO_LAYOUT[snapped]
        auto = True
    else:
        auto = False
    spec = LAYOUTS[layout]
    want = spec["rows"] + (1 if spec["extra"] else 0)
    if auto and rows is None and abs(n_rows - want) > 1:
        # Snapping a bad row count onto the nearest layout is how a photo gets read as a
        # different ECG and still comes back with a believable heart rate. Refuse instead.
        raise DigitizeError(
            f"זיהוי הפריסה לא אמין: נספרו {n_rows} שורות, הפריסה הקרובה ({layout}) "
            f"מצפה ל-{want}. יש לכפות פריסה עם layout= או לחתוך את התמונה לתרשים אחד")
    if rows is not None:
        rows_from = "caller"
        if len(base_rows) != want:
            raise DigitizeError(
                f"פריסה {layout} מצפה ל-{want} שורות, התקבלו {len(base_rows)}")
    else:
        base_rows = _pick_rows(base_rows, trace, want)
        if len(base_rows) < spec["rows"]:
            raise DigitizeError(
                f"פריסה {layout} מצפה ל-{want} שורות, זוהו {len(base_rows)}")
        base_rows, rows_from = _reanchor(base_rows, trace, want)

    H, W = trace.shape
    bounds = _row_bounds(base_rows, trace)
    ppm_grid = None
    gp = _grid_period(ink_v, W, H)
    if gp:
        try:
            ppm_grid = _refine_period(ink_v, gp)
        except Exception:
            ppm_grid = float(gp)

    rows, pulses, pulses_r = [], [], []
    for i, br in enumerate(base_rows):
        y0, y1 = bounds[i], bounds[i + 1]
        band = trace[y0:y1]
        cols = np.where(band.any(0))[0]
        if len(cols) == 0:
            rows.append(None)
            continue
        x_first, x_last = int(cols[0]), int(cols[-1])
        span = x_last - x_first
        ppm0 = ppm_grid or (span / 250.0)    # a printed row is ~250 mm of paper
        win = max(10, int(9 * ppm0))
        # Both ends. Not every machine prints the 1 mV pulse at the head of the row: a
        # Fukuda FX-8400 puts it at the foot, and a photograph that catches the start of
        # the next page puts that page's column there too. Either way the mark is a
        # calibration pulse at this page's gain and the trace must stop before it;
        # reading only the head measured the first QRS of each row instead.
        hi = min(x_first + max(win, int(0.14 * span)), x_last)
        h_l, _, x_end = _pulse_component(band, x_first, hi, span)
        if h_l is None:                      # pulse fused with the trace: measure a column
            h_l, x_end = _pulse_scale(band, x_first, min(x_first + win, x_last))
        lo = max(x_first, x_last - max(win, int(0.14 * span)))
        h_r, x_stop, _ = _pulse_component(band, lo, x_last, span)
        if h_r is None:
            h_r, x_stop = _pulse_scale(band, max(x_first, x_last - win), x_last,
                                       side="right")
        pulses.append(h_l)
        pulses_r.append(h_r)
        rows.append(dict(band=band, x_first=x_first, x_last=x_last,
                         pulse_l=h_l, x_end=x_end, pulse_r=h_r, x_stop=x_stop,
                         pulse_h=None))

    # The same agreement test decides WHICH END carries the pulse. A QRS cannot pass it
    # from either side: on a 12x1 page every lead is simultaneous, so the first and the
    # last complex both fall at the same x in every row -- but their HEIGHT differs by a
    # factor of six between aVL and V4, while a pulse is the same height in all of them.
    good_l, good_r = _agreeing(pulses), _agreeing(pulses_r)
    pulse_side = "left" if good_l else ("right" if good_r else None)
    good = good_l if good_l else (good_r or [])
    no_pulse = pulse_side is None
    for r in rows:
        if not r:
            continue
        if pulse_side == "left":
            r["pulse_h"], r["x_stop"] = r["pulse_l"], None
        elif pulse_side == "right":
            # x_end stays empty so the window still starts at the first ink: a pulse at
            # the foot says nothing about where the trace begins.
            r["pulse_h"], r["x_end"] = r["pulse_r"], None
        else:
            r["pulse_h"] = r["x_end"] = r["x_stop"] = None   # also stops x_start being
            #                                        placed past the row's first complex
    ppm_pulse = float(np.median(good)) / 10.0 if good else None     # the pulse is 10 mm
    ppm, scale_from = _resolve_scale(ppm_grid, ppm_pulse, W)
    if not ppm or ppm <= 0:
        raise DigitizeError("לא ניתן לקבוע קנה מידה: אין רשת מילימטרית ואין פולס כיול")
    # A full printout is 150-450 mm wide. When the caller named the layout they may well
    # have cropped to half a page on purpose, so only the absurd values are refused then.
    w_lo, w_hi = (60.0, 600.0) if not auto else (150.0, 450.0)
    if not (w_lo <= W / ppm <= w_hi):
        raise DigitizeError(
            f"קנה מידה לא סביר: {ppm:.2f} px/mm נותן רוחב דף של {W/ppm:.0f} mm "
            f"(מצופה {w_lo:.0f}-{w_hi:.0f}). התמונה כנראה חתוכה, מוגדלת מדי או מכילה יותר מתרשים אחד")

    # One horizontal window for every row. Rows of a printout share their margins, so
    # letting each row find its own start and end makes the columns disagree by tens of
    # milliseconds, which misaligns the simultaneous leads the measurements depend on.
    starts = [r["x_end"] + int(1 * ppm) for r in rows if r and r["x_end"]]
    ends = [(r["x_stop"] - int(1 * ppm)) if r.get("x_stop") else r["x_last"]
            for r in rows if r]
    x_start = int(np.median(starts)) if starts else int(np.median([r["x_first"] for r in rows if r]))
    x_last = int(np.median(ends))
    if x_last - x_start < int(10 * ppm):
        raise DigitizeError("השורות קצרות מדי לקריאה")
    # drop lead labels and specks: a text glyph sitting in the same column as the trace
    # corrupts both the pulse height and the extracted sample for that column
    n, lab, st, _ = cv2.connectedComponentsWithStats(trace, connectivity=8)
    keep = np.zeros(n, bool)
    keep[1:] = ((st[1:, cv2.CC_STAT_WIDTH] > 3 * ppm) |
                (st[1:, cv2.CC_STAT_HEIGHT] > 6 * ppm))
    keep = _rescue_fragments(lab, st, keep, bounds, n)
    clean = keep[lab].astype(np.uint8)
    for i, r in enumerate(rows):
        if r is not None:
            r["band"] = clean[bounds[i]:bounds[i + 1]]

    for r in rows:
        if r is None:
            continue
        r["ppmv"] = r["pulse_h"] if r["pulse_h"] else (float(np.median(good)) if good else 10.0 * ppm)
        r["x_start"], r["x_last"] = x_start, x_last
        base = np.where(r["band"][:, min(x_start + int(ppm), x_last)])[0]
        r["baseline"] = int(np.median(base)) if len(base) else r["band"].shape[0] // 2

    def extract(row, xa, xb):
        band, b0 = row["band"], row["baseline"]
        out = np.full(max(0, xb - xa), np.nan)
        for j, x in enumerate(range(xa, xb)):
            ys = np.where(band[:, x])[0]
            if len(ys) == 0:
                continue
            if ys.max() - ys.min() <= 0.6 * ppm:
                y = ys.mean()
            else:
                y = ys.min() if abs(b0 - ys.min()) > abs(ys.max() - b0) else ys.max()
            out[j] = (b0 - y) / row["ppmv"]
        idx = np.arange(len(out))
        ok = ~np.isnan(out)
        if ok.sum() < 10:
            raise DigitizeError("עקומה לא נקראה")
        out = np.interp(idx, idx[ok], out[ok])
        n_out = int(len(out) / (25 * ppm) * FS)
        return signal.resample(out, n_out) if n_out > 0 else out

    # px/mV normally comes from the calibration pulse, but on faint or creased printing
    # the pulse is the first thing to break. When the GRID has already given a sound
    # px/mm there is a safe fallback: assume the standard 10 mm/mV rather than carry a
    # gain the page cannot support. Only with no grid is a bad pulse fatal.
    gains = [r["ppmv"] / ppm for r in rows[:spec["rows"]] if r]
    gain_med = float(np.median(gains)) if gains else 0.0
    gain_note = None
    if no_pulse:
        if not scale_from.startswith("grid"):
            raise DigitizeError(
                "אין פולס כיול ואין רשת — לא ניתן לקבוע הגבר")
        for r in rows:
            if r:
                r["ppmv"] = 10.0 * ppm
        gain_med = 10.0
        gain_note = ("calibration pulse unusable: its height disagrees between rows "
                     "(no pulse printed, or lost to a crease); assumed the standard 10 mm/mV")
    elif gains and not (5.0 <= gain_med <= 20.0):
        if scale_from.startswith("grid"):
            for r in rows:
                if r:
                    r["ppmv"] = 10.0 * ppm
            gain_note = f"pulse unusable ({gain_med:.1f} mm/mV); assumed the standard 10"
        else:
            raise DigitizeError(
                f"הגבר לא סביר: {gain_med:.1f} mm/mV (מצופה 5-20), ואין רשת לגבות אותו")
    dur = (x_last - x_start) / (25.0 * ppm)
    if not (1.0 <= dur <= 20.0):
        raise DigitizeError(f"משך שורה לא סביר: {dur:.1f} שניות (מצופה 1-20)")

    plan = lead_grid(layout, lead_order)
    leads, offsets = {}, {}
    for r_i in range(spec["rows"]):
        row = rows[r_i]
        if row is None:
            continue
        x0, x1 = row["x_start"], row["x_last"]
        seg = (x1 - x0) / float(spec["cols"])
        for c, name in enumerate(plan[r_i]):
            leads[name] = extract(row, int(x0 + c * seg), int(x0 + (c + 1) * seg))
            offsets[name] = round(c * seg / (25.0 * ppm), 4)
    if not leads:
        raise DigitizeError("לא חולצה אף עקומה")

    rhythm = None
    if spec["extra"] == "rhythm" and len(rows) > spec["rows"] and rows[spec["rows"]]:
        rr = rows[spec["rows"]]
        rhythm = extract(rr, rr["x_start"], rr["x_last"])

    meta = dict(layout=layout, lead_order=lead_order, rotate_deg=rot_deg,
                deskew_deg=round(-angle, 2), px_per_mm=round(float(ppm), 2),
                scale_from=scale_from,
                px_per_mv=[int(r["ppmv"]) for r in rows[:spec["rows"]] if r],
                gain_mm_per_mv=round(float(np.median([r["ppmv"] for r in rows[:spec["rows"]] if r])) / ppm, 1),
                rows_detected=int(len(base_rows)), rows_from=rows_from,
                pulse_side=pulse_side,
                row_y=[int(r) for r in base_rows], row_bounds=[int(b) for b in bounds],
                duration_s=round(float(dur), 2), page_h=int(H), page_w=int(W),
                extra_row=spec["extra"], gain_note=gain_note)
    return dict(leads=leads, rhythm=rhythm, fs=FS, offsets=offsets, meta=meta,
                _rows=len(leads), _page=img)


def _page_gutter(trace, min_frac=0.03):
    """A wide empty vertical band in the middle third: two printouts in one photo.

    Reading across such a gutter concatenates two different recordings into one lead
    and the result looks like a plausible ECG, which is the worst way to be wrong."""
    col = trace.sum(0)
    w = len(col)
    lo, hi = int(0.30 * w), int(0.70 * w)
    empty = col[lo:hi] <= 0
    best_i = best_n = 0
    i = 0
    while i < len(empty):
        if empty[i]:
            j = i
            while j < len(empty) and empty[j]:
                j += 1
            if j - i > best_n:
                best_i, best_n = i, j - i
            i = j
        else:
            i += 1
    if best_n >= max(10, int(min_frac * w)):
        return int(lo + best_i), int(best_n)
    return None


def _resolve_scale(ppm_grid, ppm_pulse, width):
    """Settle px/mm. The grid wins whenever it gives a believable page.

    The pulse is a fallback and a tie-breaker, not an authority: it is one small mark
    that a crease, a glare or faint printing can shrink, and letting it overrule a grid
    reading that implies a sane page size is how a correct 8 px/mm became 1.44."""
    cands = []
    if ppm_grid:
        for v, how in ((ppm_grid, "grid"), (ppm_grid / 5.0, "grid (5 mm boxes)")):
            if v > 0 and 150.0 <= width / v <= 450.0:
                cands.append((v, how))
    if len(cands) == 1:
        return cands[0]
    if cands:
        if ppm_pulse:
            return min(cands, key=lambda c: abs(c[0] - ppm_pulse) / ppm_pulse)
        return cands[0]
    if ppm_pulse:
        return ppm_pulse, "calibration pulse"
    return None, None


def _pick_rows(peaks, trace, want, prof=None):
    """Keep the `want` rows with the most trace in them, in top-to-bottom order.

    The window is a fraction of the row spacing rather than a fixed three pixels: a
    timing line at the foot of a page is as flat as any baseline and scores as well as
    a lead over three pixels, but it carries no excursions, so over a third of a row it
    loses to every real lead. `prof` (the flatness profile, when the anchors came from
    the baselines) breaks ties between rows whose ink is equal."""
    peaks = np.asarray(peaks, int)
    if len(peaks) <= want:
        return peaks
    half = 3
    if len(peaks) > 1:
        half = max(3, int(round(0.30 * float(np.median(np.diff(peaks))))))
    strength = trace.sum(1).astype(float)
    score = []
    for p in peaks:
        s = float(strength[max(0, p - half):p + half + 1].sum())
        if prof is not None:
            s *= 1.0 + float(prof[p]) / max(1.0, float(prof.max()))
        score.append(s)
    keep = np.sort(peaks[np.argsort(score)[-want:]])
    return keep

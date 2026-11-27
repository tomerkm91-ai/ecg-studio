"""The analysis the user actually sees, with no transport around it.

Imported unchanged by app.py (the local server) and by the in-browser build, so a
phone running this under WebAssembly and a laptop running the server execute the
same code. Anything that differs between the two belongs in their shells, not here.
"""
import numpy as np
import cv2

import base64
import io

import digitize, measure, clinical, conduction, analyze as analyze_mod

TRACE_FS = 200          # the trace handed to the browser, downsampled from 500 Hz
PREVIEW_W = 1000        # the review image: wide enough to place a row, small enough to send


def _trace(d, st):
    """The strip the animation runs against: the rhythm lead if the page printed one.

    Leads the amplitude gate rejected are excluded here too. Picking the largest
    peak-to-peak without that check selects exactly the broken lead, because a lead
    whose trace was lost swings wider than any real one -- on one photograph it chose
    aVF, the very lead measure() had just thrown out.
    """
    fs = d["fs"]
    bad = set(st.get("bad") or {})
    if d["rhythm"] is not None:
        x, name, shift = np.asarray(d["rhythm"], float), "II (רצועת קצב)", 0.0
    else:
        usable = [k for k in d["leads"] if k not in bad] or list(d["leads"])
        best = ("II" if "II" in usable else
                max(usable, key=lambda k: float(np.ptp(np.asarray(d["leads"][k], float)))))
        x = np.asarray(d["leads"][best], float)
        name, shift = best + ("" if best not in bad else " ⚠︎"), clinical.offset_of(d, best)
    step = max(1, int(round(fs / TRACE_FS)))
    xs = x[::step]
    xs = np.nan_to_num(xs, nan=0.0)
    return {"lead": name, "fs": fs / step, "t0_s": round(float(shift), 3),
            "mv": [round(float(v), 3) for v in xs],
            "beats_s": [round(float(b) / fs, 3) for b in st["beats"]],
            "qrs_s": [[round(a / fs, 3), round(b / fs, 3)] for a, b in st["qb"]]}


class ImageReadError(ValueError):
    """The upload is not an image this machine can open. The message says what it is
    and what to do; the page shows it as it is, without the review screen."""


_HEIF_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1"}


def _sniff(b):
    """What the file is, from its first bytes. Never from the name: a phone photo
    called .jpg can be HEIC inside."""
    if b[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[4:8] == b"ftyp":
        brand = b[8:12]
        if brand in (b"avif", b"avis"):
            return "avif"
        if brand in _HEIF_BRANDS:
            return "heic"
        return "isobmff"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    if b[:4] == b"%PDF":
        return "pdf"
    if b[:4] in (b"GIF8",):
        return "gif"
    if b[:2] == b"BM":
        return "bmp"
    if b[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if b[:2] == b"\xff\x0a" or b[:12] == b"\x00\x00\x00\x0cJXL \r\n\x87\n":
        return "jxl"
    if b[:2] == b"PK":
        return "zip"
    return "unknown"


def _decode_pillow(img_bytes):
    """Second chance through Pillow, which reads AVIF itself and HEIC with pillow-heif.
    Both are optional: without them this returns None and the caller says what to
    install. EXIF orientation is applied, as cv2.imdecode does for JPEG."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    try:
        im = Image.open(io.BytesIO(img_bytes))
        im = ImageOps.exif_transpose(im).convert("RGB")
    except Exception:
        return None
    return np.ascontiguousarray(np.asarray(im)[:, :, ::-1])


def _decode(img_bytes):
    img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is not None:
        return img
    img = _decode_pillow(img_bytes)
    if img is not None:
        return img
    kind = _sniff(img_bytes[:32])
    if kind == "heic":
        msg = ("הקובץ בפורמט HEIC, ברירת המחדל של מצלמת האייפון, ואי אפשר לפתוח אותו בלי "
               "רכיב נוסף. במחשב מריצים פעם אחת: python -m pip install pillow pillow-heif "
               "ומפעילים מחדש את השרת. אפשר גם לשמור את התמונה כ-JPG ולהעלות שוב.")
    elif kind == "avif":
        msg = ("הקובץ בפורמט AVIF. במחשב מריצים פעם אחת: python -m pip install --upgrade pillow "
               "ומפעילים מחדש את השרת, או שומרים את התמונה כ-JPG.")
    elif kind == "pdf":
        msg = ("זה קובץ PDF, לא תמונה. פותחים אותו, מצלמים את המסך או מייצאים את העמוד "
               "כ-JPG או PNG, ומעלים את התמונה.")
    elif kind in ("jpeg", "png"):
        msg = (f"הקובץ מתחיל כמו {kind.upper()} אבל לא נפתח. ייתכן שהוא פגום, או שלא ירד "
               "עד הסוף (זה קורה עם קבצים ב-OneDrive שעוד לא סונכרנו למחשב). פותחים אותו "
               "פעם אחת בצופה תמונות ומנסים שוב.")
    elif kind == "zip":
        msg = "זה קובץ ארכיון או מסמך (Word, ZIP), לא תמונה."
    else:
        head = " ".join(f"{c:02x}" for c in img_bytes[:8])
        msg = (f"לא זוהה פורמט תמונה מוכר (סוג שזוהה: {kind}; תחילת הקובץ: {head}). "
               "שומרים את התמונה כ-JPG או PNG ומעלים שוב.")
    raise ImageReadError(msg)


def _preview(page):
    """The deskewed page as a data URI, small enough to send to a phone.

    JPEG, not PNG: the page is a photograph of paper, and a lossless encode of it is
    four times the bytes for a picture nobody measures off -- the measuring is done on
    the full-resolution page here, and this is only what the user points at."""
    h, w = page.shape[:2]
    sc = min(1.0, PREVIEW_W / float(w))
    small = cv2.resize(page, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA) \
        if sc < 1.0 else page
    ok, buf = cv2.imencode(".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    if not ok:
        raise ValueError("לא ניתן לקודד תצוגה מקדימה")
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode(), sc


def inspect(img_bytes, layout=None, rotate="auto", lead_order="standard", rows=None):
    """Read the page geometry and STOP, so the user can see it before believing a number.

    This exists because of one photograph. The row detector put four of twelve anchors on
    the wrong strips of paper and the analysis came back confident and wrong: heart rate
    141, a left axis of -5 degrees, and an RBBB pattern, on a page that has none of those.
    Nothing in the output said anything was amiss. Drawing the rows on the photo showed it
    in a second. So the rows are now drawn BEFORE the analysis, every time, and the user
    can move them.

    Returns the deskewed page as a data URI, the row anchors in that page's coordinates,
    which lead each row will be read as, and the scale -- or, when digitize() refuses,
    the same picture plus the reason, which is when seeing it matters most."""
    img = _decode(img_bytes)
    kw = {"rotate": rotate, "lead_order": lead_order}
    if layout:
        kw["layout"] = layout
    if rows:
        kw["rows"] = [int(r) for r in rows]
    try:
        d = digitize.digitize(img, **kw)
    except Exception as e:
        # The fallback has to be drawable even when it too fails. A blank page raises on
        # the ink mask before any geometry exists, and an inspect() that raises leaves the
        # review screen with nothing to show -- which is the one moment it is for.
        rot = 0 if rotate == "auto" else int(rotate)
        try:
            page, cand, skew = digitize.page_and_rows(img, rot)
        except Exception:
            page, cand, skew = img, [], 0.0
        uri, sc = _preview(page)
        return {"ok": False, "error": str(e), "preview": uri, "preview_scale": round(sc, 4),
                "page_w": int(page.shape[1]), "page_h": int(page.shape[0]),
                "rows": cand, "bounds": [], "rotate_deg": rot, "rotate_req": rotate,
                "deskew_deg": skew,
                "layout": layout, "lead_order": lead_order, "lead_of_row": [],
                "layouts": layouts(), "meta": {}}
    m = d["meta"]
    uri, sc = _preview(d["_page"])
    names = _row_labels(m["layout"], m["lead_order"])
    return {"ok": True, "preview": uri, "preview_scale": round(sc, 4),
            "page_w": m["page_w"], "page_h": m["page_h"],
            "rows": m["row_y"], "bounds": m["row_bounds"],
            "rotate_deg": m["rotate_deg"], "rotate_req": rotate,
            "deskew_deg": m["deskew_deg"],
            "layout": m["layout"], "lead_order": m["lead_order"],
            "lead_of_row": names, "layouts": layouts(), "meta": m}


EXTRA_NAME = {"rhythm": "רצועת קצב", "compressed": "רצועה מכווצת"}


def _row_labels(layout, order):
    spec = digitize.LAYOUTS[layout]
    names = [" · ".join(r) for r in digitize.lead_grid(layout, order)]
    return names + ([EXTRA_NAME[spec["extra"]]] if spec["extra"] else [])


def layouts():
    """Every layout the review screen offers, with the lead names of each of its rows.

    The names are built here with digitize.lead_grid rather than reimplemented in the
    page, so what the screen labels a row is what the analysis will read it as. A second
    copy of that mapping is exactly how a screen comes to reassure a user about a lead
    order the reader is not using."""
    out = {}
    for k, v in digitize.LAYOUTS.items():
        out[k] = {"n_rows": v["rows"] + (1 if v["extra"] else 0), "cols": v["cols"],
                  "extra": v["extra"],
                  "labels": {o: _row_labels(k, o) for o in digitize.LEAD_ORDERS}}
    return out


def run(img_bytes, layout=None, rotate="auto", lead_order="standard", rows=None):
    img = _decode(img_bytes)
    kw = {"rotate": rotate, "lead_order": lead_order}
    if layout:
        kw["layout"] = layout
    if rows:
        kw["rows"] = [int(r) for r in rows]
    d = digitize.digitize(img, **kw)
    st = measure.detect(d)
    res = measure.measure(d)
    cond = conduction.assess(d, st["qb"], res)
    cond.pop("lead_features", None)          # kept server-side; too much for the page
    d["meta"].pop("page_w", None)
    d["meta"].pop("page_h", None)
    return {"ok": True, "meta": d["meta"], "measurements": res,
            "flags": analyze_mod.flags(res, d["meta"]),
            "notes": analyze_mod.notes(res, d["meta"]),
            "conduction": cond, "trace": _trace(d, st),
            "disclaimer": analyze_mod.DISCLAIMER}

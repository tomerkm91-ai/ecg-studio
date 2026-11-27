# ECG Studio — אפליקציית הוראה ותרגול אק״ג (Vite + React + TypeScript)

אפליקציית הוראה ותרגול אינטראקטיבית לקריאת אק״ג, הבנת מערכת ההולכה והדמיית הלב בתנועה — בנויה ב־**Vite + React + TypeScript** ומוכנה להרצה בכיתה, במחשב ובטלפון:

1. **דוגמאות מוכנות לשיעור + מצב תרגול בכיתה** — 3 מקרי הוראה מובנים בלחיצה אחת (קצב סינוס תקין, LBBB מלא, RBBB מלא) עם מטרות הוראה, טווחי ייחוס תקינים על כל מדד, וכפתור **הסתר/חשוף פענוח** לדיון עם סטודנטים לפני חשיפת התשובה.
2. **מנתח אק״ג אוטומטי מצילום** — מנוע Python מלא (OpenCV + SciPy + NumPy ב־Pyodide Web Worker) מתוך קובצי `.py` אמיתיים, כולל עורך שורות אינטראקטיבי על התמונה המיושרת, מדידות (HR, PR, QRS, QT/QTc, ציר, ST/T ב־12 חיבורים, גל P), טבלאות קריטריונים ל־LBBB/RBBB (AHA + Strauss) וייצוא JSON.
3. **לב תלת־ממדי מסונכרן לפעימות** — מודל הלב של Doctor Jana מ־Sketchfab המסונכרן ישירות למרווחי R-R שחולצו מהאק״ג או מדוגמת השיעור, עם סרגל נגינה אינטראקטיבי + **כלי סימון פעימות ידני העובד גם ללא אינטרנט**.
4. **השוואה מורפולוגית בין פעימות** — השוואת Leave-One-Out Median לכל פעימה, דירוג חריגות RMS, תצוגת חפיפה גרפית, תיוג קורא וייצוא `beat-review.json`.
5. **פענוח משופר לצילומי HEIC מאייפון** — זיהוי חתימת קובץ, פענוח חומרה מקורי בדפדפן עם fallback ל־`heic-to` (libheif עדכני) ודחיסת JPEG יעילה בזיכרון.

## פיתוח והרצה מקומית

```sh
npm install
npm run dev
```

## בנייה לפריסה סטטית (`dist/`)

```sh
npm run build
```

לאחר הבנייה ניתן להגיש את `dist/` ישירות (תואם גם ל־`.openai/hosting.json`):

```sh
py -m http.server 8000 --bind 127.0.0.1 --directory dist
```

## בדיקות ואימות

```sh
npm run typecheck
npm test
```

## מבנה הפרויקט

| נתיב | תפקיד |
| --- | --- |
| `src/App.tsx` | מעטפת היישום, ערכת נושא כהה/בהירה וניהול המצב המשותף |
| `src/components/PhotoEntryBar.tsx` | צילום, גלריה, קבצים, הדבקה, גרירה, PWA ו־Web Share Target |
| `src/components/AnalyzerTab.tsx` | ממשק המנתח האוטומטי, עורך השורות (`RowReviewCanvas`) ולוח התוצאות (`ResultsDashboard`) |
| `src/components/HeartAtlasTab.tsx` | תצוגת לב 3D מסונכרנת + כלי סימון ידני (`ManualBeatMarker`) |
| `src/components/BeatCompareTab.tsx` | השוואת פעימות, דירוג חריגות וייצוא JSON |
| `src/lib/photoPrepare.ts` | הכנת תמונות ופענוח HEIC/HEIF רב־שלבי |
| `src/lib/pyodideClient.ts` | ניהול ה־Web Worker של Pyodide (כולל עצירה ואתחול נקי) |
| `src/lib/beatAnalysis.ts` | חישוב Leave-One-Out Median ו־RMS |
| `src/lib/timing.ts` | אינטרפולציית פאזה וכיול נקודות ידני |
| `public/ecg-worker.js` | Web Worker הטוען את Pyodide ואת קובצי `public/py/*.py` |
| `public/py/` | מודולי ה־Python האמיתיים (`digitize.py`, `measure.py`, `clinical.py`, `conduction.py`, `analyze.py`, `core.py`) |
| `public/sw.js` ו־`public/manifest.webmanifest` | תמיכת PWA ו־Web Share Target |

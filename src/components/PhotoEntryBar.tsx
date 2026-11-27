import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  ClipboardPaste,
  Download,
  Eye,
  FolderOpen,
  Image as ImageIcon,
  Play,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

interface PhotoEntryBarProps {
  rawPhoto: File | null;
  previewUrl: string | null;
  statusMessage: string;
  isBusy: boolean;
  onSelectFile: (file: File) => void;
  onStartAnalyze: () => void;
  onStopAnalyze: () => void;
  onOpenManualMark: () => void;
  onClearPhoto: () => void;
  onRequestPreview: () => void;
}

export const PhotoEntryBar: React.FC<PhotoEntryBarProps> = ({
  rawPhoto,
  previewUrl,
  statusMessage,
  isBusy,
  onSelectFile,
  onStartAnalyze,
  onStopAnalyze,
  onOpenManualMark,
  onClearPhoto,
  onRequestPreview,
}) => {
  const [dragActive, setDragActive] = useState(false);
  const [showThumb, setShowThumb] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installTip, setInstallTip] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);

  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imgItem = items.find((i) => i.type.startsWith('image/'));
      const f = imgItem?.getAsFile();
      if (f) {
        e.preventDefault();
        setPasteError(null);
        onSelectFile(f);
      }
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('paste', onPaste);
    };
  }, [onSelectFile]);

  useEffect(() => {
    if (!rawPhoto) setShowThumb(false);
  }, [rawPhoto]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) {
      setPasteError(null);
      onSelectFile(f);
    }
  };

  const handlePasteClick = async () => {
    setPasteError(null);
    try {
      const list = await navigator.clipboard.read();
      for (const item of list) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          const ext = type.split('/')[1] || 'png';
          onSelectFile(new File([blob], `clipboard.${ext}`, { type }));
          return;
        }
      }
      setPasteError('לא נמצאה תמונה בלוח. העתיקו תמונה ונסו שוב.');
    } catch {
      setPasteError('אפשר להדביק עם Ctrl+V / ⌘V או לבחור תמונה ישירות מהגלריה.');
    }
  };

  const handleInstall = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      setInstallPrompt(null);
      return;
    }
    setInstallTip(
      window.location.protocol === 'file:'
        ? 'התקנה למסך הבית זמינה דרך כתובת HTTPS של היישום.'
        : 'באייפון (Safari): שיתוף ← הוספה למסך הבית. באנדרואיד (Chrome): תפריט ← התקנת אפליקציה.'
    );
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setPasteError(null);
      onSelectFile(f);
    }
  };

  return (
    <section
      className={`card photo-bar ${dragActive ? 'drop-active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
      aria-label="טעינת צילום אק״ג"
    >
      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          onClick={() => cameraRef.current?.click()}
        >
          <Camera size={16} />
          צילום אק״ג
        </button>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*,.heic,.heif"
          capture="environment"
          hidden
          onChange={handleFileChange}
        />

        <button
          type="button"
          className="btn secondary"
          onClick={() => galleryRef.current?.click()}
        >
          <ImageIcon size={16} />
          גלריה
        </button>
        <input
          ref={galleryRef}
          type="file"
          accept="image/*,.heic,.heif"
          hidden
          onChange={handleFileChange}
        />

        <button
          type="button"
          className="btn secondary"
          onClick={() => fileRef.current?.click()}
        >
          <FolderOpen size={16} />
          קבצים
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={handleFileChange}
        />

        <button type="button" className="btn ghost" onClick={handlePasteClick}>
          <ClipboardPaste size={16} />
          הדבקה
        </button>

        <button
          type="button"
          className="btn ghost push-end"
          onClick={handleInstall}
        >
          <Download size={16} />
          התקנה בטלפון
        </button>
      </div>

      {!rawPhoto && (
        <p className="muted hint-line">
          גררו לכאן צילום תרשים אק״ג (JPEG, PNG, WebP או iPhone HEIC) או לחצו למעלה. התמונה מעובדת מקומית בלבד ואינה נשלחת לשום שרת.
        </p>
      )}

      {installTip && (
        <div className="info-banner">
          <span>{installTip}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="סגור הודעה"
            onClick={() => setInstallTip(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {pasteError && <p className="status-warn">{pasteError}</p>}

      {statusMessage && (
        <p className="status-line" role="status">
          {statusMessage}
        </p>
      )}

      {rawPhoto && (
        <div className="photo-actions">
          <div className="btn-row">
            <button
              type="button"
              className="btn accent"
              disabled={isBusy}
              onClick={onStartAnalyze}
            >
              <Play size={16} />
              ניתוח אק״ג אוטומטי
            </button>

            {isBusy && (
              <button
                type="button"
                className="btn danger"
                onClick={onStopAnalyze}
              >
                <Square size={15} />
                עצירה
              </button>
            )}

            <button
              type="button"
              className="btn secondary"
              onClick={onOpenManualMark}
            >
              <SlidersHorizontal size={16} />
              סימון פעימות ידני (אופליין)
            </button>

            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                if (!showThumb) onRequestPreview();
                setShowThumb((v) => !v);
              }}
            >
              <Eye size={16} />
              {showThumb ? 'הסתר תצוגה' : 'תצוגה מקדימה'}
            </button>

            <button
              type="button"
              className="btn ghost"
              onClick={onClearPhoto}
            >
              <X size={16} />
              נקה צילום
            </button>
          </div>

          {showThumb && previewUrl && (
            <div className="thumb-wrap">
              <img
                src={previewUrl}
                alt="תצוגה מקדימה של תרשים האק״ג שנבחר"
                className="photo-thumb"
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
};

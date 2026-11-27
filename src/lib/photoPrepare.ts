/**
 * Multi-stage ECG photo preparation & iPhone HEIC/HEIF decoder.
 *
 * Fixes the iOS HEIC failure in Stage 21 v2:
 *  1. Sniffs magic bytes instead of trusting file extension / MIME type.
 *  2. Re-wraps HEIC blobs with explicit `image/heic` MIME so iOS Safari's
 *     native hardware decoder via `createImageBitmap` succeeds directly.
 *  3. Falls back to modern `heic-to` (libheif 1.19+ WASM) and then `heic2any`.
 *  4. Encodes resized/converted images to JPEG 0.94 (never lossless PNG on
 *     huge mobile photos) and cleans up canvas & bitmap memory immediately.
 */

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_PIXELS_INPUT = 64_000_000;
const TARGET_MAX_EDGE = 2600;
const TARGET_MAX_PIXELS = 3_500_000;

interface SniffedKind {
  isJpeg: boolean;
  isPng: boolean;
  isHeic: boolean;
}

async function sniffBytes(file: Blob): Promise<SniffedKind> {
  const buf = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

  let ascii = '';
  for (let i = 0; i < buf.length; i++) {
    ascii += String.fromCharCode(buf[i]);
  }
  const hasFtypHeic =
    ascii.slice(4, 8) === 'ftyp' &&
    /heic|heix|hevc|hevx|heim|heis|mif1|msf1/i.test(ascii.slice(8, 32));

  const name = file instanceof File ? file.name : '';
  const isHeic =
    hasFtypHeic || /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(name);

  return { isJpeg, isPng, isHeic };
}

function loadScriptOnce(src: string, globalKey: string): Promise<unknown> {
  const existing = (window as unknown as Record<string, unknown>)[globalKey];
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => {
      const api = (window as unknown as Record<string, unknown>)[globalKey];
      if (api) resolve(api);
      else reject(new Error('Decoder loaded without global export'));
    };
    el.onerror = () => reject(new Error('Failed to load HEIC decoder'));
    document.head.appendChild(el);
  });
}

async function decodeHeicWithWasm(file: Blob): Promise<Blob> {
  // Primary modern decoder: heic-to (libheif 1.19+, supports iOS 17/18/26 HEIC)
  try {
    const heicToApi = (await loadScriptOnce(
      'https://cdn.jsdelivr.net/npm/heic-to@1.1.14/dist/iife/heic-to.js',
      'HeicTo'
    )) as
      | ((opts: { blob: Blob; type: string; quality?: number }) => Promise<Blob>)
      | { heicTo?: (opts: { blob: Blob; type: string; quality?: number }) => Promise<Blob> };

    const fn = typeof heicToApi === 'function' ? heicToApi : heicToApi.heicTo;
    if (fn) {
      const out = await fn({ blob: file, type: 'image/jpeg', quality: 0.94 });
      if (out instanceof Blob && out.size > 0) return out;
    }
  } catch {
    // Fall through to legacy heic2any
  }

  // Secondary fallback: heic2any using JPEG (lower memory than PNG)
  try {
    const heic2any = (await loadScriptOnce(
      'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
      'heic2any'
    )) as (opts: {
      blob: Blob;
      toType: string;
      quality?: number;
      multiple?: boolean;
    }) => Promise<Blob | Blob[]>;

    const converted = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.94,
      multiple: false,
    });
    const out = Array.isArray(converted) ? converted[0] : converted;
    if (out instanceof Blob && out.size > 0) return out;
  } catch {
    // Fall through to user-friendly error
  }

  throw new Error(
    'לא ניתן לפענח קובץ HEIC במכשיר זה. באייפון אפשר לבחור "צילום מסך" או לשנות בהגדרות מצלמה לפורמט "הכי תואם" (JPEG).'
  );
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image element decode failed'));
    };
    img.src = url;
  });
}

async function decodeToSource(
  blob: Blob,
  isHeic: boolean
): Promise<{
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  cleanup: () => void;
}> {
  // Explicitly tag HEIC MIME when iOS Files/Share sends empty or octet-stream
  const candidate =
    isHeic && !/heic|heif/i.test(blob.type)
      ? new Blob([blob], { type: 'image/heic' })
      : blob;

  // 1. Try native createImageBitmap (respects EXIF orientation & supports HEIC on Safari)
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(candidate);
      if (bmp.width > 0 && bmp.height > 0) {
        return {
          source: bmp,
          width: bmp.width,
          height: bmp.height,
          cleanup: () => bmp.close(),
        };
      }
      bmp.close();
    } catch {
      // Fallback to <img>
    }
  }

  // 2. Try native <img>
  try {
    const img = await loadImageElement(candidate);
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        cleanup: () => {
          img.removeAttribute('src');
        },
      };
    }
  } catch {
    // Fallback to WASM HEIC if HEIC
  }

  // 3. WASM HEIC decode -> decode JPEG result
  if (isHeic) {
    const jpegBlob = await decodeHeicWithWasm(blob);
    return decodeToSource(jpegBlob, false);
  }

  throw new Error(
    'הדפדפן לא הצליח לקרוא את התמונה. מומלץ לבחור תמונת JPEG או PNG, או צילום מסך של התרשים.'
  );
}

export function validateRawPhoto(file: File | Blob | null | undefined): string | null {
  if (!file || !file.size) return 'לא נבחר קובץ תמונה.';
  if (file.size > MAX_FILE_BYTES) return 'יש לבחור תמונה עד 40 MiB.';
  const name = file instanceof File ? file.name : '';
  if (
    file.type &&
    !file.type.startsWith('image/') &&
    file.type !== 'application/octet-stream' &&
    !/\.(heic|heif|jpg|jpeg|png|webp|avif)$/i.test(name)
  ) {
    return 'יש לבחור צילום אק״ג בפורמט HEIC, JPEG, PNG או WebP. עבור PDF אפשר לצלם מסך של העמוד.';
  }
  return null;
}

export async function prepareEcgPhoto(file: File | Blob): Promise<File> {
  const validationError = validateRawPhoto(file);
  if (validationError) throw new Error(validationError);

  const kind = await sniffBytes(file);
  const decoded = await decodeToSource(file, kind.isHeic);

  try {
    const { width: w, height: h, source } = decoded;
    if (w * h > MAX_PIXELS_INPUT) {
      throw new Error(
        'הצילום גדול מ־64 מגה־פיקסל. יש לחתוך את התמונה לאזור התרשים ולנסות שוב.'
      );
    }

    const scale = Math.min(
      1,
      TARGET_MAX_EDGE / Math.max(w, h),
      Math.sqrt(TARGET_MAX_PIXELS / (w * h))
    );

    // Fast path: already JPEG/PNG within target dimensions
    if (scale === 1 && (kind.isJpeg || kind.isPng)) {
      if (file instanceof File) return file;
      const ext = kind.isPng ? 'png' : 'jpg';
      const mime = kind.isPng ? 'image/png' : 'image/jpeg';
      return new File([file], `ecg.${ext}`, { type: mime });
    }

    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;

    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('לא ניתן להכין משטח עיבוד לתמונה.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, outW, outH);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.94)
      );
      if (!blob) throw new Error('המרת התמונה נכשלה.');

      const baseName =
        file instanceof File ? file.name.replace(/\.[^.]+$/, '') : 'ecg';
      return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  } finally {
    decoded.cleanup();
  }
}

import type { AnalysisResult, InspectOptions, InspectResult } from '../types/ecg';

export type EnginePhase = 'idle' | 'pyodide' | 'packages' | 'modules' | 'ready' | 'error';

export interface EngineStatus {
  phase: EnginePhase;
  pct: number;
  message: string;
}

const PHASE_LABELS: Record<EnginePhase, string> = {
  idle: 'ממתין לטעינת מנוע הניתוח',
  pyodide: 'טוען את מנוע Pyodide ברקע…',
  packages: 'טוען numpy, scipy ו־OpenCV…',
  modules: 'טוען את מודולי הניתוח (digitize, measure, clinical, conduction)…',
  ready: 'מנוע הניתוח מוכן',
  error: 'טעינת המנוע נכשלה',
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Typed client managing the dedicated Pyodide Web Worker.
 * Supports lazy initialization, cancellation (hard terminate + clean restart),
 * and serialized inspect/run calls without any iframe overhead.
 */
export class PyodideEcgClient {
  private worker: Worker | null = null;
  private reqId = 0;
  private pending = new Map<number, PendingRequest>();
  private initPromise: Promise<void> | null = null;
  private listeners = new Set<(status: EngineStatus) => void>();
  private status: EngineStatus = {
    phase: 'idle',
    pct: 0,
    message: PHASE_LABELS.idle,
  };

  subscribe(listener: (status: EngineStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  private emit(phase: EnginePhase, pct: number, customMsg?: string) {
    this.status = {
      phase,
      pct,
      message: customMsg ?? PHASE_LABELS[phase],
    };
    for (const fn of this.listeners) fn(this.status);
  }

  ensureReady(): Promise<void> {
    if (this.status.phase === 'ready' && this.worker) {
      return Promise.resolve();
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        const workerUrl = new URL('./ecg-worker.js', window.location.href).href;
        const w = new Worker(workerUrl);
        this.worker = w;

        const initId = ++this.reqId;
        this.pending.set(initId, {
          resolve: () => resolve(),
          reject: (err) => reject(err),
        });

        w.onerror = (ev) => {
          const msg = ev.message || 'מנוע הרקע הופסק באופן בלתי צפוי.';
          this.handleFatal(msg);
        };

        w.onmessage = ({ data }) => {
          if (data.phase && data.phase !== 'ready') {
            this.emit(data.phase as EnginePhase, data.pct ?? 20);
            return;
          }
          if (data.phase === 'ready') {
            this.emit('ready', 100);
            const job = this.pending.get(data.id);
            if (job) {
              this.pending.delete(data.id);
              job.resolve(undefined);
            }
            return;
          }
          const job = this.pending.get(data.id);
          if (!job) {
            if (data.error) this.handleFatal(data.error);
            return;
          }
          this.pending.delete(data.id);
          if (data.error) job.reject(new Error(data.error));
          else job.resolve(data.result);
        };

        this.emit('pyodide', 10);
        w.postMessage({ id: initId, fn: 'init' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.handleFatal(msg);
        reject(new Error(msg));
      }
    });

    return this.initPromise;
  }

  private handleFatal(message: string) {
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.emit('error', 0, `טעינת המנוע נכשלה: ${message}`);
    for (const [, job] of this.pending) {
      job.reject(new Error(message));
    }
    this.pending.clear();
  }

  cancel(reason = 'הבדיקה הופסקה על ידי המשתמש.'): void {
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    for (const [, job] of this.pending) {
      job.reject(new Error(reason));
    }
    this.pending.clear();
    this.emit('idle', 0, 'המנוע הופסק. לחצו לבדיקה מחדש בעת הצורך.');
  }

  private async call<T>(
    fn: 'inspect' | 'run',
    options: InspectOptions,
    bytes?: ArrayBuffer
  ): Promise<T> {
    await this.ensureReady();
    if (!this.worker) throw new Error('מנוע הבדיקה אינו זמין.');

    const id = ++this.reqId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        if (bytes) {
          this.worker!.postMessage({ id, fn, options, bytes }, [bytes]);
        } else {
          this.worker!.postMessage({ id, fn, options });
        }
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  inspect(options: InspectOptions, bytes?: ArrayBuffer): Promise<InspectResult> {
    return this.call<InspectResult>('inspect', options, bytes);
  }

  run(options: InspectOptions): Promise<AnalysisResult> {
    return this.call<AnalysisResult>('run', options);
  }
}

export const ecgClient = new PyodideEcgClient();

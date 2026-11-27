/* Classic Web Worker for Pyodide ECG digitization & analysis.
   Loads Pyodide from CDN and fetches the real Python modules from ./py/. */

const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.28.0/full/';
const PY_MODULES = [
  'digitize.py',
  'measure.py',
  'clinical.py',
  'conduction.py',
  'analyze.py',
  'core.py',
];

let pyodide = null;

async function initialize() {
  self.postMessage({ phase: 'pyodide', pct: 12 });
  importScripts(PYODIDE_BASE + 'pyodide.js');
  pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });

  self.postMessage({ phase: 'packages', pct: 38 });
  await pyodide.loadPackage(['numpy', 'scipy', 'opencv-python']);

  self.postMessage({ phase: 'modules', pct: 82 });
  pyodide.FS.mkdirTree('/app');

  const fetched = await Promise.all(
    PY_MODULES.map(async (name) => {
      const url = new URL('./py/' + name, self.location.href).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load module ' + name + ' (' + res.status + ')');
      return [name, await res.text()];
    })
  );

  for (const [name, src] of fetched) {
    pyodide.FS.writeFile('/app/' + name, src);
  }

  await pyodide.runPythonAsync(`
import sys
if '/app' not in sys.path:
    sys.path.insert(0, '/app')
import core
`);
}

async function pyCall(fn, opt) {
  pyodide.globals.set('_fn', fn);
  pyodide.globals.set(
    '_options_json',
    JSON.stringify({
      layout: opt.layout || null,
      rotate: opt.rotate ?? 'auto',
      lead_order: opt.lead_order ?? 'standard',
      rows: opt.rows && opt.rows.length ? opt.rows : null,
    })
  );

  const txt = await pyodide.runPythonAsync(`
import json, pathlib
_options = json.loads(_options_json)
if _options['rows']:
    _options['rows'] = [int(x) for x in _options['rows']]
try:
    _r = getattr(core, _fn)(pathlib.Path('/tmp/in.img').read_bytes(), **_options)
except Exception as _e:
    import digitize
    _kind = (
        'digitize' if isinstance(_e, digitize.DigitizeError)
        else 'image' if isinstance(_e, core.ImageReadError)
        else 'internal'
    )
    _r = {'ok': False, 'error': str(_e), 'kind': _kind}
json.dumps(_r, ensure_ascii=False)
`);
  return JSON.parse(txt);
}

self.onmessage = async ({ data }) => {
  const { id, fn, options, bytes } = data;
  try {
    if (fn === 'init') {
      await initialize();
      self.postMessage({ id, phase: 'ready', pct: 100 });
      return;
    }
    if (!pyodide) {
      throw new Error('מנוע הניתוח עדיין לא אותחל.');
    }
    if (bytes) {
      pyodide.FS.writeFile('/tmp/in.img', new Uint8Array(bytes));
    }
    const result = await pyCall(fn, options || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};

// url-state.js: the view as a query string, so a link reopens what the sender
// was looking at.
//
//   key   what                                     omitted when
//   ----  ---------------------------------------  ---------------------------
//   example  bundled example id                    a hand-loaded database
//   db    corpus database id, e.g. AgCu-86Hay      not loaded from the picker
//   bl    corpus id of the comparison assessment   no comparison, or a dropped file
//   x     xMin,xMax                                the window is the fitted one
//   t     tMin,tMax                                        "
//   T     temperature, always kelvin               unchanged since the load
//   u     composition,temperature units            x,K
//   g     G-curve panel open, 0|1                  the reader never folded it
//   fig   figure theme, dark|light                 dark
//   lab   region labels, 0|1                       on
//   col   experimental colour, source|residual     source
//   pts   experimental marks drawn, 0|1            on
//   mode  phase raster, vector (off) | both (on)   on
//   p     parameters off their assessed value      nothing has been dragged
//   tab   which page is open, picker | about       the diagram
//
// The Systems and About tabs sit over the loaded diagram, so the diagram's keys
// stay when `tab` is set.
//
// `example` and `db` are exclusive; the app never writes both, and
// `decodeState` resolves a hand-edited link that has both. `db` is the full
// manifest id, which begins with its element pair, so no system key is needed.
// `T` is always kelvin, whatever the unit toggle shows, as in the CSV export.
// Experimental data is not in the URL (the session file carries it), but its
// display settings `col` and `pts` are.
//
// Pure (no `location`, no DOM), so it can be tested without a browser. Nothing
// throws: an unknown key or a malformed value is dropped and the rest is kept,
// so a hand-edited link or one from another version still draws a diagram.

/// Values equal to these are omitted, so an untouched app has a short URL. The
/// caller passes `null` for the view, temperature and G-panel fold when they
/// are at their default, since those depend on the database.
const DEFAULTS = {
    showRaster: true,
    showExpPoints: true,
    figureTheme: 'dark',
    showRegionLabels: true,
    colourBy: 'source',
    units: { composition: 'x', temperature: 'K' },
};

/// The tabs a link may name. The default, `viz`, is never written.
const TABS = ['picker', 'about'];

const COMPOSITION_UNITS = ['x', 'at', 'wt'];
const TEMPERATURE_UNITS = ['K', 'C'];

/// `encodeURIComponent`, but leaving `: , ; =` unescaped (RFC 3986 allows them
/// in a query), so `?x=0.2,0.6&p=FCC_A1:0:a=-1234` stays readable.
function enc(s) {
    return encodeURIComponent(String(s)).replace(/%3A/g, ':')
        .replace(/%2C/g, ',').replace(/%3B/g, ';').replace(/%3D/g, '=');
}

/// The shortest string that parses back to the same double. No rounding, so a
/// reopened link recomputes the same raster (visual-check asserts this).
const num = (v) => String(v);

function pair(a, b) { return `${num(a)},${num(b)}`; }

/**
 * @param {object} s the view: `example`, `db`, `baseline` (string|null);
 *   `view`/`temp`/`gibbsOpen` (null when at their default); `units`,
 *   `figureTheme`, `showRegionLabels`, `colourBy`, `showExpPoints`,
 *   `showRaster`, `tab`; and `params` as `[[key, absoluteValue], ...]` holding
 *   only the parameters off their assessed value.
 * @returns {string} `''`, or a query string beginning with `?`.
 */
export function encodeState(s = {}) {
    const parts = [];
    const put = (k, v) => parts.push(`${k}=${enc(v)}`);

    // Both are written if both are given, so the impossible state stays
    // visible instead of being resolved here.
    if (s.example) put('example', s.example);
    if (s.db) put('db', s.db);
    // The comparison, only when it came from the corpus: the recipient cannot
    // fetch a dropped file, so the link opens without the ghost.
    if (s.baseline) put('bl', s.baseline);
    if (s.view) {
        put('x', pair(s.view.xMin, s.view.xMax));
        put('t', pair(s.view.tMin, s.view.tMax));
    }
    if (Number.isFinite(s.temp)) put('T', num(s.temp));

    const u = s.units || DEFAULTS.units;
    if (u.composition !== DEFAULTS.units.composition
        || u.temperature !== DEFAULTS.units.temperature) {
        put('u', `${u.composition},${u.temperature}`);
    }

    // Tri-state: `null` means the viewport decides, and is not written, so a
    // link made on a tall screen does not force the panel open on a small one.
    if (s.gibbsOpen === true || s.gibbsOpen === false) put('g', s.gibbsOpen ? '1' : '0');

    if (s.figureTheme && s.figureTheme !== DEFAULTS.figureTheme) put('fig', s.figureTheme);
    if (s.showRegionLabels === !DEFAULTS.showRegionLabels) {
        put('lab', s.showRegionLabels ? '1' : '0');
    }
    if (s.colourBy && s.colourBy !== DEFAULTS.colourBy) put('col', s.colourBy);
    // Like `lab`, written only when off.
    if (s.showExpPoints === !DEFAULTS.showExpPoints) {
        put('pts', s.showExpPoints ? '1' : '0');
    }
    // A boolean written as `mode=vector`, the spelling shared links use.
    if (s.showRaster === false) put('mode', 'vector');

    if (TABS.includes(s.tab)) put('tab', s.tab);

    const params = (s.params || []).filter(([k, v]) => k && Number.isFinite(v));
    if (params.length) {
        put('p', params.map(([k, v]) => `${k}=${num(v)}`).join(';'));
    }

    return parts.length ? `?${parts.join('&')}` : '';
}

function finitePair(raw) {
    const bits = String(raw).split(',');
    if (bits.length !== 2) return null;
    const lo = Number(bits[0]), hi = Number(bits[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(lo < hi)) return null;
    return [lo, hi];
}

const flag = (raw) => (raw === '1' ? true : raw === '0' ? false : undefined);

/**
 * The inverse of `encodeState`. Only keys that are present and well formed
 * appear in the result, so the caller only needs `key in state`.
 *
 * @param {string} search `location.search`, with or without the leading `?`.
 * @returns {object} plain object; absent keys are simply missing.
 */
export function decodeState(search = '') {
    const out = {};
    let q;
    try {
        q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    } catch {
        return out;
    }

    const db = q.get('db');
    if (db) out.db = db;

    // Not checked against `db`: this layer does not know either id's elements,
    // and the pair check belongs to the engine.
    const bl = q.get('bl');
    if (bl) out.baseline = bl;

    // `db` wins when a link names both: it is the more specific id, and most
    // examples are also in the corpus.
    const example = q.get('example');
    if (example && !out.db) out.example = example;

    const x = q.has('x') ? finitePair(q.get('x')) : null;
    const t = q.has('t') ? finitePair(q.get('t')) : null;
        // Both or neither: half a window with the fitted other half is a view
        // nobody saw.
    if (x && t) out.view = { xMin: x[0], xMax: x[1], tMin: t[0], tMax: t[1] };

    if (q.has('T')) {
        const temp = Number(q.get('T'));
        if (Number.isFinite(temp)) out.temp = temp;
    }

    if (q.has('u')) {
        const [comp, temp] = String(q.get('u')).split(',');
        const units = {};
        if (COMPOSITION_UNITS.includes(comp)) units.composition = comp;
        if (TEMPERATURE_UNITS.includes(temp)) units.temperature = temp;
        if (Object.keys(units).length) out.units = units;
    }

    const g = flag(q.get('g'));
    if (g !== undefined) out.gibbsOpen = g;

    if (['dark', 'light'].includes(q.get('fig'))) out.figureTheme = q.get('fig');

    const lab = flag(q.get('lab'));
    if (lab !== undefined) out.showRegionLabels = lab;

    if (TABS.includes(q.get('tab'))) out.tab = q.get('tab');

    if (['source', 'residual'].includes(q.get('col'))) out.colourBy = q.get('col');

    const pts = flag(q.get('pts'));
    if (pts !== undefined) out.showExpPoints = pts;

    if (q.get('mode') === 'vector') out.showRaster = false;

    if (q.has('p')) {
        const params = [];
        for (const entry of String(q.get('p')).split(';')) {
            if (!entry) continue;
            // Split at the last `=`, so a key that ever contains one survives.
            const cut = entry.lastIndexOf('=');
            if (cut <= 0) continue;
            const value = Number(entry.slice(cut + 1));
            if (Number.isFinite(value)) params.push([entry.slice(0, cut), value]);
        }
        if (params.length) out.params = params;
    }

    return out;
}

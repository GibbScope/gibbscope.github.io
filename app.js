import {
    palette, refreshPalette, phaseColor, mixColors, phaseColorSet, withAlpha,
    phaseColorIsReused, PHASE_SERIES_LEN,
    expSourceColor, residualColor, RESIDUAL_CLAMP,
} from './palette.js';
import { SvgContext } from './svg-canvas.js';
import { encodeState, decodeState } from './url-state.js';
import { setupPicker } from './picker.js';
import { parsePop, looksLikePop } from './pop.js';
import { parseEspei, looksLikeEspei } from './espei.js';
import { bySymbol } from './elements.js';

// Plot margins (px). `xAxis` says whether the panel draws the composition axis.
// Stacked plots share one x axis under the lower plot, so a common-tangent
// endpoint lines up vertically with the boundary it gives.
const MARGIN = { left: 74, right: 16, top: 14, bottom: 60, xAxis: true };

// The upper plot of a stacked pair: a small bottom margin and no x axis.
const MARGIN_UPPER = { left: 74, right: 16, top: 14, bottom: 10, xAxis: false };
const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/// The figure's text when no database is loaded. It names every way to load
/// one, since none of them is on the plot itself.
const EMPTY_FIGURE_NOTE =
    'No database loaded \u2014 drop a .tdb, choose an example, or pick a system';

import init, {
    engine_version,
    get_grid_width, get_grid_height, get_t_min, get_t_max,
    reset_heap_tracker, get_peak_heap_bytes, get_wasm_rss_bytes,
    load_tdb,
} from './pkg/calphad_wasm.js';

// ------------------------------------------------------------------- state --

let wasm = null;
let currentTdb = null;
// The parsed system lives in WASM memory until the next load; JS holds only
// this handle.
let tdbHandle = null;
// The fit and sweep workers parse the database in their own WASM instances, so
// the text is kept. `tdbKey` changes on every load and tells a worker that its
// cached handle is stale, without comparing the text.
let currentTdbText = null;
/// Which encoding `currentTdbText` was decoded from, so an export can be
/// written back in it. See `decodeTdb`.
let currentTdbEncoding = 'utf-8';
let tdbKey = 0;
let tdbInfo = null;
let tdbPhases = [];
let tdbCompounds = [];

const params = {
    temp: 1000,
};

let tdbParams = {
    _compound_offsets: {}
};
// Serialised once per update() and reused by every WASM call in that frame.
let tdbParamsJson = JSON.stringify(tdbParams);
// Incremented whenever `tdbParamsJson` changes, so caches compare a number
// rather than a string that can run to kilobytes.
let tdbParamsVersion = 0;

function setTdbParamsJson(json) {
    if (json === tdbParamsJson) return;
    tdbParamsJson = json;
    tdbParamsVersion++;
}

// Whether the phase raster is painted under the boundary curves. Display only:
// the sweep builds the cell grid either way, for labels and miscibility gaps.
// The URL and the session store it as `both` / `vector`.
let showRaster = true;
let boundaryData = null;

// Temperature steps of the boundary sweep, and the bisection tolerance (K) for
// each invariant reaction. 200 steps matches the raster's temperature
// resolution; bisection gives the sub-grid precision. Fewer steps saves little,
// since the 201-row cell raster is built anyway. A sweep can take a second on
// the larger systems, which is why it runs in a worker.
const BOUNDARY_T_STEPS = 200;
const BOUNDARY_T_TOLERANCE = 0.5;

/// The temperature range over which the loaded database defines its functions,
/// or the engine's defaults when nothing is loaded.
function modelTMin() { return tdbHandle ? tdbHandle.t_min() : get_t_min(); }
function modelTMax() { return tdbHandle ? tdbHandle.t_max() : get_t_max(); }

// The (x, T) rectangle currently on screen. `fittedView` is what "Reset view"
// returns to, derived from the loaded system.
let view = null;
let fittedView = null;
// Whether the T axis runs above the fitted top, where some solids are used past
// their declared range. Reset and a new system turn it off.
let extrapolatedShown = false;

// The latest raster and the window it was computed for. Pan and zoom redraw it
// scaled while the real sweep runs debounced in the worker. It holds a painted
// bitmap, so a raster from an older `paletteGeneration` (bumped when the figure
// theme changes) is repainted from its cells without a new sweep.
let lastRaster = null;
/// The fill scheme the legend key shows, so the key is rebuilt only when the
/// scheme changes.
let legendScheme = null;
let paletteGeneration = 0;
let recomputeTimer = null;
let updateFrame = null;
let tempFrame = null;

const MIN_VIEW_X_SPAN = 1e-3;
const MIN_VIEW_T_SPAN = 1.0;

// Region labels: on by default, skipped for fields too small to hold the text.
let showRegionLabels = true;
const MIN_LABEL_AREA = 0.006;
const LABEL_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/// Alpha of the whole phase raster under the boundary curves, so full-chroma
/// fills do not drown the curves. With no curves to draw, the raster is drawn
/// at 1.0.
const RASTER_FILL_ALPHA = 0.30;

// 'dark' | 'light'. Themes the plot card only, not the rest of the app.
let figureTheme = 'dark';

// Experimental datasets, keyed by an id (see `addExpSource`). Load order
// decides the colour slot; see `palette.exp`. Each carries the element `pair`
// of the database it was loaded against; see `expParked`.
const expSources = new Map();

// Says the data was mirrored, when a database's element pair is a loaded
// dataset's pair reversed. Cleared with the data and by the next database.
let expMirrorNote = '';

// 'source' | 'residual': what the marker fill shows.
let expColourBy = 'source';

// Whether the experimental marks are drawn. Display only: `visibleExpPointsJson`,
// which feeds the residuals and the fit, ignores it.
let showExpPoints = true;

// Per-point residuals from the last compute, indexed to match the flattened
// visible-point order that was sent to WASM.
let residualReport = null;

// The record kinds the importer accepts. Marker shape shows the kind and
// colour the source.
const EXP_KINDS = ['boundary', 'tie_left', 'tie_right', 'invariant', 'single_phase'];
const EXP_KIND_LABEL = {
    boundary:     'phase boundary',
    tie_left:     'tie-line, left',
    tie_right:    'tie-line, right',
    invariant:    'invariant',
    single_phase: 'single phase',
};

// ---------------------------------------------------------------- elements --

const phaseCanvas = document.getElementById('phase-canvas');
const phaseOverlay = document.getElementById('phase-overlay');
const boundaryCanvas = document.getElementById('boundary-canvas');
const boundaryOverlay = document.getElementById('boundary-overlay');
const gibbsPanel = document.getElementById('gibbs-panel');
const gibbsToggle = document.getElementById('gibbs-toggle');
const plotsColumn = document.querySelector('.plots-column');
const timingBar = document.getElementById('timing-bar');
const memoryBar = document.getElementById('memory-bar');
const engineVersionEl = document.getElementById('engine-version');
const tempSlider = document.getElementById('temp-slider');
const tempTrack = document.getElementById('temp-track');
const tempValue = document.getElementById('value-temp');
const resetBtn = document.getElementById('reset-btn');

const tdbSliders = document.getElementById('tdb-param-sliders');
const slidersHeading = document.getElementById('sliders-heading');

const rasterToggle = document.getElementById('raster-toggle');
const resetViewBtn = document.getElementById('reset-view-btn');
const extrapolatedBtn = document.getElementById('extrapolated-btn');
// Closed by default, and forced open when the sweep worker dies: see
// `disposeSweepWorker`.
const diagnosticsPanel = document.getElementById('diagnostics');
const invariantReadout = document.getElementById('invariant-readout');
const labelsBtn = document.getElementById('labels-btn');
const figureThemeBtn = document.getElementById('figure-theme-btn');
/// The Points switch, display only (see `showExpPoints`). The per-source tick
/// boxes are what change the residuals and the fit.
const pointsToggle = document.getElementById('points-toggle');
// The plot card holds both canvases and carries the figure theme; `palette.js`
// reads its computed `--fig-*` tokens.
const figureCard = document.querySelector('.plots-row .visualization-panel');
const phaseLegend = document.getElementById('phase-legend');
const tempUnits = document.getElementById('temp-units');
const compUnits = document.getElementById('comp-units');
const tempSliderMinLabel = document.getElementById('temp-slider-min');
const tempSliderMaxLabel = document.getElementById('temp-slider-max');
// Hidden while no database is loaded, since its end labels would still show
// the old database's range.
const tempControl = document.getElementById('temp-control');

/// Starts closed and opens itself when data becomes the next step (see
/// `revealExpSection`).
const expSection = document.getElementById('exp-section');

const expDropZone = document.getElementById('exp-drop-zone');
const expFileInput = document.getElementById('exp-file-input');
const expError = document.getElementById('exp-error');
const expParkedEl = document.getElementById('exp-parked');
const expPanel = document.getElementById('exp-panel');
const expTableBody = document.getElementById('exp-table-body');
const expLegend = document.getElementById('exp-legend');
const expClearBtn = document.getElementById('exp-clear-btn');
const expColourMode = document.getElementById('exp-colour-mode');
const fitPanel = document.getElementById('fit-panel');
const fitValue = document.getElementById('fit-value');
const fitBreakdown = document.getElementById('fit-breakdown');
const fitControls = document.getElementById('fit-controls');
const fitBtn = document.getElementById('fit-btn');
const fitCancelBtn = document.getElementById('fit-cancel-btn');
const fitStatus = document.getElementById('fit-status');
const fitReview = document.getElementById('fit-review');
const fitReviewText = document.getElementById('fit-review-text');
const fitAcceptBtn = document.getElementById('fit-accept-btn');
const fitRevertBtn = document.getElementById('fit-revert-btn');
const exportControls = document.getElementById('export-controls');
const exportTdbBtn = document.getElementById('export-tdb-btn');
const exportPngBtn = document.getElementById('export-png-btn');
const exportSvgBtn = document.getElementById('export-svg-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const sessionSaveBtn = document.getElementById('session-save-btn');
const sessionLoadBtn = document.getElementById('session-load-btn');
const sessionFileInput = document.getElementById('session-file-input');
const exportStatus = document.getElementById('export-status');
const exampleSelect = document.getElementById('example-select');
const exampleNote = document.getElementById('example-note');
const headerSystem = document.getElementById('header-system');

const loadOverlay = document.getElementById('load-overlay');
const loadOverlayTitle = document.getElementById('load-overlay-title');
const loadOverlayLabel = document.getElementById('load-overlay-label');

const dropZone = document.getElementById('tdb-drop-zone');
const tdbFileInput = document.getElementById('tdb-file-input');
const tdbLoadedBar = document.getElementById('tdb-loaded-bar');
const tdbFilename = document.getElementById('tdb-filename');
const tdbClearBtn = document.getElementById('tdb-clear-btn');
const tdbError = document.getElementById('tdb-error');
const tdbInfoText = document.getElementById('tdb-info-text');
const fidelityPanel = document.getElementById('fidelity-panel');
const fidelitySummary = document.getElementById('fidelity-summary');
const fidelityTableBody = document.getElementById('fidelity-table-body');
const fidelityFoot = document.getElementById('fidelity-foot');
const tdbNotesPanel = document.getElementById('tdb-notes');
const tdbNotesSummary = document.getElementById('tdb-notes-summary');
const tdbNotesBody = document.getElementById('tdb-notes-body');
const tdbNotesFoot = document.getElementById('tdb-notes-foot');

// ----------------------------------------------------------------- startup --

async function run() {
    // Read once, before anything draws, and frozen so nothing below changes it.
    const link = Object.freeze(decodeState(location.search));
    restoring = true;
    try {
        // Every engine export throws until this resolves.
        wasm = await init();

        // Before `fitCanvases`: the fold state decides the height budget.
        setupGibbsPanel();
        fitCanvases();
        observeCanvasSize();

        tempSlider.min = get_t_min();
        tempSlider.max = get_t_max();

        engineVersionEl.textContent = `Engine ${engine_version()}`;
        // The footer was first painted without the version, so the
        // attribution does not wait for the engine.
        renderFooter();

        // Always start with a database loaded. The ~2 MB corpus manifest is
        // fetched here only for a `?db=` link, otherwise on first opening the
        // Systems tab.
        await loadExampleManifest();
        let refused = '';
        let fromCorpus = false;
        if (link.db) {
            const attempt = await picker.loadById(link.db);
            fromCorpus = attempt.ok;
            if (!attempt.ok) refused = attempt.reason;
        }
        if (!fromCorpus) {
            const first = defaultExampleId(link.example);
            if (first) await loadExample(first);
            else update();
        }
        // After the fallback load, because a successful `applyTdbText` clears
        // the error area.
        if (refused) {
            tdbError.textContent = `${refused} The default example is shown instead.`;
            tdbError.classList.remove('hidden');
        }

        // Only after the load, which resets `tdbParams` and the view.
        applyLinkState(link);
        update();

        // After the database, since `applyTdbText` clears any comparison. Not
        // awaited, so the URL does not wait for a second fetch.
        if (link.baseline) loadBaselineById(link.baseline);

        // Write the URL once now, so a page opened with no query still names
        // its example; an idle page never redraws.
        restoring = false;
        scheduleUrlSync();

        const loading = document.getElementById('loading');
        if (loading) loading.classList.add('hidden');
    } catch (e) {
        console.error("Failed to initialize WASM:", e);
        const loadingText = document.querySelector('#loading p');
        if (loadingText) loadingText.textContent = "Error: Failed to load calculations engine.";
    } finally {
        restoring = false;
    }
}

// ---------------------------------------------------------------- controls --

tempSlider.addEventListener('input', (e) => {
    params.temp = parseFloat(e.target.value);
    syncTemperatureSlider();
    scheduleTemperatureDraw();
});

function setPressed(btn, on) {
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
}

// The only setter (button, session and link), so the state and the control
// cannot disagree.
function setShowRaster(on, { redraw = true } = {}) {
    if (typeof on !== 'boolean') return;
    const changed = on !== showRaster;
    showRaster = on;
    setPressed(rasterToggle, showRaster);
    if (changed && redraw) update();
}

rasterToggle.addEventListener('click', () => setShowRaster(!showRaster));

/// The only setter, as for `setShowRaster`. It calls `render(false)`, not
/// `update()`: the sweep, raster and residuals do not depend on it.
function setShowExpPoints(on, { redraw = true } = {}) {
    if (typeof on !== 'boolean') return;
    const changed = on !== showExpPoints;
    showExpPoints = on;
    setPressed(pointsToggle, showExpPoints);
    if (changed && redraw) render(false);
}

pointsToggle.addEventListener('click', () => setShowExpPoints(!showExpPoints));

// Returns every parameter to its assessed value.
resetBtn.addEventListener('click', () => {
    tdbParams = { _compound_offsets: {} };
    for (const slider of paramSliders.values()) slider.show(0);
    update();
});

// --------------------------------------------------------- loading overlay --
//
// Every way of opening a database ends in `applyTdbText`, which parses it and
// runs the first sweep in the page. The page is frozen meanwhile, so an overlay
// says so. It must be painted before the blocking call starts, or it never
// reaches the screen.

/// Resolves after the browser has painted a frame. A rAF callback, and a
/// promise resolved in it, run before paint; the `setTimeout` waits until the
/// rendering step is over. The callers also await a read first, which yields a
/// frame too; this keeps them correct if that read moves.
function painted() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/// Runs `work` with the loading overlay painted. The label gives no progress,
/// since neither `load_tdb` nor the sweep reports any.
async function duringLoad(title, work) {
    // While a link is restored, the start-up overlay already covers the page.
    if (restoring) return work();
    loadOverlayTitle.textContent = title;
    loadOverlayLabel.textContent =
        'Parsing the database, then computing its first set of phase boundaries. '
        + 'The page cannot respond until that finishes — how long it takes '
        + 'depends on how many phases the assessment has.';
    loadOverlay.classList.remove('hidden');
    await painted();
    try {
        return await work();
    } finally {
        loadOverlay.classList.add('hidden');
    }
}

// ---------------------------------------------------------------- examples --
//
// The bundled systems listed in examples/examples.json; see examples/README.md.

const EXAMPLES_ROOT = 'examples/';

// The corpus that `tools/build.sh` stages into `app/corpus/`. Relative, so it
// resolves the same on the dev server, in the harness and when deployed.
const CORPUS_ROOT = 'corpus/';

let examples = [];
let currentExampleId = null;
// At most one of the two ids is set; every load path clears the other, so a
// link never names two databases.
let currentCorpusId = null;

async function loadExampleManifest() {
    try {
        const res = await fetch(`${EXAMPLES_ROOT}examples.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        examples = await res.json();
    } catch (e) {
        console.warn('No example manifest:', e.message);
        examples = [];
    }

    exampleSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = examples.length ? 'Choose an example…' : '(no examples found)';
    exampleSelect.appendChild(none);
    for (const ex of examples) {
        const opt = document.createElement('option');
        opt.value = ex.id;
        opt.textContent = ex.label || ex.id;
        exampleSelect.appendChild(opt);
    }
    return examples;
}

/// `requested` is the id from a link. An unknown id falls back to the default.
function defaultExampleId(requested) {
    if (requested && examples.some(e => e.id === requested)) return requested;
    return (examples.find(e => e.default) || examples[0])?.id || null;
}

/// Writes an example's note into `el`. `[text](https://…)` in the note becomes
/// a link; everything else is plain text.
function renderExampleNote(el, note) {
    el.textContent = '';
    const re = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
    let at = 0;
    for (const m of note.matchAll(re)) {
        el.append(note.slice(at, m.index));
        const a = document.createElement('a');
        a.href = m[2];
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = m[1];
        el.append(a);
        at = m.index + m[0].length;
    }
    el.append(note.slice(at));
}

/// Loads a manifest entry: its database, then any data files listed with it.
async function loadExample(id) {
    const ex = examples.find(e => e.id === id);
    if (!ex) return;

    exampleSelect.value = id;
    renderExampleNote(exampleNote, ex.note || '');

    // The data files load under the overlay too, so the diagram never shows
    // without its points.
    await duringLoad(`Loading ${ex.label || ex.id}`, async () => {
        try {
            const res = await fetch(EXAMPLES_ROOT + ex.tdb);
            if (!res.ok) throw new Error(`could not fetch ${ex.tdb} (HTTP ${res.status})`);
            const { text, encoding } = decodeTdb(await res.arrayBuffer());
            const fileName = ex.tdb.split('/').pop();
            if (!applyTdbText(text, fileName, encoding)) return;
            currentExampleId = id;
            currentCorpusId = null;
            syncDatabaseSectionUi();

            // Replace rather than merge: an example is a complete starting point.
            clearExpSources();
            for (const path of ex.data || []) {
                try {
                    const dres = await fetch(EXAMPLES_ROOT + path);
                    if (!dres.ok) throw new Error(`HTTP ${dres.status}`);
                    const name = path.split('/').pop();
                    const { points } = parseExperimentalText(await dres.text(), name);
                    addExperimentalPoints(points);
                } catch (e) {
                    console.warn(`example data ${path}:`, e.message);
                }
            }
            afterFetchedDatabase();
        } catch (e) {
            tdbError.textContent = `Could not load example: ${e.message}`;
            tdbError.classList.remove('hidden');
        }
    });
}

/// Finishes loading an example or a corpus database.
function afterFetchedDatabase() {
    // A new database turns the Points switch back on. This runs before
    // `applyLinkState`, so a link's `pts=0` still wins.
    setShowExpPoints(true, { redraw: false });
    rebuildExpPanel();
    update();
    updateFitControls();
    updateExportControls();
}

function setupExamplePicker() {
    exampleSelect.addEventListener('change', (e) => {
        if (e.target.value) loadExample(e.target.value);
    });
}

// ----------------------------------------------------------- system picker --
//
// `picker.js` runs the Systems tab and knows nothing of the app. Built at
// module scope, since the tab can be clicked before `run` finishes.

const picker = setupPicker({
    manifestUrl: `${CORPUS_ROOT}phase-manifest.json`,
    root: document.getElementById('tab-picker'),
    onLoad: loadCorpusSystem,
});

/// Loads a corpus database, like `loadExample` but with no data files. The
/// data already loaded is kept, mirrored or set aside by `applyTdbText`, as
/// for a dropped file. Returns whether it loaded; on failure the picker stays
/// open.
async function loadCorpusSystem(entry) {
    // The corpus is staged flat, so the basename is the served name. The
    // picker offers only entries under `data/tdb/`, which is what is staged.
    const fileName = entry.tdb.split('/').pop();
    return duringLoad(`Loading ${entry.id}`, async () => {
        try {
            const res = await fetch(CORPUS_ROOT + fileName);
            if (!res.ok) throw new Error(`could not fetch ${fileName} (HTTP ${res.status})`);
            // Not `.text()`, which would garble the Latin-1 databases; see
            // `decodeTdb`.
            const { text, encoding } = decodeTdb(await res.arrayBuffer());
            if (!applyTdbText(text, fileName, encoding)) return false;

            currentExampleId = null;
            // The URL records the database, not the picker's selection state.
            currentCorpusId = entry.id;
            syncDatabaseSectionUi();
            exampleSelect.value = '';
            exampleNote.textContent = '';
            afterFetchedDatabase();
            showTab('viz');
            return true;
        } catch (e) {
            tdbError.textContent = `Could not load ${fileName}: ${e.message}`;
            tdbError.classList.remove('hidden');
            return false;
        }
    });
}

// --------------------------------------------------------------- URL state --
//
// Writes the view into the address bar and applies a link on load; the keys
// and encoding are in `url-state.js`. `replaceState` keeps zooming out of the
// back button's history. The whole query is rewritten each time, so unknown
// keys are dropped.

// Debounced, since a pan or a drag calls `render` many times a second.
const URL_SYNC_MS = 200;
let urlSyncTimer = null;

/// True while a link is being applied, so the first draws do not overwrite
/// the URL before it is read.
let restoring = false;

/// `params.temp` as the load set it (`applyFittedView` picks it from the
/// system's range), so an untouched temperature stays out of the link.
let pristineTemp = null;

function scheduleUrlSync() {
    if (restoring || urlSyncTimer !== null) return;
    urlSyncTimer = setTimeout(() => {
        urlSyncTimer = null;
        history.replaceState(null, '',
            `${location.pathname}${encodeState(urlState())}${location.hash}`);
    }, URL_SYNC_MS);
}

/// Whether the view differs from the fitted window. Only then does the link
/// carry it, since loading the database restores the fitted window anyway.
function viewOffFittedWindow() {
    if (!view || !fittedView) return false;
    return view.xMin !== fittedView.xMin || view.xMax !== fittedView.xMax
        || view.tMin !== fittedView.tMin || view.tMax !== fittedView.tMax;
}

/// Shows Reset view only when the view is off the fitted window, the same test
/// the URL uses. Also labels the extrapolated-region button.
function syncResetButton() {
    if (resetViewBtn) resetViewBtn.classList.toggle('hidden', !viewOffFittedWindow());
    if (extrapolatedBtn) {
        const top = extrapolatedTop();
        extrapolatedBtn.classList.toggle('hidden', top == null);
        if (top != null) {
            extrapolatedBtn.textContent =
                `${extrapolatedShown ? 'Hide' : 'Show'} extrapolated region`;
            extrapolatedBtn.title = extrapolatedShown
                ? 'Back to the diagram inside the declared ranges'
                : `Extend the axis to ${Math.round(top)} K, where the database's ` +
                  'polynomials are used past the ranges they are declared for';
        }
    }
}

function urlState() {
    return {
        example: currentExampleId,
        db: currentCorpusId,
        // Corpus comparisons only; a dropped file has a null id.
        baseline: baselineTdb?.id || null,
        view: viewOffFittedWindow() ? view : null,
        temp: (pristineTemp !== null && params.temp !== pristineTemp) ? params.temp : null,
        units: { ...units },
        // Null unless the user folded the panel; otherwise the window height
        // at start-up decides it.
        gibbsOpen: gibbsUserChose ? gibbsOpen : null,
        figureTheme,
        showRegionLabels,
        colourBy: expColourBy,
        showExpPoints,
        showRaster,
        // The diagram keys are kept on every tab, since the database stays
        // loaded behind the Systems and About tabs.
        tab: openTab,
        params: changedParamEntries(),
    };
}

/// Applies a decoded link. Call it after the database has loaded, since
/// `applyTdbText` resets `tdbParams` and the view. Parameters come before the
/// view because they can move the window the view is clamped to.
function applyLinkState(link) {
    if (link.units) {
        setUnits(link.units.composition ?? units.composition,
                 link.units.temperature ?? units.temperature, { redraw: false });
    }
    if (link.figureTheme) setFigureTheme(link.figureTheme);
    if (link.showRegionLabels !== undefined) {
        setRegionLabels(link.showRegionLabels, { redraw: false });
    }
    if (link.showRaster !== undefined) setShowRaster(link.showRaster, { redraw: false });
    if (link.colourBy) setExpColourBy(link.colourBy, { redraw: false });
    if (link.showExpPoints !== undefined) {
        setShowExpPoints(link.showExpPoints, { redraw: false });
    }
    if (link.gibbsOpen !== undefined) setGibbsOpen(link.gibbsOpen, true);
    if (link.params && currentTdb) applyParamOverrides(link.params);
    if (link.view) setViewWindow(link.view);
    if (link.temp !== undefined) setTemperature(link.temp);
    // Last: the Systems tab highlights the loaded system.
    if (link.tab) showTab(link.tab);
}

/// Sets the parameters a link carries; every other parameter goes back to its
/// assessed value. Unknown keys are skipped.
function applyParamOverrides(entries) {
    tdbParams = { _compound_offsets: {} };
    for (const [key, value] of entries) {
        const slider = paramSliders.get(key);
        if (slider && Number.isFinite(value)) slider.apply(value);
    }
    // Moves the sliders and readouts to the values now in `tdbParams`.
    applyFitParams(tdbParams);
}

// -------------------------------------------------------------- TDB loader --

function setupTdbDragAndDrop() {
    // Skip clicks on the `<label for=…>`, which opens the file dialog itself.
    dropZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'LABEL') tdbFileInput.click();
    });

    tdbFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) loadTdbFile(e.target.files[0]);
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    ['dragleave', 'dragend'].forEach(evt => {
        dropZone.addEventListener(evt, () => dropZone.classList.remove('dragover'));
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) loadTdbFile(e.dataTransfer.files[0]);
    });
}

// ----------------------------------------------------- comparison database --
//
// A second assessment of the same system, drawn as the reference ghost (see
// `baselineCache` for the sweep side).

const baselineFrame = document.getElementById('baseline-frame');
const baselineBrief = document.getElementById('baseline-brief');
const baselineSelect = document.getElementById('baseline-select');
const baselineDropZone = document.getElementById('baseline-drop-zone');
const baselineFileInput = document.getElementById('baseline-file-input');
const baselineLoadedBar = document.getElementById('baseline-loaded-bar');
const baselineNameEl = document.getElementById('baseline-name');
const baselineNoteEl = document.getElementById('baseline-note');
const baselineClearBtn = document.getElementById('baseline-clear-btn');
const baselineError = document.getElementById('baseline-error');

// TDB element names are uppercase; chemical symbols are not.
const symbolOf = (e) => e.charAt(0) + e.slice(1).toLowerCase();

/// The two elements of a parsed database, in its declared order. The order
/// decides whether the comparison's composition axis must be reversed.
function pairOf(info) {
    return (info?.elements || []).slice(0, 2).map((e) => e.toUpperCase());
}

/// Installs a comparison, or refuses it with a reason. A database for another
/// element pair is refused, since its curves would draw and look like a large
/// disagreement. The pair comes from the parsed database, not the file name.
function applyBaselineTdb(text, name, { id = null, encoding = 'utf-8' } = {}) {
    if (!tdbHandle || !tdbInfo) {
        return baselineRefusal('Load a database first — there is nothing to compare against yet.');
    }
    let handle;
    try {
        handle = load_tdb(text);
    } catch (e) {
        return baselineRefusal(`${name} could not be read: ${e.message || e}`);
    }
    let info;
    try {
        info = JSON.parse(handle.info());
    } catch (e) {
        handle.free();
        return baselineRefusal(`${name} could not be read: ${e.message || e}`);
    }

    const here = pairOf(tdbInfo);
    const there = pairOf(info);
    // Order is ignored here; a reversed pair is handled by `flip` below.
    if ([...here].sort().join() !== [...there].sort().join()) {
        handle.free();
        return baselineRefusal(
            `${name} is a ${there.map(symbolOf).join('\u2013')} database and this is `
            + `${here.map(symbolOf).join('\u2013')}. A comparison has to be the same `
            + 'two elements, or the two diagrams share an axis that means different '
            + 'things on each.');
    }

    if (baselineHandle) baselineHandle.free();
    baselineHandle = handle;
    baselineTdb = {
        text, name, id, encoding,
        key: `bl${++baselineKeySeq}`,
        // Declared in the opposite order: x here is 1 - x there.
        flip: here[0] !== there[0],
    };
    baselineError.classList.add('hidden');
    // Fold the Gibbs panel to make room, unless the user set it (see
    // `gibbsFoldedForGhost`). Before `render`, so the sweep runs once, at the
    // new size.
    if (gibbsOpen && !gibbsUserChose) {
        gibbsFoldedForGhost = true;
        setGibbsOpen(false, false, { redraw: false });
    }
    syncBaselineUi();
    // A new source misses the ghost cache, so recompute.
    render(true);
    return true;
}

function baselineRefusal(reason) {
    baselineError.textContent = reason;
    baselineError.classList.remove('hidden');
    if (baselineFrame) baselineFrame.open = true;
    return false;
}

function clearBaseline({ redraw = true } = {}) {
    if (!baselineTdb && !baselineHandle) return;
    if (baselineHandle) baselineHandle.free();
    baselineHandle = null;
    baselineTdb = null;
    baselineError.classList.add('hidden');
    // Reopen the Gibbs panel only if the comparison folded it.
    if (gibbsFoldedForGhost) {
        gibbsFoldedForGhost = false;
        setGibbsOpen(true, false, { redraw });
    }
    syncBaselineUi();
    if (redraw) render(true);
}

/// Updates the comparison section, whose summary shows whether a comparison is
/// loaded.
function syncBaselineUi() {
    if (!baselineFrame) return;
    // No leading dash: the brief wraps to its own line in the rail.
    baselineBrief.textContent = baselineTdb
        ? baselineTdb.name
        : 'the ghost is this database, unperturbed';
    // The loaded bar, which replaces the drop zone, is for a dropped file only.
    // A corpus choice is shown by the select, and choosing None removes it.
    const dropped = Boolean(baselineTdb && !baselineTdb.id);
    baselineLoadedBar.classList.toggle('hidden', !dropped);
    baselineDropZone.classList.toggle('hidden', dropped);
    if (baselineTdb) {
        baselineNameEl.textContent = baselineTdb.name;
        baselineNoteEl.textContent = baselineTdb.flip
            ? 'drawn with its composition axis reversed to match'
            : 'drawn under the live curves';
    }
    baselineSelect.value = baselineTdb?.id || '';
    rebuildPhaseLegend();
}

/// Updates the `Your database` section for where the database came from. The
/// loaded bar and its remove button are for a dropped file only: an example is
/// shown by its select, and a corpus database by the header. The Systems tab
/// marks a row loaded only while that database is on screen.
function syncDatabaseSectionUi() {
    if (!currentCorpusId) picker.forget();
    const dropped = Boolean(currentTdb && !currentExampleId && !currentCorpusId);
    tdbLoadedBar.classList.toggle('hidden', !dropped);
    dropZone.classList.toggle('hidden', dropped);
    exampleSelect.classList.toggle('is-holding', Boolean(currentExampleId));
    const brief = document.getElementById('tdb-brief');
    if (brief) {
        brief.textContent = dropped ? tdbFilename.textContent
                                    : 'drop a .tdb to use your own';
    }
}

/// The corpus's other assessments of this system, listed by id so a comparison
/// can be named in a URL. Filled when the section is first opened, not on load:
/// `picker.peers` needs the ~2 MB manifest, which is not fetched until needed.
let baselineChoicesStale = true;

async function fillBaselineChoices() {
    baselineChoicesStale = false;
    if (!baselineSelect || !tdbInfo) return;
    const here = pairOf(tdbInfo);
    let peers = [];
    try {
        peers = await picker.peers(here[0], here[1]);
    } catch { /* the index is unreadable; the drop zone still works */ }
    // Not this database itself, whose ghost would sit exactly under the live
    // curves.
    const others = peers.filter((e) => e.id !== currentCorpusId);
    baselineSelect.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = others.length
        ? `None (${plural(others.length, 'other assessment')})`
        : 'None — the corpus has no other assessment of this system';
    baselineSelect.append(none);
    for (const e of others) {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.id;
        baselineSelect.append(opt);
    }
    baselineSelect.disabled = others.length === 0;
    baselineSelect.value = baselineTdb?.id || '';
}

async function loadBaselineById(id) {
    let entry = null;
    try {
        entry = await picker.entryById(id);
    } catch { /* reported below */ }
    if (!entry) {
        return baselineRefusal(`The corpus index has no assessment called ${id}.`);
    }
    const fileName = entry.tdb.split('/').pop();
    try {
        const res = await fetch(CORPUS_ROOT + fileName);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { text, encoding } = decodeTdb(await res.arrayBuffer());
        return applyBaselineTdb(text, entry.id, { id: entry.id, encoding });
    } catch (e) {
        return baselineRefusal(`Could not load ${entry.id}: ${e.message}`);
    }
}

async function loadBaselineFile(file) {
    const { text, encoding } = decodeTdb(await file.arrayBuffer());
    applyBaselineTdb(text, file.name, { encoding });
}

function setupBaselineControls() {
    if (!baselineFrame) return;
    // The manifest is fetched on first opening, as for the Systems tab.
    baselineFrame.addEventListener('toggle', () => {
        if (baselineFrame.open && baselineChoicesStale) fillBaselineChoices();
    });
    baselineSelect.addEventListener('change', (e) => {
        const id = e.target.value;
        if (!id) { clearBaseline(); return; }
        loadBaselineById(id);
    });
    baselineClearBtn.addEventListener('click', () => clearBaseline());
    baselineFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) loadBaselineFile(e.target.files[0]);
    });
    baselineDropZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'LABEL') baselineFileInput.click();
    });
    baselineDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        baselineDropZone.classList.add('dragover');
    });
    ['dragleave', 'dragend'].forEach((evt) => {
        baselineDropZone.addEventListener(
            evt, () => baselineDropZone.classList.remove('dragover'));
    });
    baselineDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        baselineDropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) loadBaselineFile(e.dataTransfer.files[0]);
    });
    syncBaselineUi();
}

// ----------------------------------------------------------- TDB encodings --
//
// `Blob.text()` and `Response.text()` replace invalid UTF-8 with U+FFFD, which
// corrupts the notes panel and the exported file of an ISO-8859-1 database.
// Kept in step with the engine's `corpus::decode`: UTF-8 if valid, else
// ISO-8859-1.

/// Returns the encoding with the text, so an export can be written back in it.
function decodeTdb(buffer) {
    const bytes = new Uint8Array(buffer);
    try {
        // `fatal` makes invalid UTF-8 throw instead of becoming U+FFFD.
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                 encoding: 'utf-8' };
    } catch {
        // Not TextDecoder('iso-8859-1'), which is windows-1252 and differs over
        // 0x80–0x9F. Each byte becomes the code point of the same value.
        let text = '';
        for (let i = 0; i < bytes.length; i += 8192) {
            text += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        return { text, encoding: 'iso-8859-1' };
    }
}

/// The inverse of `decodeTdb`, for export. The engine writes only ASCII, so a
/// Latin-1 file still encodes as Latin-1.
function encodeTdb(text, encoding) {
    if (encoding !== 'iso-8859-1') return new TextEncoder().encode(text);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        // A character outside Latin-1 falls back to UTF-8 for the whole file.
        if (code > 0xff) return new TextEncoder().encode(text);
        bytes[i] = code;
    }
    return bytes;
}

async function loadTdbFile(file) {
    await duringLoad(`Loading ${file.name}`, async () => {
        const { text, encoding } = decodeTdb(await file.arrayBuffer());
        if (applyTdbText(text, file.name, encoding)) {
            // A dropped file cannot be named in a URL, so the link drops the
            // database; display settings stay.
            currentExampleId = null;
            currentCorpusId = null;
            syncDatabaseSectionUi();
            exampleSelect.value = '';
            exampleNote.textContent = '';
            // Someone who brings their own database likely has data to fit
            // it to, so open the data section.
            revealExpSection();
        }
    });
}

// --------------------------------------------------------- engine recovery --
//
// A Rust panic in WebAssembly is a trap: the module is dead and every later
// call fails. wasm-bindgen's `init` caches the instance, so it cannot be
// restarted in place; the user is offered a reload of the same URL instead.

let engineDead = false;

function isEngineTrap(e) {
    return (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError)
        || /unreachable|out of bounds|memory access|table index/i.test(e?.message || '');
}

/// Replaces the error area with a recovery notice. Returns true if it handled
/// the error, false if it was an ordinary "this TDB is unsupported" message.
function reportEngineTrap(e, fileName) {
    if (!isEngineTrap(e)) return false;
    engineDead = true;
    console.error('WASM engine trapped:', e);

    tdbError.replaceChildren();
    const what = document.createElement('div');
    what.textContent = fileName
        ? `"${fileName}" stopped the calculation engine — this is a bug in the parser, not in your file.`
        : 'The calculation engine stopped — this is a bug.';
    const how = document.createElement('div');
    how.className = 'engine-dead-hint';
    how.textContent = 'The page has to reload to restart it. Please send us the file so it can be fixed.';
    const reload = document.createElement('button');
    reload.className = 'engine-reload-btn';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => location.reload());
    tdbError.append(what, how, reload);
    tdbError.classList.remove('hidden');
    return true;
}

/// Installs a parsed database and rebuilds everything that depends on it.
/// Returns false (and shows the reason) if the database is unsupported, leaving
/// whatever was already loaded untouched.
function applyTdbText(text, fileName, encoding = 'utf-8') {
    if (engineDead) return false;
    try {
        // Throws a readable error on an unsupported TDB, leaving the previous
        // handle intact.
        const handle = load_tdb(text);

        if (tdbHandle) tdbHandle.free();
        tdbHandle = handle;
        currentTdb = fileName;
        currentTdbText = text;
        currentTdbEncoding = encoding;
        tdbKey += 1;

        tdbInfo = JSON.parse(tdbHandle.info());
        tdbPhases = tdbInfo.active_phases;
        tdbCompounds = tdbInfo.compounds;
        reconcileExpSources();

        tdbParams = { _compound_offsets: {} };
        setTdbParamsJson(JSON.stringify(tdbParams));
        applyFittedView();
        pristineTemp = params.temp;

        const system = tdbInfo.elements.slice(0, 2).map(symbolOf).join('\u2013');
        setHeaderSystem(system);
        document.title = `${system} \u2014 GibbScope`;

        tdbFilename.textContent = fileName;
        const nPhases = tdbInfo.phase_names.length;
        tdbInfoText.textContent =
            `${tdbInfo.elements.slice(0, 2).join('-')} system (${nPhases} phases)`;
        renderFidelityPanel();
        renderTdbNotes(text, fileName);

        // A new database drops the comparison rather than re-checking it.
        clearBaseline({ redraw: false });
        baselineChoicesStale = true;
        if (baselineFrame?.open) fillBaselineChoices();

        tdbError.classList.add('hidden');

        buildTdbSliders();
        rebuildPhaseLegend();
        refreshUnitAvailability();

        // The first sweep runs in the page, since waiting for the worker would
        // leave the previous system's fill on these axes. Warming the worker
        // first lets its own parse overlap that sweep. A sweep queued for the
        // previous database is dropped, or it would be sent after this one.
        firstSweepForDatabase = true;
        sweepQueued = null;
        warmSweepWorker();
        update();
        updateFitControls();
        updateExportControls();
        setExportStatus('');
        return true;
    } catch (e) {
        if (reportEngineTrap(e, fileName)) return false;
        tdbError.textContent = `Error: ${e.message}`;
        tdbError.classList.remove('hidden');
        return false;
    }
}

tdbClearBtn.addEventListener('click', () => {
    currentTdb = null;
    currentTdbText = null;
    currentTdbEncoding = 'utf-8';
    if (tdbHandle) tdbHandle.free();
    tdbHandle = null;
    tdbInfo = null;
    tdbPhases = [];
    tdbCompounds = [];
    tdbParams = { _compound_offsets: {} };
    view = fittedView = null;
    extrapolatedShown = false;
    lastRaster = null;
    paramSliders.clear();
    paramLocks.clear();
    unlockedParams.clear();
    paramsBeforeFit = null;
    fitControls.classList.add('hidden');
    fitReview.classList.add('hidden');
    exportControls.classList.add('hidden');
    setExportStatus('');

    // Discard the worker's pending sweeps; the next load sweeps in the page.
    firstSweepForDatabase = true;
    sweepInFlight = null;
    sweepQueued = null;
    // The comparison was made against this database, as on a load.
    clearBaseline({ redraw: false });

    currentExampleId = null;
    currentCorpusId = null;
    pristineTemp = null;
    exampleSelect.value = '';
    exampleNote.textContent = '';
    setHeaderSystem(null);
    document.title = 'GibbScope';
    tempControl.classList.add('hidden');
    fidelityPanel.classList.add('hidden');
    tdbNotesPanel.classList.add('hidden');
    syncDatabaseSectionUi();
    tdbSliders.classList.add('hidden');
    slidersHeading.classList.add('hidden');
    resetBtn.classList.add('hidden');
    // With no database nothing is parked, so the list and its prompt change.
    expMirrorNote = '';
    rebuildExpPanel();
    update(); // with no database, this clears the canvases
});

// ------------------------------------------------ experimental data import --
//
// Accepts CSV/TSV with a header row, or JSON (an array of records, or
// `{"points": [...]}`). Required: x, T. Optional: kind, x_err, T_err, phase,
// weight, source. Header names are matched loosely, and `T (C)` or `T_C` is
// read as Celsius. The full schema is in About.

const HEADER_ALIASES = {
    x:      ['x', 'xb', 'x_b', 'comp', 'composition', 'mole_fraction', 'molefraction', 'at_fraction'],
    t:      ['t', 'temp', 'temperature'],
    kind:   ['kind', 'type', 'datatype'],
    x_err:  ['x_err', 'xerr', 'dx', 'sigma_x', 'x_sigma', 'x_unc'],
    t_err:  ['t_err', 'terr', 'dt', 'sigma_t', 't_sigma', 't_unc'],
    phase:  ['phase'],
    weight: ['weight', 'w'],
    source: ['source', 'ref', 'reference', 'dataset'],
};

const KIND_ALIASES = {
    boundary:     ['boundary', 'phase_boundary', 'liquidus', 'solidus', 'solvus'],
    tie_left:     ['tie_left', 'tieleft', 'left'],
    tie_right:    ['tie_right', 'tieright', 'right'],
    // Every name the reaction table prints (`Invariant.kind`).
    invariant:    ['invariant', 'eutectic', 'monotectic', 'metatectic', 'monotectoid',
                   'eutectoid', 'syntectic', 'peritectic', 'peritectoid',
                   'polymorphic', 'allotropic', 'other'],
    single_phase: ['single_phase', 'singlephase', 'single'],
};

const CELSIUS_UNITS = ['c', 'degc', '°c', 'celsius'];

function splitDelimitedRow(line, delim) {
    const out = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
            } else cur += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === delim) {
            out.push(cur); cur = '';
        } else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
}

function detectDelimiter(line) {
    return [',', '\t', ';']
        .map(d => [d, splitDelimitedRow(line, d).length])
        .sort((a, b) => b[1] - a[1])[0][0];
}

const AT_UNITS = ['at%', 'at', '%', 'atpct'];
const WT_UNITS = ['wt%', 'wt', 'wtpct', 'mass%'];

/// 'at', 'wt', or '' for mole fraction (and for any unit not recognised).
function compositionUnit(raw) {
    const u = (raw || '').toLowerCase().replace(/[\s.]/g, '');
    return AT_UNITS.includes(u) ? 'at' : WT_UNITS.includes(u) ? 'wt' : '';
}

// "T (K)" -> {field:'t', unit:'k'};  "x_err" -> {field:'x_err', unit:''};
// "x(Ag) (at%)" -> {field:'x', unit:'at%', element:'ag'}
function classifyHeader(raw) {
    const bracket = /[([]\s*([^)\]]*)\s*[)\]]\s*$/;
    let name = raw.trim().toLowerCase();
    let unit = '';
    const paren = name.match(bracket);
    if (paren) { unit = paren[1].trim(); name = name.slice(0, paren.index).trim(); }
    // A second bracket, left on the name, is the element: `x(Ag) (at%)`.
    let element = '';
    const inner = name.match(bracket);
    if (inner) { element = inner[1].trim(); name = name.slice(0, inner.index).trim(); }
    name = name.replace(/[\s\-.]+/g, '_').replace(/_+$/, '');
    const suffix = name.match(/_(k|c|degc)$/);
    if (suffix && !unit) { unit = suffix[1]; name = name.slice(0, suffix.index); }

    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (!aliases.includes(name)) continue;
        if (field !== 'x') return { field, unit, element: '' };
        // On x, a lone bracket naming an element is the element, not a unit
        // (`x(Ag)`).
        if (!element && !compositionUnit(unit) && bySymbol.has(unit.toUpperCase())) {
            element = unit;
            unit = '';
        }
        return { field, unit, element };
    }
    return { field: null, unit, element: '' };
}

/// Reads a file's x header: the unit of x and of x_err, and whether x is the
/// fraction of the database's first element and must be mirrored. Throws for
/// an element the database does not have.
function compositionReader(unitOf, element) {
    const unit = compositionUnit(unitOf.x);
    const reader = {
        unit,
        // x_err in its own unit when its header states one, else in x's.
        errUnit: compositionUnit(unitOf.x_err) || unit,
        mirror: false,
        label: '',
    };
    const el = (element || '').toUpperCase();
    if (!el) return reader;
    reader.label = `x(${symbolOf(el)})`;
    if (!tdbInfo) {
        throw new Error(`a column headed ${reader.label} is read against the database — `
                      + 'load the .tdb first, then this file');
    }
    const pair = pairOf(tdbInfo);
    if (el === pair[0]) {
        reader.mirror = true;
    } else if (el !== pair[1]) {
        throw new Error(`${reader.label}: ${symbolOf(el)} is not an element of this `
                      + `database (${pairName(pair)})`);
    }
    return reader;
}

/// The note a file gets for having been mirrored.
function mirroredNote(reader) {
    const pair = pairOf(tdbInfo).map(symbolOf);
    return `${reader.label} is the fraction of ${pair[0]}, the database's first element: `
         + `mirrored onto x(${pair[1]}) = 1 \u2212 ${reader.label}`;
}

function normalizeKind(raw) {
    const k = String(raw ?? '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
    if (!k) return 'boundary';
    for (const [kind, aliases] of Object.entries(KIND_ALIASES)) {
        if (aliases.includes(k)) return kind;
    }
    return null;
}

function stripComments(text) {
    return text.replace(/^﻿/, '').split(/\r?\n/)
        .map(line => ({ line, trimmed: line.trim() }))
        .filter(l => l.trimmed !== '' && !l.trimmed.startsWith('#') && !l.trimmed.startsWith('$'));
}

// Turns one parsed record into a point, or throws with a readable reason.
// `reader` is `compositionReader`'s answer for the record's header.
function recordToPoint(rec, unitOf, fallbackSource, reader) {
    const num = (v) => {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
    };

    let x = num(rec.x);
    if (x === null) throw new Error('missing x');
    if (Number.isNaN(x)) throw new Error(`x is not a number ("${rec.x}")`);

    // at% and wt% become mole fraction here, the only unit the rest of the app
    // uses. The conversion is for the column's own element, and mirroring
    // comes after. Returns that element's mass, then the other's.
    const masses = () => {
        const m = elementMasses();
        if (!m) {
            throw new Error('weight percent needs atomic masses — load the .tdb first, '
                          + 'then this file');
        }
        return reader.mirror ? [m[0], m[1]] : [m[1], m[0]];
    };
    if (reader.unit === 'at') {
        x /= 100;
    } else if (reader.unit === 'wt') {
        const [mn, mo] = masses();
        const w = x / 100;
        x = (w * mo) / (w * mo + (1 - w) * mn);
    }

    if (x < 0 || x > 1) {
        throw new Error(`x = ${x} is outside 0..1 (use a mole fraction, or head the `
                      + `column "x (at%)" / "x (wt%)")`);
    }

    let t = num(rec.t);
    if (t === null) throw new Error('missing T');
    if (Number.isNaN(t)) throw new Error(`T is not a number ("${rec.t}")`);
    if (CELSIUS_UNITS.includes((unitOf.t || '').toLowerCase())) t += 273.15;
    if (t <= 0) throw new Error(`T = ${t} K must be positive (is the column in Celsius?)`);

    let kind = normalizeKind(rec.kind);
    if (kind === null) {
        throw new Error(`unknown kind "${rec.kind}" (expected one of ${EXP_KINDS.join(', ')})`);
    }

    const optional = (v, label) => {
        const n = num(v);
        if (n === null) return 0;
        if (Number.isNaN(n) || n < 0) throw new Error(`${label} must be a non-negative number`);
        return n;
    };

    // T_err needs no unit handling: a Celsius interval is already a kelvin
    // interval.
    const weightRaw = num(rec.weight);
    if (weightRaw !== null && (Number.isNaN(weightRaw) || weightRaw < 0)) {
        throw new Error('weight must be a non-negative number');
    }

    // x_err to mole fraction: at% over 100, wt% through dx/dw at the point.
    let xErr = optional(rec.x_err, 'x_err');
    if (reader.errUnit === 'at') {
        xErr /= 100;
    } else if (reader.errUnit === 'wt' && xErr > 0) {
        const [mn, mo] = masses();
        const w = x * mn / (x * mn + (1 - x) * mo);
        xErr *= (mn * mo / (w * mo + (1 - w) * mn) ** 2) / 100;
    }

    if (reader.mirror) {
        x = 1 - x;
        kind = kind === 'tie_left' ? 'tie_right' : kind === 'tie_right' ? 'tie_left' : kind;
    }

    return {
        x, t, kind,
        x_err: xErr,
        t_err: optional(rec.t_err, 'T_err'),
        phase: (rec.phase ?? '').toString().trim(),
        weight: weightRaw === null ? 1 : weightRaw,
        source: (rec.source ?? '').toString().trim() || fallbackSource,
    };
}

/// The phases that abbreviated names in a `.POP` or ESPEI file may resolve to:
/// those the engine draws, not every phase declared. A rejected phase could
/// make an abbreviation ambiguous (Cr-Ni's FCC_4SL against `FCC`).
function modelledPhases() {
    return (tdbInfo?.phase_support || [])
        .filter((s) => s.status !== 'rejected' && s.status !== 'unsupported')
        .map((s) => s.phase);
}

function parseExperimentalText(text, fileName) {
    // Thermo-Calc's PARROT input, recognised by content, not by extension.
    if (looksLikePop(text)) {
        if (!tdbInfo) {
            throw new Error('a .pop is read against the database — load the .tdb first, '
                          + 'then this file. Its compositions are named by element and '
                          + 'its phases by abbreviation, and both need the system to '
                          + 'resolve against');
        }
        return parsePop(text, {
            fileName,
            elements: tdbInfo.elements.slice(0, 2),
            phases: modelledPhases(),
        });
    }

    const fallbackSource = fileName.replace(/\.[^.]+$/, '');
    const trimmed = text.replace(/^﻿/, '').trim();
    const points = [], errors = [];

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        let parsed;
        try { parsed = JSON.parse(trimmed); }
        catch (e) { throw new Error(`not valid JSON — ${e.message}`); }
        // An ESPEI dataset, recognised by its envelope rather than by
        // `output === 'ZPF'`, so `parseEspei` can refuse a non-ZPF dataset by
        // name.
        if (looksLikeEspei(parsed)) {
            if (!tdbInfo) {
                throw new Error('an ESPEI dataset is read against the database — load '
                              + 'the .tdb first, then this file. Its compositions are '
                              + 'named by component and its phases by name, and both '
                              + 'need the system to resolve against');
            }
            return parseEspei(parsed, {
                fileName,
                elements: tdbInfo.elements.slice(0, 2),
                phases: modelledPhases(),
            });
        }
        const records = Array.isArray(parsed) ? parsed : parsed.points;
        if (!Array.isArray(records)) {
            throw new Error('JSON must be an array of records, or {"points": [...]}');
        }
        // Each key is read as a header, with its unit and element ("x (at%)",
        // "x(Ag)").
        const mirrored = new Map();
        records.forEach((rec, i) => {
            const lower = {}, unitOf = {};
            let element = '';
            for (const [k, v] of Object.entries(rec)) {
                const c = classifyHeader(k);
                if (!c.field) continue;
                lower[c.field] = v;
                unitOf[c.field] = c.unit;
                if (c.field === 'x') element = c.element;
            }
            try {
                const reader = compositionReader(unitOf, element);
                points.push(recordToPoint(lower, unitOf, fallbackSource, reader));
                if (reader.mirror) mirrored.set(reader.label, reader);
            } catch (e) { errors.push(`record ${i + 1}: ${e.message}`); }
        });
        errors.unshift(...[...mirrored.values()].map(mirroredNote));
        return { points, errors };
    }

    const lines = stripComments(text);
    if (lines.length < 2) throw new Error('needs a header row and at least one data row');

    const delim = detectDelimiter(lines[0].line);
    const headers = splitDelimitedRow(lines[0].line, delim).map(classifyHeader);
    const unitOf = {};
    headers.forEach(h => { if (h.field) unitOf[h.field] = h.unit; });

    const fields = headers.map(h => h.field);
    if (!fields.includes('x') || !fields.includes('t')) {
        throw new Error(`header must name an x column and a T column (found: ${
            splitDelimitedRow(lines[0].line, delim).join(', ')})`);
    }
    // Once per file: an element the database lacks refuses the whole file.
    const reader = compositionReader(unitOf, headers.find((h) => h.field === 'x').element);

    lines.slice(1).forEach((l, i) => {
        const cells = splitDelimitedRow(l.line, delim);
        const rec = {};
        fields.forEach((f, c) => { if (f) rec[f] = cells[c]; });
        try { points.push(recordToPoint(rec, unitOf, fallbackSource, reader)); }
        catch (e) { errors.push(`row ${i + 2}: ${e.message}`); }
    });
    if (reader.mirror && points.length > 0) errors.unshift(mirroredNote(reader));

    return { points, errors };
}

// ------------------------------------------------------- experimental data --

const EXP_MARKER_R = 4.5;

/// Opacity of an experimental mark's body and error bars. Only the 1 px edge
/// is opaque, so overlapping points can still be counted.
const EXP_BODY_ALPHA = 0.55;

/// Datasets are keyed by an id, not by name, since files for two systems can
/// cite the same reference.
let expSourceSerial = 0;

function addExpSource(fields) {
    const src = { slot: expSources.size, visible: true, points: [], ...fields,
                  key: `src${++expSourceSerial}` };
    expSources.set(src.key, src);
    return src;
}

function addExperimentalPoints(points) {
    for (const p of points) {
        // A parked dataset with the same name does not take new points.
        let src = [...expSources.values()].find((s) => s.name === p.source && !expParked(s));
        if (!src) src = addExpSource({ name: p.source, pair: tdbInfo ? pairOf(tdbInfo) : null });
        src.points.push(p);
    }
}

/// Clears residuals when a dataset is parked or kept, so the next frame does
/// not colour points by another system's misfit.
function clearResiduals(src) {
    for (const p of src.points) p.residual = null;
}

function clearExpSources() {
    expSources.clear();
    expMirrorNote = '';
}

/// Whether a dataset was loaded for another element pair than the database on
/// screen. A parked dataset stays listed but is not drawn or scored until the
/// user keeps or removes it. With no database loaded nothing is parked.
function expParked(src) {
    if (!tdbInfo || !src.pair) return false;
    const here = pairOf(tdbInfo);
    return src.pair[0] !== here[0] || src.pair[1] !== here[1];
}

/// Whether a dataset is drawn and scored.
function expShown(src) {
    return src.visible && !expParked(src);
}

const pairName = (pair) => pair.map(symbolOf).join('\u2013');

/// Matches the datasets to a newly loaded database. A dataset loaded with no
/// database adopts this one; one loaded for the same pair in the other order
/// is mirrored, since x is the fraction of the database's second element. Any
/// other pair stays parked.
function reconcileExpSources() {
    const here = pairOf(tdbInfo);
    const mirrored = [];
    for (const src of expSources.values()) {
        if (!src.pair) {
            src.pair = here;
        } else if (src.pair[0] === here[1] && src.pair[1] === here[0]) {
            mirrored.push(pairName(src.pair));
            src.points = src.points.map((p) => ({
                ...p,
                x: 1 - p.x,
                kind: p.kind === 'tie_left' ? 'tie_right'
                    : p.kind === 'tie_right' ? 'tie_left' : p.kind,
                residual: null,
            }));
            src.pair = here;
        }
        if (expParked(src)) clearResiduals(src);
    }
    expMirrorNote = mirrored.length === 0 ? ''
        : `${plural(mirrored.length, 'dataset')} loaded for ${mirrored[0]} `
          + `${mirrored.length === 1 ? 'is' : 'are'} mirrored onto ${pairName(here)} `
          + '(x \u2192 1 \u2212 x).';
    rebuildExpPanel();
}

/// The line above the dataset list about parked or mirrored data.
function renderExpParked() {
    expParkedEl.replaceChildren();
    const parked = [...expSources.values()].filter(expParked);
    if (parked.length === 0 && !expMirrorNote) {
        expParkedEl.classList.add('hidden');
        return;
    }
    expParkedEl.classList.remove('hidden');
    if (parked.length === 0) {
        expParkedEl.textContent = expMirrorNote;
        return;
    }
    const systems = [...new Set(parked.map((src) => pairName(src.pair)))];
    const text = document.createElement('span');
    text.textContent = `${plural(parked.length, 'dataset')} `
        + `${parked.length === 1 ? 'was' : 'were'} loaded for ${systems.join(' and ')} \u2014 `;
    const act = (label, action, title, apply) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small ghost';
        b.dataset.action = action;
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', () => {
            apply();
            rebuildExpPanel();
            update();
            updateFitControls();
        });
        return b;
    };
    const here = pairOf(tdbInfo);
    expParkedEl.append(text,
        act('Remove', 'remove', 'Remove these datasets', () => {
            for (const src of parked) expSources.delete(src.key);
            [...expSources.values()].forEach((s, i) => { s.slot = i; });
        }),
        act('Keep', 'keep', `Draw and score them against ${pairName(here)}`, () => {
            for (const src of parked) {
                src.pair = here;
                clearResiduals(src);
            }
        }));
}

// Sessions and data files share a drop zone. A session is recognised by its
// parsed `format` field, since a data file might mention the name in its text.
function asSession(text) {
    if (!text.trimStart().startsWith('{')) return null;
    let obj;
    try {
        obj = JSON.parse(text);
    } catch {
        return null;   // malformed JSON is the point parser's problem to report
    }
    return obj && obj.format === SESSION_FORMAT ? obj : null;
}

async function loadExperimentalFiles(fileList) {
    const problems = [];
    let loaded = 0;

    for (const file of fileList) {
        try {
            // Decoded like a TDB: some data files are ISO-8859-1, and their
            // comments supply the source names in the legend.
            const { text } = decodeTdb(await file.arrayBuffer());
            // A session is JSON too, so it is routed before point parsing.
            const session = asSession(text);
            if (session) {
                await applySession(session, file.name);
                continue;
            }
            const { points, errors } = parseExperimentalText(text, file.name);
            if (points.length === 0 && errors.length === 0) {
                problems.push(`${file.name}: no data rows`);
                continue;
            }
            addExperimentalPoints(points);
            loaded += points.length;
            // Report what was left out, in each parser's own wording.
            errors.slice(0, 5).forEach(e => problems.push(`${file.name}, ${e}`));
            if (errors.length > 5) {
                problems.push(`${file.name}: …and ${errors.length - 5} more`);
            }
        } catch (e) {
            problems.push(`${file.name}: ${e.message}`);
        }
    }

    if (problems.length) {
        expError.textContent = problems.join(' · ');
        expError.classList.remove('hidden');
    } else {
        expError.classList.add('hidden');
    }
    if (loaded > 0) {
        // New points turn the Points switch on (never off), so a dropped file
        // always changes the figure.
        setShowExpPoints(true, { redraw: false });
        rebuildExpPanel();
        revealExpSection();
    }
    update();
    updateFitControls();
}

/// Opens the data section, never closes it. Every call follows a user action,
/// so no saved preference applies (unlike `gibbsUserChose`).
function revealExpSection() {
    if (expSection) expSection.open = true;
}

function setupExpDragAndDrop() {
    expDropZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'LABEL') expFileInput.click();
    });
    expFileInput.addEventListener('change', (e) => {
        if (e.target.files.length) loadExperimentalFiles([...e.target.files]);
        e.target.value = '';
    });
    expDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        expDropZone.classList.add('dragover');
    });
    ['dragleave', 'dragend'].forEach(evt => {
        expDropZone.addEventListener(evt, () => expDropZone.classList.remove('dragover'));
    });
    expDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        expDropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) loadExperimentalFiles([...e.dataTransfer.files]);
    });

    // Sets the button's label and accessible name from the current mode.
    setExpColourBy(expColourBy, { redraw: false });

    // One button that names its mode and switches to the other.
    expColourMode.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-colour]');
        if (!btn) return;
        setExpColourBy(btn.dataset.colour === 'source' ? 'residual' : 'source');
    });

    expClearBtn.addEventListener('click', () => {
        clearExpSources();
        expError.classList.add('hidden');
        rebuildExpPanel();
        update();
        updateFitControls();
    });
}

// What the marker fill shows. `setExpColourBy` is the only setter.
const COLOUR_BY_WORD = { source: 'Source', residual: 'Residual' };

function setExpColourBy(mode, { redraw = true } = {}) {
    if (!COLOUR_BY_WORD[mode]) return;
    const changed = mode !== expColourBy;
    expColourBy = mode;
    const btn = expColourMode?.querySelector('[data-colour]');
    if (btn) {
        btn.dataset.colour = mode;
        btn.textContent = `Color: ${COLOUR_BY_WORD[mode]}`;
        // aria-label, not aria-pressed, since it switches between two modes.
        btn.setAttribute('aria-label',
            `Color points by ${COLOUR_BY_WORD[mode].toLowerCase()} — click to color by `
            + `${COLOUR_BY_WORD[mode === 'source' ? 'residual' : 'source'].toLowerCase()}`);
    }
    rebuildExpPanel();
    if (changed && redraw) render(false);
}

// Draws one kind's marker into a small canvas, so the legend glyphs are the
// exact shapes used on the diagram.
function makeMarkerGlyph(kind, color) {
    const size = 14;
    const c = document.createElement('canvas');
    c.width = c.height = size * devicePixelRatio;
    c.style.width = c.style.height = `${size}px`;
    const ctx = c.getContext('2d');
    ctx.scale(devicePixelRatio, devicePixelRatio);
    markerPath(ctx, kind, size / 2, size / 2, EXP_MARKER_R);
    ctx.fillStyle = color;
    ctx.fill();
    return c;
}

function rebuildExpPanel() {
    expTableBody.replaceChildren();
    expLegend.replaceChildren();

    // The summary line, visible while the section is closed: the misfit is
    // about these points, so their count stays in view.
    const brief = document.getElementById('exp-brief');
    const points = [...expSources.values()].reduce((n, s) => n + s.points.length, 0);
    const parked = [...expSources.values()].filter(expParked).length;
    if (brief) {
        brief.textContent = expSources.size === 0 ? ''
            : `${points} pts \u00b7 ${plural(expSources.size, 'source')}`
              + (parked ? ` \u00b7 ${parked} set aside` : '');
    }
    renderExpParked();

    // Colour and Points are shown only while unparked data is on the figure.
    const onFigure = expSources.size - parked;
    if (expColourMode) expColourMode.classList.toggle('hidden', onFigure === 0);
    if (pointsToggle) pointsToggle.classList.toggle('hidden', onFigure === 0);

    if (expSources.size === 0) {
        expPanel.classList.add('hidden');
        expDropZone.classList.remove('hidden');
        return;
    }
    expPanel.classList.remove('hidden');

    for (const src of expSources.values()) {
        const tr = document.createElement('tr');
        const isParked = expParked(src);
        tr.classList.toggle('hidden-source', !src.visible || isParked);
        tr.classList.toggle('parked-source', isParked);

        const tdToggle = document.createElement('td');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = src.visible;
        cb.disabled = isParked;
        cb.title = isParked ? `Loaded for ${pairName(src.pair)}: keep or remove it above`
            : `Show or hide ${src.name}`;
        cb.addEventListener('change', () => {
            src.visible = cb.checked;
            tr.classList.toggle('hidden-source', !src.visible || expParked(src));
            update();
            updateFitControls();
        });
        tdToggle.appendChild(cb);

        const tdName = document.createElement('td');
        tdName.className = 'exp-name';
        tdName.textContent = src.name;
        tdName.title = src.name;

        const tdCount = document.createElement('td');
        tdCount.className = 'exp-count';
        tdCount.textContent = `${src.points.length} pts`;

        const tdRemove = document.createElement('td');
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'exp-remove';
        rm.textContent = '✕';
        rm.title = `Remove ${src.name}`;
        // Without a label a screen reader would read "✕" on every row.
        rm.setAttribute('aria-label', `Remove ${src.name}`);
        rm.addEventListener('click', () => {
            expSources.delete(src.key);
            // Renumber the colour slots in the remaining order.
            [...expSources.values()].forEach((s, i) => { s.slot = i; });
            rebuildExpPanel();
            update();
            updateFitControls();
        });
        tdRemove.appendChild(rm);

        tr.append(tdToggle, tdName, tdCount, tdRemove);
        expTableBody.appendChild(tr);
    }

    // Legend: one entry per kind actually present, shape carrying the kind.
    const present = new Set();
    for (const src of expSources.values()) src.points.forEach(p => present.add(p.kind));
    EXP_KINDS.filter(k => present.has(k)).forEach(kind => {
        const item = document.createElement('span');
        item.className = 'exp-legend-item';
        item.appendChild(makeMarkerGlyph(kind, palette.textDim));
        item.appendChild(document.createTextNode(EXP_KIND_LABEL[kind]));
        expLegend.appendChild(item);
    });

    if (expColourBy === 'residual') {
        const scale = document.createElement('div');
        scale.className = 'residual-scale';
        const lo = document.createElement('span');
        lo.textContent = `model \u2212${RESIDUAL_CLAMP}\u03c3`;
        const bar = document.createElement('span');
        bar.className = 'residual-scale-bar';
        // The same three colours `residualColor` uses for the marks.
        bar.style.background = `linear-gradient(to right, ${palette.residualLow}, `
            + `${palette.residualMid}, ${palette.residualHigh})`;
        const hi = document.createElement('span');
        hi.textContent = `+${RESIDUAL_CLAMP}\u03c3`;
        scale.append(lo, bar, hi);
        expLegend.appendChild(scale);

        const note = document.createElement('div');
        note.className = 'exp-note';
        note.textContent =
            'Markers show the signed residual. '
            + 'Red means the model sits above the point, blue below.';
        expLegend.appendChild(note);
    } else if (expSources.size > palette.exp.length) {
        const note = document.createElement('div');
        note.className = 'exp-note';
        note.textContent =
            `Only the first ${palette.exp.length} sources get a distinct color; `
            + 'the rest share one gray. Use the checkboxes to isolate one.';
        expLegend.appendChild(note);
    }
}

// --------------------------------------------------------------------- fit --
//
// Unlock parameters, minimise the misfit, then accept or revert.

// Parameter key -> the slider that shows it. Populated by buildTdbSliders.
const paramSliders = new Map();
// Keys the optimizer is allowed to move.
const unlockedParams = new Set();
// Key -> its lock checkbox, so a restored session can tick the right boxes.
const paramLocks = new Map();
// Parameter state captured before a fit, so Revert is exact.
let paramsBeforeFit = null;

const FIT_MAX_EVALUATIONS = 160;
// Temperature steps of each sweep during a fit; each evaluation is a full
// sweep, so this sets the cost. It can be coarser than the display, since
// invariants come from bisection, but must still separate invariants about
// 25 K apart.
const FIT_T_STEPS = 60;

/// The half-width and step of a parameter's track, from the assessed
/// coefficient. The track is also the fit's search range (`fitBounds`): a
/// quarter of |A|, never less than ±5000. The step is the {1, 2, 5}×10ⁿ value
/// at or above a hundredth of the span, and the span is rounded up to a whole
/// number of steps so stepping reaches its ends.
function paramTrack(assessed) {
    const want = Math.max(5000, 0.25 * Math.abs(assessed || 0));
    const target = want / 100;
    const base = Math.pow(10, Math.floor(Math.log10(target)));
    const step = [1, 2, 5].map((m) => m * base).find((v) => v >= target) || 10 * base;
    return { span: Math.ceil(want / step) * step, step };
}

/// The row's track range, which is also the fit's search range. The assessed
/// coefficient goes in the tooltip, for lack of room in the row.
function rowRangeNote(span, step, assessed) {
    const note = document.createElement('span');
    note.className = 'lparam-range';
    note.textContent = `\u00b1${span}`;
    note.title = `This track runs -${span} to ${span} in steps of ${step}, `
        + 'and a fit of this parameter is bounded by the same range.'
        + (assessed === undefined ? ''
            : ` The assessed value it is centered on is ${assessed.toFixed(1)}.`);
    return note;
}

/// The unit, shown once in the group header since it is the same for every row.
function groupUnitNote(unit) {
    const note = document.createElement('span');
    note.className = 'phase-group-unit';
    note.textContent = unit;
    return note;
}

/// One parameter row: label, range and value box on the first line, the track
/// and the fit tick on the second.
function makeParamRow({ ident, name, input, control, key, range }) {
    const row = document.createElement('div');
    row.className = 'lparam-row';

    const top = document.createElement('div');
    top.className = 'lparam-top';
    const id = document.createElement('span');
    id.className = 'lparam-ident';
    // `innerHTML` only for the `L` order, which is a number. The label is
    // `Δ L₀` because the box shows the displacement from the assessed value;
    // with L = A + B·T and B fixed, ΔL₀ = ΔA at every T.
    const parts = [id];
    if (ident.sub !== undefined) {
        id.innerHTML = `\u0394 L<sub>${Number(ident.sub)}</sub>`;
        id.classList.add('lparam-title');
    } else {
        // A compound shows its formula and then the quantity, `Δ G`.
        id.textContent = ident.text;
        const nm = document.createElement('span');
        nm.className = 'param-name lparam-title';
        nm.textContent = `\u0394 ${name}`;
        parts.push(nm);
    }

    top.append(...parts, rowRangeNote(range.span, range.step, range.assessed), control);

    const bot = document.createElement('div');
    bot.className = 'lparam-bot';
    // Wrapped so the wrapper can draw a centre tick: a range input has no
    // pseudo-elements, and a background would be clipped to the 4 px bar.
    const track = document.createElement('span');
    track.className = 'lparam-track';
    track.appendChild(input);
    bot.append(track, makeLockToggle(key));

    row.append(top, bot);
    return row;
}

function makeLockToggle(key) {
    const wrap = document.createElement('label');
    wrap.className = 'param-lock';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.addEventListener('change', () => {
        if (cb.checked) unlockedParams.add(key); else unlockedParams.delete(key);
        updateFitControls();
    });
    paramLocks.set(key, cb);
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode('fit'));
    return wrap;
}

function updateFitControls() {
    if (!currentTdb) {
        fitControls.classList.add('hidden');
        return;
    }
    fitControls.classList.remove('hidden');

    const nPoints = expPointOrder.length;
    const nKeys = unlockedParams.size;
    fitBtn.disabled = nKeys === 0 || nPoints === 0;

    fitStatus.classList.remove('fit-error');
    const parked = [...expSources.values()].filter(expParked);
    if (nPoints === 0 && parked.length > 0) {
        const systems = [...new Set(parked.map((src) => pairName(src.pair)))];
        const one = parked.length === 1;
        fitStatus.textContent = `${plural(parked.length, 'dataset')} ${one ? 'is' : 'are'} `
            + `set aside for ${systems.join(' and ')}. Keep ${one ? 'it' : 'them'} to fit `
            + `against ${pairName(pairOf(tdbInfo))}.`;
    } else if (nPoints === 0) {
        fitStatus.textContent = 'Load experimental data to enable fitting.';
    } else if (nKeys === 0) {
        fitStatus.textContent = 'Tick "fit" beside the parameters to be optimized.';
    } else {
        fitStatus.textContent =
            `${nKeys} parameter${nKeys === 1 ? '' : 's'} unlocked, ${nPoints} points.`;
    }
}

function applyFitParams(params) {
    tdbParams = params;
    if (!tdbParams._compound_offsets) tdbParams._compound_offsets = {};
    // Move every slider with a matching key, so the panel and the model agree.
    for (const [key, slider] of paramSliders) {
        const absolute = readParamFromState(key);
        if (absolute === null) continue;
        slider.show(slider.toValue(absolute));
    }
}

// The fit's bounds, in absolute units, for each unlocked key: the slider's own
// min and max. A range input silently clamps a value outside them, so a fit
// past the slider would leave the panel and `tdbParams` disagreeing.
function fitBounds() {
    const bounds = {};
    for (const key of unlockedParams) {
        const slider = paramSliders.get(key);
        if (!slider || typeof slider.toAbsolute !== 'function') continue;
        const lo = slider.toAbsolute(Number(slider.input.min));
        const hi = slider.toAbsolute(Number(slider.input.max));
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) bounds[key] = [lo, hi];
    }
    return bounds;
}

function readParamFromState(key) {
    if (key.startsWith('_compound:')) {
        const name = key.slice('_compound:'.length);
        const v = tdbParams._compound_offsets?.[name];
        return typeof v === 'number' ? v : null;
    }
    const [phase, order] = key.split(':');
    const v = tdbParams[phase]?.[Number(order)]?.a;
    return typeof v === 'number' ? v : null;
}

function describeFit(result, elapsedMs) {
    fitReviewText.replaceChildren();
    const summary = document.createElement('div');
    summary.textContent =
        `Misfit ${result.objective_before.toFixed(2)} → ${result.objective_after.toFixed(2)} σ `
        + `in ${result.evaluations} evaluations, ${(elapsedMs / 1000).toFixed(1)} s`
        + (result.converged ? '' : ' (hit the evaluation cap)');
    fitReviewText.appendChild(summary);

    for (const c of result.changed) {
        const row = document.createElement('div');
        const key = document.createElement('span');
        key.className = 'fit-key';
        key.textContent = `${c.key}: `;
        row.appendChild(key);
        row.appendChild(document.createTextNode(
            `${c.before.toFixed(1)} → ${c.after.toFixed(1)}`));
        // The value is the edge of the search range, not a minimum.
        if (c.at_bound) {
            const flag = document.createElement('span');
            flag.className = 'fit-warn';
            flag.textContent = ' at limit';
            flag.title = 'The optimizer stopped against the end of this slider\'s range. '
                + 'The data wants a value outside it, so treat this as a bound rather '
                + 'than a best fit.';
            row.appendChild(flag);
        }
        fitReviewText.appendChild(row);
    }
    for (const w of result.warnings) {
        const row = document.createElement('div');
        row.className = 'fit-key';
        row.textContent = w;
        fitReviewText.appendChild(row);
    }
}

// -------------------------------------------------------------- fit worker --
//
// The optimiser is one synchronous WASM call, so it runs in a worker and the
// page stays usable. The worker is created on first use and kept, since it
// holds its own WASM instance and parsed database, and is discarded on a trap
// or a cancel.

let fitWorker = null;
let nextFitId = 1;
const pendingFits = new Map();

/// Terminating is the only way to stop a fit, which is one synchronous WASM
/// call. The next fit then re-parses the database in a new worker.
function disposeFitWorker(why) {
    if (fitWorker) fitWorker.terminate();
    fitWorker = null;
    // Reject whatever is still pending, with the reason.
    const pending = [...pendingFits.values()];
    pendingFits.clear();
    for (const p of pending) p.reject(new Error(why));
}

function getFitWorker() {
    if (fitWorker) return fitWorker;
    const worker = new Worker(new URL('./fit-worker.js', import.meta.url),
                              { type: 'module' });
    worker.onmessage = (e) => {
        const pending = pendingFits.get(e.data.id);
        if (!pending) return;
        pendingFits.delete(e.data.id);
        if (e.data.type === 'result') pending.resolve(e.data.json);
        else pending.reject(new Error(e.data.message || 'the fit failed'));
    };
    // A Rust panic in the worker is a trap that bypasses its try/catch and
    // kills the instance. Drop the worker so the next fit builds a new one.
    worker.onerror = (e) => {
        disposeFitWorker(e.message || 'the fit worker crashed');
    };
    fitWorker = worker;
    return worker;
}

function fitInWorker(worker, payload) {
    return new Promise((resolve, reject) => {
        const id = nextFitId++;
        pendingFits.set(id, { resolve, reject });
        worker.postMessage({ type: 'fit', id, ...payload });
    });
}

/// Set while a cancel is in flight, so the rejection that follows gets a plain
/// status line rather than the red error one.
let fitCancelled = false;

function cancelFit() {
    if (pendingFits.size === 0) return;
    fitCancelled = true;
    disposeFitWorker('canceled');
}

/// Locks the parameter panel while a fit runs, since the result would
/// overwrite a slider moved meanwhile. `inert` also blocks keyboard access.
function setFitRunning(running) {
    fitBtn.disabled = running;
    tdbSliders.inert = running;
    tdbSliders.classList.toggle('fitting', running);
    fitCancelBtn.classList.toggle('hidden', !running);
}

/// `updateFitControls` rewrites the status line and clears `fit-error`, so it
/// is called first and the message is written after it.
function showFitError(message) {
    setFitRunning(false);
    fitBtn.textContent = 'Fit unlocked parameters';
    updateFitControls();
    fitStatus.classList.add('fit-error');
    fitStatus.textContent = message;
}

async function runFit() {
    if (!currentTdb || unlockedParams.size === 0) return;
    const expJson = visibleExpPointsJson();
    if (expJson === '') return;

    fitCancelled = false;
    setFitRunning(true);
    fitBtn.textContent = 'Fitting…';
    fitStatus.classList.remove('fit-error');
    fitReview.classList.add('hidden');

    const startedAt = performance.now();

    // Nelder-Mead cannot report progress, so the status shows elapsed time,
    // which also shows that the page is not frozen.
    let ticker = null;
    const showElapsed = () => {
        const s = ((performance.now() - startedAt) / 1000).toFixed(1);
        fitStatus.textContent =
            `Running Nelder–Mead in a worker — ${s} s. The page stays usable.`;
    };
    showElapsed();

    // No view window: the fit sweeps the range the engine chose from the
    // database and the data, so zooming cannot change what is optimised.
    const payload = {
        paramsJson: JSON.stringify(tdbParams),
        expJson,
        keysJson: JSON.stringify([...unlockedParams]),
        maxEvaluations: FIT_MAX_EVALUATIONS,
        nTSteps: FIT_T_STEPS,
        tTolerance: BOUNDARY_T_TOLERANCE,
        boundsJson: JSON.stringify(fitBounds()),
    };

    let result;
    try {
        ticker = setInterval(showElapsed, 100);
        result = JSON.parse(await fitInWorker(getFitWorker(), {
            ...payload, tdbText: currentTdbText, tdbKey,
        }));
    } catch (e) {
        if (fitCancelled) {
            setFitRunning(false);
            fitBtn.textContent = 'Fit unlocked parameters';
            updateFitControls();
            fitStatus.textContent =
                `Fit canceled after ${((performance.now() - startedAt) / 1000).toFixed(1)} s. `
                + 'Parameters unchanged.';
        } else {
            showFitError(`Fit failed: ${e.message}`);
        }
        return;
    } finally {
        if (ticker !== null) clearInterval(ticker);
    }

    fitBtn.textContent = 'Fit unlocked parameters';
    setFitRunning(false);

    if (!result.ok) {
        showFitError(result.message || 'Fit failed.');
        return;
    }
    if (result.changed.length === 0) {
        fitStatus.textContent = result.message || 'No improvement found.';
        updateFitControls();
        return;
    }

    paramsBeforeFit = structuredClone(tdbParams);
    applyFitParams(result.params);
    describeFit(result, performance.now() - startedAt);
    fitReview.classList.remove('hidden');
    fitStatus.textContent = '';
    update();
}

function setupFitControls() {
    fitBtn.addEventListener('click', runFit);
    fitCancelBtn.addEventListener('click', cancelFit);

    fitAcceptBtn.addEventListener('click', () => {
        paramsBeforeFit = null;
        fitReview.classList.add('hidden');
        updateFitControls();
    });

    fitRevertBtn.addEventListener('click', () => {
        if (paramsBeforeFit) applyFitParams(structuredClone(paramsBeforeFit));
        paramsBeforeFit = null;
        fitReview.classList.add('hidden');
        updateFitControls();
        update();
    });
}

// ------------------------------------------------------------------ export --
//
// The modified database, the figure, and session save and load.

const SESSION_FORMAT = 'calphad-viz-session';
const SESSION_VERSION = 1;
// Figures are exported at this multiple of the on-screen size. The raster is
// upscaled nearest-neighbour, so each computed cell stays a visible square.
const FIGURE_SCALE = 3;

function downloadFile(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function setExportStatus(text, isError = false) {
    exportStatus.textContent = text;
    exportStatus.classList.toggle('export-error', isError);
}

function baseName(name) {
    return (name || 'system').replace(/\.[^.]+$/, '');
}

/// Phases drawn with some of the database's terms left out. Nothing on the
/// diagram itself shows this.
function approximatedPhases() {
    return (tdbInfo?.phase_support || [])
        .filter(s => s.status === 'approximated')
        .map(s => s.phase);
}

const FIDELITY_ORDER = { approximated: 0, unsupported: 1, rejected: 2, computed: 3 };

/// Lists what became of every phase the database declares, those with
/// physics dropped first, since the diagram does not reveal them.
function renderFidelityPanel() {
    const support = tdbInfo?.phase_support || [];
    fidelityPanel.classList.toggle('hidden', support.length === 0);
    if (!support.length) return;

    const counts = support.reduce((acc, s) => (acc[s.status] = (acc[s.status] || 0) + 1, acc), {});
    const approx = counts.approximated || 0;
    const unsupported = counts.unsupported || 0;
    const rejected = counts.rejected || 0;

    fidelityPanel.classList.toggle('has-approx', approx > 0);
    // The panel stays closed; its summary line states the grade either way.

    const parts = [];
    if (approx) parts.push(`${approx} with physics dropped`);
    if (unsupported) parts.push(`${unsupported} missing`);
    // Phases on the database's own `REJECT_PHASE` list are worded as its
    // choice, not an engine shortfall, and alone they add "the rest modelled
    // in full" so they do not read as a defect.
    if (rejected) {
        parts.push(`${rejected} rejected by the database`
            + (parts.length ? '' : ', the rest modeled in full'));
    }
    const headline = parts.length
        ? `Model fidelity — ${parts.join(', ')}`
        : 'Model fidelity — all phases modeled in full';

    // The headline split into the status block's name and brief.
    // `.has-approx` colours both amber.
    fidelitySummary.replaceChildren();
    const fidName = document.createElement('span');
    fidName.className = 'status-name';
    fidName.textContent = 'Model fidelity';
    const fidBrief = document.createElement('span');
    fidBrief.className = 'status-brief';
    fidBrief.textContent = headline.replace(/^Model fidelity — /, '');
    fidelitySummary.append(fidName, fidBrief);

    fidelityTableBody.replaceChildren();
    const rows = [...support].sort((a, b) =>
        (FIDELITY_ORDER[a.status] ?? 9) - (FIDELITY_ORDER[b.status] ?? 9));
    for (const s of rows) {
        const tr = document.createElement('tr');
        tr.className = `fid-${s.status}`;
        const name = document.createElement('td');
        name.className = 'fid-phase';
        name.textContent = s.phase;
        const detail = document.createElement('td');
        detail.className = 'fid-detail';
        // `detail` begins with the phase name, already in the first column.
        detail.textContent = s.detail.replace(new RegExp(`^${s.phase}:\\s*`), '');
        tr.append(name, detail);
        fidelityTableBody.appendChild(tr);
    }

    fidelityFoot.replaceChildren();
    const foot = document.createElement('div');
    foot.textContent = approx
        ? 'A phase with physics dropped is still drawn, so the diagram looks complete '
          + 'where it is not exact. Treat boundaries involving these phases as indicative.'
        : unsupported
            ? 'Missing phases are left off the diagram entirely, so the fields that '
              + 'depend on them are absent rather than wrong.'
            : rejected
                ? 'Every phase this database asks for is modeled with all the terms '
                  + 'it specifies. The rest are struck out by the database\u2019s own '
                  + 'REJECT_PHASE list, so they are the assessment\u2019s omission and '
                  + 'not this engine\u2019s.'
                : 'Every phase this database declares is modeled with all the terms it specifies.';
    fidelityFoot.appendChild(foot);

    // `info().warnings`: notices that are not about one phase, such as extra
    // elements or extrapolation.
    for (const w of tdbInfo?.warnings || []) {
        const row = document.createElement('div');
        row.className = 'fid-warning';
        row.textContent = w;
        fidelityFoot.appendChild(row);
    }
}

// ---------------------------------------------------------- database notes --
//
// The TDB's own `$` comment lines, which carry the reference (the CC BY
// attribution) and the assessor's caveats. Shown verbatim; only the leading
// `$`, separator rules and blank comment lines become layout.

/// Separator rules.
const NOTES_RULE = /^[-=_*+~ ]{4,}$/;

/// Splits the `$` comment lines of a TDB into blocks, in file order. A block
/// ends at an empty comment line, a rule, or a line of database content. Also
/// returns the total `$` line count.
function extractTdbNotes(text) {
    const blocks = [];
    let block = null;
    let total = 0;
    const flush = () => {
        if (block) blocks.push(block);
        block = null;
    };

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimStart();
        // Only whole-line comments; trailing `$` comments are not read.
        if (!line.startsWith('$')) { flush(); continue; }
        total += 1;
        // Drop the `$` and at most one space; further indentation is kept.
        const body = line.slice(1).replace(/^ /, '').trimEnd();
        if (body === '' || NOTES_RULE.test(body.trim())) { flush(); continue; }
        if (!block) block = { lines: [] };
        block.lines.push(body);
    }
    flush();
    return { blocks, total };
}

/// Renders the notes panel, or hides it when the database has no comments.
function renderTdbNotes(text, fileName) {
    const { blocks, total } = text ? extractTdbNotes(text) : { blocks: [], total: 0 };
    tdbNotesPanel.classList.toggle('hidden', blocks.length === 0);
    if (!blocks.length) return;

    // In the Hallstedt corpus the first comment line is the reference, so the
    // summary shows the attribution with the panel closed.
    tdbNotesSummary.replaceChildren();
    const dbName = document.createElement('span');
    dbName.className = 'status-name';
    dbName.textContent = 'Database';
    const head = document.createElement('span');
    head.className = 'status-brief';
    head.textContent = blocks[0].lines[0];
    tdbNotesSummary.append(dbName, head);

    tdbNotesBody.replaceChildren();
    for (const b of blocks) {
        const el = document.createElement('div');
        el.className = 'tdb-note';
        el.textContent = b.lines.join('\n');
        tdbNotesBody.appendChild(el);
    }

    const lines = blocks.reduce((n, b) => n + b.lines.length, 0);
    tdbNotesFoot.textContent =
        `${lines} of the ${total} comment lines in ${fileName}, verbatim and in file order — `
        + 'the rest are blank lines and rules. The wording is the assessment’s, not this '
        + 'tool’s.';
}

// Sets the short line in a status block's summary, shown while it is closed.
// Call it from the function that builds the block's body, with the same
// values, so the two cannot disagree.
function setStatusBrief(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function rebuildPhaseLegend() {
    phaseLegend.replaceChildren();
    if (!tdbInfo) {
        setStatusBrief('phase-legend-brief', '');
        return;
    }
    const approx = new Set(approximatedPhases());
    // Counted from the same lists the swatches are built from.
    const drawn = tdbInfo.phase_names.length;
    const flagged = tdbInfo.phase_names.filter((n) => approx.has(n)).length;
    setStatusBrief('phase-legend-brief',
        plural(drawn, 'phase') + (flagged ? `, ${flagged} with physics dropped` : ''));
    tdbInfo.phase_names.forEach((name, i) => {
        const sw = document.createElement('span');
        sw.className = 'ci';
        sw.style.background = phaseColor(i);
        const label = document.createElement('span');
        label.className = 'ci-label';
        label.textContent = name;
        // Phases with physics dropped are marked here too, next to the diagram.
        if (approx.has(name)) {
            const mark = document.createElement('span');
            mark.className = 'legend-approx';
            mark.textContent = '†';
            mark.title = `${name} is drawn with physics from the database left out`;
            label.append(mark);
        }
        // Past the eighth phase the hues repeat at another lightness; the
        // legend marks each reused colour.
        if (phaseColorIsReused(i)) {
            const mark = document.createElement('span');
            mark.className = 'legend-note';
            mark.textContent = '↺';
            mark.title = `${name} reuses the color of `
                + `${tdbInfo.phase_names[i % PHASE_SERIES_LEN]} at a different `
                + `lightness — the series has ${PHASE_SERIES_LEN} distinct hues`;
            label.append(mark);
        }
        phaseLegend.append(sw, label);
    });

    if (approx.size) {
        const dagger = document.createElement('span');
        dagger.className = 'legend-note';
        dagger.append(Object.assign(document.createElement('span'),
            { className: 'legend-approx', textContent: '†' }));
        dagger.append(document.createTextNode(' physics dropped — see model fidelity'));
        phaseLegend.appendChild(dagger);
    }

    // Keys for the fill scheme, each on its own line and only when that fill is
    // on screen. They have no swatch: any colour shown would name one phase.
    const scheme = coexScheme(lastRaster && lastRaster.cells);
    if (scheme.textured) {
        const dotted = document.createElement('span');
        dotted.className = 'legend-note';
        dotted.textContent = 'a washed field with dots = two phases coexist, '
            + 'in their own two colors';
        phaseLegend.appendChild(dotted);
    }
    // A wash without dots is only a miscibility gap, since every field of
    // two different phases is dotted.
    if (scheme.gap) {
        const note = document.createElement('span');
        note.className = 'legend-note';
        note.textContent = 'a wash with no dots = one phase coexisting with itself (a miscibility gap)';
        phaseLegend.appendChild(note);
    }

    // Only while ghost curves are drawn, whatever their source (perturbed
    // parameters or a comparison database). `showBaseline` rebuilds the legend
    // when they appear or go.
    if (baselineBoundaries) {
        const ghost = document.createElement('span');
        ghost.className = 'legend-note';
        // The ghost is the only hueless curve, so "grey" identifies it.
        const rule = document.createElement('span');
        rule.className = 'ci ci-ghost';
        ghost.append(rule, document.createTextNode(baselineTdb
            ? `gray line = ${baselineTdb.name}`
            : 'gray line = the assessed values, before your changes'));
        phaseLegend.appendChild(ghost);
    }
}

function updateExportControls() {
    exportControls.classList.toggle('hidden', !currentTdb);
}

function exportModifiedTdb() {
    if (!currentTdb) return;
    const text = tdbHandle.export_tdb(JSON.stringify(tdbParams));
    // Written in the encoding it was read in, so that untouched lines stay
    // byte-for-byte identical (a string Blob would be UTF-8).
    downloadFile(`${baseName(currentTdb)}-refit.tdb`,
                 encodeTdb(text, currentTdbEncoding), 'text/plain');
    const notApplied = (text.match(/NOT APPLIED/g) || []).length;
    setExportStatus(
        notApplied > 0
            ? `Exported, but ${plural(notApplied, 'change')} had no matching `
              + 'PARAMETER statement \u2014 see the file header.'
            : 'Exported. Untouched parameters are byte-for-byte identical to the original.',
        notApplied > 0);
}

// The exported figure follows the screen: the diagram alone when the Gibbs
// panel is folded, both panels on one composition axis when it is open.
// Paired, the upper panel takes `MARGIN_UPPER` (no x axis) and the lower one
// `MARGIN`; alone, the diagram takes `MARGIN`.
function figureLayout() {
    const upper = logicalSize(phaseCanvas);
    // Both panels have the same width (visual-check asserts it), so the
    // figure takes the upper one's.
    const lower = gibbsOpen ? logicalSize(boundaryCanvas) : null;
    // The unnamed-fields key goes below the panels, and the figure grows to
    // hold it, so the plot keeps its on-screen size and the same labels.
    const key = unnamedKeyFor(boundaryData, upper.width, upper.height,
                              gibbsOpen ? MARGIN_UPPER : MARGIN);
    const keyHeight = key ? unnamedKeyLayout(scratchCtx, key, upper.width, MARGIN).h : 0;
    const panels = upper.height + (lower ? lower.height : 0);
    return {
        paired: gibbsOpen,
        width: upper.width,
        height: panels + keyHeight,
        upperHeight: upper.height,
        lowerHeight: lower ? lower.height : 0,
        keyHeight,
    };
}

// Draws the figure for both the PNG and the SVG export. The lower panel is
// offset with `ctx.translate`, which `SvgContext` supports.
function drawFigure(ctx, layout) {
    const key = drawPhaseDiagram(
        null, boundaryData,
        { ctx, width: layout.width,
          height: layout.upperHeight,
          // The isotherm marks the Gibbs curves' temperature, so it is drawn
          // only with the curves.
          isotherm: layout.paired },
        layout.paired ? MARGIN_UPPER : MARGIN);

    if (layout.paired) {
        ctx.save();
        ctx.translate(0, layout.upperHeight);
        drawGibbsCurves({
            target: { ctx, width: layout.width, height: layout.lowerHeight },
            margin: MARGIN,
        });
        ctx.restore();
    }
    // Absolute coordinates rather than a translate. The strip gets its own
    // background, since the PNG is transparent where nothing is drawn.
    if (key && layout.keyHeight > 0) {
        const top = layout.height - layout.keyHeight;
        ctx.fillStyle = palette.surface;
        ctx.fillRect(0, top, layout.width, layout.keyHeight);
        drawUnnamedKeyStrip(ctx, key, top, layout.width, MARGIN);
    }
}

function figureName(layout) {
    return `${baseName(currentTdb)}-${layout.paired ? 'figure' : 'diagram'}`;
}

// The SVG comes from the same drawing code, given an SvgContext.
function buildFigureSvg(layout = figureLayout()) {
    const ctx = new SvgContext(layout.width, layout.height);
    drawFigure(ctx, layout);
    return ctx.toSvg({
        background: palette.surface,
        title: layout.paired
            ? `${baseName(currentTdb)} phase diagram and Gibbs energy curves`
            : `${baseName(currentTdb)} phase diagram`,
        description: `${baseName(currentTdb)} computed by GibbScope `
            + `${engine_version()}`
            + (layout.paired ? `, curves at ${params.temp} K` : ''),
    });
}

function exportFigureSvg() {
    if (!currentTdb) return;
    const layout = figureLayout();
    const svg = buildFigureSvg(layout);
    downloadFile(`${figureName(layout)}.svg`, svg, 'image/svg+xml');
    setExportStatus(
        `Vector ${layout.paired ? 'figure (both panels)' : 'diagram'} saved `
        + `(${(svg.length / 1024).toFixed(0)} KB).`
        // The raster is embedded as a data-URI <image>, so the file is not
        // fully vector.
        + (showRaster
            ? ' Tip: turn Raster off for a fully vector figure.' : ''));
}

function exportFigure() {
    if (!currentTdb) return;
    const layout = figureLayout();
    const canvas = document.createElement('canvas');
    canvas.width = layout.width * FIGURE_SCALE;
    canvas.height = layout.height * FIGURE_SCALE;
    const ctx = canvas.getContext('2d');
    ctx.scale(FIGURE_SCALE, FIGURE_SCALE);
    // Redraw from cached results at the same view, just larger.
    drawFigure(ctx, layout);
    canvas.toBlob((blob) => {
        downloadFile(`${figureName(layout)}.png`, blob, 'image/png');
        setExportStatus(
            `${layout.paired ? 'Figure (both panels)' : 'Diagram'} saved at `
            + `${canvas.width}x${canvas.height} px.`);
    }, 'image/png');
}

// ------------------------------------------------------------- data export --

// Data files are always in mole fraction and kelvin, whatever units are
// displayed, and say so.
const DATA_UNITS = 'x = mole fraction of the second element; T in K';

function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRows(rows) {
    return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

function boundariesCsv() {
    const rows = [['curve', 'phase', 'against', 'kind', 'pair', 'field', 'x', 'T_K']];
    boundaryData.boundaries.forEach((c, i) => {
        for (const p of c.points) {
            rows.push([i, c.phase, c.against, c.kind, c.pair, c.field, p.x, p.t]);
        }
    });
    return rows;
}

/// The parameters moved off their assessed values, as `[key, value]` pairs
/// keyed as in `paramSliders`. Compared with the parsed coefficients in
/// `tdbInfo.l_params`, so it holds after a session load; `tdbParams` is not
/// empty even for an untouched database.
function changedParamEntries() {
    if (!tdbInfo) return [];
    const out = [];
    for (const lp of tdbInfo.l_params || []) {
        const held = tdbParams[lp.phase] && tdbParams[lp.phase][lp.order];
        if (held && Number.isFinite(held.a) && held.a !== lp.a_coeff) {
            out.push([`${lp.phase}:${lp.order}:a`, held.a]);
        }
    }
    for (const [name, v] of Object.entries(tdbParams._compound_offsets || {})) {
        if (Number.isFinite(v) && v !== 0) out.push([`_compound:${name}`, v]);
    }
    return out;
}

function paramsDifferFromAssessed() {
    return changedParamEntries().length > 0;
}

// What the exported numbers were computed from.
function dataProvenance() {
    return {
        tdb: currentTdb,
        engine: engine_version(),
        created: new Date().toISOString(),
        units: DATA_UNITS,
        view: view ? { ...view } : null,
        temperature_K: params.temp,
        params: tdbParams,
        parameters_differ_from_assessed: paramsDifferFromAssessed(),
    };
}

function exportBoundariesCsv() {
    if (!currentTdb) return;
    // `boundaryData` is null when the last sweep returned nothing.
    if (!boundaryData) {
        setExportStatus('No boundaries to export — the last sweep did not '
            + 'return any. Check the diagnostics panel.', true);
        return;
    }
    const rows = boundariesCsv();
    downloadFile(`${baseName(currentTdb)}-boundaries.csv`,
                 csvRows(rows), 'text/csv');
    // Invariants have a varying number of phases each and do not fit a CSV
    // table; the status line points to the JSON export.
    setExportStatus(`${rows.length - 1} boundary points saved (${DATA_UNITS}). `
        + 'Invariants are in Data (JSON).');
}

function exportDataJson() {
    if (!currentTdb) return;
    if (!boundaryData) {
        setExportStatus('No boundaries to export — the last sweep did not '
            + 'return any. Check the diagnostics panel.', true);
        return;
    }
    const doc = {
        format: 'calphad-viz-data',
        version: 1,
        ...dataProvenance(),
        boundaries: boundaryData.boundaries,
        invariants: boundaryData.invariants,
        // Phase-set changes the engine could not classify as a reaction.
        unclassified: boundaryData.unclassified,
    };
    const text = JSON.stringify(doc, null, 2);
    downloadFile(`${baseName(currentTdb)}-data.json`, text, 'application/json');
    setExportStatus(
        `${plural(boundaryData.boundaries.length, 'boundary curve')}, `
        + `${plural(boundaryData.invariants.length, 'invariant')} and `
        + `${plural(boundaryData.unclassified.length, 'unclassified change')} saved `
        + `(${(text.length / 1024).toFixed(0)} KB, ${DATA_UNITS}).`);
}

function buildSession() {
    return {
        format: SESSION_FORMAT,
        version: SESSION_VERSION,
        created: new Date().toISOString(),
        // The database is not embedded, since it may be licensed. Load the
        // TDB first, then the session.
        tdb: { name: currentTdb },
        // The engine version, in case a later version draws it differently.
        engine: engine_version(),
        params: tdbParams,
        unlocked: [...unlockedParams],
        view: view ? { ...view } : null,
        // `both` (raster on) or `vector`.
        renderMode: showRaster ? 'both' : 'vector',
        colourBy: expColourBy,
        // Missing in older sessions, which `applySession` reads as on.
        showPoints: showExpPoints,
        temperature: params.temp,
        sources: [...expSources.values()].map(s => ({
            name: s.name,
            visible: s.visible,
            pair: s.pair,
            points: s.points.map(p => ({
                x: p.x, t: p.t, kind: p.kind,
                x_err: p.x_err, t_err: p.t_err,
                phase: p.phase, weight: p.weight, source: p.source,
            })),
        })),
    };
}

function saveSession() {
    if (!currentTdb) return;
    downloadFile(`${baseName(currentTdb)}-session.json`,
                 JSON.stringify(buildSession(), null, 2), 'application/json');
    setExportStatus('Session saved. Re-open it after loading the same .tdb file.');
}

function applySession(session, fileName) {
    if (session.format !== SESSION_FORMAT) {
        throw new Error('not a session file');
    }
    if (session.version > SESSION_VERSION) {
        throw new Error(`session was written by a newer version (${session.version})`);
    }
    if (!currentTdb) {
        throw new Error('load the .tdb file first, then the session');
    }

    const notes = [];
    if (session.tdb?.name && session.tdb.name !== currentTdb) {
        notes.push(`session was saved against ${session.tdb.name}, not ${currentTdb}`);
    }

    if (session.params && typeof session.params === 'object') {
        applyFitParams(structuredClone(session.params));
    }

    unlockedParams.clear();
    for (const [key, cb] of paramLocks) cb.checked = false;
    for (const key of session.unlocked || []) {
        if (paramLocks.has(key)) {
            unlockedParams.add(key);
            paramLocks.get(key).checked = true;
        } else {
            notes.push(`parameter ${key} is not in this database`);
        }
    }

    clearExpSources();
    for (const s of session.sources || []) {
        addExpSource({
            name: s.name,
            visible: s.visible !== false,
            points: s.points || [],
            // An older session has no pair; it is taken to be this database's.
            pair: Array.isArray(s.pair) ? s.pair : null,
        });
    }
    reconcileExpSources();

    if (session.view && fittedView) {
        setViewWindow({
            xMin: session.view.xMin ?? fittedView.xMin,
            xMax: session.view.xMax ?? fittedView.xMax,
            tMin: session.view.tMin ?? fittedView.tMin,
            tMax: session.view.tMax ?? fittedView.tMax,
        });
    }
    // Only `vector` means off; any other value draws the raster.
    if (session.renderMode !== undefined) {
        setShowRaster(session.renderMode !== 'vector', { redraw: false });
    }
    setExpColourBy(session.colourBy, { redraw: false });
    // Only an explicit `false` hides the points.
    setShowExpPoints(session.showPoints !== false, { redraw: false });
    // Through `setTemperature`, which clamps to the slider and updates the
    // readout in the displayed unit.
    if (Number.isFinite(session.temperature)) setTemperature(session.temperature);

    rebuildExpPanel();
    update();
    updateFitControls();

    const pointCount = [...expSources.values()].reduce((n, s) => n + s.points.length, 0);
    setExportStatus(
        `Restored ${fileName}: ${plural(expSources.size, 'dataset')}, `
        + `${plural(pointCount, 'point')}.`
        + (notes.length ? ` Note: ${notes.join('; ')}.` : ''),
        notes.length > 0);
}

async function loadSessionFile(file) {
    try {
        applySession(JSON.parse(await file.text()), file.name);
    } catch (e) {
        setExportStatus(`Could not load session: ${e.message}`, true);
    }
}

function setupExportControls() {
    exportTdbBtn.addEventListener('click', exportModifiedTdb);
    exportPngBtn.addEventListener('click', exportFigure);
    exportSvgBtn.addEventListener('click', exportFigureSvg);
    exportCsvBtn.addEventListener('click', exportBoundariesCsv);
    exportJsonBtn.addEventListener('click', exportDataJson);
    sessionSaveBtn.addEventListener('click', saveSession);
    sessionLoadBtn.addEventListener('click', () => sessionFileInput.click());
    sessionFileInput.addEventListener('change', (e) => {
        if (e.target.files.length) loadSessionFile(e.target.files[0]);
        e.target.value = '';
    });
}

// --------------------------------------------------------- parameter panel --

/// The number box on a parameter row. It shows the value and accepts a typed
/// one, including values between the slider's steps. The box and the slider
/// both write through `apply`, as a link does (`applyParamOverrides`).
function paramValueControl(key, { input, apply, toValue, toAbsolute, name }) {
    const entry = document.createElement('input');
    entry.type = 'number';
    entry.className = 'param-value';
    // The slider's step, so the arrow keys move one notch; off-step values
    // are still accepted.
    entry.step = input.step;
    entry.min = input.min;
    entry.max = input.max;
    entry.value = '0';
    entry.setAttribute('aria-label', `${name}, exact value`);
    input.setAttribute('aria-label', name);

    /// The unrounded value behind the box, so that re-entering the displayed
    /// (rounded) number does not round the model's value.
    let shownExact = 0;
    const display = (shown) => String(Number(shown.toFixed(3)));

    const show = (shown) => {
        shownExact = shown;
        input.value = shown;
        entry.value = display(shown);
    };

    /// Every write from the panel. Clamped to the slider's range (see
    /// `fitBounds`), and the box then shows the clamped value.
    const commit = (shown) => {
        const lo = Number(input.min), hi = Number(input.max);
        const clamped = Math.min(hi, Math.max(lo, shown));
        apply(toAbsolute(clamped));
        show(clamped);
        scheduleUpdate();
    };

    input.addEventListener('input', () => commit(Number(input.value)));

    // `change`, not `input`: typing "-1250" should not sweep at -1, -12, -125.
    entry.addEventListener('change', () => {
        const typed = Number(entry.value);
        // Empty or unparseable: restore the held value rather than use zero.
        if (entry.value.trim() === '' || !Number.isFinite(typed)) { show(shownExact); return; }
        // The displayed number retyped: keep the unrounded value.
        if (typed === Number(display(shownExact))) { show(shownExact); return; }
        commit(typed);
    });

    paramSliders.set(key, { input, entry, toValue, toAbsolute, apply, show });
    return entry;
}

function buildTdbSliders() {
    paramSliders.clear();
    paramLocks.clear();
    unlockedParams.clear();
    tdbSliders.innerHTML = '';
    tdbSliders.classList.remove('hidden');
    slidersHeading.classList.remove('hidden');
    resetBtn.classList.remove('hidden');
    tempControl.classList.remove('hidden');

    const hint = document.createElement('p');
    hint.className = 'phase-tweak-hint';
    hint.textContent = 'Choose a phase to tweak parameters!';
    tdbSliders.appendChild(hint);

    const phaseGroups = {};
    tdbInfo.l_params.forEach(lp => {
        if (!phaseGroups[lp.phase]) phaseGroups[lp.phase] = [];
        phaseGroups[lp.phase].push(lp);
    });

    Object.keys(phaseGroups).forEach(phaseName => {
        const details = document.createElement('details');
        details.className = 'phase-group';

        const summary = document.createElement('summary');
        summary.className = 'phase-group-header';
        summary.append(phaseName);
        summary.appendChild(groupUnitNote('J/mol'));
        details.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'phase-group-body';

        phaseGroups[phaseName].sort((a,b) => a.order - b.order).forEach(lp => {
            // Scaled to the coefficient; also the fit's bounds (`paramTrack`).
            const track = paramTrack(lp.a_coeff);
            const input = document.createElement('input');
            input.type = 'range';
            input.min = -track.span; input.max = track.span;
            input.value = 0; input.step = track.step;

            // `toValue`/`toAbsolute` convert between the absolute coefficient
            // and the displacement the row shows.
            const control = paramValueControl(`${lp.phase}:${lp.order}:a`, {
                input,
                name: `${lp.phase}, Redlich-Kister L${lp.order}, `
                    + 'displacement from its assessed value, in J/mol',
                toValue: (absolute) => absolute - lp.a_coeff,
                toAbsolute: (shown) => shown + lp.a_coeff,
                apply: (absolute) => {
                    if (!tdbParams[lp.phase]) tdbParams[lp.phase] = [];
                    // Untouched orders stay empty objects, meaning "as in
                    // the database"; zeros would override them.
                    while (tdbParams[lp.phase].length <= lp.order) {
                        tdbParams[lp.phase].push({});
                    }
                    tdbParams[lp.phase][lp.order].a = absolute;
                    tdbParams[lp.phase][lp.order].b = lp.b_coeff;
                },
            });

            body.appendChild(makeParamRow({
                ident: { sub: lp.order },
                input,
                control,
                key: `${lp.phase}:${lp.order}:a`,
                range: { ...track, assessed: lp.a_coeff },
            }));
        });

        details.appendChild(body);
        tdbSliders.appendChild(details);
    });

    if (tdbCompounds.length > 0) {
        const compDetails = document.createElement('details');
        compDetails.className = 'phase-group';
        const compSummary = document.createElement('summary');
        compSummary.className = 'phase-group-header';
        compSummary.append('Compounds');
        compSummary.appendChild(groupUnitNote('J/mol-fu'));
        compDetails.appendChild(compSummary);
        const compBody = document.createElement('div');
        compBody.className = 'phase-group-body';

        tdbCompounds.forEach(c => {
            // A fixed track: the engine reports no energy for a compound, so
            // there is no assessed value to scale by.
            const track = { span: 10000, step: 250 };
            const input = document.createElement('input');
            input.type = 'range';
            input.min = -track.span; input.max = track.span;
            input.value = 0; input.step = track.step;

            // The stored value is the offset itself, so both mappings are the
            // identity.
            const control = paramValueControl(`_compound:${c.name}`, {
                input,
                name: `${c.formula || c.name}, G offset in J per formula unit`,
                toValue: (absolute) => absolute,
                toAbsolute: (shown) => shown,
                apply: (absolute) => { tdbParams._compound_offsets[c.name] = absolute; },
            });

            compBody.appendChild(makeParamRow({
                ident: { text: c.formula || c.name },
                name: 'G',
                input,
                control,
                key: `_compound:${c.name}`,
                range: track,
            }));
        });
        compDetails.appendChild(compBody);
        tdbSliders.appendChild(compDetails);
    }
}

// ------------------------------------------------------------------- units --
//
// Display only. Everything stored (data, residuals, boundaries, the fit,
// exports, sessions) stays in mole fraction and kelvin.

const units = { temperature: 'K', composition: 'x' };

function elementMasses() {
    const m = tdbInfo?.element_masses;
    return (Array.isArray(m) && m.length >= 2 && m[0] > 0 && m[1] > 0)
        ? [m[0], m[1]] : null;
}

function weightPercentAvailable() {
    return elementMasses() !== null;
}

function tToDisplay(t) { return units.temperature === 'C' ? t - 273.15 : t; }
function tFromDisplay(v) { return units.temperature === 'C' ? v + 273.15 : v; }
function tUnitLabel() { return units.temperature === 'C' ? '\u00b0C' : 'K'; }

/// Mole fraction of the second element -> the chosen display unit.
function xToDisplay(x) {
    if (units.composition === 'at') return x * 100;
    if (units.composition === 'wt') {
        const m = elementMasses();
        if (!m) return x * 100;
        const [ma, mb] = m;
        return 100 * (x * mb) / ((1 - x) * ma + x * mb);
    }
    return x;
}

function xFromDisplay(v) {
    if (units.composition === 'at') return v / 100;
    if (units.composition === 'wt') {
        const m = elementMasses();
        if (!m) return v / 100;
        const [ma, mb] = m;
        const w = v / 100;
        // Inverting w = x*Mb / ((1-x)*Ma + x*Mb).
        return (w * ma) / (mb * (1 - w) + w * ma);
    }
    return v;
}

function xUnitLabel() {
    if (units.composition === 'at') return 'at%';
    if (units.composition === 'wt') return 'wt%';
    return 'mol fraction';
}

// `x(Cu)` already means mole fraction; other units are named.
function xAxisTitle() {
    const b = tdbInfo?.elements?.[1];
    const symbol = b ? symbolOf(b) : 'B';
    return units.composition === 'x'
        ? `x(${symbol})`
        : `${symbol} (${xUnitLabel()})`;
}

/// Ticks are round numbers in the displayed unit, mapped back to mole fraction
/// for placement, so a wt% axis is unevenly spaced.
function axisTicks(min, max, toDisplay, fromDisplay, target = 6) {
    const ticks = niceTicks(toDisplay(min), toDisplay(max), target);
    return {
        decimals: ticks.decimals,
        values: ticks.values
            .map(v => ({ label: v, at: fromDisplay(v) }))
            .filter(t => t.at >= min - 1e-9 && t.at <= max + 1e-9),
    };
}

/// The cycle order of each unit button, with its labels. Links and sessions
/// store the unit by name, so the order can change freely.
const UNIT_CYCLE = {
    temperature: [['K', 'K', 'Kelvin'], ['C', '\u00b0C', 'Celsius']],
    composition: [['x', 'mol frac', 'Mole fraction'],
                  ['at', 'at%', 'Atomic percent'],
                  ['wt', 'wt%', 'Weight percent']],
};

const unitButton = (key) => (key === 'composition' ? compUnits : tempUnits)
    .querySelector('.unit-cycle');

/// Sets a unit button's label and accessible name to the current unit (not
/// the next one).
function showUnitButton(key) {
    const btn = unitButton(key);
    if (!btn) return;
    const row = UNIT_CYCLE[key].find(([id]) => id === units[key]);
    if (!row) return;
    btn.dataset.unit = row[0];
    btn.textContent = row[1];
    const group = key === 'composition' ? 'Composition' : 'Temperature';
    btn.setAttribute('aria-label', `${group} unit: ${row[2]}. Activate to change.`);
    btn.title = `${row[2]} — click to change`;
}

/// Sets both units, as a link stores them together and they share a redraw.
/// An unavailable unit is ignored: `wt` needs atomic masses, so a link asking
/// for it on a database without them stays on `x`.
function setUnits(composition, temperature, { redraw = true } = {}) {
    const wanted = { composition, temperature };
    let changed = false;
    for (const key of ['composition', 'temperature']) {
        const want = wanted[key];
        if (units[key] === want) continue;
        if (!UNIT_CYCLE[key].some(([id]) => id === want)) continue;
        if (want === 'wt' && !weightPercentAvailable()) continue;
        units[key] = want;
        showUnitButton(key);
        changed = true;
    }
    if (!changed) return;
    syncTemperatureSlider();
    if (redraw) render(false);
}

function setupUnitToggles() {
    const wire = (key) => {
        const btn = unitButton(key);
        if (!btn) return;
        btn.addEventListener('click', () => {
            // Skip `wt` when unavailable, so a click always changes the unit.
            const ring = UNIT_CYCLE[key]
                .filter(([id]) => id !== 'wt' || weightPercentAvailable());
            const at = ring.findIndex(([id]) => id === units[key]);
            const next = ring[(at + 1) % ring.length][0];
            setUnits(key === 'composition' ? next : units.composition,
                     key === 'temperature' ? next : units.temperature);
        });
        showUnitButton(key);
    };
    wire('temperature');
    wire('composition');
}

/// Leaves `wt` if the new database has no atomic masses.
function refreshUnitAvailability() {
    if (!weightPercentAvailable() && units.composition === 'wt') {
        units.composition = 'x';
        showUnitButton('composition');
    }
}

// Sets the temperature from anywhere but the slider, and moves the slider.
// Clamped to the slider's range, which `applyFittedView` fits to the system.
function setTemperature(t) {
    const lo = Number(tempSlider.min), hi = Number(tempSlider.max);
    const next = Math.round(Math.min(hi, Math.max(lo, t)));
    if (next === params.temp) return;
    params.temp = next;
    tempSlider.value = String(next);
    syncTemperatureSlider();
    scheduleTemperatureDraw();
}

function syncTemperatureSlider() {
    tempValue.textContent = tToDisplay(params.temp).toFixed(
        units.temperature === 'C' ? 1 : 0);
    // The thumb's position as a fraction of the slider's range (not of the
    // view, which zooming changes), for the CSS that places the label and
    // fills the track.
    const lo = Number(tempSlider.min), hi = Number(tempSlider.max);
    const frac = hi > lo ? Math.min(1, Math.max(0, (params.temp - lo) / (hi - lo))) : 0;
    tempTrack.style.setProperty('--temp-frac', frac.toFixed(4));
    tempTrack.style.setProperty('--temp-at', `${(frac * 100).toFixed(2)}%`);
    if (fittedView) {
        tempSliderMinLabel.textContent =
            `${tToDisplay(fittedView.tMin).toFixed(0)} ${tUnitLabel()}`;
        tempSliderMaxLabel.textContent =
            `${tToDisplay(viewBounds().tMax).toFixed(0)} ${tUnitLabel()}`;
    }
}

// ------------------------------------------------------------- view window --
//
// Auto-fit, zoom and pan for the phase diagram, and the plot layout.

function niceTicks(min, max, target = 6) {
    const span = max - min;
    if (!(span > 0)) return { values: [min], decimals: 2 };
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
        out.push(v);
    }
    return { values: out, decimals: Math.max(0, -Math.floor(Math.log10(step))) };
}

const X_FULL_MIN = 0, X_FULL_MAX = 1;

// How far zoom and pan may go: the fitted window, raised to the extrapolated
// top when that is shown. Without a database, the data's extent.
function viewBounds() {
    if (fittedView) {
        const top = extrapolatedShown ? extrapolatedTop() : null;
        return top == null ? fittedView : { ...fittedView, tMax: top };
    }
    const fromData = dataExtentView();
    return fromData || { xMin: X_FULL_MIN, xMax: X_FULL_MAX,
                         tMin: modelTMin(), tMax: modelTMax() };
}

// The view when data is loaded but no database is: the data's extent, padded,
// within the model's temperature range. Null when no data is shown.
function dataExtentView() {
    const pts = [];
    for (const src of expSources.values()) {
        if (expShown(src)) pts.push(...src.points);
    }
    if (pts.length === 0) return null;
    const ts = pts.map(p => p.t), xs = pts.map(p => p.x);
    const tLo = Math.min(...ts), tHi = Math.max(...ts);
    const tPad = Math.max(25, 0.08 * (tHi - tLo));
    const xLo = Math.min(...xs), xHi = Math.max(...xs);
    const xPad = Math.max(0.02, 0.05 * (xHi - xLo));
    return {
        xMin: Math.max(X_FULL_MIN, xLo - xPad),
        xMax: Math.min(X_FULL_MAX, xHi + xPad),
        tMin: Math.max(modelTMin(), tLo - tPad),
        tMax: Math.min(modelTMax(), tHi + tPad),
    };
}

function currentView() {
    return view || viewBounds();
}

/// Sets a window from a session or a link, clamped to the same bounds as pan
/// and zoom. A window that already fits is used unchanged: `lo + (hi - lo)` is
/// not always `hi` in floating point, and a reopened link must redraw exactly
/// the same picture (visual-check compares the canvas).
function setViewWindow(w) {
    if (!w || !fittedView) return;
    // Only the extrapolated region reaches above the fitted top, so a window
    // that does was recorded with it shown.
    if (w.tMax > fittedView.tMax && extrapolatedTop() != null) widenToExtrapolated();
    const limit = viewBounds();
    const span = (lo, hi, min, max, minSpan) => {
        if (lo >= min && hi <= max && hi - lo >= minSpan) return [lo, hi];
        const width = Math.min(Math.max(hi - lo, minSpan), max - min);
        const start = Math.min(Math.max(lo, min), max - width);
        return [start, start + width];
    };
    const [xMin, xMax] = span(w.xMin, w.xMax, limit.xMin, limit.xMax, MIN_VIEW_X_SPAN);
    const [tMin, tMax] = span(w.tMin, w.tMax, limit.tMin, limit.tMax, MIN_VIEW_T_SPAN);
    view = { xMin, xMax, tMin, tMax };
    lastRaster = null;
}

// The fitted window: the full composition range, up to just above the last
// liquidus (`fitted_t_max` in the engine).
function fitViewToSystem() {
    return {
        xMin: X_FULL_MIN,
        xMax: X_FULL_MAX,
        tMin: modelTMin(),
        tMax: tdbHandle.fitted_t_max(tdbParamsJson),
    };
}

/// How far up "show extrapolated region" goes, or null when the sweep reaches
/// no higher than the fitted axis. The sweep's top is set at the assessed
/// parameters, so it is compared with the assessed axis as well: a slider that
/// lowers the current axis does not make the database extrapolate (F-43).
function extrapolatedTop() {
    const top = tdbInfo?.t_sweep_max;
    if (!fittedView || !tdbHandle) return null;
    const axis = Math.max(fittedView.tMax, tdbHandle.fitted_t_max('{}'));
    return top > axis + 1 ? top : null;
}

/// Lets the axis, and the T slider with it, reach the extrapolated top.
function widenToExtrapolated() {
    extrapolatedShown = true;
    tempSlider.max = Math.round(extrapolatedTop());
    syncTemperatureSlider();
}

function setExtrapolatedShown(on) {
    if (on && extrapolatedTop() != null) {
        widenToExtrapolated();
        view = { ...fittedView, tMax: extrapolatedTop() };
        lastRaster = null;
    } else {
        applyFittedView();
    }
    render(true);
}

function applyFittedView() {
    extrapolatedShown = false;
    fittedView = fitViewToSystem();
    view = { ...fittedView };
    lastRaster = null;

    tempSlider.min = Math.round(fittedView.tMin);
    tempSlider.max = Math.round(fittedView.tMax);
    if (params.temp > fittedView.tMax || params.temp < fittedView.tMin) {
        params.temp = Math.round(fittedView.tMin + 0.6 * (fittedView.tMax - fittedView.tMin));
        tempSlider.value = params.temp;
    }
    syncTemperatureSlider();
}

// Sizes the canvas's backing store at devicePixelRatio while drawing stays in
// CSS pixels, and returns whether it resized. It writes nothing when size and
// dpr are unchanged: assigning `canvas.width` clears the canvas even to the
// same value, and can retrigger the ResizeObserver (a console error in Chromium).
function sizeCanvas(canvas, cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // At least 1 px; a zero size would draw everything off-canvas.
    cssW = Math.max(1, Math.round(cssW));
    cssH = Math.max(1, Math.round(cssH));
    if (Number(canvas.dataset.cssWidth) === cssW
        && Number(canvas.dataset.cssHeight) === cssH
        && Number(canvas.dataset.cssDpr) === dpr) return false;

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.dataset.cssWidth = cssW;
    canvas.dataset.cssHeight = cssH;
    canvas.dataset.cssDpr = dpr;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
}

// Minimum plot size (px) and the diagram's preferred height-to-width ratio.
const PLOT_MIN_W  = 300;
const PLOT_MIN_H  = 290;
const PLOT_ASPECT = 0.76;
/// The flattest the diagram may be drawn (1.9:1). Below it the figure stops
/// shrinking with the window and the page scrolls.
const PLOT_MIN_ASPECT = 0.52;
// The card's own padding and border, either side (style.css
// `.visualization-panel`).
const CARD_CHROME = 30;

// The stacked plots share the window's height. PAIR_CHROME is the height above
// and below the two canvases (header, control strip, fold strip, card padding
// and footer), so the page fits the window while the plots column is the
// tallest. Update it when any of those changes height.
const PAIR_CHROME  = 253;
const GIBBS_SHARE  = 0.34;
const GIBBS_MIN_H  = 210;

// The Gibbs panel opens by default only on a tall enough window, judged once at
// start-up by `window.innerHeight` alone, since the page's height depends on
// the answer.
const GIBBS_OPEN_VH  = 860;

let gibbsOpen = true;
// Set once the user opens or folds the panel, so the session and the link keep
// the choice.
let gibbsUserChose = false;

/// Set while the Gibbs panel is folded because a comparison was loaded, so
/// `clearBaseline` reopens it. Not applied once the user has set the panel
/// (`gibbsUserChose`), so `g=1` in a link wins.
let gibbsFoldedForGhost = false;

// Computes every canvas size and returns them without applying them. It reads
// only widths that the grid sets and this code never writes, so the layout
// cannot feed back on itself.
function layoutPlots() {
    // Measured on the plots column, whose width the grid sets; the card hugs
    // its canvases.
    const colW = Math.max(PLOT_MIN_W,
        Math.floor(plotsColumn.clientWidth) - CARD_CHROME);

    const budget = Math.max(PLOT_MIN_H + GIBBS_MIN_H, window.innerHeight - PAIR_CHROME);
    // The Gibbs panel's share comes off first, so on a short window the
    // diagram does not take everything.
    const gibbsShare = gibbsOpen
        ? Math.min(budget - PLOT_MIN_H, Math.max(GIBBS_MIN_H, budget * GIBBS_SHARE))
        : 0;
    const avail = Math.max(PLOT_MIN_H, budget - gibbsShare);

    // The plots always take the full column width. The height is what is
    // left, but no flatter than PLOT_MIN_ASPECT; past that the page scrolls.
    const w = Math.round(Math.max(PLOT_MIN_W, colW));
    const h = Math.round(Math.max(PLOT_MIN_H, w * PLOT_MIN_ASPECT,
                                  Math.min(avail, w * PLOT_ASPECT)));
    // Then the Gibbs panel takes any room the diagram's aspect cap left, up to
    // the diagram's height; not the rail's, which changes as parameter groups
    // open. `budget - h` can be negative when the aspect floor held the
    // diagram up, so `GIBBS_MIN_H` is applied last.
    const gibbsH = gibbsOpen
        ? Math.round(Math.max(GIBBS_MIN_H,
                              Math.min(h,
                                       Math.max(gibbsShare, budget - h))))
        : 0;
    // Same width, so the two composition axes match.
    return { phase: { w, h }, gibbs: gibbsOpen ? { w, h: gibbsH } : null };
}

function fitCanvases() {
    const l = layoutPlots();
    let changed = sizeCanvas(phaseCanvas, l.phase.w, l.phase.h);
    changed = sizeCanvas(phaseOverlay, l.phase.w, l.phase.h) || changed;
    if (l.gibbs) {
        changed = sizeCanvas(boundaryCanvas, l.gibbs.w, l.gibbs.h) || changed;
        changed = sizeCanvas(boundaryOverlay, l.gibbs.w, l.gibbs.h) || changed;
    }
    return changed;
}

// The Gibbs panel is a button and a div; a `<details>` would put its border
// and summary between the plots. `redraw: false` is for a caller that draws
// next anyway (`clearBaseline` during `applyTdbText`); the canvases are resized
// regardless.
function setGibbsOpen(open, byUser, { redraw = true } = {}) {
    // A user's choice also means clearing the comparison will not reopen it.
    if (byUser) { gibbsUserChose = true; gibbsFoldedForGhost = false; }
    if (gibbsOpen === open) return;
    gibbsOpen = open;
    gibbsPanel.dataset.open = String(open);
    gibbsToggle.setAttribute('aria-expanded', String(open));
    // The ResizeObserver does not see this, so resize here.
    fitCanvases();
    if (redraw && wasm) render(false);
}

function setupGibbsPanel() {
    gibbsToggle.addEventListener('click', () => setGibbsOpen(!gibbsOpen, true));
    gibbsOpen = window.innerHeight >= GIBBS_OPEN_VH;
    gibbsPanel.dataset.open = String(gibbsOpen);
    gibbsToggle.setAttribute('aria-expanded', String(gibbsOpen));
}

function observeCanvasSize() {
    // The height budget follows `window.innerHeight`, which no observed element
    // reports, so a window listener runs alongside the observer.
    window.addEventListener('resize', () => { fitCanvases(); if (wasm) render(false); });
    if (typeof ResizeObserver === 'undefined') return;
    // A resize can trigger a second notification; `sizeCanvas` then writes
    // nothing, so there is no third. The redraw is unconditional, since an
    // unresized canvas can still hold a stale picture.
    const ro = new ResizeObserver(() => {
        fitCanvases();
        if (wasm) render(false);
    });
    // The plots column, whose width the grid sets. The canvas wrappers follow
    // the canvases, so observing them would miss layout changes.
    ro.observe(plotsColumn);
}

// The canvas size in CSS pixels, which all drawing uses. Falls back to
// `canvas.width` only for a canvas never sized.
function logicalSize(canvas) {
    const w = Number(canvas.dataset.cssWidth);
    const h = Number(canvas.dataset.cssHeight);
    return {
        width:  Number.isFinite(w) ? w : canvas.width,
        height: Number.isFinite(h) ? h : canvas.height,
    };
}

// The data-to-pixel mapping used by every plot and pointer handler. The y
// domain is a parameter because the Gibbs panel's comes from the energies it
// has just computed. Build one per draw and do not keep it: pan, zoom and
// `applyFittedView` replace `view`.
function makeScales({ width, height, margin, xMin, xMax, yMin, yMax }) {
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const xSpan = xMax - xMin;
    const ySpan = yMax - yMin;
    return {
        rect: { x: margin.left, y: margin.top, w: plotW, h: plotH },
        mapX: (x) => margin.left + ((x - xMin) / xSpan) * plotW,
        mapY: (y) => margin.top + plotH - ((y - yMin) / ySpan) * plotH,
        invX: (px) => xMin + ((px - margin.left) / plotW) * xSpan,
        invY: (py) => yMin + ((margin.top + plotH - py) / plotH) * ySpan,
        contains: (px, py) => px >= margin.left && px <= margin.left + plotW
                           && py >= margin.top && py <= margin.top + plotH,
        xOfIndex: (i, n) => xMin + (n > 1 ? (i / (n - 1)) * xSpan : 0),
    };
}

// The phase diagram's margin, which drawing, hover and clicks must all use. It
// depends on whether the Gibbs panel is open.
function phaseMargin() {
    return gibbsOpen ? MARGIN_UPPER : MARGIN;
}

// The phase diagram's scales: composition across, temperature up. `canvas` is
// the diagram or its same-sized hover overlay.
function phaseScales(canvas = phaseCanvas) {
    const { width, height } = logicalSize(canvas);
    const v = currentView();
    return makeScales({ width, height, margin: phaseMargin(),
                        xMin: v.xMin, xMax: v.xMax, yMin: v.tMin, yMax: v.tMax });
}

function plotRect() {
    return phaseScales().rect;
}

// The Gibbs panel's composition scale. The y domain (0 to 1) is a
// placeholder: only `drawGibbsCurves` knows the energy range, and callers of
// this use only x and the plot rectangle.
function gibbsXScale() {
    const { width, height } = logicalSize(boundaryCanvas);
    const v = currentView();
    return makeScales({ width, height, margin: MARGIN,
                        xMin: v.xMin, xMax: v.xMax, yMin: 0, yMax: 1 });
}

// The energy range of the last on-screen Gibbs draw, so the hover overlay can
// put a mark on a curve. `paintFigure` redraws the panel before the next hover
// frame, so it always matches the screen. Exports do not write it.
let gibbsGDomain = null;

function gibbsScales() {
    if (!gibbsGDomain) return null;
    const { width, height } = logicalSize(boundaryCanvas);
    const v = currentView();
    return makeScales({ width, height, margin: MARGIN,
                        xMin: v.xMin, xMax: v.xMax,
                        yMin: gibbsGDomain.minG, yMax: gibbsGDomain.maxG });
}

// Canvas pixels from a mouse event, for handlers that need no data coordinates.
function eventToPixels(e, canvas = phaseCanvas) {
    const r = canvas.getBoundingClientRect();
    const { width, height } = logicalSize(canvas);
    return {
        px: (e.clientX - r.left) * width / r.width,
        py: (e.clientY - r.top) * height / r.height,
    };
}

function eventToPlot(e) {
    const { px, py } = eventToPixels(e);
    const s = phaseScales();
    return {
        px, py,
        inside: s.contains(px, py),
        x: s.invX(px),
        t: s.invY(py),
    };
}

// How close to the 1.5 px isotherm a press must be to grab it instead of
// panning.
const ISOTHERM_GRAB_PX = 7;

/// The isotherm's y in canvas pixels, or null when it is not drawn (the Gibbs
/// panel is folded, or T is outside the view). The hit tests use it, so a
/// hidden isotherm cannot be grabbed.
function isothermPy() {
    if (!currentTdb || !view || !gibbsOpen) return null;
    const v = currentView();
    if (params.temp < v.tMin || params.temp > v.tMax) return null;
    return phaseScales().mapY(params.temp);
}

function isothermHit(py) {
    const at = isothermPy();
    return at !== null && Math.abs(py - at) <= ISOTHERM_GRAB_PX;
}

/// At full span, zoom and pan return the bounds themselves: `hi - (hi - lo)` is
/// not always `lo` in floating point, and a window one ulp off the fitted one
/// would keep Reset visible and the view in the link.
const atFullSpan = (span, lo, hi) => span >= hi - lo;

// Scales a range about an anchor, keeping it inside [lo, hi].
function zoomRange(min, max, factor, anchor, lo, hi, minSpan) {
    const span = Math.min(Math.max((max - min) * factor, minSpan), hi - lo);
    if (atFullSpan(span, lo, hi)) return [lo, hi];
    let newMin = anchor - ((anchor - min) / (max - min)) * span;
    newMin = Math.min(Math.max(newMin, lo), hi - span);
    return [newMin, newMin + span];
}

function shiftRange(min, max, delta, lo, hi) {
    const span = max - min;
    if (atFullSpan(span, lo, hi)) return [lo, hi];
    const newMin = Math.min(Math.max(min + delta, lo), hi - span);
    return [newMin, newMin + span];
}

// Pan/zoom redraws immediately from cached data; the true recompute lands once
// the gesture settles.
function scheduleRecompute(delay = 150) {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => { recomputeTimer = null; render(true); }, delay);
}

// True while the isotherm is being dragged, which suppresses both panning and
// the hover readout for the duration.
let scrub = false;

function setRegionLabels(on, { redraw = true } = {}) {
    const changed = on !== showRegionLabels;
    showRegionLabels = on;
    setPressed(labelsBtn, showRegionLabels);
    if (changed && redraw) render(false);
}

function setupDiagramZoom() {
    labelsBtn.addEventListener('click', () => setRegionLabels(!showRegionLabels));

    figureThemeBtn.addEventListener('click', () => {
        setFigureTheme(figureTheme === 'light' ? 'dark' : 'light');
    });

    resetViewBtn.addEventListener('click', () => {
        if (!currentTdb) return;
        applyFittedView();
        render(true);
    });

    extrapolatedBtn?.addEventListener('click', () => {
        if (!currentTdb) return;
        setExtrapolatedShown(!extrapolatedShown);
    });

    phaseCanvas.addEventListener('dblclick', () => {
        if (!currentTdb) return;
        applyFittedView();
        render(true);
    });

    // Wheel events are coalesced to one stretched redraw per frame, and one
    // real recompute after scrolling stops.
    let zoomFrame = false;
    phaseCanvas.addEventListener('wheel', (e) => {
        if (!currentTdb || !view) return;
        const at = eventToPlot(e);
        if (!at.inside) return;
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.0015);
        const limit = viewBounds();
        [view.xMin, view.xMax] = zoomRange(
            view.xMin, view.xMax, factor, at.x, limit.xMin, limit.xMax, MIN_VIEW_X_SPAN);
        [view.tMin, view.tMax] = zoomRange(
            view.tMin, view.tMax, factor, at.t, limit.tMin, limit.tMax, MIN_VIEW_T_SPAN);
        if (!zoomFrame) {
            zoomFrame = true;
            requestAnimationFrame(() => { zoomFrame = false; render(false); });
        }
        scheduleRecompute();
    }, { passive: false });

    let drag = null;
    phaseCanvas.addEventListener('mousedown', (e) => {
        if (!currentTdb || !view) return;
        const at = eventToPlot(e);
        if (!at.inside) return;
        // Grabbing the isotherm wins over panning, and sets the temperature
        // under the cursor. The drag never sweeps: the diagram does not depend
        // on T and is redrawn from the last raster.
        if (isothermHit(at.py)) {
            scrub = true;
            phaseCanvas.classList.add('scrubbing');
            hoverPoint = null;
            clearOverlay();
            setTemperature(at.t);
            return;
        }
        drag = { px: at.px, py: at.py, start: { ...view }, moved: false };
        phaseCanvas.classList.add('panning');
    });

    // Pan redraws are coalesced to one per frame, as for the wheel; each one
    // repaints both plots.
    let panFrame = false;
    window.addEventListener('mousemove', (e) => {
        if (scrub) {
            // Not limited to the plot: a drag past the top pins the temperature
            // at the slider's maximum (`setTemperature` clamps).
            const { py } = eventToPixels(e);
            setTemperature(phaseScales().invY(py));
            return;
        }
        if (!drag) return;
        const { px, py } = eventToPixels(e);
        // A few pixels of slop, so a click with a shaky hand is still a click.
        if (Math.abs(px - drag.px) > 3 || Math.abs(py - drag.py) > 3) drag.moved = true;
        if (!drag.moved) return;
        const p = plotRect();
        const s = drag.start;
        // Dragging moves the data with the cursor, so the deltas are inverted.
        const dx = -((px - drag.px) / p.w) * (s.xMax - s.xMin);
        const dt = ((py - drag.py) / p.h) * (s.tMax - s.tMin);
        const limit = viewBounds();
        [view.xMin, view.xMax] = shiftRange(s.xMin, s.xMax, dx, limit.xMin, limit.xMax);
        [view.tMin, view.tMax] = shiftRange(s.tMin, s.tMax, dt, limit.tMin, limit.tMax);
        if (!panFrame) {
            panFrame = true;
            requestAnimationFrame(() => { panFrame = false; render(false); });
        }
    });

    // A press that did not move is a click, which sets the temperature; only a
    // real pan triggers a sweep.
    window.addEventListener('mouseup', (e) => {
        if (scrub) {
            scrub = false;
            phaseCanvas.classList.remove('scrubbing');
            return;
        }
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        phaseCanvas.classList.remove('panning');
        if (moved) { scheduleRecompute(0); return; }
        const at = eventToPlot(e);
        // With the Gibbs panel folded there is no isotherm to move.
        if (gibbsOpen && at.inside) setTemperature(at.t);
    });
}

// ----------------------------------------------------------- hover readout --
//
// What is stable under the cursor.

let hoverPoint = null;       // { x, t } in data units
let hoverPending = false;

// Clears both overlays. They share one crosshair, so clearing only one would
// leave half of it behind.
function clearOverlay() {
    for (const c of [phaseOverlay, boundaryOverlay]) {
        const { width, height } = logicalSize(c);
        c.getContext('2d').clearRect(0, 0, width, height);
    }
}

function scheduleHoverDraw() {
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(() => { hoverPending = false; drawHover(); });
}

// What the last sweep calls each field of its raster, keyed `(phase << 2) |
// set`: the names its region labels use. `fieldSides` holds the two sides of a
// gap that splits one field, lower x first. Replaced with each sweep.
let fieldNames = new Map();
let fieldSides = new Map();
function adoptFieldNames(report) {
    const rows = report.field_names || [];
    fieldNames = new Map(rows.map((f) => [(f.phase_index << 2) | f.set, f.name]));
    fieldSides = new Map(rows.filter((f) => f.sides)
        .map((f) => [(f.phase_index << 2) | f.set, f.sides]));
}

/// The raster cell nearest (x, T) that holds the same phases as `cell`, or
/// null. `phase_at` builds one hull, so its sets only rank phases on that hull;
/// the raster's sets identify the field across T, and `field_names` is keyed by
/// them. The search runs outward in rings, since the hover and the raster can
/// put a boundary one cell apart, and stops after `FIELD_SEARCH_CELLS` rings: a
/// stale raster may hold the same phases only in a distant field.
const FIELD_SEARCH_CELLS = 3;
function rasterFieldCell(cell, x, t) {
    const r = boundaryData, w = r?.window;
    const cols = r?.cell_cols, rows = r?.cell_rows;
    if (!r?.cells || !w || !cols || !rows || !(w.xMax > w.xMin) || !(w.tMax > w.tMin)) {
        return null;
    }
    // Row 0 is `tMin`, as in `drawCoexDots`'s lookup.
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - w.xMin) / (w.xMax - w.xMin) * cols)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((t - w.tMin) / (w.tMax - w.tMin) * rows)));
    for (let k = 0; k <= FIELD_SEARCH_CELLS; k++) {
        for (let dy = -k; dy <= k; dy++) {
            const y = cy + dy;
            if (y < 0 || y >= rows) continue;
            // The whole row on the ring's top and bottom, its two ends
            // otherwise.
            const step = Math.abs(dy) === k ? 1 : 2 * k;
            for (let dx = -k; dx <= k; dx += step) {
                const xx = cx + dx;
                if (xx < 0 || xx >= cols) continue;
                const c = decodePhaseCell(r.cells[y * cols + xx]);
                if (c.kind === cell.kind && c.a === cell.a && c.b === cell.b) return c;
            }
        }
    }
    return null;
}

// The names of the two coexisting phases, left then right, as the region
// labels name them. The two sides of a gap take the engine's side names, such
// as "LIQUID (Cu-rich)" and "LIQUID (Pb-rich)".
//
// A cell sorts two different phases by index, not by side, so the order comes
// from `tie` (`tie_line_at`), whose third entry is the left-hand phase. A gap's
// sets are already in left-to-right order.
function phaseEndNames(cell, x, t, tie) {
    const base = (i) => tdbInfo?.phase_names?.[i] ?? `phase ${i}`;
    const leftFirst = (a, b, pair) => (a !== b && tie?.[2] === b ? [pair[1], pair[0]] : pair);
    const f = rasterFieldCell(cell, x, t);
    if (!f) return leftFirst(cell.a, cell.b, [base(cell.a), base(cell.b)]);
    const sides = fieldSides.get((f.a << 2) | f.aSet);
    if (f.kind === PHASE_KIND.MISCIBILITY_GAP && f.aSet === f.bSet && sides) return sides;
    const named = (i, set) => fieldNames.get((i << 2) | set) ?? base(i);
    return leftFirst(f.a, f.b, [named(f.a, f.aSet), named(f.b, f.bSet)]);
}

function describePoint(cell, x, t, tie) {
    const [a, b] = phaseEndNames(cell, x, t, tie);
    return cell.kind === PHASE_KIND.SINGLE ? a : `${a} + ${b}`;
}

// The tie line's endpoint marker, shared by the diagram and the energy panel,
// since the tie line and the common tangent are the same equilibrium. It has no
// ring, which would cut the dot in two on a dashed tangent. `ground` is unused.
const TIE_DOT_R = 4.5;

// `color` has no default: the canvas ignores `fillStyle = undefined` and fills
// in black, which is invisible on the dark panel.
function tieDot(ctx, px, py, ground, color) {
    ctx.beginPath();
    ctx.arc(px, py, TIE_DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

// The ink of the cursor's tie line. With the Gibbs panel open, lime belongs to
// the isotherm's equilibrium, so the cursor's tie line takes the text colour;
// with the panel folded it is lime. The readout box keeps lime on its answering
// line either way.
function hoverInk() {
    return gibbsOpen ? palette.text : palette.highlight;
}

function sameAssemblage(a, b) {
    return a.kind === b.kind && a.a === b.a && a.aSet === b.aSet
        && a.b === b.b && a.bSet === b.bSet;
}

function drawHover() {
    clearOverlay();
    drawUnnamedHover(phaseOverlay.getContext('2d'), phaseScales(phaseOverlay));
    if (!hoverPoint || !currentTdb || !tdbHandle) {
        delete phaseOverlay.dataset.hover;
        return;
    }

    const ctx = phaseOverlay.getContext('2d');
    const s = phaseScales(phaseOverlay);
    const { x: ML, y: MT, w: plotW, h: plotH } = s.rect;
    const mapX = s.mapX, mapT = s.mapY;

    const { x, t } = hoverPoint;
    const px = mapX(x), py = mapT(t);
    const cell = decodePhaseCell(tdbHandle.phase_at(x, t, tdbParamsJson));
    const ink = hoverInk();

    // Whether the panel below shows the same equilibrium as the cursor. The
    // curves are drawn at `params.temp`, so the panel lights a construction
    // only when the phases at the cursor's T and at `params.temp` are the same.
    const agrees = gibbsOpen && sameAssemblage(cell, decodePhaseCell(
        tdbHandle.phase_at(x, params.temp, tdbParamsJson)));

    ctx.save();
    ctx.beginPath();
    ctx.rect(ML, MT, plotW, plotH);
    ctx.clip();

    // Two dashed lines across the plot. Each piece starts at the plot's edge,
    // so the dashes stay put as the pointer moves.
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = withAlpha(palette.text, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ML, py); ctx.lineTo(px, py);
    ctx.moveTo(ML + plotW, py); ctx.lineTo(px, py);
    ctx.moveTo(px, MT); ctx.lineTo(px, py);
    ctx.moveTo(px, MT + plotH); ctx.lineTo(px, py);
    ctx.stroke();
    ctx.setLineDash([]);

    // The tie line through this point: the two compositions in equilibrium.
    // `[x_left, x_right, phase_left, phase_right]`, or empty.
    const tie = tdbHandle.tie_line_at(x, t, tdbParamsJson);
    if (tie.length) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(mapX(tie[0]), py); ctx.lineTo(mapX(tie[1]), py);
        ctx.stroke();
        for (const tx of tie.slice(0, 2)) tieDot(ctx, mapX(tx), py, palette.bg, ink);
    }
    ctx.restore();

    // Readout, kept inside the plot and flipped away from the edges.
    const xd = (v) => xToDisplay(v).toFixed(units.composition === 'x' ? 3 : 1);

    // A tie line can have zero length where a boundary meets the edge of the
    // diagram; its lever fractions would be 0/0.
    const span = tie.length ? tie[1] - tie[0] : 0;
    const hasLever = span > 1e-9;

    const lines = [
        `x = ${xd(x)} ${xUnitLabel()}   T = ${tToDisplay(t).toFixed(1)} ${tUnitLabel()}`,
    ];
    // `liveLine` is drawn in `--highlight`: the line that says what is here.
    let liveLine = -1;

    // The lever line names both phases, so the phase line is shown only when
    // there is no lever: a single-phase field or a zero-length tie line.
    if (!hasLever) {
        lines.push(describePoint(cell, x, t, tie));
        liveLine = lines.length - 1;
    }

    if (tie.length) {
        lines.push(`tie-line  ${xd(tie[0])} \u2192 ${xd(tie[1])}`);
        // The lever rule: the amount of each phase at this point. On x it is a
        // molar fraction whatever the axis unit, so it is labelled mol and never
        // converted.
        if (hasLever) {
            const right = Math.min(1, Math.max(0, (x - tie[0]) / span));
            const pc = (f) => `${(f * 100).toFixed(0)} %`;
            const [ln, rn] = phaseEndNames(cell, x, t, tie);
            lines.push(`lever  ${pc(1 - right)} ${ln} \u00b7 ${pc(right)} ${rn} (mol)`);
            liveLine = lines.length - 1;
        }
    }
    // The readout is canvas text; the harness reads it from here.
    phaseOverlay.dataset.hover = JSON.stringify({ x, t, lines });
    ctx.font = '11px ' + LABEL_FONT;
    const boxW = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16;
    const boxH = lines.length * 15 + 10;
    let bx = px + 12, by = py + 12;
    if (bx + boxW > ML + plotW) bx = px - 12 - boxW;
    if (by + boxH > MT + plotH) by = py - 12 - boxH;

    ctx.fillStyle = withAlpha(palette.bg, 0.92);
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx, by, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
        ctx.fillStyle = i === liveLine ? palette.highlight : palette.text;
        ctx.fillText(line, bx + 8, by + 6 + i * 15);
    });

    drawHoverInGibbs(x, agrees);
}

// The cursor's composition, continued into the panel below. The two plots share
// the x axis, so the line meets a boundary in the diagram and the matching
// tangent endpoint in the panel at the same screen column.
function drawHoverInGibbs(x, agrees) {
    if (!gibbsOpen) return;
    const s = gibbsXScale();
    const { x: ML, y: MT, w: plotW, h: plotH } = s.rect;
    if (plotW <= 0 || plotH <= 0) return;
    const px = s.mapX(x);
    if (px < ML || px > ML + plotW) return;

    const ctx = boundaryOverlay.getContext('2d');
    ctx.save();
    // Clipped: a tangent endpoint is often outside the window while its field
    // is inside it.
    ctx.beginPath();
    ctx.rect(ML, MT, plotW, plotH);
    ctx.clip();

    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = withAlpha(palette.text, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, MT);
    ctx.lineTo(px, MT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    if (agrees) drawHoveredConstruction(ctx, x);
    ctx.restore();
}

// Lights, in lime, the panel construction under the cursor: the common tangent
// that spans x, or the lowest curve when none does. Called only when the
// diagram and the panel agree (`agrees`).
function drawHoveredConstruction(ctx, x) {
    const gs = gibbsScales();
    if (!gs) return;
    const { curveData, tangents } = gibbsEnergies();
    const mapX = gs.mapX, mapG = gs.mapY;

    // A tangent spanning this composition: two phases coexist, and the tangent
    // is the tie line in the diagram above.
    for (let i = 0; i < tangents.length; i += 2) {
        const x1 = tangents[i], x2 = tangents[i + 1];
        if (x < Math.min(x1, x2) || x > Math.max(x1, x2)) continue;
        const g1 = hullG(curveData, x1), g2 = hullG(curveData, x2);
        if (!isFinite(g1) || !isFinite(g2)) return;
        // The same dash as the other tangents, so only the hue changes.
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = palette.highlight;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mapX(x1), mapG(g1));
        ctx.lineTo(mapX(x2), mapG(g2));
        ctx.stroke();
        ctx.setLineDash([]);
        tieDot(ctx, mapX(x1), mapG(g1), palette.surface, palette.highlight);
        tieDot(ctx, mapX(x2), mapG(g2), palette.surface, palette.highlight);
        // The cursor's point on the tangent: the mixture's Gibbs energy at x.
        // Its position between the endpoints is the lever rule the readout
        // states.
        const at = g1 + (g2 - g1) * (x - x1) / (x2 - x1);
        if (isFinite(at)) tieDot(ctx, mapX(x), mapG(at), palette.surface,
                                 palette.highlight);
        return;
    }

    // No tangent spans x, so one phase is stable: light the lowest curve.
    let best = null;
    for (const c of curveData) {
        if (c.type !== 'sub') continue;
        const g = interpG(c.g, x);
        if (!isFinite(g)) continue;
        if (!best || g < best.g) best = { name: c.name, g };
    }
    if (!best) return;

    // Drawn from the windowed samples the panel drew, so the lit curve lies on
    // the drawn one when zoomed. The window comes from `currentView()`, not the
    // scale's inverse: the cache is keyed on the exact numbers `drawGibbsCurves`
    // passed, and a round trip through pixels changes the last bit.
    const v = currentView();
    const windowed = gibbsWindowedCurves(v.xMin, v.xMax);
    const curve = windowed.find(c => c.name === best.name);
    if (curve) {
        ctx.strokeStyle = palette.highlight;
        ctx.lineWidth = 2;
        ctx.beginPath();
        curve.g.forEach((gv, i) => {
            const cx = mapX(gs.xOfIndex(i, curve.g.length));
            if (i === 0) ctx.moveTo(cx, mapG(gv)); else ctx.lineTo(cx, mapG(gv));
        });
        ctx.stroke();
    }
    tieDot(ctx, mapX(x), mapG(best.g), palette.surface, palette.highlight);
}

function setupHoverReadout() {
    phaseCanvas.addEventListener('mousemove', (e) => {
        if (!currentTdb || !view) return;
        const at = eventToPlot(e);
        // Panning and scrubbing both own the cursor while in progress.
        if (!at.inside || scrub || phaseCanvas.classList.contains('panning')) {
            phaseCanvas.classList.remove('over-isotherm');
            hoverPoint = null;
            clearOverlay();
            return;
        }
        // The resize cursor over the isotherm.
        phaseCanvas.classList.toggle('over-isotherm', isothermHit(at.py));
        hoverPoint = { x: at.x, t: at.t };
        scheduleHoverDraw();
    });

    phaseCanvas.addEventListener('mouseleave', () => {
        // A fast exit fires no `mousemove` to clear the classes, and the resize
        // cursor would stay.
        phaseCanvas.classList.remove('over-isotherm');
        hoverPoint = null;
        clearOverlay();
    });

    // Hovering the energy panel reads out the diagram at (x, params.temp), the
    // temperature the curves are drawn at.
    boundaryCanvas.addEventListener('mousemove', (e) => {
        if (!currentTdb || !view || scrub) return;
        const { px, py } = eventToPixels(e, boundaryCanvas);
        const s = gibbsXScale();
        if (!s.contains(px, py)) {
            hoverPoint = null;
            clearOverlay();
            return;
        }
        hoverPoint = { x: s.invX(px), t: params.temp };
        scheduleHoverDraw();
    });

    boundaryCanvas.addEventListener('mouseleave', () => {
        hoverPoint = null;
        clearOverlay();
    });

    // The energy panel does not zoom. It shares the diagram's x axis, so a
    // wheel here would zoom the diagram in x alone. The wheel is still
    // swallowed so the page does not scroll under the pointer.
    boundaryCanvas.addEventListener('wheel', (e) => {
        const s = gibbsXScale();
        const { px, py } = eventToPixels(e, boundaryCanvas);
        if (s.contains(px, py)) e.preventDefault();
    }, { passive: false });
}

// ---------------------------------------------------------------- keyboard --
//
// Every gesture the two plots have, without a pointer.
//
//   ↑ / ↓                the isotherm, one slider step (nothing, folded)
//   PageUp / PageDown    the isotherm, ten steps (nothing, folded)
//   ← / →                the crosshair, 1 % of the visible composition range
//   Home / End           the crosshair to the window's edges
//   Shift + arrow        pan
//   + / -                zoom about the crosshair, else the window centre
//   0                    reset the view to the fitted window
//   Escape               clear the crosshair
//
// Each key calls the function the mouse calls, so the two inputs cannot
// disagree. Temperature and crosshair keys never sweep; pan and zoom go through
// `scheduleRecompute()` as the wheel and drag do. A held key repeats, so redraws
// are coalesced into frames.
//
// The keyboard crosshair sits at `params.temp`, as the G panel's hover does,
// and follows the isotherm when ↑ / ↓ move it.

const KEY_PAN_FRACTION  = 0.08;   // of the visible span, per press
const KEY_ZOOM_FACTOR   = 1.25;
const KEY_X_STEP        = 0.01;   // of the visible composition range

let diagramKeyFrame = false;
function scheduleDiagramKeyDraw() {
    if (diagramKeyFrame) return;
    diagramKeyFrame = true;
    requestAnimationFrame(() => { diagramKeyFrame = false; render(false); });
}

function keyboardCrosshair(x) {
    const v = currentView();
    hoverPoint = { x: Math.min(v.xMax, Math.max(v.xMin, x)), t: params.temp };
    scheduleHoverDraw();
}

// Returns whether it moved the temperature. With the Gibbs panel folded there
// is no isotherm, slider or curve to show T, so it does nothing and the key
// scrolls the page. The mouse paths into T are gated the same way.
function keyboardTemperature(steps) {
    if (!gibbsOpen) return false;
    const step = Number(tempSlider.step) || 1;
    setTemperature(params.temp + steps * step);
    // The crosshair is read at `params.temp`, so it follows.
    if (hoverPoint) keyboardCrosshair(hoverPoint.x);
    return true;
}

function keyboardPan(dxFraction, dtFraction) {
    const limit = viewBounds();
    if (dxFraction) {
        [view.xMin, view.xMax] = shiftRange(view.xMin, view.xMax,
            dxFraction * (view.xMax - view.xMin), limit.xMin, limit.xMax);
    }
    if (dtFraction) {
        [view.tMin, view.tMax] = shiftRange(view.tMin, view.tMax,
            dtFraction * (view.tMax - view.tMin), limit.tMin, limit.tMax);
    }
    scheduleDiagramKeyDraw();
    scheduleRecompute();
}

// `vertical` is false in the G panel, which has no temperature axis.
function keyboardZoom(factor, vertical) {
    const limit = viewBounds();
    const ax = hoverPoint ? hoverPoint.x : (view.xMin + view.xMax) / 2;
    [view.xMin, view.xMax] = zoomRange(view.xMin, view.xMax, factor, ax,
        limit.xMin, limit.xMax, MIN_VIEW_X_SPAN);
    if (vertical) {
        // Anchored on the isotherm, where the crosshair is in T.
        const at = params.temp >= view.tMin && params.temp <= view.tMax
            ? params.temp : (view.tMin + view.tMax) / 2;
        [view.tMin, view.tMax] = zoomRange(view.tMin, view.tMax, factor, at,
            limit.tMin, limit.tMax, MIN_VIEW_T_SPAN);
    }
    scheduleDiagramKeyDraw();
    scheduleRecompute();
}

function onDiagramKey(e, vertical) {
    if (!currentTdb || !view) return;
    // Browser and OS shortcuts win; Ctrl+0, for one, resets the page zoom.
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const v = currentView();
    const xStep = (v.xMax - v.xMin) * KEY_X_STEP;
    // The first press puts the crosshair at the centre of the window.
    const nudge = (dir) => keyboardCrosshair(
        hoverPoint ? hoverPoint.x + dir * xStep : (v.xMin + v.xMax) / 2);

    let handled = true;
    switch (e.key) {
        case 'ArrowUp':
            if (!e.shiftKey) handled = keyboardTemperature(1);
            else if (vertical) keyboardPan(0, KEY_PAN_FRACTION);
            else handled = false;
            break;
        case 'ArrowDown':
            if (!e.shiftKey) handled = keyboardTemperature(-1);
            else if (vertical) keyboardPan(0, -KEY_PAN_FRACTION);
            else handled = false;
            break;
        case 'PageUp':   handled = keyboardTemperature(10);  break;
        case 'PageDown': handled = keyboardTemperature(-10); break;
        case 'ArrowLeft':
            if (e.shiftKey) keyboardPan(-KEY_PAN_FRACTION, 0); else nudge(-1);
            break;
        case 'ArrowRight':
            if (e.shiftKey) keyboardPan(KEY_PAN_FRACTION, 0); else nudge(1);
            break;
        case 'Home': keyboardCrosshair(v.xMin); break;
        case 'End':  keyboardCrosshair(v.xMax); break;
        // `=` is the unshifted `+` key on most layouts, so both zoom in.
        case '+': case '=': keyboardZoom(1 / KEY_ZOOM_FACTOR, vertical); break;
        case '-': case '_': keyboardZoom(KEY_ZOOM_FACTOR, vertical);    break;
        case '0':
            applyFittedView();
            render(true);
            break;
        case 'Escape':
            hoverPoint = null;
            clearOverlay();
            break;
        default: handled = false;
    }
    // Only keys that did something; the rest keep their default (scrolling).
    if (handled) e.preventDefault();
}

function setupDiagramKeys() {
    phaseCanvas.addEventListener('keydown', (e) => onDiagramKey(e, true));
    boundaryCanvas.addEventListener('keydown', (e) => onDiagramKey(e, false));
}

// ------------------------------------------------------------- update loop --
//
// Recompute and redraw when a setting changes.

function clearCanvases() {
    clearOverlay();
    for (const c of [phaseCanvas, boundaryCanvas]) {
        const { width, height } = logicalSize(c);
        c.getContext('2d').clearRect(0, 0, width, height);
    }
    timingBar.textContent = '\u2014';
    memoryBar.textContent = '';
    lastRaster = null;
    // Each panel is blanked through the function that builds it, so its summary
    // line ("2 phases", "1 reaction") is cleared with its body.
    rebuildPhaseLegend();
    drawInvariantReadout(null);
    drawFitPanel(null);
    // The Diagnostics summary goes with the timing bar.
    setStatusBrief('diagnostics-brief', '');
}

function update() {
    // A direct call cancels any queued slider frame, which would recompute the
    // state this call replaces.
    if (updateFrame !== null) {
        cancelAnimationFrame(updateFrame);
        updateFrame = null;
    }
    render(true);
}

// At most one update per animation frame while a slider is dragged. The sweep
// itself is coalesced by `requestSweep`.
function scheduleUpdate() {
    if (updateFrame !== null) return;
    updateFrame = requestAnimationFrame(() => { updateFrame = null; update(); });
}

// Redraws after a temperature change, without a sweep. `params.temp` reaches
// only `g_curve`, `g_compound` and `tangents`, so the diagram's raster and
// boundaries are unchanged. A queued full update does this work itself.
function renderTemperature() {
    if (!wasm || !currentTdb || engineDead) return;
    if (updateFrame !== null) return;
    // Both panels: the diagram draws the isotherm.
    render(false);
}

function scheduleTemperatureDraw() {
    if (tempFrame !== null) return;
    tempFrame = requestAnimationFrame(() => { tempFrame = null; renderTemperature(); });
}

// Sets the figure's theme. The class goes first, since `refreshPalette` reads
// the computed tokens off the card. No sweep: the cells do not depend on colour,
// but the cached bitmap does, so `paletteGeneration` is bumped to repaint it.
function setFigureTheme(name) {
    figureTheme = name === 'light' ? 'light' : 'dark';
    figureCard.classList.toggle('fig-light', figureTheme === 'light');
    refreshPalette(figureCard);
    paletteGeneration++;
    setPressed(figureThemeBtn, figureTheme === 'light');
    // The legend swatches use the same palette as the fills.
    rebuildPhaseLegend();
    rebuildExpPanel();
    render(false);
}

// `recompute: false` redraws from the cached raster and boundaries at the
// current view, as during a pan or zoom.
function render(recompute = true) {
    if (engineDead) return;
    // Every change to the screen ends here, so the URL (debounced) and the
    // Reset button's visibility are kept in step from this one place.
    scheduleUrlSync();
    syncResetButton();
    try {
        renderInner(recompute);
    } catch (e) {
        // A trap leaves the module dead and every later frame would throw too,
        // so it is reported once and rendering stops.
        if (!reportEngineTrap(e, currentTdb)) throw e;
    }
}

// ------------------------------------------------------------ sweep worker --
//
// `compute_boundaries` can take a second on a large system, so it runs in
// `app/boundary-worker.js`, which documents the protocol. On this side:
//
//   * One request in flight and one waiting. A request replaced before it is
//     sent is dropped, and Diagnostics counts the drops. A result that arrives
//     answers the newest request sent, and is installed.
//   * The result carries the window it was solved over (`adoptSweep`), so the
//     raster stays registered when the view has moved since the request.
//   * The first sweep for a database, and any sweep while a link is restored,
//     run on this thread, so the app never opens on blank axes or on the
//     previous system's raster while the worker parses its copy.
//   * A failed worker (a trap, which arrives as the `error` event, or an
//     exception) is discarded for the session and sweeps run here. A trap is
//     deterministic, so rebuilding the worker would only trap again.

let sweepWorker = null;
let sweepWorkerBroken = false;
/// Why the sweep is running on this thread, shown beside every timing line.
let sweepWorkerNote = '';
/// The database key whose text the worker holds, so a sweep message carries the
/// text only when the key changes.
let sweepWorkerKey = null;
/// The same for the comparison database, which is loaded and replaced
/// independently of the main one.
let sweepWorkerBaselineKey = null;
let sweepSeq = 0;
let sweepInFlight = null;
let sweepQueued = null;
let sweepSuperseded = 0;
/// Cleared by the first sweep that runs on this thread after a database loads.
let firstSweepForDatabase = true;

function sweepRunsHere() {
    return sweepWorkerBroken || firstSweepForDatabase || restoring;
}

/// Everything one sweep needs, captured when it is requested, so the answer can
/// be matched to its arguments when it returns.
function sweepRequest() {
    const expJson = visibleExpPointsJson();
    return {
        id: ++sweepSeq,
        key: tdbKey,
        paramsJson: tdbParamsJson,
        expJson,
        // `attachResiduals` indexes into this order; a snapshot keeps residuals
        // on the right points if a dataset is hidden mid-sweep.
        expOrder: expPointOrder,
        view: { xMin: view.xMin, xMax: view.xMax, tMin: view.tMin, tMax: view.tMax },
        wantBaseline: baselineWanted(),
        // The ghost's source, snapshotted so a ghost that lands after the
        // comparison changed is filed under the database it came from.
        baselineSrc: baselineSource(),
        postedAt: 0,
    };
}

/// Null once the worker has failed, and every sweep then runs in the page.
function getSweepWorker() {
    if (sweepWorkerBroken) return null;
    if (sweepWorker) return sweepWorker;
    const worker = new Worker(new URL('./boundary-worker.js', import.meta.url),
                              { type: 'module' });
    worker.onmessage = (e) => onSweepMessage(e.data);
    // A Rust panic in the worker is a trap: it skips the worker's try/catch
    // and arrives here, with the instance already dead.
    worker.onerror = (e) => disposeSweepWorker(e.message || 'the sweep worker crashed');
    sweepWorker = worker;
    sweepWorkerKey = null;
    return worker;
}

/// Sends the worker the database as soon as it loads, so the first sweep there
/// does not also pay for the parse.
function warmSweepWorker() {
    if (!currentTdbText) return;
    const worker = getSweepWorker();
    if (!worker) return;
    worker.postMessage({ type: 'warm', tdbText: currentTdbText, tdbKey });
    sweepWorkerKey = tdbKey;
}

function disposeSweepWorker(why) {
    if (sweepWorker) sweepWorker.terminate();
    sweepWorker = null;
    sweepWorkerBroken = true;
    sweepWorkerNote = why;
    sweepWorkerKey = null;
    sweepWorkerBaselineKey = null;
    sweepInFlight = null;
    sweepQueued = null;
    console.warn('sweep worker discarded, computing in the page:', why);
    // Opens the closed Diagnostics panel so the message is seen.
    if (diagnosticsPanel) diagnosticsPanel.open = true;
    // Redraw on this thread now, so the diagram does not stay at the last
    // answer.
    if (currentTdb && !engineDead) update();
}

function requestSweep(req) {
    if (sweepInFlight) {
        if (sweepQueued) sweepSuperseded++;
        sweepQueued = req;
        return;
    }
    postSweep(req);
}

function postSweep(req) {
    const worker = getSweepWorker();
    if (!worker) { sweepHere(req); return; }
    sweepInFlight = req;
    req.postedAt = performance.now();
    const msg = {
        type: 'sweep', id: req.id, tdbKey: req.key,
        paramsJson: req.paramsJson,
        nTSteps: BOUNDARY_T_STEPS, tTolerance: BOUNDARY_T_TOLERANCE,
        xMin: req.view.xMin, xMax: req.view.xMax,
        tMin: req.view.tMin, tMax: req.view.tMax,
        expJson: req.expJson,
        // Only on a cache miss, so a parameter drag computes the ghost once.
        baselineTSteps: req.wantBaseline && !baselineCached(req.view)
            ? BASELINE_T_STEPS : 0,
        // Null: the ghost is this database at its assessed parameters.
        baselineKey: baselineTdb ? baselineTdb.key : null,
    };
    if (sweepWorkerKey !== req.key) {
        msg.tdbText = currentTdbText;
        sweepWorkerKey = req.key;
    }
    // The comparison's text, likewise sent only when the worker lacks it.
    if (baselineTdb && sweepWorkerBaselineKey !== baselineTdb.key) {
        msg.baselineText = baselineTdb.text;
        sweepWorkerBaselineKey = baselineTdb.key;
    }
    worker.postMessage(msg);
    timingBar.textContent = 'Sweep running in the worker…';
}

function onSweepMessage(m) {
    if (!m) return;
    if (m.type === 'error') {
        disposeSweepWorker(m.message || 'the sweep failed');
        return;
    }
    if (m.type !== 'result') return;

    // An answer to a request dropped by Unload: the request in flight now
    // still has its own answer coming.
    if (!sweepInFlight || sweepInFlight.id !== m.id) return;
    const req = sweepInFlight;
    sweepInFlight = null;
    installSweep(req, m);
    drainSweepQueue();
}

function drainSweepQueue() {
    if (!sweepQueued) return;
    const next = sweepQueued;
    sweepQueued = null;
    postSweep(next);
}

function installSweep(req, m) {
    // Dropped if the database changed while the sweep ran.
    if (!currentTdb || !tdbHandle || engineDead || m.key !== tdbKey) return;
    try {
        adoptSweep(req, m.report, m.baseline ? m.baseline.boundaries : null);
        const t1 = performance.now();
        paintFigure(showRaster ? m.report.cells : null);
        workerRssBytes = m.rssBytes;
        reportSweepCost(m.sweepMs, performance.now() - t1,
                        performance.now() - req.postedAt,
                        m.peakHeap, m.rssDelta, true);
    } catch (e) {
        if (!reportEngineTrap(e, currentTdb)) throw e;
    }
}

/// The memory of both WASM instances. The worker holds a second copy of the
/// engine and of the parsed database.
let workerRssBytes = 0;
function wasmMemoryNote() {
    const page = get_wasm_rss_bytes();
    if (!workerRssBytes) return ` | WASM ${(page / 1e6).toFixed(1)} MB`;
    return ` | WASM ${(page / 1e6).toFixed(1)} MB page`
         + ` + ${(workerRssBytes / 1e6).toFixed(1)} MB worker`;
}

// The ghost: the assessed diagram drawn under a perturbed one, so a change
// shows as a displacement. It appears whenever a parameter is off its assessed
// value (`paramsDifferFromAssessed`) and is not a toggle.
//
// It comes from `ghost_boundaries`, which builds no raster, and is computed in
// the worker beside the live sweep. It depends only on the database and the
// temperature window, so it is cached, and only a database change or a
// vertical pan or zoom recomputes it.
let baselineCache = null;
let baselineBoundaries = null;

// The ghost's source. A comparison database (another assessment of the same
// system) takes the assessed parameters' place in the same hueless layer; the
// sliders still show each offset from the assessment.
//
// `flip` is set when the comparison declares its elements in the other order,
// so its x runs the other way and is mirrored onto the live axis.
let baselineTdb = null;      // { text, name, id, key, flip, encoding }
let baselineHandle = null;   // the page's own copy, for the no-worker path
let baselineKeySeq = 0;

/// Maps the comparison's curves onto the live composition axis. Returns a new
/// array: the input belongs to a cache entry, and flipping it in place would
/// flip it again on the next draw.
function baselineToLiveAxis(boundaries) {
    if (!baselineTdb || !baselineTdb.flip || !boundaries) return boundaries;
    return boundaries.map((curve) => ({
        ...curve,
        points: curve.points.map((p) => ({ ...p, x: 1 - p.x })),
    }));
}

/// The ghost's temperature levels: the live diagram's resolution, spread over
/// the visible window rather than the database's declared range. A separate
/// name so a call site says which of the two it means.
const BASELINE_T_STEPS = BOUNDARY_T_STEPS;

function baselineWanted() {
    return Boolean(currentTdb && tdbHandle && view
        && (baselineTdb || paramsDifferFromAssessed()));
}

/// What the cached ghost is of. Part of the cache key, so swapping one
/// comparison for another at the same window recomputes it.
function baselineSource() {
    return baselineTdb ? baselineTdb.key : 'assessed';
}

/// Keyed on the database, the source and the temperature window only, since
/// `ghost_boundaries` takes no composition window.
function baselineCached(v) {
    return Boolean(baselineCache
        && baselineCache.key === tdbKey
        && baselineCache.src === baselineSource()
        && baselineCache.tMin === v.tMin && baselineCache.tMax === v.tMax);
}

/// Publishes the ghost for the sweep now landing. `boundaries` is the assessed
/// curves when this sweep computed them, null when the cache held them or there
/// is nothing to compare against. The ghost changes only when a sweep lands, so
/// the live curves and the ghost always come from the same answer.
function showBaseline(req, boundaries) {
    const had = Boolean(baselineBoundaries);
    if (!req.wantBaseline) {
        baselineBoundaries = null;
    } else {
        if (boundaries) {
            baselineCache = {
                key: req.key,
                src: req.baselineSrc,
                tMin: req.view.tMin, tMax: req.view.tMax,
                data: { boundaries: baselineToLiveAxis(boundaries) },
            };
        }
        baselineBoundaries = baselineCached(req.view) ? baselineCache.data : null;
    }
    // The legend lists the ghost, so it is rebuilt when the ghost appears or
    // goes, and not on every frame of a drag.
    if (Boolean(baselineBoundaries) !== had) rebuildPhaseLegend();
}

/// The ghost computed on this thread, for the no-worker path. Only the
/// boundaries are kept; `drawBaselineGhost` reads nothing else.
function baselineGhostHere(req) {
    if (!req.wantBaseline || baselineCached(req.view)) {
        showBaseline(req, null);
        return;
    }
    // The temperature window needs no mapping between the two databases.
    const handle = baselineHandle || tdbHandle;
    const b = handle.ghost_boundaries(
        '{}', BASELINE_T_STEPS, BOUNDARY_T_TOLERANCE,
        req.view.tMin, req.view.tMax);
    showBaseline(req, b.boundaries);
}

/// Draws the whole figure from what the app holds. `cells` is non-null only on
/// the frame a sweep lands, the only time `lastRaster` is replaced; other draws
/// reuse the cached bitmap at `lastRaster.view`.
function paintFigure(cells) {
    clearOverlay();
    if (hoverPoint) scheduleHoverDraw();
    // `figureLayout` makes the same margin choice for an export.
    drawPhaseDiagram(cells, boundaryData, null, phaseMargin());
    drawInvariantReadout(boundaryData);
    drawFitPanel(residualReport);
    drawGibbsCurves();
}

function renderInner(recompute = true) {
    if (!wasm) return;

    if (!currentTdb) {
        clearCanvases();
        // Empty axes, with or without data: they carry the line saying no
        // database is loaded, and data loaded before a TDB is drawn on them.
        drawPhaseDiagram(null, null, null, phaseMargin());
        return;
    }

    if (!recompute) {
        paintFigure(null);
        return;
    }

    setTdbParamsJson(JSON.stringify(tdbParams));
    const req = sweepRequest();
    if (sweepRunsHere()) {
        sweepHere(req);
    } else {
        requestSweep(req);
        // Until the answer lands, redraw the cached raster at the window it was
        // computed for: incomplete, not wrong.
        paintFigure(null);
    }
}

/// The sweep on this thread: the first sweep, and the fallback when the worker
/// failed. See `sweepRunsHere`.
function sweepHere(req) {
    const t0 = performance.now();
    reset_heap_tracker();
    const rss0 = get_wasm_rss_bytes();
    // Cleared before the call, so a sweep that throws leaves it null for the
    // export guards.
    boundaryData = null;

    const report = tdbHandle.compute_boundaries(
        req.paramsJson, BOUNDARY_T_STEPS, BOUNDARY_T_TOLERANCE,
        req.view.xMin, req.view.xMax, req.view.tMin, req.view.tMax, req.expJson);
    adoptSweep(req, report, undefined);
    const t1 = performance.now();
    // Read before the draw: `drawGibbsCurves` also allocates in WASM, and this
    // number is the sweep's alone.
    const peakHeap = get_peak_heap_bytes();
    const rssDelta = get_wasm_rss_bytes() - rss0;

    firstSweepForDatabase = false;
    paintFigure(showRaster ? report.cells : null);
    const t2 = performance.now();
    reportSweepCost(t1 - t0, t2 - t1, t2 - t0, peakHeap, rssDelta, false);
}

/// Installs a sweep's answer, from either thread. `baseline` is the ghost's
/// curves when they came back with it, null when the cache held them, and
/// `undefined` when this thread must compute them.
function adoptSweep(req, report, baseline) {
    boundaryData = report;
    // The window the cells were solved over: the request's, which the live view
    // may have left since. `drawPhaseDiagram` places the raster with it.
    boundaryData.window = req.view;
    adoptFieldNames(report);
    attachResiduals(report.residuals, req.expOrder);
    if (baseline === undefined) baselineGhostHere(req);
    else showBaseline(req, baseline);
}

/// Writes the Diagnostics timings. On the worker path `compute` is the worker's
/// time and `total` runs from posting the request, so the difference is
/// queueing, message passing and the draw.
function reportSweepCost(computeMs, renderMs, totalMs, peakHeap, rssDelta, inWorker) {
    const dropped = sweepSuperseded > 0
        ? ` | ${sweepSuperseded} superseded, never computed` : '';
    timingBar.textContent =
        `Compute: ${computeMs.toFixed(1)} ms${inWorker ? ' (worker)' : ''} `
        + `| Render: ${renderMs.toFixed(1)} ms | Total: ${totalMs.toFixed(1)} ms`
        + `${dropped}${sweepWorkerNote ? ` | on the page: ${sweepWorkerNote}` : ''}`;
    memoryBar.textContent =
        `Logical: ${(peakHeap / 1024).toFixed(0)} KB `
        + `| Physical Δ: ${(rssDelta / 1024).toFixed(0)} KB`
        + `${wasmMemoryNote()}`;
    // The summary shown on the closed panel.
    setStatusBrief('diagnostics-brief',
        `${totalMs.toFixed(0)} ms${inWorker ? '' : ', on the page'}`);
}

// ----------------------------------------------------------------- drawing --

// Linearly interpolates a G-curve array at composition x ∈ [0, 1].
function interpG(gArr, x) {
    const n = gArr.length;
    const fi = x * (n - 1);
    const lo = Math.floor(fi);
    const hi = Math.min(lo + 1, n - 1);
    const t = fi - lo;
    return gArr[lo] * (1 - t) + gArr[hi] * t;
}

// The hull's energy at composition x: the lowest G of any phase there. A line
// compound counts only at its own x, matched to `tangents()`'s `x_fixed`
// within 1e-9.
function hullG(curveData, x) {
    let best = Infinity;
    curveData.forEach(c => {
        const v = c.type === 'comp'
            ? (Math.abs(c.x - x) < 1e-9 ? c.g : Infinity)
            : interpG(c.g, x);
        if (v < best) best = v;
    });
    return best;
}

// The raster's shape from the sweep report, or the grid globals without one.
// `ok` is false when the cell count does not match, which would shear the image.
function rasterShape(data, report) {
    const cols = report && report.cell_cols > 0 ? report.cell_cols : get_grid_width();
    const rows = report && report.cell_rows > 0 ? report.cell_rows : get_grid_height();
    return { cols, rows, ok: Number.isInteger(rows) && Number.isInteger(cols)
                              && rows * cols === (data ? data.length : 0) };
}

// The isotherm: the G panel's temperature, marked on the diagram. Drawn into
// the diagram rather than the overlay, so it stays on mouse-out and is
// exported. Its markers are the tie-line endpoints from `tangents(T)`, the G
// panel's numbers, not crossings of the interpolated boundary polylines. `dim`
// while an unnamed field is lit, so the lit field is the only `--highlight`.
function drawIsotherm(ctx, mapX, mapT, rect, dim = false) {
    if (!currentTdb || !tdbHandle) return;
    const t = params.temp;
    const v = currentView();
    if (t < v.tMin || t > v.tMax) return;
    const py = mapT(t);

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();

    // Snapped to a half pixel, and cased like the boundary curves.
    const ly = Math.round(py) + 0.5;
    ctx.setLineDash([]);
    ctx.strokeStyle = palette.bg;
    ctx.lineWidth = 3.5;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(rect.x, ly);
    ctx.lineTo(rect.x + rect.w, ly);
    ctx.stroke();

    const ink = dim ? palette.textDim : palette.highlight;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(rect.x, ly);
    ctx.lineTo(rect.x + rect.w, ly);
    ctx.stroke();

    const { tangents } = gibbsEnergies();
    for (const x of tangents) {
        ctx.beginPath();
        ctx.arc(mapX(x), py, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = ink;
        ctx.fill();
        ctx.strokeStyle = palette.bg;
        ctx.lineWidth = 1.2;
        ctx.stroke();
    }
    ctx.restore();
}

// -------------------------------------------------------- coexistence fill --
//
// A two-phase field is washed in one phase's hue, with a lattice of dots in
// the other's. The wash is one colour per cell, in the bitmap; the lattice is
// drawn in screen space after the raster is placed, so its pitch does not
// stretch with the window.

const COEX_DOT_R = 1.8;
const COEX_DOT_ALPHA = 0.40;

/// Lattice pitch in CSS pixels, scaled with the plot's width. Below 12 px the
/// dots compete with the curves; above 18 they stop reading as a texture.
const COEX_PITCH_MIN = 12;
const COEX_PITCH_MAX = 18;
const COEX_PITCH_REF_W = 660;
function coexPitch(plotW) {
    return Math.min(COEX_PITCH_MAX, Math.max(COEX_PITCH_MIN,
        COEX_PITCH_MAX * plotW / COEX_PITCH_REF_W));
}

/// Which fill scheme this raster gets. `textured`: some field has two different
/// phases and gets the lattice. `gap`: some field is a miscibility gap, washed
/// in its hue with no dots. The bitmap, the lattice and the legend key all ask
/// this one function so they agree. Cached on the cells array.
let coexSchemeCache = { cells: null, out: { textured: false, gap: false } };
function coexScheme(cells) {
    if (!cells) return { textured: false, gap: false };
    if (coexSchemeCache.cells === cells) return coexSchemeCache.out;
    let textured = false, gap = false;
    for (let i = 0; i < cells.length; i++) {
        if (((cells[i] >>> 16) & 0x3) === PHASE_KIND.SINGLE) continue;
        if (((cells[i] >>> 8) & 0xff) === (cells[i] & 0xff)) gap = true;
        else textured = true;
    }
    const out = { textured, gap };
    coexSchemeCache = { cells, out };
    return out;
}

/// Which of a field's two phases takes the wash (the left-hand one) and which
/// the dots. Cells store the pair sorted by phase index, so each (phase, set)
/// gets its mean column over the whole raster and the smaller mean washes.
/// Whole-raster, not per row, so roles do not swap partway up a leaning field.
function coexRoles(cells, gridW) {
    const sum = new Map(), n = new Map();
    const note = (key, col) => {
        sum.set(key, (sum.get(key) || 0) + col);
        n.set(key, (n.get(key) || 0) + 1);
    };
    for (let i = 0; i < cells.length; i++) {
        const c = decodePhaseCell(cells[i]);
        const col = i % gridW;
        note((c.a << 2) | c.aSet, col);
        if (c.kind !== PHASE_KIND.SINGLE) note((c.b << 2) | c.bSet, col);
    }
    const mean = new Map();
    for (const [k, s] of sum) mean.set(k, s / n.get(k));
    return mean;
}

/// The wash and dot hues for one coexistence cell. `flat` marks a miscibility
/// gap, which gets no dots since they would be the same hue.
function coexPair(cell, roles) {
    if (cell.a === cell.b) {
        const flat = phaseColorSet(cell.a, cell.aSet);
        return { wash: flat, dot: flat, flat: true };
    }
    const ka = (cell.a << 2) | cell.aSet, kb = (cell.b << 2) | cell.bSet;
    const left = (roles.get(ka) ?? 0) <= (roles.get(kb) ?? 0)
        ? [cell.a, cell.aSet, cell.b, cell.bSet]
        : [cell.b, cell.bSet, cell.a, cell.aSet];
    return { wash: phaseColorSet(left[0], left[1]),
             dot: phaseColorSet(left[2], left[3]), flat: false };
}

function coexWashColor(code, roles) {
    const cell = decodePhaseCell(code);
    if (cell.kind === PHASE_KIND.SINGLE) return phaseColorSet(cell.a, cell.aSet);
    // Washed toward the ground, so it differs from the single-phase field of
    // the same hue beside it.
    return mixColors(palette.surface, coexPair(cell, roles).wash, palette.coexWash);
}

/// The dot lattice, in screen space over the placed raster. Each site looks up
/// the cell under it and draws only inside a two-phase field.
function drawCoexDots(ctx, r, mapX, mapT, rect) {
    if (!r.cells || !coexScheme(r.cells).textured) return;
    const cols = r.shape.cols, rows = r.shape.rows;
    const rv = r.view;
    const x0 = mapX(rv.xMin), x1 = mapX(rv.xMax);
    const yTop = mapT(rv.tMax), yBot = mapT(rv.tMin);
    if (!(x1 > x0) || !(yBot > yTop)) return;
    const roles = coexRoles(r.cells, cols);

    const P = coexPitch(rect.w), R = COEX_DOT_R;
    const left = Math.max(rect.x, x0), right = Math.min(rect.x + rect.w, x1);
    const top = Math.max(rect.y, yTop), bottom = Math.min(rect.y + rect.h, yBot);

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.globalAlpha = COEX_DOT_ALPHA;
    // Phased on the plot rect, not the loop bounds, so a pan does not slide the
    // lattice under a still field. `ceil` keeps odd rows offset by half a
    // pitch; a modulo would realign them into a square grid.
    const first = (edge, from) => from + Math.ceil((edge - from) / P) * P;
    let row = 0;
    for (let py = first(top, rect.y); py < bottom; py += P, row++) {
        const stagger = row % 2 ? P / 2 : 0;
        for (let px = first(left, rect.x + stagger); px < right; px += P) {
            const cx = Math.floor((px - x0) / (x1 - x0) * cols);
            const cy = Math.floor((yBot - py) / (yBot - yTop) * rows);
            if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
            const cell = decodePhaseCell(r.cells[cy * cols + cx]);
            if (cell.kind !== PHASE_KIND.TWO_PHASE
                && cell.kind !== PHASE_KIND.MISCIBILITY_GAP) continue;
            const pair = coexPair(cell, roles);
            if (pair.flat) continue;   // a gap's two hues are one hue
            ctx.fillStyle = pair.dot;
            ctx.beginPath();
            ctx.arc(px, py, R, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();
}

/// The phase raster, painted into an offscreen bitmap at the engine's shape.
/// Cell row 0 is the lowest temperature and canvas y grows downward, hence the
/// inverted row.
function rasterBitmap(cells, shape) {
    const gridW = shape.cols, gridH = shape.rows;
    const offscreen = document.createElement('canvas');
    offscreen.width = gridW;
    offscreen.height = gridH;
    const offCtx = offscreen.getContext('2d');
    const imageData = offCtx.createImageData(gridW, gridH);

    // Roles are needed even when nothing is textured, since gaps are washed too.
    const roles = coexRoles(cells, gridW);

    for (let i = 0; i < cells.length; i++) {
        const colorStr = coexWashColor(cells[i], roles);
        const r = parseInt(colorStr.slice(1, 3), 16);
        const g = parseInt(colorStr.slice(3, 5), 16);
        const b = parseInt(colorStr.slice(5, 7), 16);
        const invertedRow = gridH - 1 - Math.floor(i / gridW);
        const pixelIdx = (invertedRow * gridW + (i % gridW)) * 4;
        imageData.data[pixelIdx]     = r;
        imageData.data[pixelIdx + 1] = g;
        imageData.data[pixelIdx + 2] = b;
        imageData.data[pixelIdx + 3] = 255;
    }
    offCtx.putImageData(imageData, 0, 0);
    return offscreen;
}

function drawPhaseDiagram(data, boundaries, target = null, margin = MARGIN) {
    const ctx = target ? target.ctx : phaseCanvas.getContext('2d');
    const W = target ? target.width : logicalSize(phaseCanvas).width;
    const H = target ? target.height : logicalSize(phaseCanvas).height;
    ctx.fillStyle = palette.surface;
    ctx.fillRect(0, 0, W, H);

    const v = currentView();
    // Not `phaseScales()`: an export target has the figure's size.
    const s = makeScales({ width: W, height: H, margin,
                           xMin: v.xMin, xMax: v.xMax, yMin: v.tMin, yMax: v.tMax });
    const { x: ML, y: MT, w: plotW, h: plotH } = s.rect;
    const mapX = s.mapX, mapT = s.mapY;
    const rect = s.rect;

    const shape = rasterShape(data, boundaries);
    if (data && !shape.ok) {
        throw new Error(`raster is ${data.length} cells but the engine describes it `
            + `as ${shape.rows} x ${shape.cols} = ${shape.rows * shape.cols}`);
    }

    if (data) {
        // The cells' window comes from their sweep, since the view may have
        // moved while the worker ran. The export path has none.
        const rv = (boundaries && boundaries.window) || v;
        lastRaster = { canvas: rasterBitmap(data, shape), cells: data, shape,
                       view: { ...rv }, paint: paletteGeneration };
    } else if (lastRaster && lastRaster.cells && lastRaster.paint !== paletteGeneration) {
        // Same cells, new colours. See `paletteGeneration`.
        lastRaster = { ...lastRaster, paint: paletteGeneration,
                       canvas: rasterBitmap(lastRaster.cells, lastRaster.shape) };
    }

    // The raster is drawn at `lastRaster.view`, the window its cells were
    // solved over, so it stays registered during a pan or zoom. That window is
    // a copy because pan and zoom mutate `view` in place. The legend's key
    // follows the fill scheme on screen, so it is rebuilt when that changes.
    if (!target && lastRaster && lastRaster.cells) {
        const scheme = coexScheme(lastRaster.cells);
        if (!legendScheme || scheme.textured !== legendScheme.textured
            || scheme.gap !== legendScheme.gap) {
            legendScheme = { ...scheme };
            rebuildPhaseLegend();
        }
    }

    if (showRaster) {
        const alpha = boundaries ? RASTER_FILL_ALPHA : 1.0;
        const place = (r) => {
            const rv = r.view;
            ctx.drawImage(r.canvas,
                mapX(rv.xMin), mapT(rv.tMax),
                mapX(rv.xMax) - mapX(rv.xMin), mapT(rv.tMin) - mapT(rv.tMax));
        };
        if (lastRaster) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(rect.x, rect.y, rect.w, rect.h);
            ctx.clip();
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = alpha;
            place(lastRaster);
            ctx.globalAlpha = 1.0;
            ctx.restore();

            drawCoexDots(ctx, lastRaster, mapX, mapT, rect);
        }
    }

    // Ticks only; no grid lines, which would cross every boundary.
    const xTicks = axisTicks(v.xMin, v.xMax, xToDisplay, xFromDisplay, 6);
    const tTicks = axisTicks(v.tMin, v.tMax, tToDisplay, tFromDisplay, 6);

    // The ghost goes under the boundaries, so a perturbation reads as a shift.
    if (boundaries && baselineBoundaries) {
        drawBaselineGhost(ctx, mapX, mapT, rect);
    }
    // Experimental points go under the curves, and draw without a database too.
    drawExperimentalPoints(ctx, mapX, mapT, rect);
    if (boundaries) {
        drawBoundaryCurves(ctx, boundaries, mapX, mapT, rect);
    }

    // The isotherm appears only with its G panel: open on screen, or in an
    // export of the pair (`drawFigure` sets `target.isotherm`). Under the labels.
    if (target ? target.isotherm === true : gibbsOpen) {
        drawIsotherm(ctx, mapX, mapT, rect, !target && unnamedHover !== null);
    }

    // In-field names, and a key for fields too small to take one. On screen the
    // key is a list in the Phases block; in a file the fields carry numbers and
    // `drawFigure` adds the key under the figure.
    let key = null;
    if (boundaries && showRegionLabels) {
        const { dropped } = drawRegionLabels(ctx, boundaries, mapX, mapT, rect);
        key = unnamedKey(dropped);
        if (key && target) drawFieldNumbers(ctx, key, mapX, mapT, rect);
    }
    // Outside the branch above, so `Labels` off clears the list.
    if (!target && phaseCanvas) {
        renderUnnamedKey(key);
    }

    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(ML, MT, plotW, plotH);

    // X-axis ticks and labels, only on the panel that owns the axis.
    ctx.fillStyle = palette.textDim;
    ctx.font = '11px "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xDecimals = units.composition === 'x' ? Math.max(1, xTicks.decimals) : xTicks.decimals;
    if (margin.xAxis) {
        xTicks.values.forEach(t => {
            const px = mapX(t.at);
            ctx.strokeStyle = palette.axis; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(px, MT + plotH); ctx.lineTo(px, MT + plotH + 4); ctx.stroke();
            ctx.fillText(t.label.toFixed(xDecimals), px, MT + plotH + 6);
        });
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    tTicks.values.forEach(t => {
        const py = mapT(t.at);
        ctx.strokeStyle = palette.axis; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(ML - 4, py); ctx.lineTo(ML, py); ctx.stroke();
        ctx.fillText(t.label.toFixed(tTicks.decimals), ML - 7, py);
    });
    ctx.setLineDash([]);

    // With nothing loaded, a note says where to load a database. Screen only.
    if (!target && !currentTdb) {
        ctx.fillStyle = palette.textDim;
        ctx.font = `13px ${UI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(EMPTY_FIGURE_NOTE, ML + plotW / 2, MT + plotH / 2);
    }

    drawAxisTitles(ctx, W, H, margin.xAxis ? xAxisTitle() : null,
                   `T (${tUnitLabel()})`, margin);
    drawFigureCaption(ctx, W, margin);
    return key;
}

// ---------------------------------------------------------- figure caption --
//
// The caption names the database and what the engine could not model, so an
// exported figure carries its own fidelity. The grade comes from the engine's
// `tdbInfo.phase_support`, not the manifest, so a user's own file gets one too,
// and follows `corpus.rs` in listing unsupported phases first.

/// Kept in step with the wording of the picker and the fidelity panel.
const CAPTION_FULL = 'all phases modeled in full';

/// At most two names, then a count. A fixed rule, not fitted to the width, so
/// exports of one database at different sizes say the same thing.
function fewPhases(names) {
    return names.length <= 2 ? names.join(', ')
        : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}

function figureCaption() {
    if (!currentTdb) return '';
    const support = tdbInfo?.phase_support || [];
    const named = (status) => support.filter((s) => s.status === status).map((s) => s.phase);
    const unsupported = named('unsupported');
    const approximated = named('approximated');

    const parts = [];
    // Named, not counted, so a reader can see whether their phase is missing.
    if (unsupported.length) parts.push(`phases missing: ${fewPhases(unsupported)}`);
    if (approximated.length) parts.push(`physics dropped: ${fewPhases(approximated)}`);
    // A rejected phase is the assessment's choice, not an engine limit, so it
    // is counted and attributed to the database.
    const rejected = named('rejected');
    if (rejected.length) {
        parts.push(`${rejected.length} rejected by the database`
            + (parts.length ? '' : ', the rest modeled in full'));
    }
    const head = `${baseName(currentTdb)} — ${parts.length ? parts.join('; ') : CAPTION_FULL}`;
    // A comparison's grey curves are named here, since exports have no legend.
    return baselineTdb ? `${head}  ·  gray: ${baselineTdb.name}` : head;
}

function drawFigureCaption(ctx, W, margin) {
    const text = figureCaption();
    if (!text) return;
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = palette.textDim;
    ctx.font = `10px ${UI_FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W - margin.right, margin.top / 2);
    ctx.restore();
}

// Axis titles in the panel's own margin. A falsy `xTitle` skips the x title,
// as the upper panel of the pair has no x axis.
function drawAxisTitles(ctx, W, H, xTitle, yTitle, margin = MARGIN) {
    const plotW = W - margin.left - margin.right;
    const plotH = H - margin.top - margin.bottom;
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = palette.text;
    ctx.font = '600 12px ' + UI_FONT;
    ctx.textAlign = 'center';

    if (xTitle) {
        ctx.textBaseline = 'bottom';
        ctx.fillText(xTitle, margin.left + plotW / 2, H - 6);
    }

    ctx.translate(14, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'top';
    ctx.fillText(yTitle, 0, 0);
    ctx.restore();
}

// Diagonal hatch over the band where some phase on the hull is evaluated past
// its declared temperature range, using the database's last polynomial segment.
function drawExtrapolationBand(ctx, extrapolation, mapT, clip) {
    const t = extrapolation && extrapolation.t_past_declared_range;
    if (t == null) return;

    const yLine = mapT(t);
    const y = clip.y;
    const h = Math.min(yLine, clip.y + clip.h) - y;
    if (h <= 0) return;    // the ceiling is at or above the view

    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, y, clip.w, h);
    ctx.clip();
    ctx.strokeStyle = palette.textDim;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = clip.x - h; px < clip.x + clip.w + h; px += 8) {
        ctx.moveTo(px, y + h);
        ctx.lineTo(px + h, y);
    }
    ctx.stroke();
    ctx.restore();

    if (yLine > clip.y && yLine < clip.y + clip.h) {
        ctx.save();
        ctx.strokeStyle = palette.textDim;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(clip.x, yLine);
        ctx.lineTo(clip.x + clip.w, yLine);
        ctx.stroke();
        ctx.restore();
    }
}

// The dash rule: dashed lines are drawn by the app (the crosshair, the
// declared-range ceiling, the common tangents); solid lines are computed by
// the engine.
//
// The ghost: the assessed boundaries under the live ones, 1.6 px against the
// live 2 px, drawn first so a live curve covers it where they coincide. Kept
// hueless so it cannot match a phase colour; `--fig-ghost` is in style.css.
function drawBaselineGhost(ctx, mapX, mapT, rect) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.strokeStyle = palette.ghost;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const curve of baselineBoundaries.boundaries) {
        if (curve.points.length < 2) continue;
        ctx.beginPath();
        curve.points.forEach((p, i) => {
            const px = mapX(p.x), py = mapT(p.t);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
    }
    ctx.restore();
}

function drawBoundaryCurves(ctx, boundaries, mapX, mapT, clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    ctx.setLineDash([]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    drawExtrapolationBand(ctx, boundaries.extrapolation, mapT, clip);

    // Full hue, 2 px, uncased: the fills are muted enough without a casing.
    ctx.lineWidth = 2;
    for (const curve of boundaries.boundaries) {
        if (curve.points.length < 2) continue;
        ctx.strokeStyle = phaseColor(curve.phase_index);
        ctx.beginPath();
        curve.points.forEach((p, i) => {
            const px = mapX(p.x), py = mapT(p.t);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
    }

    // Invariant horizontals, with a marker on each coexisting composition.
    for (const inv of boundaries.invariants) {
        const py = mapT(inv.t);
        const xs = inv.phases.map(p => mapX(p.x));
        // Solid and 2 px like the boundary curves, which also sets it apart
        // from the 1.6 px ghost.
        ctx.setLineDash([]);
        ctx.strokeStyle = palette.text;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.min(...xs), py);
        ctx.lineTo(Math.max(...xs), py);
        ctx.stroke();

        // Hollow markers for a reaction past the declared temperature range,
        // so it is not read as an assessed value. Only that cause: a reaction
        // above the highest melting point may be real.
        const predicted = (inv.extrapolated_kinds || []).includes('past_declared_range');
        ctx.setLineDash([]);
        for (const px of xs) {
            ctx.beginPath();
            ctx.arc(px, py, 3.2, 0, Math.PI * 2);
            ctx.fillStyle = predicted ? palette.bg : palette.text;
            ctx.fill();
            ctx.strokeStyle = predicted ? palette.text : palette.bg;
            ctx.lineWidth = predicted ? 1.4 : 1;
            ctx.stroke();
        }
    }

    ctx.restore();
}

// --------------------------------------------------------- goodness of fit --

// Visible points, flattened in the order the engine reports residuals in.
let expPointOrder = [];

function visibleExpPointsJson() {
    expPointOrder = [];
    for (const src of expSources.values()) {
        if (!expShown(src)) continue;
        for (const p of src.points) expPointOrder.push(p);
    }
    if (expPointOrder.length === 0) return '';
    return JSON.stringify(expPointOrder.map(p => ({
        x: p.x, t: p.t, kind: p.kind,
        x_err: p.x_err, t_err: p.t_err,
        phase: p.phase, weight: p.weight, source: p.source,
    })));
}

/// `order` is the visible-point list the residuals were computed against,
/// carried with the sweep request since a dataset may be hidden before the
/// answer lands.
function attachResiduals(report, order = expPointOrder) {
    for (const p of order) p.residual = null;
    residualReport = report || null;
    if (!report) return;
    report.points.forEach((r, i) => {
        if (order[i]) order[i].residual = r;
    });
}

function drawFitPanel(report) {
    if (!report || report.n_points === 0) {
        fitPanel.classList.add('hidden');
        setStatusBrief('fit-brief', '');
        return;
    }
    fitPanel.classList.remove('hidden');
    fitValue.textContent = report.objective.toFixed(2);
    // The headline's own text, not a second rounding of the objective.
    setStatusBrief('fit-brief',
        `${fitValue.textContent} σ over ${plural(report.n_points, 'point')}`);

    fitBreakdown.replaceChildren();
    for (const k of report.by_kind) {
        const span = document.createElement('span');
        span.textContent =
            `${EXP_KIND_LABEL[k.kind] || k.kind}: ${k.rms.toFixed(2)} (n=${k.count})`;
        fitBreakdown.appendChild(span);
    }
    if (report.n_unmatched > 0) {
        const warn = document.createElement('span');
        warn.className = 'fit-warn';
        warn.textContent =
            `${plural(report.n_unmatched, 'point')} had nothing to match `
            + '\u2014 the model may have lost a phase';
        fitBreakdown.appendChild(warn);
    }
    // Points outside the database's declared range, excluded from the misfit.
    // Unlike `n_unmatched`, these are not the model falling short.
    if (report.n_out_of_range > 0) {
        const warn = document.createElement('span');
        warn.className = 'fit-warn';
        warn.textContent = `${plural(report.n_out_of_range, 'point')} outside the `
            + "database's declared temperature range \u2014 reported, not scored";
        warn.title = 'These points sit at temperatures the database never claimed to '
            + 'describe. They are excluded from the misfit, because minimizing the '
            + 'distance to the edge of an assessment is not fitting the data.';
        fitBreakdown.appendChild(warn);
    }
}

// Splits "LIQUID + FCC_A1" at the plus, so a narrow two-phase field can take
// its name on two lines.
function labelLines(text) {
    const parts = text.split(' + ');
    return parts.length === 2 ? [parts[0], '+ ' + parts[1]] : [text];
}

/// Names each phase field in place, at an anchor the engine picks inside the
/// field. A label that does not fit, or overlaps one already placed, is
/// dropped. Returns `{ boxes, dropped }`: where the names went, and the names
/// that found no place (`{ text, fields }`), for the unnamed-fields key.
function drawRegionLabels(ctx, boundaries, mapX, mapT, clip) {
    const labels = boundaries.region_labels || [];
    if (labels.length === 0) return { boxes: [], dropped: [] };

    // Labels keep clear of the invariant horizontals.
    const invariantRows = (boundaries.invariants || []).map(inv => mapT(inv.t));
    const LINE_H = 13;

    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    // The UI sans, not the monospace `LABEL_FONT`; at 12 px crowded diagrams
    // lose several labels.
    ctx.font = '500 11px ' + UI_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.setLineDash([]);
    // Round joins, since a miter casing throws spikes out of acute glyph corners.
    ctx.lineJoin = 'round';
    // Set only where it exists: `SvgContext`, used by the SVG export, throws on
    // this property.
    if (ctx.miterLimit !== undefined) ctx.miterLimit = 2;

    const placed = [];
    // Keyed by name: disjoint fields of one name share an entry in the key,
    // with every field kept so each can carry the number.
    const dropped = new Map();
    const drop = (label) => {
        const fields = dropped.get(label.text);
        if (fields) fields.push(label); else dropped.set(label.text, [label]);
    };
    const named = new Set();
    for (const label of labels) {
        if (label.area < MIN_LABEL_AREA) { drop(label); continue; }
        const px = mapX(label.x);
        const fieldW = label.width * clip.w * 0.92;

        // One line if it fits, else two.
        let lines = [label.text];
        let textW = ctx.measureText(label.text).width;
        if (textW > fieldW) {
            const split = labelLines(label.text);
            if (split.length === 1) { drop(label); continue; }
            const splitW = Math.max(...split.map(l => ctx.measureText(l).width));
            if (splitW > fieldW) { drop(label); continue; }
            lines = split;
            textW = splitW;
        }

        const h = lines.length * LINE_H + 3;
        let py = mapT(label.t);

        // Nudge off an invariant horizontal, toward the side the anchor is on:
        // across the line is a different field.
        for (const row of invariantRows) {
            if (Math.abs(py - row) < h / 2 + 4) {
                py = row + (py < row ? -1 : 1) * (h / 2 + 7);
                break;
            }
        }

        const box = { x: px - textW / 2 - 3, y: py - h / 2, w: textW + 6, h };
        if (box.x < clip.x || box.x + box.w > clip.x + clip.w
            || box.y < clip.y || box.y + box.h > clip.y + clip.h) {
            drop(label); continue;
        }
        if (placed.some(p => box.x < p.x + p.w && box.x + box.w > p.x
                          && box.y < p.y + p.h && box.y + box.h > p.y)) {
            drop(label); continue;
        }
        placed.push(box);
        named.add(label.text);

        // A 2 px casing keeps the text readable over any field.
        lines.forEach((line, i) => {
            const ly = py - (lines.length - 1) * LINE_H / 2 + i * LINE_H;
            ctx.lineWidth = 2;
            ctx.strokeStyle = palette.casing;
            ctx.strokeText(line, px, ly);
            ctx.fillStyle = palette.text;
            ctx.fillText(line, px, ly);
        });
    }
    ctx.restore();
    // A name placed in any of its fields is not listed as dropped.
    return { boxes: placed,
             dropped: [...dropped].filter(([text]) => !named.has(text))
                 .map(([text, fields]) => ({ text, fields })) };
}

/// The export's key numbers at most nine unnamed fields, so each number is one
/// digit, then gives a count. The on-screen list can show the rest
/// (`renderUnnamedKey`).
const UNNAMED_MAX = 9;

/// `{ shown: [{ n, text, fields }], rest, extra: [{ text, fields }] }`, or
/// `null` when every name fitted. `extra` holds the `rest` entries past the cap.
function unnamedKey(dropped) {
    if (dropped.length === 0) return null;
    const shown = dropped.slice(0, UNNAMED_MAX).map((d, i) => ({ n: i + 1, ...d }));
    const extra = dropped.slice(UNNAMED_MAX);
    return { shown, rest: extra.length, extra };
}

/// In an export, a number on every field the key lists: a bold digit cased
/// like the in-field names, kept inside the plot when an anchor is on an edge.
const UNNAMED_NUM_FONT = `700 11px ${UI_FONT}`;
const UNNAMED_NUM_INSET = 6;

function drawFieldNumbers(ctx, key, mapX, mapT, rect) {
    const r = UNNAMED_NUM_INSET;
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = UNNAMED_NUM_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    for (const entry of key.shown) {
        for (const f of entry.fields) {
            const x = Math.min(rect.x + rect.w - r, Math.max(rect.x + r, mapX(f.x)));
            const y = Math.min(rect.y + rect.h - r, Math.max(rect.y + r, mapT(f.t)));
            ctx.strokeStyle = palette.casing;
            ctx.strokeText(String(entry.n), x, y);
            ctx.fillStyle = palette.text;
            ctx.fillText(String(entry.n), x, y);
        }
    }
    ctx.restore();
}

/// Lays out the key under an exported figure, `unnamed fields  1 NAME · 2 NAME`,
/// as rows of `{ x, y, n?, text, sep? }` across the plot's width, wrapping only
/// when a line is full. Also returns its height.
const UNNAMED_ROW = 15, UNNAMED_PAD = 7, UNNAMED_GAP = 14, UNNAMED_NUM_GAP = 4;
const UNNAMED_HEAD = 'unnamed fields';
const UNNAMED_TEXT_FONT = `500 11px ${UI_FONT}`;

function unnamedKeyLayout(ctx, key, width, margin) {
    ctx.save();
    const left = margin.left, right = width - margin.right;
    const items = [{ text: UNNAMED_HEAD, head: true }]
        .concat(key.shown.map((e) => ({ n: e.n, text: e.text })))
        .concat(key.rest > 0 ? [{ text: `+${key.rest} more`, more: true }] : []);
    let x = left, row = 0;
    for (const [i, it] of items.entries()) {
        ctx.font = UNNAMED_NUM_FONT;
        it.numW = it.n ? ctx.measureText(String(it.n)).width + UNNAMED_NUM_GAP : 0;
        ctx.font = UNNAMED_TEXT_FONT;
        const w = it.numW + ctx.measureText(it.text).width;
        if (x > left && x + w > right) { x = left; row++; }
        // A dot between two entries on one row; the head needs none.
        it.sep = x > left && i > 1;
        it.x = x;
        it.y = UNNAMED_PAD + row * UNNAMED_ROW + UNNAMED_ROW / 2;
        x += w + UNNAMED_GAP;
    }
    ctx.restore();
    return { items, h: UNNAMED_PAD * 2 + (row + 1) * UNNAMED_ROW };
}

/// The key under an exported figure, at `top`.
function drawUnnamedKeyStrip(ctx, key, top, width, margin) {
    const { items } = unnamedKeyLayout(ctx, key, width, margin);
    ctx.save();
    ctx.setLineDash([]);
    ctx.textBaseline = 'middle';
    for (const it of items) {
        const y = top + it.y;
        if (it.sep) {
            ctx.font = UNNAMED_TEXT_FONT;
            ctx.textAlign = 'center';
            ctx.fillStyle = palette.textDim;
            ctx.fillText('·', it.x - UNNAMED_GAP / 2, y);
        }
        ctx.textAlign = 'left';
        if (it.n) {
            ctx.font = UNNAMED_NUM_FONT;
            ctx.fillStyle = palette.text;
            ctx.fillText(String(it.n), it.x, y);
        }
        ctx.font = UNNAMED_TEXT_FONT;
        ctx.fillStyle = it.head || it.more ? palette.textDim : palette.text;
        ctx.fillText(it.text, it.x + it.numW, y);
    }
    ctx.restore();
}

/// The same key on screen, in the Phases block, with its count in the block's
/// summary. Entries carry no numbers; hovering or focusing one lights its
/// fields (`drawUnnamedHover`). A `+N more` button shows entries past nine.
/// Rebuilt only when its content changes, since every paint calls this and a
/// rebuild would replace the focused entry.
let lastUnnamedKey = null;
let unnamedHover = null;   // the `text` of the entry being pointed at
// `currentTdb` while the list is expanded, so another database opens collapsed.
let unnamedExpanded = null;

function renderUnnamedKey(key) {
    const el = document.getElementById('unnamed-key');
    if (!el) return;
    lastUnnamedKey = key;
    const total = key ? key.shown.length + key.rest : 0;
    setStatusBrief('unnamed-brief', total ? plural(total, 'unnamed field') : '');
    const open = !!key && key.rest > 0 && unnamedExpanded === currentTdb;
    const said = key ? [...key.shown, ...key.extra].map((e) => e.text).join('\n')
        + `\n+${key.rest} ${open}` : '';
    if (el.dataset.said === said && el.hidden === !key) return;
    el.dataset.said = said;
    if (!key) { el.hidden = true; el.replaceChildren(); return; }
    const span = (cls, text) => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        return s;
    };
    const parts = [span('unnamed-head', 'Not named on the diagram')];
    for (const e of open ? [...key.shown, ...key.extra] : key.shown) {
        const item = span('unnamed-item', e.text);
        item.tabIndex = 0;
        item.dataset.field = e.text;
        parts.push(item);
    }
    if (key.rest > 0) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'unnamed-more';
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'show fewer' : `+${key.rest} more`;
        parts.push(more);
    }
    el.replaceChildren(...parts);
    el.hidden = false;
}

/// The entry is remembered by name, so a new sweep lights the same field again.
/// A change repaints the figure, which dims the isotherm (`drawIsotherm`).
function setupUnnamedHover() {
    const el = document.getElementById('unnamed-key');
    if (!el) return;
    const show = (next) => {
        if (next === unnamedHover) return;
        unnamedHover = next;
        if (currentTdb && boundaryData) paintFigure(null);
        scheduleHoverDraw();
    };
    const point = (e) => {
        const item = e.target.closest && e.target.closest('.unnamed-item');
        show(item ? item.dataset.field : null);
    };
    el.addEventListener('mouseover', point);
    el.addEventListener('focusin', point);
    // `+N more` and `show fewer`. The rebuild replaces the button, so focus
    // moves to the new one.
    el.addEventListener('click', (e) => {
        if (!e.target.closest || !e.target.closest('.unnamed-more') || !lastUnnamedKey) return;
        unnamedExpanded = unnamedExpanded === currentTdb ? null : currentTdb;
        show(null);
        renderUnnamedKey(lastUnnamedKey);
        el.querySelector('.unnamed-more')?.focus();
    });
    el.addEventListener('mouseleave', () => show(null));
    el.addEventListener('focusout', (e) => {
        if (!el.contains(e.relatedTarget)) show(null);
    });
}

/// The pointed-at entry's fields, lit on the overlay: their raster cells
/// washed in `--fig-highlight`, and the boundary pieces edging them stroked
/// in it with a casing, which the light theme needs over pale washes.
const UNNAMED_WASH_ALPHA = 0.25;

/// Which raster cells carry the entry's fields. Each label is one cell code,
/// found at its anchor; the ring search covers an anchor a cell off its field.
function unnamedFieldMask(entry) {
    const r = lastRaster;
    if (!r || !r.cells || !r.shape) return null;
    const { cols, rows } = r.shape, w = r.view;
    if (!(w.xMax > w.xMin) || !(w.tMax > w.tMin)) return null;
    const matches = (code, f) => {
        const c = decodePhaseCell(code);
        if (c.kind === PHASE_KIND.SINGLE) return c.a === f.phase_index;
        return (c.a === f.phase_index && c.b === f.against_index)
            || (c.a === f.against_index && c.b === f.phase_index);
    };
    const codes = new Set();
    for (const f of entry.fields) {
        const cx = Math.floor((f.x - w.xMin) / (w.xMax - w.xMin) * cols);
        const cy = Math.floor((f.t - w.tMin) / (w.tMax - w.tMin) * rows);
        search: for (let k = 0; k <= FIELD_SEARCH_CELLS; k++) {
            for (let dy = -k; dy <= k; dy++) {
                for (let dx = -k; dx <= k; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
                    const x = cx + dx, y = cy + dy;
                    if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
                    const code = r.cells[y * cols + x];
                    if (matches(code, f)) { codes.add(code); break search; }
                }
            }
        }
    }
    if (codes.size === 0) return null;
    const mask = new Uint8Array(cols * rows);
    for (let i = 0; i < mask.length; i++) {
        if (codes.has(r.cells[i])) mask[i] = 1;
    }
    return { mask, cols, rows, view: w };
}

/// Pieces of the drawn boundaries (curves, invariant horizontals and the
/// raster's edges) that edge the lit cells, in data units, about a cell long.
///
/// Only the field's own curves count, lit within 3 cells of lit cells (a thin
/// sliver's curve can sit that far off), with gaps of up to `UNNAMED_EDGE_GAP`
/// unlit pieces filled. Invariant horizontals and the raster's edges are lit
/// where the cells lie on exactly one side, probed 0.6 and 1.4 cells out.
const UNNAMED_EDGE_GAP = 6;

function unnamedFieldEdges(m, boundaries, entry) {
    const { mask, cols, rows, view: w } = m;
    const u = (x) => (x - w.xMin) / (w.xMax - w.xMin) * cols;
    const v = (t) => (t - w.tMin) / (w.tMax - w.tMin) * rows;
    const inMask = (cu, cv) => {
        const x = Math.floor(cu), y = Math.floor(cv);
        return x >= 0 && x < cols && y >= 0 && y < rows && mask[y * cols + x] === 1;
    };
    const same = (p, q, a, b) => (p === a && q === b) || (p === b && q === a);
    const ids = entry.fields.map((f) => ({
        single: f.kind === 'single', a: f.phase_index, b: f.against_index }));
    const curveMatches = (c) => ids.some((f) => (f.single
        ? c.phase_index === f.a : same(c.phase_index, c.against_index, f.a, f.b)));
    const invariantMatches = (inv) => {
        const ps = inv.phases.map((p) => p.phase_index);
        return ids.some((f) => !f.single && ps.includes(f.a) && ps.includes(f.b));
    };

    // Splits a segment into pieces about a cell long, each marked by `lit`.
    const cut = (p, q, lit) => {
        const du = u(q.x) - u(p.x), dv = v(q.t) - v(p.t);
        const len = Math.hypot(du, dv);
        if (!(len > 0)) return [];
        const nu = -dv / len, nv = du / len;
        const k = Math.max(1, Math.ceil(len));
        const out = [];
        for (let j = 0; j < k; j++) {
            const s0 = j / k, s1 = (j + 1) / k, sm = (s0 + s1) / 2;
            const mu = u(p.x) + du * sm, mv = v(p.t) + dv * sm;
            const side = (sgn, reach) => reach.some((d) => inMask(mu + sgn * d * nu, mv + sgn * d * nv));
            out.push({ on: lit(side),
                       a: { x: p.x + (q.x - p.x) * s0, t: p.t + (q.t - p.t) * s0 },
                       b: { x: p.x + (q.x - p.x) * s1, t: p.t + (q.t - p.t) * s1 } });
        }
        return out;
    };
    const NEAR = [0, 0.3, 0.6, 1.4, 2.2, 3.0], EDGE = [0.6, 1.4];
    const near = (side) => side(1, NEAR) || side(-1, NEAR);
    const oneSide = (side) => side(1, EDGE) !== side(-1, EDGE);

    const pieces = [];
    const keep = (run) => { for (const r of run) if (r.on) pieces.push([r.a, r.b]); };
    for (const c of boundaries.boundaries || []) {
        if (!curveMatches(c)) continue;
        const run = [];
        for (let i = 1; i < c.points.length; i++) run.push(...cut(c.points[i - 1], c.points[i], near));
        let last = -1;
        run.forEach((r, i) => {
            if (!r.on) return;
            if (last >= 0 && i - last - 1 <= UNNAMED_EDGE_GAP) {
                for (let j = last + 1; j < i; j++) run[j].on = true;
            }
            last = i;
        });
        keep(run);
    }
    for (const inv of boundaries.invariants || []) {
        if (!invariantMatches(inv)) continue;
        const xs = inv.phases.map((p) => p.x);
        keep(cut({ x: Math.min(...xs), t: inv.t }, { x: Math.max(...xs), t: inv.t }, oneSide));
    }
    const corners = [{ x: w.xMin, t: w.tMin }, { x: w.xMax, t: w.tMin },
                     { x: w.xMax, t: w.tMax }, { x: w.xMin, t: w.tMax }];
    corners.forEach((p, i) => keep(cut(p, corners[(i + 1) % 4], oneSide)));
    return pieces;
}

function drawUnnamedHover(ctx, s) {
    const entry = unnamedHover && lastUnnamedKey && boundaryData
        && [...lastUnnamedKey.shown, ...lastUnnamedKey.extra]
            .find((e) => e.text === unnamedHover);
    const m = entry ? unnamedFieldMask(entry) : null;
    if (!m) return;
    const { rect } = s, w = m.view;

    // A cell-per-pixel bitmap placed exactly over the raster, so its edges are
    // the fill's. Row 0 is `tMin`, as in `rasterBitmap`.
    const bmp = document.createElement('canvas');
    bmp.width = m.cols;
    bmp.height = m.rows;
    const bctx = bmp.getContext('2d');
    bctx.fillStyle = palette.highlight;
    for (let i = 0; i < m.mask.length; i++) {
        if (m.mask[i]) bctx.fillRect(i % m.cols, m.rows - 1 - Math.floor(i / m.cols), 1, 1);
    }
    const pieces = unnamedFieldEdges(m, boundaryData, entry);

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = UNNAMED_WASH_ALPHA;
    ctx.drawImage(bmp, s.mapX(w.xMin), s.mapY(w.tMax),
                  s.mapX(w.xMax) - s.mapX(w.xMin), s.mapY(w.tMin) - s.mapY(w.tMax));
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [a, b] of pieces) {
        ctx.moveTo(s.mapX(a.x), s.mapY(a.t));
        ctx.lineTo(s.mapX(b.x), s.mapY(b.t));
    }
    ctx.strokeStyle = palette.casing;
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = palette.highlight;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
}

/// The key a figure of this size would carry, so an export can be sized for
/// the strip before drawing. It runs the label placement itself on a scratch
/// context, so it cannot disagree with the draw that follows.
let scratchCtx = null;
function unnamedKeyFor(boundaries, width, height, margin) {
    if (!boundaries || !showRegionLabels) return null;
    if (!scratchCtx) scratchCtx = document.createElement('canvas').getContext('2d');
    const v = currentView();
    const s = makeScales({ width, height, margin,
                           xMin: v.xMin, xMax: v.xMax, yMin: v.tMin, yMax: v.tMax });
    return unnamedKey(drawRegionLabels(scratchCtx, boundaries, s.mapX, s.mapY, s.rect).dropped);
}

// Marker shapes. Shape encodes `kind`; colour encodes `source` or the signed
// residual.
function markerPath(ctx, kind, px, py, r) {
    ctx.beginPath();
    switch (kind) {
        case 'tie_left':
            ctx.moveTo(px - r * 1.15, py);
            ctx.lineTo(px + r * 0.85, py - r);
            ctx.lineTo(px + r * 0.85, py + r);
            ctx.closePath();
            break;
        case 'tie_right':
            ctx.moveTo(px + r * 1.15, py);
            ctx.lineTo(px - r * 0.85, py - r);
            ctx.lineTo(px - r * 0.85, py + r);
            ctx.closePath();
            break;
        case 'invariant':
            ctx.moveTo(px, py - r * 1.25);
            ctx.lineTo(px + r * 1.25, py);
            ctx.lineTo(px, py + r * 1.25);
            ctx.lineTo(px - r * 1.25, py);
            ctx.closePath();
            break;
        case 'single_phase':
            ctx.rect(px - r * 0.85, py - r * 0.85, r * 1.7, r * 1.7);
            break;
        default:
            ctx.arc(px, py, r, 0, Math.PI * 2);
    }
}

function drawErrorBar(ctx, px, py, dx, dy) {
    const cap = 3;
    ctx.beginPath();
    ctx.moveTo(px - dx, py - dy);
    ctx.lineTo(px + dx, py + dy);
    if (dx !== 0) {
        ctx.moveTo(px - dx, py - cap); ctx.lineTo(px - dx, py + cap);
        ctx.moveTo(px + dx, py - cap); ctx.lineTo(px + dx, py + cap);
    } else {
        ctx.moveTo(px - cap, py - dy); ctx.lineTo(px + cap, py - dy);
        ctx.moveTo(px - cap, py + dy); ctx.lineTo(px + cap, py + dy);
    }
    ctx.stroke();
}

// The experimental points. Error bars go under the markers.
function drawExperimentalPoints(ctx, mapX, mapT, clip) {
    if (expSources.size === 0 || !showExpPoints) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    ctx.setLineDash([]);

    // Markers grow as the square root of the zoom, since crowding falls with
    // it, clamped so the shape stays legible without burying the curve. The
    // zoom comes from the scale, so an export target uses its own window.
    const fullRangePx = mapX(1) - mapX(0);
    const zoom = fullRangePx > 0 ? fullRangePx / clip.w : 1;
    const rScale = Math.min(1.15, Math.max(0.70, 0.70 * Math.sqrt(zoom)));
    const markerR = EXP_MARKER_R * rScale;

    for (const src of expSources.values()) {
        if (!expShown(src) || src.points.length === 0) continue;
        const sourceColor = expSourceColor(src.slot);
        const colorOf = (p) => (expColourBy === 'residual' && p.residual)
            ? residualColor(p.residual.signed)
            : sourceColor;

        // The bar takes the body's alpha, so bar and marker read as one mark.
        ctx.lineWidth = 1.5;
        for (const p of src.points) {
            if (p.x_err <= 0 && p.t_err <= 0) continue;
            const px = mapX(p.x), py = mapT(p.t);
            ctx.strokeStyle = withAlpha(colorOf(p), EXP_BODY_ALPHA);
            if (p.x_err > 0) drawErrorBar(ctx, px, py, mapX(p.x + p.x_err) - px, 0);
            if (p.t_err > 0) drawErrorBar(ctx, px, py, 0, mapT(p.t + p.t_err) - py);
        }

        // Translucent body with a hairline edge, so a cloud of points does not
        // hide the liquidus and overlaps stay countable.
        ctx.lineWidth = 1;
        for (const p of src.points) {
            const px = mapX(p.x), py = mapT(p.t);
            const c = colorOf(p);
            ctx.fillStyle = withAlpha(c, EXP_BODY_ALPHA);
            ctx.strokeStyle = c;
            markerPath(ctx, p.kind, px, py, markerR);
            ctx.fill();
            ctx.stroke();
        }
    }

    ctx.restore();
}

// Topology changes the engine saw but could not explain, which mean a reaction
// may be missing from the diagram.
function unexplainedChanges(boundaries) {
    return (boundaries?.unclassified || []).filter(u => u.explained === false);
}

function appendUnclassifiedNotice(boundaries) {
    const missing = unexplainedChanges(boundaries);
    if (missing.length === 0) return;

    const note = document.createElement('span');
    note.className = 'inv-unclassified';
    note.textContent = ` ⚠ ${missing.length} unclassified change`
        + `${missing.length === 1 ? '' : 's'}`;
    // The detail, since the diagram cannot show these.
    note.title = 'The phase sequence changed here, but the reaction could not be '
        + 'classified — the diagram may be missing an invariant:\n\n'
        + missing.map(u =>
            `${u.t_low.toFixed(1)}–${u.t_high.toFixed(1)} K: ${u.detail}\n`
            + `  below: ${u.seq_below.join(' | ')}\n  above: ${u.seq_above.join(' | ')}`
          ).join('\n\n');
    invariantReadout.appendChild(note);
}

/// What each reaction name means on cooling, for the table's tooltip. The names
/// are the engine's (`reaction_kind` and `degenerate_reaction`); About lists the
/// same eleven, and the two are kept in step.
const REACTION_MEANING = {
    eutectic: 'L → α + β',
    monotectic: 'L₁ → α + L₂, one liquid phase at two compositions',
    metatectic: 'β → α + L',
    monotectoid: 'α₁ → α₂ + β, one solid phase at two compositions',
    eutectoid: 'γ → α + β',
    syntectic: 'L₁ + L₂ → α',
    peritectic: 'L + α → β',
    peritectoid: 'α + β → γ',
    polymorphic: 'a compound changes form at one composition, between its two neighbors',
    allotropic: 'an element changes form at the edge of the axis, neither form holding more '
        + 'of the other element',
    other: 'none of the named reactions, e.g. a liquid forming on cooling; '
        + 'check whether it is extrapolated',
};

// The table of invariant reactions. Built as DOM nodes, not innerHTML, since
// phase names come from a user-supplied file.
function drawInvariantReadout(boundaries) {
    invariantReadout.replaceChildren();
    if (!boundaries) {
        setStatusBrief('invariant-brief', '');
        return;
    }
    setStatusBrief('invariant-brief', boundaries.invariants.length === 0
        ? 'none in range'
        : plural(boundaries.invariants.length, 'reaction'));

    if (boundaries.invariants.length === 0) {
        invariantReadout.textContent = 'No invariant reactions in this temperature range.';
        // Unclassified changes are still reported.
        appendUnclassifiedNotice(boundaries);
        return;
    }

    const table = document.createElement('table');
    table.className = 'inv-table';
    const head = document.createElement('tr');
    for (const h of ['Reaction', `T (${tUnitLabel()})`, `Compositions (${xUnitLabel()})`]) {
        const th = document.createElement('th');
        th.textContent = h;
        head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    invariantReadout.appendChild(table);

    boundaries.invariants.forEach((inv) => {
        const row = document.createElement('tr');
        tbody.appendChild(row);

        const kindCell = document.createElement('td');
        const kind = document.createElement('span');
        kind.className = 'inv-kind';
        kind.textContent = inv.kind;
        const meaning = REACTION_MEANING[inv.kind];
        kind.title = meaning ? `${inv.kind}: ${meaning}` : inv.kind;
        kindCell.appendChild(kind);
        row.appendChild(kindCell);

        const tCell = document.createElement('td');
        tCell.className = 'inv-t';
        tCell.textContent = `${tToDisplay(inv.t).toFixed(1)} ±${inv.t_uncertainty.toFixed(3)}`;
        row.appendChild(tCell);

        const compCell = document.createElement('td');
        compCell.className = 'inv-comps';
        compCell.textContent = inv.phases.map(p =>
            `${p.phase} ${xToDisplay(p.x).toFixed(units.composition === 'x' ? 3 : 1)}`).join('  /  ');
        row.appendChild(compCell);

        // The compositions' brackets go in the tooltip, as inline they would
        // crowd the row.
        const xErr = inv.x_uncertainty;
        if (typeof xErr === 'number' && isFinite(xErr)) {
            const per = inv.phases
                .map(p => `  ${p.phase} ${p.x.toFixed(5)} ±${p.x_uncertainty.toExponential(1)}`)
                .join('\n');
            kind.title += `\n\nat ${inv.t.toFixed(3)} ±${inv.t_uncertainty.toFixed(3)} K, `
                + `mole fraction, bracketed from both sides of the reaction:\n${per}`;
        }

        // Tagged when a phase is evaluated past its declared temperature range.
        // Lying above the highest melting point alone is not tagged; that cause
        // stays in Data (JSON), and in this tag's title when both apply.
        if ((inv.extrapolated_kinds || []).includes('past_declared_range')) {
            const tag = document.createElement('span');
            tag.className = 'inv-extrapolated';
            tag.textContent = 'extrapolated';
            tag.title = inv.extrapolated.join('\n\n');
            kindCell.appendChild(tag);
        }
    });

    appendUnclassifiedNotice(boundaries);
}

// The G panel's energies, cached on the database, the temperature and the
// parameter version (not `tdbParamsJson`, which can run to kilobytes), so a
// pan redraws without calling into the engine.
let gibbsCache = null;
let gibbsWindowCache = null;

// The full-range curves, for the geometry: a tangent endpoint may lie outside
// the window, and `interpG` assumes the array covers 0..1.
function gibbsEnergies() {
    if (gibbsCache && gibbsCache.key === tdbKey
        && gibbsCache.temp === params.temp
        && gibbsCache.version === tdbParamsVersion) {
        return gibbsCache;
    }
    const curveData = [];
    tdbPhases.forEach((ph, i) => {
        const g = tdbHandle.g_curve(ph, params.temp, tdbParamsJson);
        curveData.push({name: ph, g: g, color: phaseColor(i), type: 'sub'});
    });
    tdbCompounds.forEach((c, i) => {
        const g = tdbHandle.g_compound(c.name, params.temp, tdbParamsJson);
        if (!isNaN(g)) {
            curveData.push({name: c.name, g: g, x: c.x,
                            color: phaseColor(tdbPhases.length + i), type: 'comp'});
        }
    });
    gibbsCache = {
        key: tdbKey, temp: params.temp, version: tdbParamsVersion,
        curveData, tangents: tdbHandle.tangents(params.temp, tdbParamsJson),
    };
    return gibbsCache;
}

// The same curves resampled across the visible composition range, for drawing
// only: `interpG` on a windowed array would put tangent endpoints at wrong
// energies.
function gibbsWindowedCurves(xMin, xMax) {
    if (gibbsWindowCache && gibbsWindowCache.key === tdbKey
        && gibbsWindowCache.temp === params.temp
        && gibbsWindowCache.version === tdbParamsVersion
        && gibbsWindowCache.xMin === xMin && gibbsWindowCache.xMax === xMax) {
        return gibbsWindowCache.curves;
    }
    const curves = tdbPhases.map((ph, i) => ({
        name: ph,
        g: tdbHandle.g_curve_window(ph, params.temp, tdbParamsJson, xMin, xMax),
        color: phaseColor(i),
    }));
    gibbsWindowCache = {
        key: tdbKey, temp: params.temp, version: tdbParamsVersion, xMin, xMax, curves,
    };
    return curves;
}

// The G panel. `opts` holds `target` and `margin` for an export.
function drawGibbsCurves(opts = {}) {
    // Folded, the canvas is hidden, and unfolding repaints it.
    if (!gibbsOpen && !opts.target) return;
    const margin = opts.margin || MARGIN;
    const target = opts.target || null;
    const ctx = target ? target.ctx : boundaryCanvas.getContext('2d');
    const W = target ? target.width : logicalSize(boundaryCanvas).width;
    const H = target ? target.height : logicalSize(boundaryCanvas).height;

    // An opaque fill, not `clearRect`, which `SvgContext` does not have.
    ctx.fillStyle = palette.surface;
    ctx.fillRect(0, 0, W, H);

    // Callers ensure a database is loaded.
    const { curveData, tangents } = gibbsEnergies();

    // The diagram's window, so the two panels share the x axis.
    const v = currentView();
    const windowed = gibbsWindowedCurves(v.xMin, v.xMax);

    // The G range of what is visible, so a zoomed slice is not flattened.
    let minG = Infinity, maxG = -Infinity;
    windowed.forEach(c => {
        c.g.forEach(v2 => { if (v2 < minG) minG = v2; if (v2 > maxG) maxG = v2; });
    });
    curveData.forEach(c => {
        if (c.type !== 'comp') return;
        if (c.x < v.xMin || c.x > v.xMax) return;
        if (c.g < minG) minG = c.g;
        if (c.g > maxG) maxG = c.g;
    });
    // A level curve gives a zero span and a NaN `mapG`; the pad below keeps
    // the span positive.
    if (!isFinite(minG) || !isFinite(maxG)) { minG = -1; maxG = 1; }
    const gSpan = maxG - minG;
    const pad = gSpan > 0 ? gSpan * 0.05 : Math.max(1, Math.abs(maxG) * 0.05);
    minG -= pad;
    maxG += pad;

    const s = makeScales({ width: W, height: H, margin,
                           xMin: v.xMin, xMax: v.xMax, yMin: minG, yMax: maxG });
    if (!target) gibbsGDomain = { minG, maxG };
    const { x: ML, y: MT, w: plotW, h: plotH } = s.rect;
    const mapX = s.mapX, mapG = s.mapY;

    ctx.fillStyle = palette.surface;
    ctx.fillRect(ML, MT, plotW, plotH);

    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(ML, MT, plotW, plotH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(ML, MT, plotW, plotH);
    ctx.clip();

    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = withAlpha(palette.text, 0.65);
    ctx.lineWidth = 1.5;
    for (let i = 0; i < tangents.length; i += 2) {
        const x1 = tangents[i], x2 = tangents[i + 1];
        const g1 = hullG(curveData, x1);
        const g2 = hullG(curveData, x2);
        if (isFinite(g1) && isFinite(g2)) {
            ctx.beginPath();
            ctx.moveTo(mapX(x1), mapG(g1));
            ctx.lineTo(mapX(x2), mapG(g2));
            ctx.stroke();
        }
    }
    ctx.setLineDash([]);

    // Solution phases from the windowed samples, which span the scale's x
    // domain as `xOfIndex` expects.
    windowed.forEach(c => {
        ctx.strokeStyle = c.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        c.g.forEach((gv, i) => {
            const x = s.xOfIndex(i, c.g.length);
            if (i === 0) ctx.moveTo(mapX(x), mapG(gv));
            else ctx.lineTo(mapX(x), mapG(gv));
        });
        ctx.stroke();
    });

    curveData.forEach(c => {
        if (c.type !== 'comp') return;
        ctx.fillStyle = c.color;
        ctx.beginPath();
        ctx.arc(mapX(c.x), mapG(c.g), 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette.text;
        ctx.font = '10px "SF Mono", Menlo, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.name, mapX(c.x) + 8, mapG(c.g) - 7);
    });

    // Dots where the tangents touch the hull, ringed to separate them from
    // their curve.
    for (let i = 0; i < tangents.length; i += 2) {
        const x1 = tangents[i], x2 = tangents[i + 1];
        const g1 = hullG(curveData, x1);
        const g2 = hullG(curveData, x2);
        if (isFinite(g1) && isFinite(g2)) {
            [[x1, g1], [x2, g2]].forEach(([xp, gp]) => {
                ctx.beginPath();
                ctx.arc(mapX(xp), mapG(gp), 4.5, 0, Math.PI * 2);
                ctx.fillStyle = withAlpha(palette.text, 0.78);
                ctx.fill();
                ctx.strokeStyle = palette.surface;
                ctx.lineWidth = 1;
                ctx.stroke();
            });
        }
    }

    ctx.restore();

    ctx.fillStyle = palette.textDim;
    ctx.font = '11px "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const gTicks = axisTicks(v.xMin, v.xMax, xToDisplay, xFromDisplay, 6);
    const gDecimals = units.composition === 'x'
        ? Math.max(1, gTicks.decimals) : gTicks.decimals;
    gTicks.values.forEach(t => {
        const px = mapX(t.at);
        ctx.strokeStyle = palette.axis; ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(px, MT + plotH); ctx.lineTo(px, MT + plotH + 4); ctx.stroke();
        ctx.fillText(t.label.toFixed(gDecimals), px, MT + plotH + 6);
    });

    // Y ticks chosen in kJ/mol, so they are round in the unit shown.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = axisTicks(minG, maxG, (j) => j / 1000, (kj) => kj * 1000, 6);
    yTicks.values.forEach(t => {
        const py = mapG(t.at);
        ctx.strokeStyle = palette.axis; ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(ML - 4, py); ctx.lineTo(ML, py); ctx.stroke();
        ctx.fillText(t.label.toFixed(yTicks.decimals), ML - 7, py);
    });

    // No legend here; `#phase-legend` maps the same colours.
    drawAxisTitles(ctx, W, H, xAxisTitle(), 'G (kJ/mol)', margin);
}

// ------------------------------------------------------------- phase cells --

// A phase cell as encoded by `PhaseCell::encode` (gibbs_engine/hull.rs): bits
// 0-7 = upper phase index, 8-15 = lower phase index, 16-17 = kind, 18-19 =
// lower phase's set, 20-21 = upper phase's set. Indices are into
// tdbInfo.phase_names (solution phases, then compounds). In the sweep's raster
// the sets are field identities, stable in T and named by `field_names`; in
// `phase_at`'s answer they are only a rank on one hull.
const PHASE_KIND = { SINGLE: 0, TWO_PHASE: 1, MISCIBILITY_GAP: 2 };

function decodePhaseCell(code) {
    return {
        kind: (code >>> 16) & 0x3,
        a: (code >>> 8) & 0xff,
        b: code & 0xff,
        aSet: (code >>> 18) & 0x3,
        bSet: (code >>> 20) & 0x3,
    };
}

// -------------------------------------------------------------------- main --
//
// The header, the footer and the start-up sequence.

// The header's Paper link, from the `site-links` JSON block; Code and the lab
// are in the footer. Left out if the block has no paper URL or is malformed.
function renderSiteLinks() {
    const row = document.getElementById('site-link-row');
    const url = siteConfig().paper?.url;
    if (!row || !url) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Paper';
    row.replaceChildren(a);
}

/// The centred system name, which also opens the picker. Hidden rather than
/// emptied, which would keep a Tab stop, when there is no database or the
/// Diagram tab is not active.
let headerSystemName = null;

function setHeaderSystem(system) {
    headerSystemName = system || null;
    syncHeaderSystem();
}

function syncHeaderSystem() {
    if (!headerSystem) return;
    const onDiagram = document.getElementById('tab-viz')?.classList.contains('active');
    headerSystem.textContent = headerSystemName || '';
    headerSystem.classList.toggle('hidden', !headerSystemName || !onDiagram);
    headerSystem.title = headerSystemName
        ? `${headerSystemName} — open the system picker` : '';
}

function siteConfig() {
    try {
        return JSON.parse(document.getElementById('site-links')?.textContent || '{}');
    } catch { return {}; }
}

// The footer's links, About's engine version, and the Cite popover. Runs at
// first paint and again once the engine version exists.
function renderFooter() {
    const cfg = siteConfig();
    const lab = document.getElementById('footer-lab');
    const anchor = document.getElementById('footer-refs-end');
    if (!lab || !anchor) return;

    if (cfg.lab) lab.href = cfg.lab;
    else lab.removeAttribute('href');

    // Only the generated links and their separators are rebuilt, since the
    // static children carry handlers. Each link brings the separator before
    // it; the fixed one at `anchor` follows the run.
    for (const stale of document.querySelectorAll('[data-footer-ref]')) stale.remove();
    const refs = [
        { label: 'Paper', url: (cfg.paper || {}).url },
        { label: 'arXiv', url: (cfg.paper || {}).arxiv },
        { label: 'Code',  url: cfg.code },
    ];
    for (const r of refs) {
        if (!r.url) continue;               // never a dead link
        const a = document.createElement('a');
        a.className = 'footer-ref';
        a.dataset.footerRef = '';
        a.href = r.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = r.label;
        // Not `.footer-ref`, which would underline it like a link.
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.dataset.footerRef = '';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '·';
        anchor.before(sep, a);
    }

    // The popover shows the version too. Rebuilding its contents is safe, as
    // `setupCitePopover` wires only the button and the popover element.
    if (document.getElementById('cite-popover')?.childNodes.length) {
        renderCitePopover();
    }

    const ver = document.getElementById('about-build-version');
    // `engine_version()` throws until the module is initialised.
    if (ver) {
        ver.textContent = 'GibbScope'
            + (wasm ? ` \u2014 engine ${engine_version()}` : '');
    }
}

/// The corpus credit in full, from `site-links`. About and the picker both
/// build it here, so they cannot differ after the lead-in, which an element
/// can set with `data-prefix`.
function renderCorpusCredit(el) {
    if (!el) return;
    const corpus = siteConfig().corpus || {};
    el.textContent = '';
    el.append(document.createTextNode(el.dataset.prefix || 'Databases from '));
    // Drops the citation's full stop, as the sentence continues after it.
    const cite = (corpus.text || '').replace(/\.$/, '');
    if (corpus.doi) {
        const a = document.createElement('a');
        a.href = `https://doi.org/${corpus.doi}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = cite || corpus.doi;
        el.appendChild(a);
    } else {
        el.append(document.createTextNode(cite));
    }
    el.append(document.createTextNode(', redistributed unmodified under '));
    const lic = document.createElement('a');
    lic.href = corpus.licenceUrl || 'https://creativecommons.org/licenses/by/4.0/';
    lic.target = '_blank';
    lic.rel = 'noopener';
    lic.textContent = corpus.licence || 'CC BY 4.0';
    el.append(lic, document.createTextNode('.'));
}

// The Cite popover: the paper, the archived software and the engine build.
// An entry with no BibTeX in `site-links` shows a pending note instead. The
// databases and experimental data are credited in About's Acknowledgments,
// which the popover links to.
function renderCitePopover() {
    const pop = document.getElementById('cite-popover');
    const cfg = siteConfig();
    const paper = cfg.paper || {};
    const software = cfg.software || {};
    pop.textContent = '';

    const addSection = (heading, bibtex, pending) => {
        const h = document.createElement('h3');
        h.textContent = heading;
        pop.appendChild(h);
        if (!bibtex) {
            const p = document.createElement('p');
            p.className = 'pending';
            p.textContent = pending;
            pop.appendChild(p);
            return;
        }
        const pre = document.createElement('pre');
        pre.className = 'cite-bibtex';
        pre.textContent = bibtex;
        pop.appendChild(pre);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cite-copy';
        btn.textContent = 'Copy BibTeX';
        btn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(bibtex);
                btn.textContent = 'Copied';
            } catch {
                // Clipboard access is refused over plain http and in some
                // embeddings, so the text is selected instead.
                const r = document.createRange();
                r.selectNodeContents(pre);
                const sel = getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
                btn.textContent = 'Selected — press Ctrl/Cmd+C';
            }
            setTimeout(() => { btn.textContent = 'Copy BibTeX'; }, 2500);
        });
        pop.appendChild(btn);
    };

    addSection('Paper', paper.bibtex, 'The paper is not yet available.');
    addSection('Software', software.bibtex,
               'The archived release on Zenodo, with its DOI, is not yet available.');

    // The engine build, the same string an exported SVG carries in `<desc>`.
    if (wasm) {
        const build = document.createElement('p');
        build.className = 'cite-build mono';
        build.textContent =
            `Figures in this session were produced by engine ${engine_version()}`;
        pop.appendChild(build);
    }

    // Third-party data; `setupCitePopover` handles the click.
    const ack = document.createElement('p');
    ack.className = 'cite-ack';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'footer-link cite-goto-ack';
    go.textContent = 'Acknowledgments';
    ack.append('See citations of third-party data in ', go, '.');
    pop.appendChild(ack);
}

function setupCitePopover() {
    const btn = document.getElementById('cite-btn');
    const pop = document.getElementById('cite-popover');
    if (!btn || !pop) return;
    renderCitePopover();

    // Tracked here, since the click-away handler calls `setOpen(false)` on
    // every click and focus is restored only on a real close.
    let open = false;
    let returnFocusTo = null;

    const setOpen = (want) => {
        if (want === open) return;
        open = want;
        pop.classList.toggle('hidden', !open);
        btn.setAttribute('aria-expanded', String(open));
        if (open) {
            returnFocusTo = document.activeElement;
            (pop.querySelector('.cite-copy') || pop).focus();
        } else if (returnFocusTo) {
            // Only when the popover still has focus, so a click elsewhere
            // keeps it there.
            if (pop.contains(document.activeElement)) returnFocusTo.focus();
            returnFocusTo = null;
        }
    };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(!open);
    });
    // Delegated, as the popover's contents are rebuilt.
    pop.addEventListener('click', (e) => {
        if (!e.target.closest('.cite-goto-ack')) return;
        returnFocusTo = null;       // focus goes to the section instead
        setOpen(false);
        showAcknowledgments();
    });
    document.addEventListener('click', (e) => {
        if (!pop.contains(e.target) && e.target !== btn) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setOpen(false);
    });
}

function initApp() {
    // Before anything draws; the plot card carries the figure theme.
    refreshPalette(figureCard);
    renderSiteLinks();
    renderFooter();
    renderCorpusCredit(document.getElementById('about-credit'));
    renderCorpusCredit(document.getElementById('picker-credit'));
    setupCitePopover();
    setupTdbDragAndDrop();
    setupBaselineControls();
    setupExamplePicker();
    setupExpDragAndDrop();
    setupDiagramZoom();
    setupFitControls();
    setupExportControls();
    setupHoverReadout();
    setupUnnamedHover();
    setupDiagramKeys();
    setupUnitToggles();
    run();
    
    document.querySelectorAll('.tab')
        .forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
}

/// The tab on screen, for the URL. Every tab change goes through `showTab`, so
/// the tab strip and the content always agree.
let openTab = 'viz';

function showTab(name) {
    openTab = name;
    scheduleUrlSync();
    document.querySelectorAll('.tab').forEach(b => {
        const on = b.dataset.tab === name;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.tab-content')
        .forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
    syncHeaderSystem();
    // The manifest is fetched on first open, not at start-up.
    if (name === 'picker') picker.open();
}

headerSystem?.addEventListener('click', () => showTab('picker'));

/// About at Acknowledgments, which credits the databases and the experimental
/// data and has the software licence directly below it.
function showAcknowledgments() {
    showTab('about');
    const sec = document.getElementById('about-acknowledgments');
    sec?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    sec?.querySelector('h2')?.focus({ preventScroll: true });
}

document.getElementById('license-btn')?.addEventListener('click', showAcknowledgments);

document.addEventListener('DOMContentLoaded', initApp);

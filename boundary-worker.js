// boundary-worker.js: runs the boundary sweep off the main thread, so that a
// slow sweep does not block the pointer events a slider drag needs.
//
// The page's `TdbHandle` points into the page's wasm memory and cannot be
// passed in, so this worker has its own wasm instance and parses the database
// again from the same text, as fit-worker.js does. A Rust panic is a wasm trap:
// it skips the catch below and reaches the page as the worker's `error` event.
// Parsing is slow on large databases, so the page sends a `warm` message as
// soon as one loads.

import init, {
    load_tdb, reset_heap_tracker, get_peak_heap_bytes, get_wasm_rss_bytes,
} from './pkg/calphad_wasm.js';

let ready = null;
let handle = null;
let loadedKey = null;

/// The comparison database, in its own slot so that recomputing the ghost on
/// every pan does not re-parse either database.
let baselineHandle = null;
let baselineLoadedKey = null;

/// Returns the handle for `tdbKey`, parsing `tdbText` if this worker has not
/// seen that key. The page sends the text with the first message for a key, so
/// a missing text is a bug, and the throw reaches the page as an `error`.
function ensureHandle(tdbText, tdbKey) {
    if (loadedKey === tdbKey && handle) return handle;
    if (!tdbText) throw new Error('the sweep worker was not sent the database');
    if (handle) handle.free();
    handle = load_tdb(tdbText);
    loadedKey = tdbKey;
    return handle;
}

/// `ensureHandle` for the comparison database.
function ensureBaselineHandle(text, key) {
    if (baselineLoadedKey === key && baselineHandle) return baselineHandle;
    if (!text) throw new Error('the sweep worker was not sent the comparison database');
    if (baselineHandle) baselineHandle.free();
    baselineHandle = load_tdb(text);
    baselineLoadedKey = key;
    return baselineHandle;
}

self.onmessage = async (event) => {
    const msg = event.data;
    if (!msg) return;

    try {
        // Instantiate once; later messages await the same promise.
        ready ??= init();
        await ready;

        // Parse now, while the page draws its first frame, so the first sweep
        // does not pay for it.
        if (msg.type === 'warm') {
            ensureHandle(msg.tdbText, msg.tdbKey);
            return;
        }
        if (msg.type !== 'sweep') return;

        const h = ensureHandle(msg.tdbText, msg.tdbKey);

        reset_heap_tracker();
        const rss0 = get_wasm_rss_bytes();
        const t0 = performance.now();

        const report = h.compute_boundaries(
            msg.paramsJson, msg.nTSteps, msg.tTolerance,
            msg.xMin, msg.xMax, msg.tMin, msg.tMax, msg.expJson);

        // The ghost uses `ghost_boundaries`: no cell raster, no residuals, and
        // "{}" is the assessed state. It sweeps the view's T window rather than
        // the database's range, so its curves stay smooth on a narrow view; the
        // live sweep cannot, because its residuals must not depend on the view.
        // The ghost may come from a second database, and the page mirrors its
        // curves when the element order differs.
        let baseline = null;
        if (msg.baselineTSteps > 0) {
            const bh = msg.baselineKey != null
                ? ensureBaselineHandle(msg.baselineText, msg.baselineKey) : h;
            const b = bh.ghost_boundaries(
                '{}', msg.baselineTSteps, msg.tTolerance, msg.tMin, msg.tMax);
            baseline = { boundaries: b.boundaries };
        }

        self.postMessage({
            type: 'result', id: msg.id, key: msg.tdbKey,
            report, baseline,
            sweepMs: performance.now() - t0,
            // This instance's memory figures; the page's own tracker sees none
            // of the engine's work.
            peakHeap: get_peak_heap_bytes(),
            rssBytes: get_wasm_rss_bytes(),
            rssDelta: get_wasm_rss_bytes() - rss0,
        });
    } catch (e) {
        // Ordinary failures (a refused database, malformed params) land here;
        // a trap arrives as the `error` event. app.js discards the worker after
        // either.
        self.postMessage({
            type: 'error',
            id: msg.id,
            message: (e && e.message) ? e.message : String(e),
        });
    }
};

// fit-worker.js: runs the Nelder-Mead fit off the main thread, since
// `TdbHandle::fit` is a synchronous wasm call that takes seconds.
//
// The page's handle points into the page's wasm memory and cannot be passed
// in, so this worker has its own instance and parses the database again from
// the same text, once per database. Everything that crosses is a string.

import init, { load_tdb } from './pkg/calphad_wasm.js';

let ready = null;
let handle = null;
let loadedKey = null;

/// Returns the handle for `tdbKey`, parsing `tdbText` when the key changes.
/// The page issues a new key for each database, so the text is never compared.
function ensureHandle(tdbText, tdbKey) {
    if (loadedKey === tdbKey && handle) return handle;
    if (handle) handle.free();
    handle = load_tdb(tdbText);
    loadedKey = tdbKey;
    return handle;
}

self.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'fit') return;

    try {
        // Instantiate once; later messages await the same promise.
        ready ??= init();
        await ready;

        const h = ensureHandle(msg.tdbText, msg.tdbKey);
        const json = h.fit(
            msg.paramsJson, msg.expJson, msg.keysJson,
            msg.maxEvaluations, msg.nTSteps, msg.tTolerance, msg.boundsJson);

        self.postMessage({ type: 'result', id: msg.id, json });
    } catch (e) {
        // Ordinary failures (a refused database, malformed params) land here.
        // A Rust panic is a wasm trap: it skips this catch and reaches the page
        // as the worker's `error` event. app.js discards the worker after either.
        self.postMessage({
            type: 'error',
            id: msg.id,
            message: (e && e.message) ? e.message : String(e),
        });
    }
};

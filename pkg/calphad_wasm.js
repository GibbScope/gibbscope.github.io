/* @ts-self-types="./calphad_wasm.d.ts" */

/**
 * The parsed system, kept in wasm memory; JS holds an opaque reference, so a
 * slider drag does not re-parse the database.
 */
export class TdbHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TdbHandle.prototype);
        obj.__wbg_ptr = ptr;
        TdbHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TdbHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tdbhandle_free(ptr, 0);
    }
    /**
     * Phase boundaries as vector polylines plus the invariant reactions found
     * along the way. `n_t_steps` sets the sweep resolution; `t_tolerance` is
     * how tightly each invariant temperature is bracketed by bisection (K).
     * @param {string} params_json
     * @param {number} n_t_steps
     * @param {number} t_tolerance
     * @param {number} x_min
     * @param {number} x_max
     * @param {number} t_min
     * @param {number} t_max
     * @param {string} exp_json
     * @returns {any}
     */
    compute_boundaries(params_json, n_t_steps, t_tolerance, x_min, x_max, t_min, t_max, exp_json) {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(exp_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_compute_boundaries(this.__wbg_ptr, ptr0, len0, n_t_steps, t_tolerance, x_min, x_max, t_min, t_max, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The loaded database re-emitted with the current parameters written back
     * into their `PARAMETER` statements. Untouched lines survive byte for
     * byte; anything that could not be applied is listed in the header.
     * @param {string} params_json
     * @returns {string}
     */
    export_tdb(params_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.tdbhandle_export_tdb(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Minimises the weighted RMS misfit (`ResidualReport::objective`) over the
     * unlocked parameters, seeded from the current ones. `unlocked_keys_json` is a JSON array of keys such as
     * `["LIQUID:0:a", "_compound:MG2SI_C1"]`. Returns a JSON `FitResult`.
     * @param {string} params_json
     * @param {string} exp_json
     * @param {string} unlocked_keys_json
     * @param {number} max_evaluations
     * @param {number} n_t_steps
     * @param {number} t_tolerance
     * @param {string} bounds_json
     * @returns {string}
     */
    fit(params_json, exp_json, unlocked_keys_json, max_evaluations, n_t_steps, t_tolerance, bounds_json) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(exp_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(unlocked_keys_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passStringToWasm0(bounds_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len3 = WASM_VECTOR_LEN;
            const ret = wasm.tdbhandle_fit(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, max_evaluations, n_t_steps, t_tolerance, ptr3, len3);
            deferred5_0 = ret[0];
            deferred5_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Suggested top of the temperature axis for the current parameters.
     * @param {string} params_json
     * @returns {number}
     */
    fitted_t_max(params_json) {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_fitted_t_max(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * G of a line compound at `t`, per mole of atoms, with the offset a fitted
     * parameter has put on it, as `build_hull` places it; the G-curve panel
     * draws the compound's dot from this and its tangents from the hull. NaN if
     * not a compound.
     * @param {string} phase
     * @param {number} t
     * @param {string} params_json
     * @returns {number}
     */
    g_compound(phase, t, params_json) {
        const ptr0 = passStringToWasm0(phase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_g_compound(this.__wbg_ptr, ptr0, len0, t, ptr1, len1);
        return ret;
    }
    /**
     * G(x) for one solution phase at temperature `t`, on the N_COMPOSITIONS grid.
     * @param {string} phase
     * @param {number} t
     * @param {string} params_json
     * @returns {Float64Array}
     */
    g_curve(phase, t, params_json) {
        const ptr0 = passStringToWasm0(phase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_g_curve(this.__wbg_ptr, ptr0, len0, t, ptr1, len1);
        var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v3;
    }
    /**
     * The same, sampled over the composition window `[x_min, x_max]`.
     *
     * A separate method because wasm-bindgen's generated JS drops arguments the
     * bundle does not declare: a stale `app/pkg` would ignore extra arguments
     * on `g_curve` and return the full range, whereas a missing method throws.
     * @param {string} phase
     * @param {number} t
     * @param {string} params_json
     * @param {number} x_min
     * @param {number} x_max
     * @returns {Float64Array}
     */
    g_curve_window(phase, t, params_json, x_min, x_max) {
        const ptr0 = passStringToWasm0(phase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_g_curve_window(this.__wbg_ptr, ptr0, len0, t, ptr1, len1, x_min, x_max);
        var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v3;
    }
    /**
     * The boundary curves alone, swept over a temperature range the caller
     * chooses: the reference ghost's entry point.
     *
     * The live sweep's range is fixed, because the misfit is computed from its
     * curves. The ghost carries no residual, so it can follow the view, which
     * puts its levels where the reader is looking rather than spread over a
     * wide declared range.
     *
     * A separate method for the reason `g_curve_window` gives. It computes no
     * raster (`cells` empty, `cell_rows`/`cell_cols` 0) and no residuals. It
     * does compute invariants: their brackets feed `curve_levels`, so a polyline
     * runs up to a reaction instead of stopping a grid step short. No
     * composition window: every hull is built over the whole range. The page
     * mirrors the returned curves when the two databases declare their elements
     * in opposite orders.
     * @param {string} params_json
     * @param {number} n_t_steps
     * @param {number} t_tolerance
     * @param {number} t_min
     * @param {number} t_max
     * @returns {any}
     */
    ghost_boundaries(params_json, n_t_steps, t_tolerance, t_min, t_max) {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_ghost_boundaries(this.__wbg_ptr, ptr0, len0, n_t_steps, t_tolerance, t_min, t_max);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Everything the UI needs to build its panels, in one call.
     * @returns {string}
     */
    info() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.tdbhandle_info(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * What is stable at a single (x, T), as an encoded `PhaseCell`. One hull
     * build, so it is cheap enough for a hover readout; `PhaseCell::decode` on
     * the JS side turns it back into phase indices.
     *
     * The phases and the kind are the raster's. The sets are not: they are the
     * left-to-right rank on this one hull (`composition_sets`), while the
     * raster's sets number fields across the whole sweep, which one hull
     * cannot know. A caller naming a field takes its set from the raster.
     * @param {number} x
     * @param {number} t
     * @param {string} params_json
     * @returns {number}
     */
    phase_at(x, t, params_json) {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_phase_at(this.__wbg_ptr, x, t, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    t_max() {
        const ret = wasm.tdbhandle_t_max(this.__wbg_ptr);
        return ret;
    }
    /**
     * The temperature range this database asserts its functions over: its own
     * `TEMP-LIM`, or the envelope of its parsed segments. The axis and every
     * sweep are clamped to it.
     * @returns {number}
     */
    t_min() {
        const ret = wasm.tdbhandle_t_min(this.__wbg_ptr);
        return ret;
    }
    /**
     * Flat list of common-tangent endpoints `[x_left, x_right, ...]` at `t`.
     * @param {number} t
     * @param {string} params_json
     * @returns {Float64Array}
     */
    tangents(t, params_json) {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_tangents(this.__wbg_ptr, t, ptr0, len0);
        var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v2;
    }
    /**
     * The tie-line through a two-phase point: `[x_left, x_right, p_left,
     * p_right]`, where `p_left` is the index (as in `phase_names`) of the phase
     * at `x_left`; or empty when only one phase is stable there.
     *
     * The phases are here because `phase_at` cannot give them in order: a
     * two-phase cell holds its phases sorted by index.
     * @param {number} x
     * @param {number} t
     * @param {string} params_json
     * @returns {Float64Array}
     */
    tie_line_at(x, t, params_json) {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tdbhandle_tie_line_at(this.__wbg_ptr, x, t, ptr0, len0);
        var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v2;
    }
}
if (Symbol.dispose) TdbHandle.prototype[Symbol.dispose] = TdbHandle.prototype.free;

/**
 * @returns {string}
 */
export function engine_version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.engine_version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @returns {number}
 */
export function get_grid_height() {
    const ret = wasm.get_grid_height();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function get_grid_width() {
    const ret = wasm.get_grid_height();
    return ret >>> 0;
}

/**
 * Peak heap growth, in bytes, since the last `reset_heap_tracker`.
 * @returns {number}
 */
export function get_peak_heap_bytes() {
    const ret = wasm.get_peak_heap_bytes();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function get_t_max() {
    const ret = wasm.get_t_max();
    return ret;
}

/**
 * @returns {number}
 */
export function get_t_min() {
    const ret = wasm.get_t_min();
    return ret;
}

/**
 * The size of wasm linear memory in bytes (0 outside wasm).
 * @returns {number}
 */
export function get_wasm_rss_bytes() {
    const ret = wasm.get_wasm_rss_bytes();
    return ret >>> 0;
}

/**
 * Parses a TDB once and precomputes the active phase / compound lists.
 * @param {string} text
 * @returns {TdbHandle}
 */
export function load_tdb(text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_tdb(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return TdbHandle.__wrap(ret[0]);
}

/**
 * Starts a new peak measurement from the current heap size.
 */
export function reset_heap_tracker() {
    wasm.reset_heap_tracker();
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_8c4e43fe74559d73: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_String_8f0eb39a4a4c2f66: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_361308b2356cecd0: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_3eb36ae241fe6f44: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_set_3f1d0b984ed272ed: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_f43e577aea94465b: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./calphad_wasm_bg.js": import0,
    };
}

const TdbHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tdbhandle_free(ptr >>> 0, 1));

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('calphad_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

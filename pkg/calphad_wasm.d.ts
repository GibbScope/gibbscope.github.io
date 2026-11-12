/* tslint:disable */
/* eslint-disable */

/**
 * The parsed system, kept in wasm memory; JS holds an opaque reference, so a
 * slider drag does not re-parse the database.
 */
export class TdbHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Phase boundaries as vector polylines plus the invariant reactions found
     * along the way. `n_t_steps` sets the sweep resolution; `t_tolerance` is
     * how tightly each invariant temperature is bracketed by bisection (K).
     */
    compute_boundaries(params_json: string, n_t_steps: number, t_tolerance: number, x_min: number, x_max: number, t_min: number, t_max: number, exp_json: string): any;
    /**
     * The loaded database re-emitted with the current parameters written back
     * into their `PARAMETER` statements. Untouched lines survive byte for
     * byte; anything that could not be applied is listed in the header.
     */
    export_tdb(params_json: string): string;
    /**
     * Minimises the weighted RMS misfit (`ResidualReport::objective`) over the
     * unlocked parameters, seeded from the current ones. `unlocked_keys_json` is a JSON array of keys such as
     * `["LIQUID:0:a", "_compound:MG2SI_C1"]`. Returns a JSON `FitResult`.
     */
    fit(params_json: string, exp_json: string, unlocked_keys_json: string, max_evaluations: number, n_t_steps: number, t_tolerance: number, bounds_json: string): string;
    /**
     * Suggested top of the temperature axis for the current parameters.
     */
    fitted_t_max(params_json: string): number;
    /**
     * G of a line compound at `t`, per mole of atoms, with the offset a fitted
     * parameter has put on it, as `build_hull` places it; the G-curve panel
     * draws the compound's dot from this and its tangents from the hull. NaN if
     * not a compound.
     */
    g_compound(phase: string, t: number, params_json: string): number;
    /**
     * G(x) for one solution phase at temperature `t`, on the N_COMPOSITIONS grid.
     */
    g_curve(phase: string, t: number, params_json: string): Float64Array;
    /**
     * The same, sampled over the composition window `[x_min, x_max]`.
     *
     * A separate method because wasm-bindgen's generated JS drops arguments the
     * bundle does not declare: a stale `app/pkg` would ignore extra arguments
     * on `g_curve` and return the full range, whereas a missing method throws.
     */
    g_curve_window(phase: string, t: number, params_json: string, x_min: number, x_max: number): Float64Array;
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
     */
    ghost_boundaries(params_json: string, n_t_steps: number, t_tolerance: number, t_min: number, t_max: number): any;
    /**
     * Everything the UI needs to build its panels, in one call.
     */
    info(): string;
    /**
     * What is stable at a single (x, T), as an encoded `PhaseCell`. One hull
     * build, so it is cheap enough for a hover readout; `PhaseCell::decode` on
     * the JS side turns it back into phase indices.
     *
     * The phases and the kind are the raster's. The sets are not: they are the
     * left-to-right rank on this one hull (`composition_sets`), while the
     * raster's sets number fields across the whole sweep, which one hull
     * cannot know. A caller naming a field takes its set from the raster.
     */
    phase_at(x: number, t: number, params_json: string): number;
    t_max(): number;
    /**
     * The temperature range this database asserts its functions over: its own
     * `TEMP-LIM`, or the envelope of its parsed segments. The axis and every
     * sweep are clamped to it.
     */
    t_min(): number;
    /**
     * Flat list of common-tangent endpoints `[x_left, x_right, ...]` at `t`.
     */
    tangents(t: number, params_json: string): Float64Array;
    /**
     * The tie-line through a two-phase point: `[x_left, x_right, p_left,
     * p_right]`, where `p_left` is the index (as in `phase_names`) of the phase
     * at `x_left`; or empty when only one phase is stable there.
     *
     * The phases are here because `phase_at` cannot give them in order: a
     * two-phase cell holds its phases sorted by index.
     */
    tie_line_at(x: number, t: number, params_json: string): Float64Array;
}

export function engine_version(): string;

export function get_grid_height(): number;

export function get_grid_width(): number;

/**
 * Peak heap growth, in bytes, since the last `reset_heap_tracker`.
 */
export function get_peak_heap_bytes(): number;

export function get_t_max(): number;

export function get_t_min(): number;

/**
 * The size of wasm linear memory in bytes (0 outside wasm).
 */
export function get_wasm_rss_bytes(): number;

/**
 * Parses a TDB once and precomputes the active phase / compound lists.
 */
export function load_tdb(text: string): TdbHandle;

/**
 * Starts a new peak measurement from the current heap size.
 */
export function reset_heap_tracker(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly engine_version: () => [number, number];
    readonly get_grid_height: () => number;
    readonly get_peak_heap_bytes: () => number;
    readonly get_t_max: () => number;
    readonly get_t_min: () => number;
    readonly get_wasm_rss_bytes: () => number;
    readonly get_grid_width: () => number;
    readonly reset_heap_tracker: () => void;
    readonly __wbg_tdbhandle_free: (a: number, b: number) => void;
    readonly load_tdb: (a: number, b: number) => [number, number, number];
    readonly tdbhandle_compute_boundaries: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly tdbhandle_export_tdb: (a: number, b: number, c: number) => [number, number];
    readonly tdbhandle_fit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number];
    readonly tdbhandle_fitted_t_max: (a: number, b: number, c: number) => number;
    readonly tdbhandle_g_compound: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly tdbhandle_g_curve: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly tdbhandle_g_curve_window: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly tdbhandle_ghost_boundaries: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly tdbhandle_info: (a: number) => [number, number];
    readonly tdbhandle_phase_at: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly tdbhandle_t_max: (a: number) => number;
    readonly tdbhandle_t_min: (a: number) => number;
    readonly tdbhandle_tangents: (a: number, b: number, c: number, d: number) => [number, number];
    readonly tdbhandle_tie_line_at: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

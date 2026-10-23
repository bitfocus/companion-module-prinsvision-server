/**
 * Wheel-node parameter layer (PLAN_COMPANION_ENCODER_GRADING F2/F3/F4).
 *
 * Pure functions, no Companion/socket state. One spec table drives:
 *  - variable definitions + values (F2, `current_<id>` on the encoder LCD)
 *  - relative adjust / reset actions (F3, spec.get/set + step/min/max)
 *  - rotary presets (F4, grouped per node type)
 *
 * Server conventions encoded here:
 *  - Reset stores params as {} (Server grading_events `_reset_and_broadcast`)
 *    — defaults are client-side knowledge, mirrored from the Control UI
 *    (UI/src/features/control/types/nodes.ts DEFAULTS). `withDefaults()`
 *    reads {} as "everything at default".
 *  - Pivot and Log lowRange/highRange default per pipeline mode (PVLog /
 *    ACEScct mid-grey). The server sends each slot's mode with the snapshot
 *    and every layer:stack_sync; defaults mirror the Control UI's
 *    getWheelPivotDefault / getLogWheelsRangeDefaults.
 *  - Broadcast per-wheel temp/tint is a derived 2D paint view on the wheel's
 *    Y/R/G/B — math copied verbatim from the Control UI's broadcastMath.ts
 *    (TEMP/TINT_SCALE 0.005: ±100 temp/tint ↔ ±0.5 channel offset). The
 *    node's global Temp/Tint is white balance, like Primary/Log.
 *  - Temp/Tint (all three wheel types) = white balance in real Kelvin
 *    (PHASE 22.13 F4b): ΔK from 6500 K, typing limit ±4000; tint ±100 =
 *    Duv ±0.02. Ranges mirror the Control UI's temperatureMath.ts.
 *  - Wave Corrector (PHASE 22.13 F7): its own params, not wheels. Balls are
 *    vectorscope [Cb, Cr] arrays shown and edited as an RGB balance with luma
 *    held — math copied from the Control UI's waveCorrectorControls.ts, which
 *    needs the slot's working-gamut luma, hence the pipeline mode on get/set.
 *    Reset stores the full neutral set (server `_reset_params`), never {}.
 */

export type WheelNodeType = 'primary_wheels' | 'log_wheels' | 'broadcast_wheels' | 'wave_corrector'
/** Node types the encoders drive. The name predates the Wave Corrector (not a
 *  wheel node, but the Corrector of the Base PrinsVision Look a new slot starts
 *  with) — it rides the same spec/preview/commit path. */
export const WHEEL_NODE_TYPES: WheelNodeType[] = ['primary_wheels', 'log_wheels', 'broadcast_wheels', 'wave_corrector']

export type Params = Record<string, unknown>

export type PipelineMode = 'prinsvision' | 'aces'

interface RGBMasterWheel {
    color: { r: number; g: number; b: number }
    master: number
}

interface BroadcastWheel {
    y: number
    r: number
    g: number
    b: number
}

// ============================================================================
// Defaults (mirror of Control UI nodes.ts DEFAULTS)
// ============================================================================

const rgbMasterWheel = (): RGBMasterWheel => ({ color: { r: 0, g: 0, b: 0 }, master: 0 })
const broadcastWheel = (): BroadcastWheel => ({ y: 0, r: 0, g: 0, b: 0 })

// Mid-grey (linear 0.18) in the grading log space: PVLog / ACEScct.
export const pivotDefault = (mode: PipelineMode): number => mode === 'aces' ? 0.4135884 : 0.3821938

const logRangeDefaults = (mode: PipelineMode) =>
    mode === 'aces' ? { lowRange: 0.28, highRange: 0.48 } : { lowRange: 0.25, highRange: 0.44 }

export function nodeDefaults(nodeType: WheelNodeType, mode: PipelineMode): Params {
    const GLOBALS_DEFAULT = { contrast: 1.0, pivot: pivotDefault(mode), saturation: 1.0, hue: 0 }
    switch (nodeType) {
        case 'primary_wheels':
            return {
                lift: rgbMasterWheel(), gamma: rgbMasterWheel(),
                gain: rgbMasterWheel(), offset: rgbMasterWheel(),
                temperature: 0, tint: 0, ...GLOBALS_DEFAULT, lumMix: 1.0,
            }
        case 'log_wheels':
            return {
                shadow: rgbMasterWheel(), midtone: rgbMasterWheel(),
                highlight: rgbMasterWheel(), offset: rgbMasterWheel(),
                ...logRangeDefaults(mode),
                temperature: 0, tint: 0, ...GLOBALS_DEFAULT, lumMix: 1.0,
            }
        case 'broadcast_wheels':
            return {
                black: broadcastWheel(), flare: broadcastWheel(),
                gamma: broadcastWheel(), gain: broadcastWheel(),
                temperature: 0, tint: 0, ...GLOBALS_DEFAULT,
            }
        case 'wave_corrector':
            // Mirror of Shared/Constants/ui_node_defaults.json `wave_corrector`
            // (the same in both modes; the server's neutral_params() equals it).
            // wave_corrector_params_test.mjs compares against that file.
            return {
                gain: 1, exposure: 0, pedestal: 0, bandLow: 0.2, bandHigh: 0.45, softLow: 0.1, softHigh: 0.1,
                bandGamma: 0, shadow: [0, 0], band: [0, 0], white: [0, 0],
                saturation: 1, hue: 0, contrast: 1, temperature: 0, tint: 0,
            }
    }
}

/**
 * Stored params merged over defaults. The server stores {} after a reset and
 * may hold partial dicts historically — every missing key means "default".
 * Wheel sub-objects merge per key so a partial {lift: {master: .1}} keeps
 * default color channels.
 */
export function withDefaults(nodeType: WheelNodeType, params: Params | null | undefined, mode: PipelineMode): Params {
    const base = nodeDefaults(nodeType, mode)
    if (!params) return base
    const out: Params = { ...base }
    for (const [key, value] of Object.entries(params)) {
        const def = base[key]
        // Arrays (Wave Corrector balls [x, y]) are values, not wheels: a
        // per-key merge would turn [0.1, 0.2] into {0: 0.1, 1: 0.2}, which the
        // server reads as a ball without x/y and refuses.
        if (Array.isArray(def) || Array.isArray(value)) {
            if (value !== undefined) out[key] = value
        } else if (def !== null && typeof def === 'object' && value !== null && typeof value === 'object') {
            out[key] = mergeWheel(def as Params, value as Params)
        } else if (value !== undefined) {
            out[key] = value
        }
    }
    return out
}

function mergeWheel(def: Params, stored: Params): Params {
    const out: Params = { ...def }
    for (const [k, v] of Object.entries(stored)) {
        if (v !== null && typeof v === 'object' && typeof def[k] === 'object' && def[k] !== null) {
            out[k] = { ...(def[k] as Params), ...(v as Params) }
        } else if (v !== undefined) {
            out[k] = v
        }
    }
    return out
}

// ============================================================================
// Broadcast derived temp/tint — verbatim copy of the Control UI's
// broadcastMath.ts (keep in sync with that file; it is the source of truth)
// ============================================================================

export const TEMP_SCALE = 0.005
export const TINT_SCALE = 0.005

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function wheelToTempTint(w: BroadcastWheel): { temp: number; tint: number } {
    return {
        temp: ((w.r - w.b) / 2) / TEMP_SCALE,
        tint: -w.g / TINT_SCALE,
    }
}

export function applyTempTintDelta(w: BroadcastWheel, dTemp: number, dTint: number): BroadcastWheel {
    return {
        y: w.y,
        r: clamp(w.r + dTemp * TEMP_SCALE, -1, 1),
        g: clamp(w.g - dTint * TINT_SCALE, -1, 1),
        b: clamp(w.b - dTemp * TEMP_SCALE, -1, 1),
    }
}

// ============================================================================
// Param specs — one row per encoder-addressable parameter
// ============================================================================

export interface ParamSpec {
    /** Variable suffix + action option id, e.g. 'log_temperature' */
    id: string
    nodeType: WheelNodeType
    /** Human label, e.g. 'Log: Temperature' */
    label: string
    min: number
    max: number
    /** Default rotate step (plan m1); overridable per action instance */
    step: number
    /** Display rounding for the LCD variable (after displayScale) */
    decimals: number
    /**
     * LCD value = stored value × displayScale (default 1), so the readout
     * matches the Control UI box (Wave Corrector: Gain 100 %, Band Low 20 %).
     * step/min/max stay in stored units.
     */
    displayScale?: number
    /** Read current value from params-with-defaults (mode: Wave ball luma) */
    get: (params: Params, mode: PipelineMode) => number
    /**
     * Return the DELTA to put on the wire — only the touched top-level key(s),
     * each carrying its full value. NOT a full params dict: the server drops
     * None fields (`_build_params`), so a full dict would reset every param the
     * module hasn't cached (e.g. a previously-set tint) to default. Wheel
     * sub-objects are sent whole (color+master) because the engine's
     * `_wheel_to_array` needs the complete wheel.
     */
    set: (params: Params, value: number, mode: PipelineMode) => Params
    /**
     * Delta for "reset this control" when it is not "set the default value":
     * one RGB channel of a Wave ball at 0 is not a neutral ball (the other two
     * gave way), so a ball channel resets the whole ball. See resetDelta().
     */
    reset?: (params: Params, mode: PipelineMode) => Params
}

const scalarSpec = (
    nodeType: WheelNodeType, prefix: string, labelPrefix: string, key: string, label: string,
    min: number, max: number, step: number, decimals: number,
): ParamSpec => ({
    id: `${prefix}_${camelToSnake(key)}`,
    nodeType,
    label: `${labelPrefix}: ${label}`,
    min, max, step, decimals,
    get: (p) => Number(p[key] ?? 0),
    set: (_p, v) => ({ [key]: clamp(v, min, max) }),
})

const rgbMasterSpecs = (
    nodeType: WheelNodeType, prefix: string, labelPrefix: string, wheelKey: string, wheelLabel: string,
): ParamSpec[] => {
    const wheelOf = (p: Params) => p[wheelKey] as RGBMasterWheel
    const channel = (ch: 'r' | 'g' | 'b'): ParamSpec => ({
        id: `${prefix}_${wheelKey}_${ch}`,
        nodeType,
        label: `${labelPrefix}: ${wheelLabel} ${ch.toUpperCase()}`,
        min: -1, max: 1, step: 0.005, decimals: 3,
        get: (p) => Number(wheelOf(p).color[ch]),
        set: (p, v) => ({
            [wheelKey]: { ...wheelOf(p), color: { ...wheelOf(p).color, [ch]: clamp(v, -1, 1) } },
        }),
    })
    return [
        {
            // The wheel master IS the luma / Y channel (UI: "Y/Master"),
            // matching the broadcast wheels' explicit Y. Label it Y for
            // consistency; the id keeps `_master` (that's the stored param key).
            id: `${prefix}_${wheelKey}_master`,
            nodeType,
            label: `${labelPrefix}: ${wheelLabel} Y`,
            min: -1, max: 1, step: 0.005, decimals: 3,
            get: (p) => Number(wheelOf(p).master),
            set: (p, v) => ({ [wheelKey]: { ...wheelOf(p), master: clamp(v, -1, 1) } }),
        },
        channel('r'), channel('g'), channel('b'),
    ]
}

const broadcastChannelSpecs = (wheelKey: string, wheelLabel: string): ParamSpec[] => {
    const wheelOf = (p: Params) => p[wheelKey] as BroadcastWheel
    const channel = (ch: 'y' | 'r' | 'g' | 'b'): ParamSpec => ({
        id: `broadcast_${wheelKey}_${ch}`,
        nodeType: 'broadcast_wheels',
        label: `Broadcast: ${wheelLabel} ${ch.toUpperCase()}`,
        min: -1, max: 1, step: 0.005, decimals: 3,
        get: (p) => Number(wheelOf(p)[ch]),
        set: (p, v) => ({ [wheelKey]: { ...wheelOf(p), [ch]: clamp(v, -1, 1) } }),
    })
    const derived = (axis: 'temp' | 'tint'): ParamSpec => ({
        id: `broadcast_${wheelKey}_${axis}`,
        nodeType: 'broadcast_wheels',
        label: `Broadcast: ${wheelLabel} ${axis === 'temp' ? 'Temp' : 'Tint'}`,
        min: -100, max: 100, step: 1, decimals: 1,
        get: (p) => wheelToTempTint(wheelOf(p))[axis],
        set: (p, v) => {
            const cur = wheelToTempTint(wheelOf(p))
            const dTemp = axis === 'temp' ? v - cur.temp : 0
            const dTint = axis === 'tint' ? v - cur.tint : 0
            return { [wheelKey]: applyTempTintDelta(wheelOf(p), dTemp, dTint) }
        },
    })
    return [channel('y'), channel('r'), channel('g'), channel('b'), derived('temp'), derived('tint')]
}

const BROADCAST_WHEEL_KEYS = ['black', 'flare', 'gamma', 'gain'] as const

/** Broadcast global Temp/Tint = the node's white balance (stored params, not
 *  derived from the wheels since PHASE 22.13 F4b). Ids kept, so Stream Deck
 *  buttons made for the derived version keep working. */
const broadcastWhiteBalanceSpec = (axis: 'temp' | 'tint'): ParamSpec => {
    const spec = axis === 'temp'
        ? scalarSpec('broadcast_wheels', 'broadcast', 'Broadcast', 'temperature', 'Global Temp',
                     -TEMP_LIMIT_K, TEMP_LIMIT_K, 50, 0)
        : scalarSpec('broadcast_wheels', 'broadcast', 'Broadcast', 'tint', 'Global Tint',
                     -TINT_LIMIT, TINT_LIMIT, 1, 1)
    return { ...spec, id: `broadcast_${axis}` }
}

function camelToSnake(s: string): string {
    return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

const globalSpecs = (nodeType: WheelNodeType, prefix: string, labelPrefix: string): ParamSpec[] => [
    scalarSpec(nodeType, prefix, labelPrefix, 'contrast', 'Contrast', 0, 4, 0.02, 2),
    // 4 decimals: the mid-grey default (0.3822 / 0.4136) reads exactly on the LCD
    scalarSpec(nodeType, prefix, labelPrefix, 'pivot', 'Pivot', 0, 1, 0.005, 4),
    scalarSpec(nodeType, prefix, labelPrefix, 'saturation', 'Saturation', 0, 4, 0.02, 2),
    scalarSpec(nodeType, prefix, labelPrefix, 'hue', 'Hue', -180, 180, 1, 1),
    // Broadcast has no Lum Mix (post-show 2026-10-03); Primary and Log keep it.
    ...(nodeType === 'broadcast_wheels' ? []
        : [scalarSpec(nodeType, prefix, labelPrefix, 'lumMix', 'Lum Mix', 0, 1, 0.01, 2)]),
]

// Temperature is the white-balance change in K from 6500 K (+ = warmer),
// typing limit ±4000 like the Control UI (temperatureMath.ts). Shown as a
// plain signed number — 0 = neutral — NOT with a "K" unit, which read as
// absolute Kelvin and confused the operator. Step 50 K/tick (the Control UI
// steps in mired; a Stream Deck tick is coarse anyway).
const TEMP_LIMIT_K = 4000
const TINT_LIMIT = 100
const tempSpec = (nodeType: WheelNodeType, prefix: string, labelPrefix: string): ParamSpec =>
    scalarSpec(nodeType, prefix, labelPrefix, 'temperature', 'Temperature', -TEMP_LIMIT_K, TEMP_LIMIT_K, 50, 0)

// ============================================================================
// Wave Corrector (PHASE 22.13 F7) — ranges and ball math copied from the
// Control UI (waveCorrectorControls.ts + the Tangent dispatcher's WAVE_RANGES,
// tangentDispatch.ts); keep in sync with those files, they are the source of
// truth. The server (services/grading/wave_corrector.py validate) refuses a
// crossed band or a ball past the unit circle — the commit is then not stored —
// so the clamps below are not cosmetic.
// ============================================================================

type WaveBall = [number, number]
const WAVE_BALLS = ['shadow', 'band', 'white'] as const
/** Low stays this far below High (the editor's BAND_MIN_GAP). */
const WAVE_BAND_GAP = 0.01
const WAVE_GRID = 1e4
const waveRound = (v: number): number => Math.round(v * WAVE_GRID) / WAVE_GRID
// Toward zero on the grid; the 1e-7 nudge keeps float noise of an exact grid
// value (0.59999999999) on that value. Copied from waveCorrectorControls.ts.
const waveTruncGrid = (v: number): number => Math.trunc(v * WAVE_GRID + Math.sign(v) * 1e-7) / WAVE_GRID

/** Working-gamut luma weights (Kr, Kg, Kb) — the Control UI's MULTI_MATRIX_LUMA. */
const WAVE_LUMA: Record<PipelineMode, readonly [number, number, number]> = {
    prinsvision: [0.2627, 0.678, 0.0593],    // Rec.2020
    aces: [0.2722287, 0.6740818, 0.0536895], // ACES AP1
}

/** A ball inside the unit disc, truncated on the 1e-4 grid so rounding never carries it past 1. */
function clampBall(x: number, y: number): WaveBall {
    const r = Math.hypot(x, y)
    const k = r > 1 ? 1 / r : 1
    return [waveTruncGrid(x * k), waveTruncGrid(y * k)]
}

type BallRgb = { r: number; g: number; b: number }
const rgbScale = (kr: number): number => 1 / (2 * (1 - kr))

/** The ball [Cb, Cr] as the RGB step it stands for at grey, luma held; Cr = 1 reads R = 1. */
export function ballToRgb(ball: WaveBall, mode: PipelineMode): BallRgb {
    const [kr, kg, kb] = WAVE_LUMA[mode]
    const s = rgbScale(kr)
    const r = s * 2 * (1 - kr) * ball[1]
    const b = s * 2 * (1 - kb) * ball[0]
    return { r, g: -(kr * r + kb * b) / kg, b }
}

/** The ball after setting one channel to `value`: the other two give way equally in luma. */
function ballWithChannel(ball: WaveBall, channel: keyof BallRgb, value: number, mode: PipelineMode): WaveBall {
    const [kr, kg, kb] = WAVE_LUMA[mode]
    const k = { r: kr, g: kg, b: kb }
    const q = ballToRgb(ball, mode)
    const d = value - q[channel]
    const others = (['r', 'g', 'b'] as const).filter((c) => c !== channel)
    const give = (k[channel] * d) / (k[others[0]] + k[others[1]])
    const next = { ...q, [channel]: value }
    for (const c of others) next[c] = q[c] - give
    const s = rgbScale(kr)
    return clampBall(next.b / (s * 2 * (1 - kb)), next.r / (s * 2 * (1 - kr)))
}

const waveScalar = (
    key: string, label: string, min: number, max: number, step: number,
    decimals: number, displayScale = 1,
): ParamSpec => ({
    ...scalarSpec('wave_corrector', 'wave', 'Wave', key, label, min, max, step, decimals),
    displayScale,
})

const waveBandEdge = (edge: 'low' | 'high'): ParamSpec => {
    const key = edge === 'low' ? 'bandLow' : 'bandHigh'
    return {
        id: `wave_band_${edge}`,
        nodeType: 'wave_corrector',
        label: `Wave: Band ${edge === 'low' ? 'Low' : 'High'}`,
        min: 0, max: 1, step: 0.005, decimals: 1, displayScale: 100,
        get: (p) => Number(p[key]),
        // The moving edge stops at the other one (editor clampBandLow/High).
        set: (p, v) => edge === 'low'
            ? { bandLow: waveRound(Math.min(Math.max(v, 0), Number(p.bandHigh) - WAVE_BAND_GAP)) }
            : { bandHigh: waveRound(Math.max(Math.min(v, 1), Number(p.bandLow) + WAVE_BAND_GAP)) },
    }
}

const waveBallChannel = (ballKey: typeof WAVE_BALLS[number], ch: keyof BallRgb): ParamSpec => {
    const ballOf = (p: Params) => p[ballKey] as WaveBall
    return {
        id: `wave_${ballKey}_${ch}`,
        nodeType: 'wave_corrector',
        label: `Wave: ${ballKey[0].toUpperCase() + ballKey.slice(1)} ${ch.toUpperCase()}`,
        // The editor's R/G/B box range (BALL_RGB_INPUT ±2); the disc clamp bites first.
        min: -2, max: 2, step: 0.005, decimals: 1, displayScale: 100,
        get: (p, mode) => ballToRgb(ballOf(p), mode)[ch],
        set: (p, v, mode) => ({ [ballKey]: ballWithChannel(ballOf(p), ch, clamp(v, -2, 2), mode) }),
        reset: () => ({ [ballKey]: [0, 0] }),
    }
}

const WAVE_SPECS: ParamSpec[] = [
    // Ranges: the Control UI boxes (waveCorrectorControls.ts typing limits).
    // Contrast 0.001–4 like the Tangent (WAVE_RANGES) and the wheels, not the
    // editor box's 2: a 3.0 set from the Tangent would otherwise snap to 2 on
    // the first encoder tick. Steps per encoder tick.
    waveScalar('gain', 'Gain', 0.01, 10, 0.01, 1, 100),
    // Exposure in stops, apart from Gain (x2 = gain * 2^exposure * x1): ±8 like
    // the editor's typing limit and the Tangent, one tick = ¼ stop, LCD in stops.
    waveScalar('exposure', 'Exposure', -8, 8, 0.25, 2),
    waveScalar('pedestal', 'Pedestal', -0.2, 0.2, 0.001, 1, 100),
    waveScalar('bandGamma', 'Band Gamma', -1, 1, 0.01, 1, 100),
    waveBandEdge('low'),
    waveBandEdge('high'),
    // One softness per band edge, each 8–25 %, feathered outside the band only (no half-band clamp).
    // 8 % is the minimum feather the server and the Engine accept (MIN_SOFTNESS).
    waveScalar('softLow', 'Soft Low', 0.08, 0.25, 0.005, 1, 100),
    waveScalar('softHigh', 'Soft High', 0.08, 0.25, 0.005, 1, 100),
    waveScalar('saturation', 'Saturation', 0, 2, 0.02, 1, 100),
    // Hue: Oklab rotation in degrees, ±180 like the editor box and the Tangent (539); 1° per tick.
    waveScalar('hue', 'Hue', -180, 180, 1, 1),
    waveScalar('contrast', 'Contrast', 0.001, 4, 0.01, 2),
    waveScalar('temperature', 'Temperature', -TEMP_LIMIT_K, TEMP_LIMIT_K, 50, 0),
    waveScalar('tint', 'Tint', -TINT_LIMIT, TINT_LIMIT, 1, 1),
    ...WAVE_BALLS.flatMap((b) => (['r', 'g', 'b'] as const).map((ch) => waveBallChannel(b, ch))),
]

export const PARAM_SPECS: ParamSpec[] = [
    // Primary
    tempSpec('primary_wheels', 'primary', 'Primary'),
    scalarSpec('primary_wheels', 'primary', 'Primary', 'tint', 'Tint', -TINT_LIMIT, TINT_LIMIT, 1, 1),
    ...globalSpecs('primary_wheels', 'primary', 'Primary'),
    ...(['lift', 'gamma', 'gain', 'offset'] as const).flatMap((w) =>
        rgbMasterSpecs('primary_wheels', 'primary', 'Primary', w, w[0].toUpperCase() + w.slice(1))),
    // Log
    tempSpec('log_wheels', 'log', 'Log'),
    scalarSpec('log_wheels', 'log', 'Log', 'tint', 'Tint', -TINT_LIMIT, TINT_LIMIT, 1, 1),
    scalarSpec('log_wheels', 'log', 'Log', 'lowRange', 'Low Range', 0, 0.7, 0.005, 3),
    scalarSpec('log_wheels', 'log', 'Log', 'highRange', 'High Range', 0.3, 1, 0.005, 3),
    ...globalSpecs('log_wheels', 'log', 'Log'),
    ...(['shadow', 'midtone', 'highlight', 'offset'] as const).flatMap((w) =>
        rgbMasterSpecs('log_wheels', 'log', 'Log', w, w[0].toUpperCase() + w.slice(1))),
    // Broadcast
    ...globalSpecs('broadcast_wheels', 'broadcast', 'Broadcast'),
    ...BROADCAST_WHEEL_KEYS.flatMap((w) =>
        broadcastChannelSpecs(w, w[0].toUpperCase() + w.slice(1))),
    broadcastWhiteBalanceSpec('temp'),
    broadcastWhiteBalanceSpec('tint'),
    // Wave Corrector
    ...WAVE_SPECS,
]

export function specById(id: string): ParamSpec | undefined {
    return PARAM_SPECS.find((s) => s.id === id)
}

/**
 * The delta that resets one control (encoder push): the spec's own reset when
 * it has one (a Wave ball channel → the whole ball), else the default value
 * through set(), so the same clamps apply (Band Low's default can sit above
 * the current High — it then stops under it, like the editor).
 */
export function resetDelta(spec: ParamSpec, effective: Params, mode: PipelineMode): Params {
    if (spec.reset) return spec.reset(effective, mode)
    return spec.set(effective, spec.get(nodeDefaults(spec.nodeType, mode), mode), mode)
}

// ============================================================================
// Variable definitions + values (F2)
// ============================================================================

export function wheelVariableDefinitions(): Record<string, { name: string }> {
    const defs: Record<string, { name: string }> = {}
    for (const spec of PARAM_SPECS) {
        defs[`current_${spec.id}`] = { name: `Current Slot — ${spec.label}` }
    }
    return defs
}

/**
 * Values for the current slot. `paramsByType` holds the stored params per
 * wheel-node type, or null when the slot has no such node (→ blank '').
 */
export function wheelVariableValues(
    paramsByType: Partial<Record<WheelNodeType, Params | null>>,
    mode: PipelineMode,
): Record<string, string | number> {
    const values: Record<string, string | number> = {}
    for (const nodeType of WHEEL_NODE_TYPES) {
        const stored = paramsByType[nodeType]
        const effective = stored === null || stored === undefined ? null : withDefaults(nodeType, stored, mode)
        for (const spec of PARAM_SPECS) {
            if (spec.nodeType !== nodeType) continue
            values[`current_${spec.id}`] = effective === null
                ? ''
                : roundTo(spec.get(effective, mode) * (spec.displayScale ?? 1), spec.decimals)
        }
    }
    return values
}

function roundTo(v: number, decimals: number): number {
    const f = 10 ** decimals
    return Math.round(v * f) / f
}

import { InstanceBase, InstanceStatus } from '@companion-module/base'
import type {
    CompanionActionDefinition,
    CompanionFeedbackDefinition,
    CompanionPresetDefinitions,
    CompanionPresetSection,
    CompanionVariableDefinitions,
    SomeCompanionConfigField,
} from '@companion-module/base'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { getConfigFields, type PrinsVisionConfig } from './config.js'
import type {
    LayerInfo,
    LayerStackSyncPayload,
    LayerUpdatedPayload,
    SlotInfo,
    SlotStateChangedPayload,
    StateSnapshotPayload,
} from './types.js'
// Single source of truth = package.json "version"; sync-version.mjs propagates
// it here and into companion/manifest.json before every build.
import { MODULE_VERSION } from './version.js'
import { CONTROLLER_API_VERSION } from './apiVersion.js'
import {
    PARAM_SPECS,
    WHEEL_NODE_TYPES,
    type PipelineMode,
    resetDelta,
    specById,
    wheelVariableDefinitions,
    wheelVariableValues,
    withDefaults,
    type Params,
    type WheelNodeType,
} from './wheelParams.js'
import { horizontalGradientPngBase64 } from './png.js'
import { editableLayer } from './layers.js'
import { parseInputMapping, mappedSlot } from './inputMapping.js'
import { AtemDiscovery, AtemFollower, type AtemFollowSettings } from './atemFollow.js'
import { RouterFollower, type RouterFollowSettings } from './routerFollow.js'
import { unreachableMessage } from './status.js'

// Bipolar-axis gradients for the encoder buttons (a solid colour can't show a
// two-way axis). Muted so white text stays readable. Computed once at load.
const TEMP_GRADIENT_PNG = horizontalGradientPngBase64([38, 78, 168], [150, 100, 32])   // cool blue → warm amber
const TINT_GRADIENT_PNG = horizontalGradientPngBase64([34, 132, 60], [150, 48, 128])   // green → magenta

// ============================================================================
// Constants
// ============================================================================

const SLOT_NUMBER_FIELD = {
    type: 'number' as const,
    id: 'slot_number',
    label: 'Slot',
    default: 1,
    min: 1,
    max: 128,
}

// Number of per-slot variables predefined (slot_<n>_name, slot_<n>_status).
// Covers any realistic setup; raise if a user actually runs more slots.
/** A Look's view (selected node, folded groups) — Companion has no node tree, so it sends none. */
const NO_LOOK_VIEW = { selected_node_id: null, collapsed_tree_groups: null, collapsed_layers: null }

const MAX_SLOT_VARIABLES = 32

// ============================================================================
// Module
// ============================================================================

// `any` skips InstanceBase's TManifest constraint (actions/feedbacks/variables/
// config typed as a matching manifest interface) — this module doesn't author
// one, since actions/feedbacks are built as plain object literals below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default class PrinsVisionModule extends InstanceBase<any> {
    private socket: Socket | null = null

    // Slot state — keyed by slot_number (integer)
    private slots = new Map<number, SlotInfo>()

    // Layer/node state — keyed by slot UUID
    private layersBySlotId = new Map<string, LayerInfo[]>()

    // Tree presets known server-side — drives the preset action dropdowns.
    // Refreshed on snapshot + preset broadcasts; initActions() re-runs after
    // every refresh so the dropdown choices stay current.
    private treePresets: Array<{ id: string; label: string }> = []

    // RAW/Bypass/Grade preview mode per slot, synced from the paired Control
    // UI via controller:preview_mode_changed. Unknown slots default to 'grade'.
    private previewModeBySlot = new Map<number, string>()

    // Currently active slot inside this Companion instance. Drives the
    // `current_slot` variable + `slot_active` feedback so an operator can
    // bind one button to "switch to this slot" and another to "act on the
    // currently selected slot".
    private currentSlot: number = 1
    private inputMapping = new Map<number, number>()
    private tallyBySlotId = new Map<string, boolean>()
    private tallySubscribed = false
    private atemStatus = ''
    private routerStatus = ''
    private routerFollower = new RouterFollower(
        (slot, context) => this.selectSlot(slot, context),
        (slots, context) => this.sendFollowTally(slots, context),
        () => this.checkFeedbacks('router_follow_enabled', 'router_route_requested'),
        message => {
            if (message === this.routerStatus) return
            this.routerStatus = message
            this.setVariableValues({ router_follow_status: message })
            this.log('info', `Router follow: ${message}`)
        },
        slot => this.slots.has(slot),
    )
    private atemFollower = new AtemFollower(
        (slot, context) => this.selectSlot(slot, context),
        (slots, context) => new Promise<void>((resolve, reject) => {
            if (!this.socket?.connected) { reject(new Error('PrinsVision disconnected')); return }
            this.socket.timeout(2000).emit('controller:set_tally', { slot_numbers: slots, mode: 'replace', context },
                (error: Error | null, reply?: { success: boolean; error?: string }) => {
                    if (error || !reply?.success) reject(error ?? new Error(reply?.error ?? 'Tally rejected'))
                    else resolve()
                })
        }),
        message => {
            if (message === this.atemStatus) return
            this.atemStatus = message
            this.setVariableValues({ atem_follow_status: message })
            this.log('info', `ATEM follow: ${message}`)
        },
        slot => this.slots.has(slot),
        () => this.checkFeedbacks('atem_aux_requested'),
    )

    private atemDiscovery = new AtemDiscovery(report => {
        if (report.error) this.log('warn', `ATEM discovery: ${report.error}`)
        // A poll that was in flight when the socket dropped resolves after stop();
        // its report is stale and must not be queued for the next connection.
        if (!this.socket?.connected) {
            this.log('warn', 'ATEM discovery report dropped — not connected to PrinsVision; a fresh one follows after reconnect')
            return
        }
        this.socket.emit('controller:atem_connections', { ...report, companion_label: this.label })
    })

    // Retry timer for "io server disconnect" — Socket.IO turns off auto-reconnect
    // when the server disconnects us deliberately (e.g. on Companion-disable).
    // We keep our own slow retry so the module reconnects automatically once
    // the operator re-enables Companion in PatchBay Config.
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private static readonly RECONNECT_DELAY_MS = 3000

    // Trailing throttle for wheel-variable pushes: live previews arrive at
    // drag rate (30-60 Hz) but the LCD only needs ~10 Hz, and Companion's
    // setVariableValues fans out to every bound control.
    private wheelSyncTimer: ReturnType<typeof setTimeout> | null = null
    private static readonly WHEEL_SYNC_MS = 100

    // Encoder adjusts emit node_<type>_preview per tick; the commit (persist +
    // history entry + lock release) fires once the encoder rests. Keyed per
    // node; the accumulated delta is committed so a burst of temp+tint turns
    // persists both fields, not just the last.
    private pendingCommits = new Map<string, { timer: ReturnType<typeof setTimeout>; delta: Params }>()
    private static readonly COMMIT_DEBOUNCE_MS = 500

    // Ack waits are bounded so reply closures never pile up. Preset apply/save
    // rebuild a node chain server-side (DB + engine push), hence the longer wait.
    private static readonly ACK_TIMEOUT_MS = 5000
    private static readonly PRESET_ACK_TIMEOUT_MS = 15000

    // =========================================================================
    // Lifecycle
    // =========================================================================

    async init(config: PrinsVisionConfig): Promise<void> {
        this.log('info', `PrinsVision Companion module v${MODULE_VERSION} starting up`)
        this.initVariables()
        this.initActions()
        this.initFeedbacks()
        this.initPresets()
        this.connectSocket(config)
    }

    async destroy(): Promise<void> {
        this.disconnectSocket()
    }

    async configUpdated(config: PrinsVisionConfig): Promise<void> {
        this.disconnectSocket()
        this.connectSocket(config)
    }

    getConfigFields(): SomeCompanionConfigField[] {
        return getConfigFields()
    }

    // =========================================================================
    // Socket
    // =========================================================================

    private connectSocket(config: PrinsVisionConfig): void {
        try { this.inputMapping = parseInputMapping(config.input_mapping ?? '') }
        catch (error) {
            this.disconnectSocket()
            this.updateStatus(InstanceStatus.BadConfig, String(error))
            return
        }
        // Bonjour-discovered devices report as "<host>:<port>"; fall back to manual fields.
        let host = config.host
        let port = config.port
        let source = 'manual'
        if (config.bonjour_device) {
            const [bHost, bPort] = config.bonjour_device.split(':')
            if (bHost) host = bHost
            const parsed = Number.parseInt(bPort ?? '', 10)
            if (Number.isFinite(parsed)) port = parsed
            source = `bonjour (${config.bonjour_device})`
        }

        // Companion fires configUpdated() on every keystroke — bail out until
        // the operator has filled in enough to actually connect, otherwise
        // every keystroke spawns a doomed reconnect loop.
        const missing: string[] = []
        if (!host || !host.trim()) missing.push('host')
        if (!port || !Number.isFinite(port)) missing.push('port')
        if (!config.pair_code || !config.pair_code.trim()) missing.push('pair code')
        if (missing.length > 0) {
            this.updateStatus(InstanceStatus.BadConfig, `Fill in: ${missing.join(', ')}`)
            this.setVariableValues({ connected: 'Disconnected' })
            this.log('debug', `connectSocket skipped — missing config: ${missing.join(', ')}`)
            return
        }

        this.updateStatus(InstanceStatus.Connecting)

        const url = `http://${host}:${port}`
        // The pair code is the credential: log only enough to recognise it.
        const pairCode = config.pair_code.trim()
        this.log('info', `Connecting → url=${url}  source=${source}  pair_code=${pairCode.slice(0, 4)}…(len=${pairCode.length})`)

        // PrinsVision mounts Socket.IO at /ws/socket.io (not the default /socket.io)
        // — see Server/main.py: app.mount("/ws/socket.io", socket_app)
        const SOCKET_IO_PATH = '/ws/socket.io/'

        // Pre-flight: verify Socket.IO endpoint is reachable via plain HTTP
        // before letting socket.io-client reconnect-loop on opaque "xhr poll error".
        const probeUrl = `${url}${SOCKET_IO_PATH}?EIO=4&transport=polling`
        const probeStart = Date.now()
        fetch(probeUrl, { signal: AbortSignal.timeout(3000) })
            .then(async (res) => {
                const text = await res.text().catch(() => '')
                this.log('info', `HTTP probe ${probeUrl} → ${res.status} ${res.statusText} (${Date.now() - probeStart}ms, ${text.length}B)`)
                if (text && text.length < 300) this.log('debug', `HTTP probe body: ${text}`)
            })
            .catch((err: Error) => {
                this.log('warn', `HTTP probe FAILED → ${err.name}: ${err.message} (${Date.now() - probeStart}ms) — server unreachable from Companion's side`)
            })

        const socket = io(url, {
            path: SOCKET_IO_PATH,
            reconnection: true,
            reconnectionDelay: 2000,
            reconnectionDelayMax: 10000,
            timeout: 5000,
            auth: { user_type: 'companion' },
        })
        this.socket = socket

        this.socket.on('connect', () => {
            this.log('info', `Socket connected — sid=${this.socket?.id ?? '?'} transport=${this.socket?.io?.engine?.transport?.name ?? '?'}`)
            this.updateStatus(InstanceStatus.Ok)
            this.setVariableValues({ connected: 'Connected' })
            this.checkFeedbacks('connection_ok')

            const connectPayload = {
                client_name: 'Companion',
                pair_code: config.pair_code.trim(),
                // The server checks this number, not MODULE_VERSION (audit 111 T7, B2/B3).
                api_version: CONTROLLER_API_VERSION,
                module_version: MODULE_VERSION,
            }
            this.log('info', `Emitting controller:connect with ${Object.keys(connectPayload).join(', ')}`)
            this.socket!.emit('controller:connect', connectPayload)
        })

        this.socket.on('disconnect', (reason: string) => {
            this.atemFollower.stop()
            this.atemDiscovery.stop()
            this.routerFollower.stop()
            this.log('warn', `Socket disconnected — reason=${reason}`)
            // socket.io-client flushes sendBuffer on reconnect. The operator
            // guards keep emits out of it while disconnected, but an emit made
            // while `connected` was still true and the ping had already expired
            // lands there too. Nothing queued against the old connection may
            // reach the server after reconnect. (Runs before the client's own
            // _clearAcks, so their ack closures are released as well.)
            for (const packet of socket.sendBuffer.splice(0)) {
                this.log('warn', `Dropped queued "${String(packet.data?.[0] ?? '?')}" on disconnect — it will not be replayed after reconnect`)
            }
            // An encoder still turning when the link drops: its commit would
            // persist a delta against a server that has meanwhile released the
            // lock (and may have been graded by someone else).
            for (const [key, { timer }] of this.pendingCommits) {
                clearTimeout(timer)
                this.log('warn', `Encoder change on ${key} not committed — connection lost before the encoder rested; the previewed value is not saved`)
            }
            this.pendingCommits.clear()
            this.updateStatus(InstanceStatus.Disconnected)
            this.setVariableValues({ connected: 'Disconnected' })
            this.tallyBySlotId.clear()
            this.tallySubscribed = false
            this.checkFeedbacks('connection_ok', 'slot_streaming', 'slot_idle', 'slot_tally')

            // Socket.IO turns OFF auto-reconnect when the server kicks us
            // (reason === 'io server disconnect'), which happens on
            // Companion-disable / API-key rotation. Schedule our own slow
            // retry so the module reconnects as soon as the operator
            // re-enables it in Control UI.
            if (reason === 'io server disconnect') {
                this.scheduleReconnect()
            }
        })

        this.socket.on('connect_error', (err: Error & { type?: string; description?: unknown }) => {
            // engine.io errors carry .type and .description that explain
            // whether transport, server response, or auth was the failure.
            const detail = err.description !== undefined ? JSON.stringify(err.description) : '(no description)'
            this.log('warn', `connect_error → name=${err.name} type=${err.type ?? '?'} message="${err.message}" description=${detail}`)
            this.updateStatus(InstanceStatus.ConnectionFailure, unreachableMessage(`${host}:${port}`, !!config.bonjour_device))
            this.setVariableValues({ connected: 'Disconnected' })
        })

        this.socket.io.on('reconnect_attempt', (n: number) => {
            this.log('debug', `reconnect_attempt #${n}`)
        })
        this.socket.io.on('error', (err: Error) => {
            this.log('warn', `manager error → ${err.message}`)
        })

        this.socket.on('controller:atem_follow_settings', (settings: AtemFollowSettings) => {
            this.inputMapping = new Map(settings.mappings.map(m => [m.input, m.slot]))
            this.atemFollower.configure(settings)
            this.atemDiscovery.configure(settings.http_port)
        })
        this.socket.on('controller:router_follow_settings', (settings: RouterFollowSettings) => {
            this.routerFollower.configure(settings)
        })
        this.socket.on('tally:changed', (data: { entity_type: string; entity_id: string; tally_1: boolean }) => {
            if (data.entity_type !== 'slot') return
            this.tallyBySlotId.set(data.entity_id, data.tally_1 === true)
            this.checkFeedbacks('slot_tally')
        })

        this.socket.on('controller:state_snapshot', (payload: StateSnapshotPayload) => {
            if (!this.tallySubscribed) {
                this.tallySubscribed = true
                const socket = this.socket
                socket?.emit('tally:subscribe', {}, (response: { success: boolean; tally?: Record<string, { entity_type: string; entity_id: string; tally_1: boolean }> }) => {
                    if (socket !== this.socket || !socket.connected || !response?.success) return
                    for (const state of Object.values(response.tally ?? {})) {
                        if (state.entity_type === 'slot' && !this.tallyBySlotId.has(state.entity_id)) this.tallyBySlotId.set(state.entity_id, state.tally_1 === true)
                    }
                    this.checkFeedbacks('slot_tally')
                })
            }
            this.slots.clear()
            this.layersBySlotId.clear()
            for (const slot of payload.slots) {
                this.slots.set(slot.slot_number, {
                    id: slot.id,
                    slotNumber: slot.slot_number,
                    label: slot.label,
                    status: slot.status as SlotInfo['status'],
                    pipelineMode: this.parsePipelineMode(slot.pipeline_mode, `slot ${slot.slot_number}`),
                })
            }
            for (const [slotId, layers] of Object.entries(payload.layers_by_slot)) {
                this.layersBySlotId.set(slotId, layers.map((l) => ({
                    id: l.id,
                    type: l.type,
                    enabled: l.enabled,
                    active: l.active,
                    params: l.params,
                })))
            }
            this.setVariableValues({ slot_count: this.slots.size })
            this.syncSlotVariables()
            this.syncWheelVariables()
            // Rebuild presets so the Presets tab only shows entries for slots
            // that actually exist server-side (preserves slot_number order).
            this.initPresets()
            this.checkFeedbacks('slot_streaming', 'slot_idle', 'slot_active')
            this.log('debug', `State snapshot received: ${this.slots.size} slots`)
            this.refreshPresetList()
        })

        // Preset library changed server-side → refresh the action dropdowns.
        for (const ev of ['preset:added', 'preset:updated', 'preset:deleted'] as const) {
            this.socket.on(ev, () => this.refreshPresetList())
        }

        // RAW/Bypass/Grade sync from the paired Control UI. Fires both when
        // the operator clicks the pills and as confirmation of our own
        // set_preview_mode action (the UI applies it, then notifies back).
        this.socket.on('controller:preview_mode_changed', (payload: { slot_number: number; mode: string }) => {
            if (!payload?.slot_number || !payload.mode) return
            this.previewModeBySlot.set(payload.slot_number, payload.mode)
            this.checkFeedbacks('preview_mode')
        })

        this.socket.on('controller:rejected', (payload: { reason: string; message?: string }) => {
            this.log('warn', `Connection rejected by server: ${payload.reason}${payload.message ? ` — ${payload.message}` : ''}`)
            // Pair-code problems are a config issue, not a connection issue —
            // show BadConfig so the operator knows to fix the module settings.
            if (payload.reason === 'pair_code_required' || payload.reason === 'pair_code_invalid') {
                this.updateStatus(InstanceStatus.BadConfig, 'Pair code not accepted — copy the current one from Patch Bay Config → Companion')
            } else if (payload.reason === 'version_mismatch') {
                // Another controller-API number: only another module version fixes it.
                this.updateStatus(InstanceStatus.BadConfig, payload.message ?? 'This module does not match this PrinsVision version')
            } else {
                this.updateStatus(InstanceStatus.ConnectionFailure, payload.reason)
            }
        })

        // Server pushes slot-selection changes here, both ways:
        //   source='companion'  → echo of our own select_slot (no-op for us)
        //   source='control_ui' → operator picked a tile in the UI; sync our state
        this.socket.on('controller:slot_selected', (payload: { slot_number: number; slot_id: string; source: string; context?: string }) => {
            if (!payload?.slot_number) return
            if (payload.source === 'companion') return
            // Only explicitly scoped Control UI choices can request a route.
            if (payload.context) {
                this.routerFollower.requestSlot(payload.slot_number, payload.context)
                this.atemFollower.requestSlot(payload.slot_number)
            }
            this.currentSlot = payload.slot_number
            this.syncSlotVariables()
            this.syncWheelVariables()
            this.checkFeedbacks('slot_active')
            this.log('debug', `Slot selection synced from Control UI: slot ${payload.slot_number}`)
        })

        // Slot runtime state transitions (SM-D29). This is a server-wide
        // broadcast — every connected client receives it, including us.
        this.socket.on('slot:state_changed', (payload: SlotStateChangedPayload) => {
            for (const [num, slot] of this.slots.entries()) {
                if (slot.id === payload.id) {
                    this.slots.set(num, { ...slot, status: payload.state as SlotInfo['status'] })
                    break
                }
            }
            this.syncSlotVariables()
            this.checkFeedbacks('slot_streaming', 'slot_idle')
        })

        this.socket.on('layer:stack_sync', (payload: LayerStackSyncPayload) => {
            // stack_sync fires on every commit/reset and carries the server's
            // grading state, which is itself delta-based (only the last-touched
            // param per node). Replacing would wipe the params the module has
            // accumulated from previews — so carry over prior params and merge
            // the incoming delta. An empty {} means "reset to default" (the
            // server clears a node's params on reset) → clear, don't merge.
            // A pipeline switch re-anchors pivot/ranges and changes their reset defaults.
            for (const [num, slot] of this.slots.entries()) {
                if (slot.id === payload.slot_id) {
                    this.slots.set(num, { ...slot, pipelineMode: this.parsePipelineMode(payload.pipeline_mode, `slot ${num}`) })
                    break
                }
            }
            const prevById = new Map((this.layersBySlotId.get(payload.slot_id) ?? []).map((l) => [l.id, l]))
            this.layersBySlotId.set(payload.slot_id, payload.layers.map((l) => {
                const isEmpty = !l.params || Object.keys(l.params).length === 0
                const existing = prevById.get(l.id)
                return {
                    id: l.id,
                    type: l.type,
                    enabled: l.enabled,
                    active: l.active,
                    params: isEmpty ? {} : (existing ? { ...existing.params, ...l.params } : l.params),
                }
            }))
            this.scheduleWheelSync()
            this.log('debug', `Layer sync for slot ${payload.slot_id}: ${payload.layers.length} layers`)
        })

        this.socket.on('layer:updated', (payload: LayerUpdatedPayload) => {
            const layers = this.layersBySlotId.get(payload.slot_id)
            if (!layers) return
            const idx = layers.findIndex((l) => l.id === payload.layer_id)
            if (idx === -1) return
            layers[idx] = { ...layers[idx], params: { ...layers[idx].params, ...payload.params } }
            if ('enabled' in payload.params) {
                layers[idx].enabled = payload.params['enabled'] as boolean
            }
            this.scheduleWheelSync()
        })

        // Live wheel previews for the followed slot (server F1: this sid is in
        // the `slot:<currentSlot>` room, so drag-rate previews arrive here).
        // Payload slot_id is the NUMERIC slot number; params is the full dict.
        for (const nodeType of WHEEL_NODE_TYPES) {
            for (const phase of ['preview', 'updated'] as const) {
                this.socket.on(`node:${nodeType}:${phase}`, (payload: { slot_id: number; node_id: string; params: Params }) => {
                    if (!payload || payload.slot_id !== this.currentSlot) return
                    const slot = this.slots.get(this.currentSlot)
                    const layers = slot ? this.layersBySlotId.get(slot.id) : undefined
                    if (layers) {
                        const idx = layers.findIndex((l) => l.id === payload.node_id)
                        // Grading previews/commits carry ONLY the touched param
                        // (e.g. {lift} or {saturation}) — verified on the wire.
                        // Each key arrives as its full value, so a top-level
                        // merge is correct: replacing would snap every other
                        // param back to default on the LCD.
                        if (idx !== -1) layers[idx] = { ...layers[idx], params: { ...layers[idx].params, ...payload.params } }
                    }
                    this.scheduleWheelSync()
                })
            }
            // Lock-denial: the server answers a blocked preview with
            // node:<type>:locked to this sid only. Log it so a dead encoder
            // is explainable instead of silent (plan F3, user-besluit).
            this.socket.on(`node:${nodeType}:locked`, (payload: { slot_id: number; locked_by?: string }) => {
                this.log('warn',
                    `Slot ${payload?.slot_id} is locked by ${payload?.locked_by ?? 'another user'} — encoder adjust ignored`)
            })
        }
    }

    private disconnectSocket(): void {
        this.atemFollower.stop()
        this.atemDiscovery.stop()
        this.routerFollower.stop()
        this.tallyBySlotId.clear()
        this.tallySubscribed = false
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        if (this.wheelSyncTimer) {
            clearTimeout(this.wheelSyncTimer)
            this.wheelSyncTimer = null
        }
        for (const { timer } of this.pendingCommits.values()) clearTimeout(timer)
        this.pendingCommits.clear()
        if (this.socket) {
            this.socket.disconnect()
            this.socket = null
        }
    }

    /**
     * Slow polling reconnect for the "server kicked us" case. Companion
     * disabled, API key rotated, server restarted mid-session — all paths
     * land here. Calls socket.connect() every RECONNECT_DELAY_MS until the
     * server accepts us again, then the connect handler resumes normally.
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) return
        this.log('info', `Scheduling reconnect in ${PrinsVisionModule.RECONNECT_DELAY_MS}ms (server-side disconnect — Companion may be disabled)`)
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            if (this.socket && !this.socket.connected) {
                this.log('info', 'Attempting reconnect…')
                this.socket.connect()
            }
        }, PrinsVisionModule.RECONNECT_DELAY_MS)
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    /**
     * Fetch the tree-preset index and rebuild the action definitions so the
     * preset dropdowns list current names. Ack-based; keeps the old list (with
     * a warning) when the server errors (the actions stay usable).
     */
    private refreshPresetList(): void {
        if (!this.socket?.connected) {
            this.log('warn', 'Preset list refresh skipped — not connected to PrinsVision; it refreshes on the next state snapshot')
            return
        }
        this.socket.timeout(PrinsVisionModule.ACK_TIMEOUT_MS).emit(
            'preset:list',
            { type: 'tree' },
            (error: Error | null, resp: { status: string; presets?: Array<{ id: string; name: string }> }) => {
                if (error) {
                    this.log('warn', `preset:list got no answer (${error.message}) — keeping the previous preset list`)
                    return
                }
                if (resp?.status !== 'ok' || !Array.isArray(resp.presets)) {
                    this.log('warn', `preset:list failed: ${JSON.stringify(resp).slice(0, 200)}`)
                    return
                }
                this.treePresets = resp.presets.map((p) => ({ id: p.id, label: p.name }))
                this.initActions()
                this.log('debug', `Preset list refreshed: ${this.treePresets.length} tree presets`)
            },
        )
    }

    // =========================================================================
    // Operator commands — never queued
    // =========================================================================
    //
    // socket.io-client buffers every emit made while disconnected and flushes
    // the lot on reconnect, so after a network blip Companion would replay a
    // burst of stale undos, preset applies and slot switches. Every operator
    // command goes through canSend(): while disconnected it is dropped, logged
    // and shown in `last_dropped_action` — never sent later.

    /** True when an operator command may go out now; otherwise reports the drop. */
    private canSend(what: string): boolean {
        if (this.socket?.connected) return true
        this.log('warn', `${what} dropped — not connected to PrinsVision; it will not be sent after reconnect`)
        this.setVariableValues({ last_dropped_action: `${what} at ${new Date().toTimeString().slice(0, 8)} (not connected)` })
        return false
    }

    private sendCommand(what: string, event: string, payload: object): void {
        if (!this.canSend(what)) return
        this.socket!.emit(event, payload)
    }

    /** Command with a server reply. The ack wait is bounded so closures never accumulate. */
    private sendCommandWithReply<T>(what: string, event: string, payload: object, timeoutMs: number, onReply: (reply: T) => void): void {
        if (!this.canSend(what)) return
        this.socket!.timeout(timeoutMs).emit(event, payload, (error: Error | null, reply: T) => {
            if (error) {
                // Sent, but the answer never came (timeout or link lost meanwhile):
                // the server may or may not have applied it.
                this.log('warn', `${what}: no answer from PrinsVision (${error.message}) — check the Control UI whether it was applied`)
                return
            }
            onReply(reply)
        })
    }

    private getLayersForSlot(slotNumber: number): LayerInfo[] {
        const slot = this.slots.get(slotNumber)
        if (!slot) return []
        return this.layersBySlotId.get(slot.id) ?? []
    }

    private findEnabledLayer(slotNumber: number, nodeType: string): LayerInfo | undefined {
        return editableLayer(this.getLayersForSlot(slotNumber), nodeType)
    }

    private findLayer(slotNumber: number, nodeType: string): LayerInfo | undefined {
        return this.getLayersForSlot(slotNumber).find((l) => l.type === nodeType)
    }

    /**
     * Resolve a slot_number option to a concrete slot. The ready-made preset
     * buttons pass 0 = "the currently selected slot"; a hand-added action/
     * feedback uses SLOT_NUMBER_FIELD (min 1) and passes an explicit number.
     */
    private resolveSlot(slotNumber: unknown): number {
        const n = Number(slotNumber)
        return Number.isFinite(n) && n > 0 ? n : this.currentSlot
    }

    // =========================================================================
    // Variables
    // =========================================================================

    private initVariables(): void {
        const spec: CompanionVariableDefinitions = {
            module_version: { name: 'Module Version' },
            connected: { name: 'Connection Status' },
            atem_follow_status: { name: 'ATEM follow status' },
            last_dropped_action: { name: 'Last action dropped while disconnected' },
            router_follow_status: { name: 'Router / TSL follow status' },
            slot_count: { name: 'Number of Slots' },
            current_slot: { name: 'Currently Selected Slot' },
            current_slot_name: { name: 'Currently Selected Slot — Name' },
            current_slot_status: { name: 'Currently Selected Slot — Status' },
        }
        const initialValues: Record<string, string | number> = {
            module_version: MODULE_VERSION,
            connected: 'Disconnected',
            atem_follow_status: 'Disabled',
            last_dropped_action: '',
            router_follow_status: 'Disabled',
            slot_count: 0,
            current_slot: this.currentSlot,
            current_slot_name: '',
            current_slot_status: '',
        }
        for (let i = 1; i <= MAX_SLOT_VARIABLES; i++) {
            spec[`slot_${i}_name`] = { name: `Slot ${i} — Name` }
            spec[`slot_${i}_status`] = { name: `Slot ${i} — Status` }
            initialValues[`slot_${i}_name`] = ''
            initialValues[`slot_${i}_status`] = ''
        }
        // Wheel-node parameters of the current slot (encoder LCD readouts)
        for (const [id, def] of Object.entries(wheelVariableDefinitions())) {
            spec[id] = def
            initialValues[id] = ''
        }
        this.setVariableDefinitions(spec)
        this.setVariableValues(initialValues)
    }

    /**
     * Push the current slot's wheel-node parameters into the
     * `current_<node>_<param>` variables. Slots without a given wheel node
     * show blank. Reset chains arrive as params {} — wheelVariableValues
     * reads that as "all defaults" (server convention, see wheelParams.ts).
     */
    private syncWheelVariables(): void {
        const layers = this.getLayersForSlot(this.currentSlot)
        const paramsByType: Partial<Record<WheelNodeType, Params | null>> = {}
        for (const nodeType of WHEEL_NODE_TYPES) {
            paramsByType[nodeType] = layers.find((l) => l.type === nodeType)?.params ?? null
        }
        this.setVariableValues(wheelVariableValues(paramsByType, this.currentPipelineMode()))
    }

    /** The current slot's pipeline mode (pivot/Log-range defaults). No slot → no
     *  layers, so the mode is never read for a value then. */
    private currentPipelineMode(): PipelineMode {
        return this.slots.get(this.currentSlot)?.pipelineMode ?? 'prinsvision'
    }

    /** Server-sent mode → PipelineMode. A missing/unknown value means a server
     *  that predates the field: warn, and use PVLog defaults — pivot and Log
     *  ranges then show and reset to PVLog mid-grey even on an ACES slot. */
    private parsePipelineMode(raw: string | null | undefined, where: string): PipelineMode {
        if (raw === 'prinsvision' || raw === 'aces') return raw
        this.log('warn', `${where}: server sent pipeline_mode ${JSON.stringify(raw)} — using PVLog defaults for pivot/Log ranges (wrong on an ACES slot); update PrinsVision`)
        return 'prinsvision'
    }

    /** Trailing-edge throttle around syncWheelVariables (drag-rate → LCD-rate). */
    private scheduleWheelSync(): void {
        if (this.wheelSyncTimer) return
        this.wheelSyncTimer = setTimeout(() => {
            this.wheelSyncTimer = null
            this.syncWheelVariables()
        }, PrinsVisionModule.WHEEL_SYNC_MS)
    }

    // =========================================================================
    // Encoder parameter adjust (F3)
    // =========================================================================

    /**
     * Apply a param DELTA for a wheel node on the current slot: merge it into
     * the local cache (instant LCD), emit a preview and arm the debounced
     * commit. Emits ONLY the delta (the touched key(s)) — the server drops
     * absent fields (`_build_params`), so this leaves every other param,
     * including ones the module never cached (e.g. a pre-set tint), untouched.
     * Sending a full dict would reset those to default.
     */
    private pushWheelParams(nodeType: WheelNodeType, layerId: string, delta: Params): void {
        // Capture the slot now: a later slot switch must not redirect this
        // node's pending commit to a different slot.
        const slotNumber = this.currentSlot
        // Checked before the cache update: a dropped turn must not move the LCD.
        if (!this.canSend(`${nodeType} change (slot ${slotNumber})`)) return
        const slot = this.slots.get(slotNumber)
        const layers = slot ? this.layersBySlotId.get(slot.id) : undefined
        if (layers) {
            const idx = layers.findIndex((l) => l.id === layerId)
            if (idx !== -1) layers[idx] = { ...layers[idx], params: { ...layers[idx].params, ...delta } }
        }
        this.scheduleWheelSync()

        // Volatile: a preview the transport can't take right now is dropped,
        // never queued. The commit below carries the merged delta.
        this.socket!.volatile.emit(`node_${nodeType}_preview`, { slot_id: slotNumber, node_id: layerId, params: delta })

        // Accumulate the deltas turned during the rest window; commit them
        // together so temp+tint (or several wheels) all persist.
        const key = `${nodeType}:${layerId}`
        const existing = this.pendingCommits.get(key)
        if (existing) clearTimeout(existing.timer)
        const mergedDelta = { ...(existing?.delta ?? {}), ...delta }
        const timer = setTimeout(() => {
            this.pendingCommits.delete(key)
            this.sendCommand(`${nodeType} commit (slot ${slotNumber})`, `node_${nodeType}_commit`, { slot_id: slotNumber, node_id: layerId, params: mergedDelta })
        }, PrinsVisionModule.COMMIT_DEBOUNCE_MS)
        this.pendingCommits.set(key, { timer, delta: mergedDelta })
    }

    /** Shared lookup for the adjust/reset callbacks. Logs when unusable. */
    private wheelParamContext(paramId: string): { spec: NonNullable<ReturnType<typeof specById>>; layer: LayerInfo; effective: Params; mode: PipelineMode } | null {
        const spec = specById(paramId)
        if (!spec) {
            this.log('warn', `Unknown wheel parameter '${paramId}'`)
            return null
        }
        const layer = editableLayer(this.getLayersForSlot(this.currentSlot), spec.nodeType)
        if (!layer) {
            const present = this.findLayer(this.currentSlot, spec.nodeType)
            this.log('warn', present
                ? `Slot ${this.currentSlot}: ${spec.nodeType} is switched off (eye or Corrector bypass) — '${paramId}' ignored`
                : `Slot ${this.currentSlot} has no ${spec.nodeType} node — '${paramId}' ignored`)
            return null
        }
        const mode = this.currentPipelineMode()
        return { spec, layer, effective: withDefaults(spec.nodeType, layer.params, mode), mode }
    }

    /**
     * Push every known slot's name + status into Companion variables, plus the
     * "current" pair so a button text like `$(prinsvision-server:current_slot_name)`
     * always reflects what the operator just picked.
     */
    private syncSlotVariables(): void {
        const values: Record<string, string | number> = {}
        for (let i = 1; i <= MAX_SLOT_VARIABLES; i++) {
            const slot = this.slots.get(i)
            values[`slot_${i}_name`] = slot?.label ?? ''
            values[`slot_${i}_status`] = slot?.status ?? ''
        }
        const current = this.slots.get(this.currentSlot)
        values.current_slot = this.currentSlot
        values.current_slot_name = current?.label ?? ''
        values.current_slot_status = current?.status ?? ''
        this.setVariableValues(values)
    }

    // =========================================================================
    // Actions
    // =========================================================================

    private initActions(): void {
        const actions: Record<string, CompanionActionDefinition> = {
            router_input_observed: {
                name: 'Router: Receive confirmed input (generated trigger)',
                description: 'Used by the imported SW-P-08 triggers. Does not request a route.',
                options: [
                    { type: 'textinput', id: 'context', label: 'Configuration ID', default: '' },
                    { type: 'number', id: 'input', label: 'Input', default: 1, min: 1, max: 65535 },
                ],
                callback: action => this.routerFollower.observeInput(Number(action.options.input), String(action.options.context)),
            },
            // ------------------------------------------------------------------
            // Slot selection
            // ------------------------------------------------------------------

            follow_atem_aux: {
                name: 'ATEM: Follow AUX input',
                description: 'Manual trigger action for the ATEM AUX source ID. Input→slot mapping comes from PrinsVision Patch Bay Config → Companion. Unmapped inputs leave selection unchanged. Disable automatic follow when using manual triggers.',
                options: [{ type: 'number', id: 'input', label: 'ATEM input ID (use an expression/variable)', default: 0, min: 0, max: 100000 }],
                callback: action => {
                    const slot = mappedSlot(action.options.input, this.inputMapping)
                    if (slot === undefined || !this.slots.has(slot)) return
                    this.selectSlot(slot)
                },
            },
            follow_atem_program: {
                name: 'ATEM: Follow Program input (red tally)',
                description: 'Use one Variable changed trigger for the ATEM Program source ID. Sets red tally using the shared input→slot mapping; does not select a slot. Unmapped inputs clear this connection’s tally.',
                options: [{ type: 'number', id: 'input', label: 'ATEM Program input ID (use an expression/variable)', default: 0, min: 0, max: 100000 }],
                callback: action => {
                    const slot = mappedSlot(action.options.input, this.inputMapping)
                    this.sendTally(slot !== undefined && this.slots.has(slot) ? [slot] : [], 'replace')
                },
            },
            set_tally: {
                name: 'Slot: Set red tally',
                description: 'Set or clear this Companion connection’s Program tally. Does not select the slot or change its engine.',
                options: [SLOT_NUMBER_FIELD, { type: 'checkbox', id: 'on_air', label: 'On air', default: true }],
                callback: action => this.sendTally([Number(action.options.slot_number)], action.options.on_air ? 'on' : 'off'),
            },

            select_slot: {
                name: 'Slot: Select',
                description:
                    'Switch the paired Control UI to a specific slot. ' +
                    'Requires a Pair Code in the module config.',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    const slotNum = action.options['slot_number'] as number
                    this.selectSlot(slotNum)
                },
            },

            // ------------------------------------------------------------------
            // Undo / Redo
            // ------------------------------------------------------------------

            undo: {
                name: 'Grading: Undo',
                description:
                    'Undo the last grading change on a slot. Replays the paired ' +
                    'Control UI\'s history stack (same as Cmd+Z there), so a ' +
                    'Control UI session must be open.',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    const slotNum = this.resolveSlot(action.options['slot_number'])
                    this.sendCommand(`undo (slot ${slotNum})`, 'controller:undo', { slot_number: slotNum })
                },
            },

            redo: {
                name: 'Grading: Redo',
                description: 'Redo the last grading change on a slot (via the paired Control UI).',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    const slotNum = this.resolveSlot(action.options['slot_number'])
                    this.sendCommand(`redo (slot ${slotNum})`, 'controller:redo', { slot_number: slotNum })
                },
            },

            // ------------------------------------------------------------------
            // Reset wheel groups
            // ------------------------------------------------------------------

            reset_primary_wheels: {
                name: 'Grading: Reset Primary Wheels',
                description: 'Reset all primary color wheels to neutral on a slot',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    const slotNum = this.resolveSlot(action.options['slot_number'])
                    const layer = this.findEnabledLayer(slotNum, 'primary_wheels')
                    if (!layer) {
                        this.log('warn', `No active primary_wheels node on slot ${slotNum}`)
                        return
                    }
                    this.sendCommand(`reset primary wheels (slot ${slotNum})`, 'node_primary_wheels_reset', {
                        slot_id: slotNum,
                        node_id: layer.id,
                    })
                },
            },

            reset_log_wheels: {
                name: 'Grading: Reset Log Wheels',
                description: 'Reset all log color wheels to neutral on a slot',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    const slotNum = this.resolveSlot(action.options['slot_number'])
                    const layer = this.findEnabledLayer(slotNum, 'log_wheels')
                    if (!layer) {
                        this.log('warn', `No active log_wheels node on slot ${slotNum}`)
                        return
                    }
                    this.sendCommand(`reset log wheels (slot ${slotNum})`, 'node_log_wheels_reset', {
                        slot_id: slotNum,
                        node_id: layer.id,
                    })
                },
            },

            reset_broadcast_wheels: {
                name: 'Grading: Reset Broadcast Wheels',
                description: 'Reset all broadcast color wheels to neutral on a slot',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    const slotNum = this.resolveSlot(action.options['slot_number'])
                    const layer = this.findEnabledLayer(slotNum, 'broadcast_wheels')
                    if (!layer) {
                        this.log('warn', `No active broadcast_wheels node on slot ${slotNum}`)
                        return
                    }
                    this.sendCommand(`reset broadcast wheels (slot ${slotNum})`, 'node_broadcast_wheels_reset', {
                        slot_id: slotNum,
                        node_id: layer.id,
                    })
                },
            },

            reset_wave_corrector: {
                name: 'Grading: Reset Wave Corrector',
                description: 'Reset the Wave Corrector (gain, exposure, pedestal, band, balls, saturation, hue, contrast, temp/tint) to neutral on a slot',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    const slotNum = this.resolveSlot(action.options['slot_number'])
                    const layer = this.findEnabledLayer(slotNum, 'wave_corrector')
                    if (!layer) {
                        this.log('warn', `No active wave_corrector node on slot ${slotNum}`)
                        return
                    }
                    this.sendCommand(`reset wave corrector (slot ${slotNum})`, 'node_wave_corrector_reset', {
                        slot_id: slotNum,
                        node_id: layer.id,
                    })
                },
            },

            // ------------------------------------------------------------------
            // Encoder parameter adjust (current slot; F3)
            // ------------------------------------------------------------------

            adjust_parameter: {
                name: 'Grading: Adjust Parameter (relative)',
                description:
                    'Nudge a grading parameter (Primary/Log/Broadcast wheels or Wave Corrector) on the CURRENT slot (rotary encoders: ' +
                    'bind + to rotate-right and − to rotate-left). Live preview per ' +
                    'tick, auto-commit once the encoder rests.',
                options: [
                    {
                        type: 'dropdown' as const,
                        id: 'parameter',
                        label: 'Parameter',
                        default: 'log_temperature',
                        choices: PARAM_SPECS.map((s) => ({ id: s.id, label: s.label })),
                    },
                    {
                        type: 'dropdown' as const,
                        id: 'direction',
                        label: 'Direction',
                        default: 'up',
                        choices: [
                            { id: 'up', label: '+ (increase)' },
                            { id: 'down', label: '− (decrease)' },
                        ],
                    },
                    {
                        type: 'number' as const,
                        id: 'step',
                        label: 'Step (0 = parameter default)',
                        default: 0,
                        min: 0,
                        max: 100,
                    },
                ],
                callback: (action) => {
                    const ctx = this.wheelParamContext(action.options['parameter'] as string)
                    if (!ctx) return
                    const { spec, layer, effective, mode } = ctx
                    const stepOpt = Number(action.options['step'] ?? 0)
                    const step = (stepOpt > 0 ? stepOpt : spec.step)
                        * (action.options['direction'] === 'down' ? -1 : 1)
                    const next = spec.set(effective, spec.get(effective, mode) + step, mode)
                    this.pushWheelParams(spec.nodeType, layer.id, next)
                },
            },

            reset_parameter: {
                name: 'Grading: Reset Parameter',
                description:
                    'Reset one wheel parameter on the CURRENT slot to its default ' +
                    '(rotary encoders: bind to push). Pivot and Log ranges reset to ' +
                    'the slot\'s pipeline mode (PVLog or ACEScct mid-grey). A Wave ' +
                    'Corrector ball R/G/B resets that whole ball to neutral.',
                options: [
                    {
                        type: 'dropdown' as const,
                        id: 'parameter',
                        label: 'Parameter',
                        default: 'log_temperature',
                        choices: PARAM_SPECS.map((s) => ({ id: s.id, label: s.label })),
                    },
                ],
                callback: (action) => {
                    const ctx = this.wheelParamContext(action.options['parameter'] as string)
                    if (!ctx) return
                    const { spec, layer, effective, mode } = ctx
                    this.pushWheelParams(spec.nodeType, layer.id, resetDelta(spec, effective, mode))
                },
            },

            // ------------------------------------------------------------------
            // Node enable / disable
            // ------------------------------------------------------------------

            // ------------------------------------------------------------------
            // Presets (tree presets — full node chain)
            // ------------------------------------------------------------------

            preset_apply: {
                name: 'Preset: Apply',
                description: 'Apply a saved node-tree preset to a slot',
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'dropdown' as const,
                        id: 'preset_id',
                        label: 'Preset',
                        default: this.treePresets[0]?.id ?? '',
                        choices: this.treePresets,
                    },
                ],
                callback: (action) => {
                    const presetId = action.options['preset_id'] as string
                    if (!presetId) {
                        this.log('warn', 'preset_apply: no preset selected')
                        return
                    }
                    // slot_number 0 (used by the auto-generated preset buttons)
                    // = the currently selected slot; a hand-added action uses
                    // the SLOT_NUMBER_FIELD (min 1).
                    const slotNum = (action.options['slot_number'] as number) || this.currentSlot
                    this.sendCommandWithReply<{ status: string; message?: string }>(
                        `preset apply (slot ${slotNum})`,
                        'preset:apply_tree',
                        // No tree view here: the Look keeps the view it was saved with.
                        { preset_id: presetId, slot_id: slotNum, ...NO_LOOK_VIEW },
                        PrinsVisionModule.PRESET_ACK_TIMEOUT_MS,
                        (resp) => {
                            if (resp?.status !== 'ok') this.log('warn', `preset:apply_tree failed: ${resp?.message ?? 'unknown'}`)
                        },
                    )
                },
            },

            preset_save: {
                name: 'Preset: Save As New',
                description: 'Save the slot\'s current node chain as a new tree preset',
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'textinput' as const,
                        id: 'preset_name',
                        label: 'Preset Name',
                        default: 'Companion Preset',
                    },
                ],
                callback: (action) => {
                    const slotNum = action.options['slot_number'] as number
                    const name = String(action.options['preset_name'] ?? '').trim()
                    if (!name) {
                        this.log('warn', 'preset_save: preset name is empty')
                        return
                    }
                    this.sendCommandWithReply<{ status: string; message?: string }>(
                        `preset save (slot ${slotNum})`,
                        'preset:save_tree',
                        // No tree view here: the Look gets none (the Control UI's own applies).
                        { slot_id: slotNum, name, slot_name: this.slots.get(slotNum)?.label ?? '', ...NO_LOOK_VIEW },
                        PrinsVisionModule.PRESET_ACK_TIMEOUT_MS,
                        (resp) => {
                            if (resp?.status !== 'ok') this.log('warn', `preset:save_tree failed: ${resp?.message ?? 'unknown'}`)
                            else this.refreshPresetList()
                        },
                    )
                },
            },

            preset_overwrite: {
                name: 'Preset: Update (Overwrite)',
                description: 'Overwrite an existing tree preset with the slot\'s current node chain',
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'dropdown' as const,
                        id: 'preset_id',
                        label: 'Preset',
                        default: this.treePresets[0]?.id ?? '',
                        choices: this.treePresets,
                    },
                ],
                callback: (action) => {
                    const presetId = action.options['preset_id'] as string
                    if (!presetId) {
                        this.log('warn', 'preset_overwrite: no preset selected')
                        return
                    }
                    const slotNum = action.options['slot_number'] as number
                    this.sendCommandWithReply<{ status: string; message?: string }>(
                        `preset overwrite (slot ${slotNum})`,
                        'preset:overwrite_tree',
                        // No tree view here: the Look keeps the view it was saved with.
                        { preset_id: presetId, slot_id: slotNum, ...NO_LOOK_VIEW },
                        PrinsVisionModule.PRESET_ACK_TIMEOUT_MS,
                        (resp) => {
                            if (resp?.status !== 'ok') this.log('warn', `preset:overwrite_tree failed: ${resp?.message ?? 'unknown'}`)
                        },
                    )
                },
            },

            // ------------------------------------------------------------------
            // RAW / Bypass / Grade preview mode
            // ------------------------------------------------------------------

            set_preview_mode: {
                name: 'Preview: RAW / Bypass / Grade',
                description:
                    'Set the preview mode on a slot (via the paired Control UI — ' +
                    'drives viewer, output and attached LUT boxes, same as the pills)',
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'dropdown' as const,
                        id: 'mode',
                        label: 'Mode',
                        default: 'grade',
                        choices: [
                            { id: 'raw', label: 'RAW' },
                            { id: 'bypass', label: 'Bypass' },
                            { id: 'grade', label: 'Grade' },
                        ],
                    },
                ],
                callback: (action) => {
                    const slotNum = this.resolveSlot(action.options['slot_number'])
                    const mode = action.options['mode'] as string
                    this.sendCommand(`preview mode ${mode} (slot ${slotNum})`, 'controller:set_preview_mode', {
                        slot_number: slotNum,
                        mode,
                    })
                },
            },

        }

        this.setActionDefinitions(actions)
    }

    // =========================================================================
    // Feedbacks
    // =========================================================================

    private selectSlot(slotNumber: number, context?: string): void {
        // Checked before any local change: a dropped switch must not move
        // current_slot, or "current slot" actions would hit the wrong slot
        // once the link is back.
        if (!this.canSend(`select slot ${slotNumber}`)) return
        if (!context) {
            this.routerFollower.requestSlot(slotNumber)
            this.atemFollower.requestSlot(slotNumber)
        }
        this.currentSlot = slotNumber
        this.syncSlotVariables()
        this.syncWheelVariables()
        this.checkFeedbacks('slot_active')
        this.socket!.emit('controller:select_slot', { slot_number: slotNumber, ...(context ? { context } : {}) })
    }

    private sendTally(slots: number[], mode: 'replace' | 'on' | 'off'): void {
        this.sendCommandWithReply<{ success: boolean; error?: string }>(
            `tally ${mode} [${slots.join(', ')}]`,
            'controller:set_tally',
            { slot_numbers: slots, mode },
            PrinsVisionModule.ACK_TIMEOUT_MS,
            (reply) => {
                if (reply && !reply.success) this.log('warn', `Tally rejected: ${reply.error ?? 'unknown error'}`)
            },
        )
    }

    private sendFollowTally(slots: number[], context: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.socket?.connected) { reject(new Error('PrinsVision disconnected')); return }
            this.socket.timeout(2000).emit('controller:set_tally', { slot_numbers: slots, mode: 'replace', context },
                (error: Error | null, reply?: { success: boolean; error?: string }) => {
                    if (error || !reply?.success) reject(error ?? new Error(reply?.error ?? 'Tally rejected'))
                    else resolve()
                })
        })
    }

    private initFeedbacks(): void {
        const feedbacks: Record<string, CompanionFeedbackDefinition> = {
            router_follow_enabled: {
                type: 'boolean', name: 'Router: Follow active (generated trigger)',
                defaultStyle: { bgcolor: 0x00aa00 },
                options: [{ type: 'textinput', id: 'context', label: 'Configuration ID', default: '' }],
                callback: feedback => this.routerFollower.isFollowing(String(feedback.options.context)),
            },
            router_route_requested: {
                type: 'boolean', name: 'Router: Route requested (generated trigger)',
                defaultStyle: { bgcolor: 0x00aa00 },
                options: [
                    { type: 'textinput', id: 'context', label: 'Configuration ID', default: '' },
                    { type: 'number', id: 'input', label: 'Input', default: 1, min: 1, max: 65535 },
                ],
                callback: feedback => this.routerFollower.isRequested(Number(feedback.options.input), String(feedback.options.context)),
            },
            atem_aux_requested: {
                type: 'boolean', name: 'ATEM: AUX switch requested (generated trigger)',
                description: 'True while a slot choice in PrinsVision waits for the ATEM AUX to take this input.',
                defaultStyle: { bgcolor: 0x00aa00 },
                options: [
                    { type: 'textinput', id: 'context', label: 'Configuration ID', default: '' },
                    { type: 'number', id: 'input', label: 'ATEM input ID', default: 1, min: 0, max: 100000 },
                ],
                callback: feedback => this.atemFollower.isRequested(Number(feedback.options.input), String(feedback.options.context)),
            },
            slot_tally: {
                type: 'boolean', name: 'Slot: Red tally (Program)',
                description: 'Active when this slot has Program tally, independent of engine status or slot selection.',
                defaultStyle: { bgcolor: 0xed1c24, color: 0xffffff },
                options: [SLOT_NUMBER_FIELD],
                callback: feedback => {
                    const slot = this.slots.get(Number(feedback.options.slot_number))
                    return this.socket?.connected === true && !!slot && this.tallyBySlotId.get(slot.id) === true
                },
            },
            connection_ok: {
                type: 'boolean',
                name: 'PrinsVision: Connected',
                description: 'Active when connected to PrinsVision',
                defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
                options: [],
                callback: () => {
                    return this.socket?.connected ?? false
                },
            },

            slot_streaming: {
                type: 'boolean',
                name: 'Slot: Running',
                description: 'Active when the slot runtime is running (streaming)',
                defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
                options: [SLOT_NUMBER_FIELD],
                callback: (feedback) => {
                    const slot = this.slots.get(feedback.options['slot_number'] as number)
                    return slot?.status === 'running'
                },
            },

            slot_active: {
                type: 'boolean',
                name: 'Slot: Active (this surface)',
                description: 'Active when the given slot is the one selected by this Companion module',
                defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
                options: [SLOT_NUMBER_FIELD],
                callback: (feedback) => {
                    return (feedback.options['slot_number'] as number) === this.currentSlot
                },
            },

            slot_idle: {
                type: 'boolean',
                name: 'Slot: Idle',
                description: 'Active when the slot is idle',
                defaultStyle: { bgcolor: 0x555555, color: 0xffffff },
                options: [SLOT_NUMBER_FIELD],
                callback: (feedback) => {
                    const slot = this.slots.get(feedback.options['slot_number'] as number)
                    return !slot || slot.status === 'idle'
                },
            },

            preview_mode: {
                type: 'boolean',
                name: 'Preview: Mode Active',
                description: 'Active when the slot\'s RAW/Bypass/Grade mode matches (synced from the paired Control UI)',
                defaultStyle: { bgcolor: 0xcc6600, color: 0xffffff },
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'dropdown' as const,
                        id: 'mode',
                        label: 'Mode',
                        default: 'grade',
                        choices: [
                            { id: 'raw', label: 'RAW' },
                            { id: 'bypass', label: 'Bypass' },
                            { id: 'grade', label: 'Grade' },
                        ],
                    },
                ],
                callback: (feedback) => {
                    const slotNum = this.resolveSlot(feedback.options['slot_number'])
                    const mode = this.previewModeBySlot.get(slotNum) ?? 'grade'
                    return mode === (feedback.options['mode'] as string)
                },
            },
        }

        this.setFeedbackDefinitions(feedbacks)
    }

    // =========================================================================
    // Presets
    // =========================================================================

    /**
     * Build one "Select Slot N" preset per slot the server actually has.
     * Called on init AND on every controller:state_snapshot so the Presets
     * tab stays in sync when slots are added/removed server-side.
     *
     * Statically generates one preset per slot (no template-group): Companion 5
     * rewrites `$(this:foo)` expressions in template-groups to module-variable refs
     * (`$(PV_Server:foo)`) that resolve to $NA. Concrete values bypass that entirely.
     */
    /**
     * Rotary presets (F4): rotate = relative adjust, push = reset parameter
     * (P1). Static per-parameter set (P2), grouped per wheel-node type. The
     * LCD strip shows the live `current_<param>` variable — Companion rewrites
     * the `prinsvision-server` token to the actual connection label on drag.
     */
    private buildEncoderPresets(presets: CompanionPresetDefinitions): CompanionPresetSection[] {
        // Global scalars every wheel-node shares (after temp/tint, before the
        // per-wheel channels).
        const globalsOf = (prefix: string) =>
            ['contrast', 'pivot', 'saturation', 'hue', ...(prefix === 'broadcast' ? [] : ['lum_mix'])]
                .map((g) => `${prefix}_${g}`)
        const V1_SET: Record<string, { title: string; ids: string[] }> = {
            encoders_primary: {
                title: 'Encoders — Primary',
                ids: ['primary_temperature', 'primary_tint', ...globalsOf('primary'),
                    // Per wheel: master (Y) + R/G/B colour channels
                    ...(['lift', 'gamma', 'gain', 'offset'] as const).flatMap((w) =>
                        (['master', 'r', 'g', 'b'] as const).map((ch) => `primary_${w}_${ch}`))],
            },
            encoders_log: {
                title: 'Encoders — Log',
                // Log-specific Low/High range boundaries after temp/tint.
                ids: ['log_temperature', 'log_tint', 'log_low_range', 'log_high_range', ...globalsOf('log'),
                    ...(['shadow', 'midtone', 'highlight', 'offset'] as const).flatMap((w) =>
                        (['master', 'r', 'g', 'b'] as const).map((ch) => `log_${w}_${ch}`))],
            },
            encoders_broadcast: {
                title: 'Encoders — Broadcast',
                ids: ['broadcast_temp', 'broadcast_tint', ...globalsOf('broadcast'),
                    // Per wheel: Y (luma) + R/G/B
                    ...(['black', 'flare', 'gamma', 'gain'] as const).flatMap((w) =>
                        (['y', 'r', 'g', 'b'] as const).map((ch) => `broadcast_${w}_${ch}`))],
            },
            encoders_wave: {
                title: 'Encoders — Wave Corrector',
                // Editor order: temp/tint, the rings (Pedestal/Band Gamma/Gain
                // under Shadow/Band/White) with Exposure next to Gain, the band,
                // the knob row, then each ball as R/G/B.
                ids: ['wave_temperature', 'wave_tint', 'wave_pedestal', 'wave_band_gamma', 'wave_gain',
                    'wave_exposure',
                    'wave_band_low', 'wave_band_high', 'wave_soft_low', 'wave_soft_high', 'wave_saturation',
                    'wave_hue', 'wave_contrast',
                    ...(['shadow', 'band', 'white'] as const).flatMap((b) =>
                        (['r', 'g', 'b'] as const).map((ch) => `wave_${b}_${ch}`))],
            },
        }
        const compact = (label: string): string => label
            .replace(/^[^:]+: /, '')
            .replace('Temperature', 'Temp').replace('Saturation', 'Sat')
            .replace('Low Range', 'Low').replace('High Range', 'High')
            .replace('Global ', '')

        // Colour-code the encoder buttons by channel: R/G/B/Y get their channel
        // colour (Y = white → black text), and temp/tint a single hint colour
        // (a true 2-colour axis gradient would need an embedded PNG per button).
        const channelStyle = (id: string): { bgcolor: number; png64?: string; color: number } => {
            if (id.endsWith('_r')) return { bgcolor: 0x8f1f1f, color: 0xffffff }
            if (id.endsWith('_g')) return { bgcolor: 0x1f7a2f, color: 0xffffff }
            if (id.endsWith('_b')) return { bgcolor: 0x1f3f99, color: 0xffffff }
            if (id.endsWith('_y') || id.endsWith('_master')) return { bgcolor: 0xdedede, color: 0x000000 }
            // Bipolar axes get a two-colour gradient PNG (bgcolor is a required
            // fallback the png64 paints over).
            if (id.endsWith('_temperature') || id.endsWith('_temp')) return { bgcolor: 0x000000, png64: TEMP_GRADIENT_PNG, color: 0xffffff }
            if (id.endsWith('_tint')) return { bgcolor: 0x000000, png64: TINT_GRADIENT_PNG, color: 0xffffff }
            return { bgcolor: 0x000000, color: 0xffffff }
        }

        const sections: CompanionPresetSection[] = []
        for (const [sectionId, section] of Object.entries(V1_SET)) {
            const definitionIds: string[] = []
            for (const paramId of section.ids) {
                const spec = PARAM_SPECS.find((s) => s.id === paramId)
                if (!spec) continue
                const presetId = `encoder_${spec.id}`
                definitionIds.push(presetId)
                presets[presetId] = {
                    type: 'simple',
                    name: `${spec.label} (encoder)`,
                    keywords: ['encoder', 'rotary', 'wheel', spec.nodeType],
                    style: {
                        // Fixed 14px (not 'auto') so longer labels like
                        // "Contrast"/"Highlight" don't wrap mid-word.
                        text: `${compact(spec.label)}\\n$(prinsvision-server:current_${spec.id})`,
                        size: '14',
                        show_topbar: false,
                        ...channelStyle(spec.id),
                    },
                    steps: [{
                        down: [{ actionId: 'reset_parameter', options: { parameter: spec.id } }],
                        up: [],
                        rotate_left: [{ actionId: 'adjust_parameter', options: { parameter: spec.id, direction: 'down', step: 0 } }],
                        rotate_right: [{ actionId: 'adjust_parameter', options: { parameter: spec.id, direction: 'up', step: 0 } }],
                    }],
                    feedbacks: [],
                }
            }
            sections.push({
                id: sectionId,
                name: section.title,
                description:
                    'Drag onto a rotary encoder (Stream Deck+ / Loupedeck): rotate = adjust, ' +
                    'push = reset to default. Acts on the currently selected slot; the LCD shows the live value.',
                definitions: definitionIds,
            })
        }
        return sections
    }

    /**
     * One "Apply preset" button per saved node-tree preset (from preset:list,
     * refreshed via refreshPresetList). Applies to the CURRENTLY selected slot
     * (slot_number 0 → currentSlot in the preset_apply callback), matching the
     * encoder workflow. Empty when the operator hasn't saved any tree presets.
     */
    private buildGradingPresetSection(presets: CompanionPresetDefinitions): CompanionPresetSection | null {
        if (this.treePresets.length === 0) return null
        const definitionIds: string[] = []
        for (const tp of this.treePresets) {
            const presetId = `apply_tree_${tp.id}`
            definitionIds.push(presetId)
            presets[presetId] = {
                type: 'simple',
                name: `Apply: ${tp.label}`,
                keywords: ['preset', 'grade', 'apply', 'tree'],
                style: {
                    text: tp.label,
                    size: 'auto',
                    show_topbar: false,
                    color: 0xffffff,
                    bgcolor: 0x1a1a3a,
                },
                steps: [{
                    down: [{ actionId: 'preset_apply', options: { slot_number: 0, preset_id: tp.id } }],
                    up: [],
                }],
                feedbacks: [],
            }
        }
        return {
            id: 'grading_presets',
            name: 'Grading Presets',
            description:
                'One button per saved node-tree preset. Pressing it applies that grade to the ' +
                'currently selected slot. List refreshes when presets are saved/deleted server-side.',
            definitions: definitionIds,
        }
    }

    /**
     * Ready-made drag-and-drop buttons for the common grading actions, all
     * acting on the CURRENTLY selected slot (slot_number 0). Saves the operator
     * from hand-building a button per action. Preview-mode + node-toggle carry
     * their live feedback so the button lights up for the active state.
     */
    private buildActionPresets(presets: CompanionPresetDefinitions): CompanionPresetSection[] {
        // Fixed 14px font (not 'auto', which wraps single words like "Bypass"/
        // "Primary") + no topbar so the label has the full button height.
        const base = (text: string, bgcolor: number) => ({ text, size: '14' as const, color: 0xffffff, bgcolor, show_topbar: false as const })

        // Preview Mode — RAW / Bypass / Grade (mixed case fits the button width)
        const PREVIEW_LABEL: Record<string, string> = { raw: 'RAW', bypass: 'Bypass', grade: 'Grade' }
        const previewIds = (['raw', 'bypass', 'grade'] as const).map((mode) => {
            const id = `preview_${mode}`
            presets[id] = {
                type: 'simple',
                name: `Preview: ${PREVIEW_LABEL[mode]}`,
                keywords: ['preview', 'raw', 'bypass', 'grade', 'mode'],
                style: base(PREVIEW_LABEL[mode], 0x000000),
                steps: [{ down: [{ actionId: 'set_preview_mode', options: { slot_number: 0, mode } }], up: [] }],
                feedbacks: [{ feedbackId: 'preview_mode', options: { slot_number: 0, mode }, style: { bgcolor: 0xcc6600, color: 0xffffff } }],
            }
            return id
        })

        // Grading Control — Undo / Redo / Reset Primary / Log / Broadcast / Wave Corrector
        const control: Array<[string, string, string, number, string]> = [
            ['ctl_undo', 'Grading: Undo', 'Undo', 0x222222, 'undo'],
            ['ctl_redo', 'Grading: Redo', 'Redo', 0x222222, 'redo'],
            ['ctl_reset_primary', 'Reset Primary Wheels', 'Reset\\nPrimary', 0x3a1a1a, 'reset_primary_wheels'],
            ['ctl_reset_log', 'Reset Log Wheels', 'Reset\\nLog', 0x3a1a1a, 'reset_log_wheels'],
            ['ctl_reset_broadcast', 'Reset Broadcast Wheels', 'Reset\\nBroadcast', 0x3a1a1a, 'reset_broadcast_wheels'],
            ['ctl_reset_wave', 'Reset Wave Corrector', 'Reset\\nWave', 0x3a1a1a, 'reset_wave_corrector'],
        ]
        const controlIds = control.map(([id, name, text, bg, actionId]) => {
            presets[id] = {
                type: 'simple',
                name,
                keywords: ['grade', 'undo', 'redo', 'reset'],
                style: base(text, bg),
                steps: [{ down: [{ actionId, options: { slot_number: 0 } }], up: [] }],
                feedbacks: [],
            }
            return id
        })

        return [
            { id: 'preview_mode_presets', name: 'Preview Mode (current slot)',
              description: 'RAW / Bypass / Grade on the currently selected slot. Lights up for the active mode.',
              definitions: previewIds },
            { id: 'grading_control', name: 'Grading Control (current slot)',
              description: 'Undo, Redo and wheel-resets on the currently selected slot.',
              definitions: controlIds },
        ]
    }

    private initPresets(): void {
        const presets: CompanionPresetDefinitions = {}
        const presetIds: string[] = []

        // Slot-independent sections (all act on the current slot): ready-made
        // action buttons, saved grading presets, and the rotary encoders.
        const actionSections = this.buildActionPresets(presets)
        const encoderSections = this.buildEncoderPresets(presets)
        const gradingSection = this.buildGradingPresetSection(presets)
        const extraSections = [
            ...actionSections,
            ...(gradingSection ? [gradingSection] : []),
            ...encoderSections,
        ]

        // Sort by slot_number ascending so the Presets tab shows them in
        // operator-friendly order. Map keys aren't guaranteed to be sorted.
        const slotNumbers = Array.from(this.slots.keys()).sort((a, b) => a - b)

        // Skip the slot section entirely if no slots exist yet — better than
        // a dead "Select Slot 1" placeholder that does nothing.
        if (slotNumbers.length === 0) {
            this.setPresetDefinitions(extraSections, presets)
            return
        }

        for (const i of slotNumbers) {
            const id = `slot_select_${i}`
            const slot = this.slots.get(i)
            const labelText = slot && slot.label ? slot.label : '(no name)'
            presetIds.push(id)
            presets[id] = {
                type: 'simple',
                name: `Select Slot ${i} — ${labelText}`,
                keywords: ['slot', 'select', 'switch', `slot${i}`],
                style: {
                    // Bake the slot name directly into the preset text. Variable
                    // expansion via $(connection:slot_<n>_name) was unreliable for
                    // certain slot numbers in Companion 5. initPresets() re-runs on
                    // every state_snapshot so renames stay live. Name only — the
                    // slot number is visible in the preset name/tooltip; unnamed
                    // slots fall back to "Slot N".
                    text: slot && slot.label ? labelText : `Slot ${i}`,
                    // Fixed 14px — 'auto' picks an oversized font and wraps
                    // names mid-word ("Gra / de 1").
                    size: '14',
                    show_topbar: false,
                    color: 0xffffff,
                    bgcolor: 0x000000,
                },
                steps: [
                    {
                        down: [{ actionId: 'select_slot', options: { slot_number: i } }],
                        up: [],
                    },
                ],
                feedbacks: [
                    {
                        feedbackId: 'slot_active',
                        options: { slot_number: i },
                        // Companion v2.0.4 spec: boolean-feedback presets MUST
                        // declare the `style` override per-instance — the
                        // feedback's defaultStyle is only used when the user
                        // adds the feedback by hand, not via a preset.
                        style: { bgcolor: 0x00aa00, color: 0xffffff },
                    },
                ],
            }
        }

        const sections: CompanionPresetSection[] = [
            {
                id: 'slot_selection',
                name: 'Slot Selection',
                description:
                    'Drag a button to switch the paired Control UI to that slot. ' +
                    'Each button auto-renders the slot number + live name and lights up when active. ' +
                    'List rebuilds automatically when slots are added or removed server-side.',
                definitions: presetIds,
            },
            ...extraSections,
        ]

        this.setPresetDefinitions(sections, presets)
    }
}

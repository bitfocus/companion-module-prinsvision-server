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

// ============================================================================
// Constants
// ============================================================================

const NODE_TYPE_CHOICES = [
    { id: 'primary_wheels', label: 'Primary Wheels' },
    { id: 'log_wheels', label: 'Log Wheels' },
    { id: 'curves', label: 'Curves' },
    { id: 'lut3d', label: '3D LUT' },
    { id: 'cst', label: 'Color Space Transform' },
]

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

    // Retry timer for "io server disconnect" — Socket.IO turns off auto-reconnect
    // when the server disconnects us deliberately (e.g. on Companion-disable).
    // We keep our own slow retry so the module reconnects automatically once
    // the operator re-enables Companion in PatchBay Config.
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private static readonly RECONNECT_DELAY_MS = 3000

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
        if (!config.api_key || !config.api_key.trim()) missing.push('API key')
        if (!config.pair_code || !config.pair_code.trim()) missing.push('pair code')
        if (missing.length > 0) {
            this.updateStatus(InstanceStatus.BadConfig, `Fill in: ${missing.join(', ')}`)
            this.setVariableValues({ connected: 'Disconnected' })
            this.log('debug', `connectSocket skipped — missing config: ${missing.join(', ')}`)
            return
        }

        this.updateStatus(InstanceStatus.Connecting)

        const url = `http://${host}:${port}`
        const apiKeyPreview = config.api_key
            ? `${config.api_key.slice(0, 6)}…${config.api_key.slice(-4)} (len=${config.api_key.length})`
            : '(empty!)'
        const pairCodePreview = config.pair_code ? config.pair_code.trim() : '(none)'
        this.log('info', `Connecting → url=${url}  source=${source}  api_key=${apiKeyPreview}  pair_code=${pairCodePreview}`)

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

        this.socket = io(url, {
            path: SOCKET_IO_PATH,
            reconnection: true,
            reconnectionDelay: 2000,
            reconnectionDelayMax: 10000,
            timeout: 5000,
            auth: { user_type: 'companion' },
        })

        this.socket.on('connect', () => {
            this.log('info', `Socket connected — sid=${this.socket?.id ?? '?'} transport=${this.socket?.io?.engine?.transport?.name ?? '?'}`)
            this.updateStatus(InstanceStatus.Ok)
            this.setVariableValues({ connected: 'Connected' })
            this.checkFeedbacks('connection_ok')

            const connectPayload = {
                api_key: config.api_key,
                client_name: 'Companion',
                pair_code: config.pair_code.trim(),
            }
            this.log('info', `Emitting controller:connect with ${Object.keys(connectPayload).join(', ')}`)
            this.socket!.emit('controller:connect', connectPayload)
        })

        this.socket.on('disconnect', (reason: string) => {
            this.log('warn', `Socket disconnected — reason=${reason}`)
            this.updateStatus(InstanceStatus.Disconnected)
            this.setVariableValues({ connected: 'Disconnected' })
            this.checkFeedbacks('connection_ok', 'slot_streaming', 'slot_idle', 'node_enabled')

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
            this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
            this.setVariableValues({ connected: 'Disconnected' })
        })

        this.socket.io.on('reconnect_attempt', (n: number) => {
            this.log('debug', `reconnect_attempt #${n}`)
        })
        this.socket.io.on('error', (err: Error) => {
            this.log('warn', `manager error → ${err.message}`)
        })

        this.socket.on('controller:state_snapshot', (payload: StateSnapshotPayload) => {
            this.slots.clear()
            this.layersBySlotId.clear()
            for (const slot of payload.slots) {
                this.slots.set(slot.slot_number, {
                    id: slot.id,
                    slotNumber: slot.slot_number,
                    label: slot.label,
                    status: slot.status as SlotInfo['status'],
                })
            }
            for (const [slotId, layers] of Object.entries(payload.layers_by_slot)) {
                this.layersBySlotId.set(slotId, layers.map((l) => ({
                    id: l.id,
                    type: l.type,
                    enabled: l.enabled,
                    params: l.params,
                })))
            }
            this.setVariableValues({ slot_count: this.slots.size })
            this.syncSlotVariables()
            // Rebuild presets so the Presets tab only shows entries for slots
            // that actually exist server-side (preserves slot_number order).
            this.initPresets()
            this.checkFeedbacks('slot_streaming', 'slot_idle', 'node_enabled', 'slot_active')
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

        this.socket.on('controller:rejected', (payload: { reason: string }) => {
            this.log('warn', `Connection rejected by server: ${payload.reason}`)
            // Pair-code problems are a config issue, not a connection issue —
            // show BadConfig so the operator knows to fix the module settings.
            if (payload.reason === 'pair_code_required' || payload.reason === 'pair_code_invalid') {
                this.updateStatus(InstanceStatus.BadConfig, 'Invalid or missing pair code — generate one in PatchBay Config → Companion')
            } else {
                this.updateStatus(InstanceStatus.ConnectionFailure, payload.reason)
            }
        })

        // Server pushes slot-selection changes here, both ways:
        //   source='companion'  → echo of our own select_slot (no-op for us)
        //   source='control_ui' → operator picked a tile in the UI; sync our state
        this.socket.on('controller:slot_selected', (payload: { slot_number: number; slot_id: string; source: string }) => {
            if (!payload?.slot_number) return
            if (payload.source === 'companion') return
            this.currentSlot = payload.slot_number
            this.syncSlotVariables()
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
            this.layersBySlotId.set(payload.slot_id, payload.layers.map((l) => ({
                id: l.id,
                type: l.type,
                enabled: l.enabled,
                params: l.params,
            })))
            this.checkFeedbacks('node_enabled')
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
            this.checkFeedbacks('node_enabled')
        })
    }

    private disconnectSocket(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
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
     * preset dropdowns list current names. Ack-based; silently keeps the old
     * list when the server errors (the actions stay usable).
     */
    private refreshPresetList(): void {
        this.socket?.emit(
            'preset:list',
            { type: 'tree' },
            (resp: { status: string; presets?: Array<{ id: string; name: string }> }) => {
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

    private getLayersForSlot(slotNumber: number): LayerInfo[] {
        const slot = this.slots.get(slotNumber)
        if (!slot) return []
        return this.layersBySlotId.get(slot.id) ?? []
    }

    private findEnabledLayer(slotNumber: number, nodeType: string): LayerInfo | undefined {
        return this.getLayersForSlot(slotNumber).find((l) => l.type === nodeType && l.enabled)
    }

    private findLayer(slotNumber: number, nodeType: string): LayerInfo | undefined {
        return this.getLayersForSlot(slotNumber).find((l) => l.type === nodeType)
    }

    // =========================================================================
    // Variables
    // =========================================================================

    private initVariables(): void {
        const spec: CompanionVariableDefinitions = {
            module_version: { name: 'Module Version' },
            connected: { name: 'Connection Status' },
            slot_count: { name: 'Number of Slots' },
            current_slot: { name: 'Currently Selected Slot' },
            current_slot_name: { name: 'Currently Selected Slot — Name' },
            current_slot_status: { name: 'Currently Selected Slot — Status' },
        }
        const initialValues: Record<string, string | number> = {
            module_version: MODULE_VERSION,
            connected: 'Disconnected',
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
        this.setVariableDefinitions(spec)
        this.setVariableValues(initialValues)
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
            // ------------------------------------------------------------------
            // Slot selection
            // ------------------------------------------------------------------

            select_slot: {
                name: 'Slot: Select',
                description:
                    'Switch the paired Control UI to a specific slot. ' +
                    'Requires a Pair Code in the module config.',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    const slotNum = action.options['slot_number'] as number
                    this.currentSlot = slotNum
                    this.syncSlotVariables()
                    this.checkFeedbacks('slot_active')
                    this.socket?.emit('controller:select_slot', { slot_number: slotNum })
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
                    this.socket?.emit('controller:undo', {
                        slot_number: action.options['slot_number'] as number,
                    })
                },
            },

            redo: {
                name: 'Grading: Redo',
                description: 'Redo the last grading change on a slot (via the paired Control UI).',
                options: [SLOT_NUMBER_FIELD],
                callback: (action) => {
                    this.socket?.emit('controller:redo', {
                        slot_number: action.options['slot_number'] as number,
                    })
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
                    const slotNum = action.options['slot_number'] as number
                    const layer = this.findEnabledLayer(slotNum, 'primary_wheels')
                    if (!layer) {
                        this.log('warn', `No active primary_wheels node on slot ${slotNum}`)
                        return
                    }
                    this.socket?.emit('node_primary_wheels_reset', {
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
                    const slotNum = action.options['slot_number'] as number
                    const layer = this.findEnabledLayer(slotNum, 'log_wheels')
                    if (!layer) {
                        this.log('warn', `No active log_wheels node on slot ${slotNum}`)
                        return
                    }
                    this.socket?.emit('node_log_wheels_reset', {
                        slot_id: slotNum,
                        node_id: layer.id,
                    })
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
                    this.socket?.emit(
                        'preset:apply_tree',
                        { preset_id: presetId, slot_id: action.options['slot_number'] as number },
                        (resp: { status: string; message?: string }) => {
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
                    this.socket?.emit(
                        'preset:save_tree',
                        { slot_id: slotNum, name, slot_name: this.slots.get(slotNum)?.label ?? '' },
                        (resp: { status: string; message?: string }) => {
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
                    this.socket?.emit(
                        'preset:overwrite_tree',
                        { preset_id: presetId, slot_id: action.options['slot_number'] as number },
                        (resp: { status: string; message?: string }) => {
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
                    this.socket?.emit('controller:set_preview_mode', {
                        slot_number: action.options['slot_number'] as number,
                        mode: action.options['mode'] as string,
                    })
                },
            },

            // Node toggles route through the paired Control UI
            // (controller:toggle_node → server forward → UI setEnabled path),
            // so lut3d unload/reload, intensity bypass, history entries and
            // chain persist all behave exactly like clicking the eye icon.
            // Feedback state comes back via layer:stack_sync.
            toggle_node: {
                name: 'Grading: Toggle Node',
                description: 'Toggle a node type on or off on a slot (via the paired Control UI)',
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'dropdown' as const,
                        id: 'node_type',
                        label: 'Node Type',
                        default: 'primary_wheels',
                        choices: NODE_TYPE_CHOICES,
                    },
                ],
                callback: (action) => {
                    this.socket?.emit('controller:toggle_node', {
                        slot_number: action.options['slot_number'] as number,
                        node_type: action.options['node_type'] as string,
                    })
                },
            },

            enable_node: {
                name: 'Grading: Enable Node',
                description: 'Force-enable a specific node type on a slot (via the paired Control UI)',
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'dropdown' as const,
                        id: 'node_type',
                        label: 'Node Type',
                        default: 'primary_wheels',
                        choices: NODE_TYPE_CHOICES,
                    },
                ],
                callback: (action) => {
                    this.socket?.emit('controller:toggle_node', {
                        slot_number: action.options['slot_number'] as number,
                        node_type: action.options['node_type'] as string,
                        enabled: true,
                    })
                },
            },

            disable_node: {
                name: 'Grading: Disable Node',
                description: 'Force-disable a specific node type on a slot (via the paired Control UI)',
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'dropdown' as const,
                        id: 'node_type',
                        label: 'Node Type',
                        default: 'primary_wheels',
                        choices: NODE_TYPE_CHOICES,
                    },
                ],
                callback: (action) => {
                    this.socket?.emit('controller:toggle_node', {
                        slot_number: action.options['slot_number'] as number,
                        node_type: action.options['node_type'] as string,
                        enabled: false,
                    })
                },
            },
        }

        this.setActionDefinitions(actions)
    }

    // =========================================================================
    // Feedbacks
    // =========================================================================

    private initFeedbacks(): void {
        const feedbacks: Record<string, CompanionFeedbackDefinition> = {
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
                defaultStyle: { bgcolor: 0x0066cc, color: 0xffffff },
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
                    const slotNum = feedback.options['slot_number'] as number
                    const mode = this.previewModeBySlot.get(slotNum) ?? 'grade'
                    return mode === (feedback.options['mode'] as string)
                },
            },

            node_enabled: {
                type: 'boolean',
                name: 'Node: Enabled',
                description: 'Active when a specific node type is enabled on a slot',
                defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
                options: [
                    SLOT_NUMBER_FIELD,
                    {
                        type: 'dropdown' as const,
                        id: 'node_type',
                        label: 'Node Type',
                        default: 'primary_wheels',
                        choices: NODE_TYPE_CHOICES,
                    },
                ],
                callback: (feedback) => {
                    const slotNum = feedback.options['slot_number'] as number
                    const nodeType = feedback.options['node_type'] as string
                    const layer = this.findLayer(slotNum, nodeType)
                    return layer?.enabled ?? false
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
    private initPresets(): void {
        const presets: CompanionPresetDefinitions = {}
        const presetIds: string[] = []

        // Sort by slot_number ascending so the Presets tab shows them in
        // operator-friendly order. Map keys aren't guaranteed to be sorted.
        const slotNumbers = Array.from(this.slots.keys()).sort((a, b) => a - b)

        // Skip the section entirely if no slots exist yet — better than a
        // dead "Select Slot 1" placeholder that does nothing.
        if (slotNumbers.length === 0) {
            this.setPresetDefinitions([], {})
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
                    // every state_snapshot so renames stay live.
                    text: `Slot ${i}\\n${labelText}`,
                    size: 'auto',
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
                        style: { bgcolor: 0x0066cc, color: 0xffffff },
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
        ]

        this.setPresetDefinitions(sections, presets)
    }
}


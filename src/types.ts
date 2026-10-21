// Internal state types for tracking PrinsVision runtime state.
// SlotStatus mirrors the server's SlotState enum (SM-D29). Feedbacks check
// `running` and `idle`; the rest are kept so the union narrows correctly and
// the status variable can show the raw state string.
export type SlotStatus = 'idle' | 'starting' | 'running' | 'degraded' | 'error' | 'stopping' | 'stopped'

export interface SlotInfo {
    id: string
    slotNumber: number
    label: string
    status: SlotStatus
    /** Wheel pivot / Log-range defaults follow it */
    pipelineMode: 'prinsvision' | 'aces'
}

export interface LayerInfo {
    id: string
    type: string // 'primary_wheels' | 'log_wheels' | 'curves' | 'lut3d' | 'cst'
    enabled: boolean
    /** May be edited: own eye on and Corrector not bypassed. Absent from older Cores. */
    active?: boolean
    params: Record<string, unknown>
}

// ============================================================================
// Socket.IO payloads — server → client
// ============================================================================

// slot:state_changed broadcast (SM-D29 state machine). Replaces the pre-slot-
// model `slot:status_changed` event, which the server no longer emits.
export interface SlotStateChangedPayload {
    id: string
    state: string
    previous_state: string
}

export interface LayerStackSyncPayload {
    slot_id: string // Slot UUID
    pipeline_mode?: string
    layers: Array<{
        id: string
        type: string
        enabled: boolean
        active?: boolean
        params: Record<string, unknown>
    }>
}

export interface LayerUpdatedPayload {
    slot_id: string
    layer_id: string
    params: Record<string, unknown>
}

// Sent once on controller:connect, then replays slot:status_changed +
// layer:stack_sync so the module can rebuild full state in one shot.
export interface StateSnapshotPayload {
    slots: Array<{
        id: string
        slot_number: number
        label: string
        status: string
        pipeline_mode?: string
    }>
    layers_by_slot: Record<string, Array<{
        id: string
        type: string
        enabled: boolean
        active?: boolean
        params: Record<string, unknown>
    }>>
}

export interface AtemFollowSettings {
    context: string
    enabled: boolean
    connection_label: string
    http_port: number
    aux: number
    me: number
    switch_aux_on_selection: boolean
    mappings: Array<{ input: number; slot: number }>
}

/** Feedback option of the generated AUX triggers; the server builds the same string for the export. */
export function atemRouteContext(settings: AtemFollowSettings): string {
    return `${settings.context}:aux${settings.aux}`
}

export interface AtemConnection {
    label: string
    enabled: boolean
    /** Companion's status category (good, warning, error), null while it has none. */
    status: string | null
}

export interface AtemConnectionsReport {
    connections: AtemConnection[]
    error?: string
}

// Runs on the Companion machine, so loopback also works with a remote Core.
// Never opens another ATEM connection or mutates Companion configuration.
async function companionGet(httpPort: number, path: string, signal: AbortSignal) {
    const response = await fetch(`http://127.0.0.1:${httpPort}/api${path}`, { signal, redirect: 'error' })
    if (!response.ok) throw new Error(`Companion HTTP ${response.status}; check its port and ATEM connection label`)
    return response
}

/** The single source for which Companion connections count as an ATEM. */
export async function listAtemConnections(httpPort: number, signal: AbortSignal): Promise<AtemConnection[]> {
    const connections = await (await companionGet(httpPort, '/connections', signal)).json() as Array<{
        label: string; moduleId: string; enabled: boolean; status?: { category: string } | null
    }>
    return connections.filter(c => c.moduleId === 'bmd-atem')
        .map(c => ({ label: c.label, enabled: c.enabled, status: c.status?.category ?? null }))
}

export async function readAtemBuses(settings: AtemFollowSettings, signal: AbortSignal): Promise<[number, number]> {
    const atems = await listAtemConnections(settings.http_port, signal)
    const atem = atems.find(c => c.label === settings.connection_label)
    if (!atem) {
        const found = atems.length ? `found: ${atems.map(c => c.label).join(', ')}` : 'none found'
        throw new Error(`No ATEM connection "${settings.connection_label}" in Companion (${found})`)
    }
    if (!atem.enabled || atem.status !== 'good') {
        throw new Error(`ATEM connection "${atem.label}" is ${atem.enabled ? 'not connected' : 'disabled'}`)
    }
    const label = encodeURIComponent(settings.connection_label)
    const values = await Promise.all([
        companionGet(settings.http_port, `/variable/${label}/aux${settings.aux}_input_id/value`, signal).then(r => r.text()),
        companionGet(settings.http_port, `/variable/${label}/pgm${settings.me}_input_id/value`, signal).then(r => r.text()),
    ])
    if (values.some(v => !/^\d+$/.test(v.trim()) || !Number.isSafeInteger(Number(v)))) {
        throw new Error('ATEM bus has no valid input ID')
    }
    return [Number(values[0]), Number(values[1])]
}

/** Reports the ATEM connections whenever they change, also while follow is off, so Patch Bay can offer them. */
export class AtemDiscovery {
    private httpPort?: number
    private timer?: ReturnType<typeof setTimeout>
    private generation = 0
    private lastReport?: string
    constructor(private report: (report: AtemConnectionsReport) => void) {}

    configure(httpPort: number) {
        if (httpPort === this.httpPort) return
        this.stop()
        this.httpPort = httpPort
        void this.poll(this.generation)
    }

    stop() {
        this.generation++
        clearTimeout(this.timer)
        this.httpPort = undefined
        this.lastReport = undefined
    }

    private async poll(generation: number) {
        const httpPort = this.httpPort
        if (httpPort === undefined || generation !== this.generation) return
        const abort = new AbortController()
        const timeout = setTimeout(() => abort.abort(), 1500)
        let report: AtemConnectionsReport
        try {
            report = { connections: await listAtemConnections(httpPort, abort.signal) }
        } catch (error) {
            report = { connections: [], error: abort.signal.aborted
                ? `Companion web API did not answer on port ${httpPort}`
                : error instanceof Error ? error.message : String(error) }
        } finally {
            clearTimeout(timeout)
        }
        if (generation !== this.generation) return
        const key = JSON.stringify(report)
        if (key !== this.lastReport) {
            this.lastReport = key
            this.report(report)
        }
        this.timer = setTimeout(() => { void this.poll(generation) }, 5000)
    }
}

/**
 * Serial polling with cancellation: obsolete AUX/project replies cannot act.
 * The reverse direction (slot choice → AUX) only raises a feedback; an imported
 * Companion trigger switches the AUX, and the next poll confirms it.
 */
export class AtemFollower {
    private settings?: AtemFollowSettings
    private timer?: ReturnType<typeof setTimeout>
    private requestTimer?: ReturnType<typeof setTimeout>
    private abort?: AbortController
    private generation = 0
    private lastAux?: string
    private lastProgram?: string
    private auxInput?: number
    private pending?: number
    private routeError = ''
    constructor(
        private select: (slot: number, context: string) => void,
        private tally: (slots: number[], context: string) => Promise<void>,
        private status: (message: string) => void,
        private hasSlot: (slot: number) => boolean,
        private changed: () => void,
    ) {}

    /** Only operator choices call this, never selections made by following the AUX. */
    requestSlot(slot: number) {
        const settings = this.settings
        if (!settings?.enabled || !settings.switch_aux_on_selection || !this.hasSlot(slot)) return
        const onAux = settings.mappings.find(m => m.input === this.auxInput)?.slot
        if (onAux === slot && this.pending === undefined) return
        const input = settings.mappings.find(m => m.slot === slot)?.input
        if (input === undefined) return
        clearTimeout(this.requestTimer)
        this.pending = input
        this.routeError = ''
        this.changed()
        this.requestTimer = setTimeout(() => {
            this.pending = undefined
            this.routeError = 'No AUX confirmation — import the ATEM triggers'
            this.changed()
            this.status(this.routeError)
        }, 2500)
    }

    isRequested(input: number, context: string): boolean {
        const settings = this.settings
        return !!settings?.enabled && settings.switch_aux_on_selection
            && context === atemRouteContext(settings) && this.pending === input
    }

    private clearRequest() {
        clearTimeout(this.requestTimer)
        if (this.pending === undefined) return
        this.pending = undefined
        this.changed()
    }

    configure(settings: AtemFollowSettings) {
        if (JSON.stringify(settings) === JSON.stringify(this.settings)) return
        const previous = this.settings
        this.stop()
        this.settings = settings
        if (previous?.enabled) void this.tally([], previous.context).catch(() => {})
        if (settings.enabled) void this.poll(this.generation)
        else this.status('Disabled')
    }

    stop() {
        this.generation++
        clearTimeout(this.timer)
        this.abort?.abort()
        this.clearRequest()
        this.settings = undefined
        this.lastAux = this.lastProgram = undefined
        this.auxInput = undefined
        this.routeError = ''
    }

    private async poll(generation: number) {
        const settings = this.settings
        if (!settings?.enabled || generation !== this.generation) return
        const abort = this.abort = new AbortController()
        const timeout = setTimeout(() => abort.abort(), 1500)
        try {
            const [aux, program] = await readAtemBuses(settings, abort.signal)
            if (generation !== this.generation) return
            const slotFor = (input: number) => {
                const slot = settings.mappings.find(m => m.input === input)?.slot
                return slot !== undefined && this.hasSlot(slot) ? slot : undefined
            }
            this.auxInput = aux
            if (aux === this.pending) {
                this.clearRequest()
                this.routeError = ''
            }
            // While a requested switch is in flight, the old AUX source must not pull the selection back.
            if (this.pending === undefined) {
                const auxSlot = slotFor(aux)
                const auxKey = `${aux}:${auxSlot}`
                if (auxKey !== this.lastAux && auxSlot !== undefined) this.select(auxSlot, settings.context)
                this.lastAux = auxKey
            }
            const programSlot = slotFor(program)
            const programKey = `${program}:${programSlot}`
            if (programKey !== this.lastProgram) {
                await this.tally(programSlot === undefined ? [] : [programSlot], settings.context)
                if (generation !== this.generation) return
                this.lastProgram = programKey
            }
            this.status([`Following AUX ${settings.aux} / Program M/E ${settings.me}`, this.routeError].filter(Boolean).join(' · '))
        } catch (error) {
            if (generation !== this.generation) return
            this.lastAux = this.lastProgram = undefined
            this.auxInput = undefined
            this.clearRequest()
            // A stale Program variable must never keep a tile red after loss.
            await this.tally([], settings.context).catch(() => {})
            if (generation === this.generation) this.status(String(error))
        } finally {
            clearTimeout(timeout)
            if (generation === this.generation) this.timer = setTimeout(() => { void this.poll(generation) }, 250)
        }
    }
}

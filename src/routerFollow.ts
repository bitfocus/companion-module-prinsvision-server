import type { AtemFollowSettings } from './atemFollow.js'

export interface RouterFollowSettings extends AtemFollowSettings {
    router: {
        destination: number
        level: number
        tsl_connection_label: string
        tsl_field: string
        route_on_selection: boolean
    }
    mappings: Array<{ input: number; slot: number; tsl_address?: number | null }>
}

export function tallyIsRed(value: string, field: string): boolean {
    const normalized = value.trim().toLowerCase()
    if (['rh_tally', 'text_tally', 'lh_tally'].includes(field)) {
        if (!/^[0-3]$/.test(normalized)) throw new Error('Invalid TSL colour')
        return normalized === '1' || normalized === '3'
    }
    if (!['true', 'false', '1', '0'].includes(normalized)) throw new Error('No valid TSL tally received')
    return normalized === 'true' || normalized === '1'
}

/**
 * Router feedback arrives through imported Companion triggers; no router socket
 * or writes to Companion configuration. HTTP is only used for health and TSL.
 * Requests are transient feedbacks, separate from the reflected current_slot.
 */
export class RouterFollower {
    private settings?: RouterFollowSettings
    private timer?: ReturnType<typeof setTimeout>
    private requestTimer?: ReturnType<typeof setTimeout>
    private abort?: AbortController
    private generation = 0
    private ready = false
    private observed?: number
    private pending?: number
    private lastTally = ''
    private routeError = ''

    constructor(
        private select: (slot: number, context: string) => void,
        private tally: (slots: number[], context: string) => Promise<void>,
        private changed: () => void,
        private status: (message: string) => void,
        private hasSlot: (slot: number) => boolean,
    ) {}

    configure(settings: RouterFollowSettings) {
        if (JSON.stringify(settings) === JSON.stringify(this.settings)) return
        const previous = this.settings
        this.stop()
        this.settings = settings
        const generation = this.generation
        const cleared = previous?.enabled ? this.tally([], previous.context).catch(() => {}) : Promise.resolve()
        if (settings.enabled) void cleared.then(() => { if (generation === this.generation) void this.poll(generation) })
        else this.status('Disabled')
    }

    stop() {
        this.generation++
        clearTimeout(this.timer)
        clearTimeout(this.requestTimer)
        this.abort?.abort()
        this.settings = undefined
        this.ready = false
        this.observed = this.pending = undefined
        this.lastTally = ''
        this.routeError = ''
        this.changed()
    }

    isFollowing(context: string): boolean {
        return !!this.settings?.enabled && this.ready && this.settings.context === context
    }

    isRequested(input: number, context: string): boolean {
        return this.isFollowing(context) && !!this.settings?.router.route_on_selection && this.pending === input
    }

    /** Only actual operator choices call this, never snapshot/follow updates. */
    requestSlot(slot: number, context?: string) {
        const settings = this.settings
        if (!settings || !this.isFollowing(context ?? settings.context) || !settings.router.route_on_selection) return
        const input = settings.mappings.find(m => m.slot === slot)?.input
        if (input === undefined || !this.hasSlot(slot)) return
        if (input === this.observed && this.pending === undefined) return
        clearTimeout(this.requestTimer)
        this.pending = input
        this.routeError = ''
        this.changed()
        this.requestTimer = setTimeout(() => {
            this.pending = undefined
            this.observed = undefined
            this.routeError = 'No route confirmation — check imported triggers and router'
            this.changed()
            this.status(this.routeError)
        }, 2500)
    }

    observeInput(input: number, context: string) {
        const settings = this.settings
        if (!settings || !this.isFollowing(context)) return
        const slot = settings.mappings.find(m => m.input === input)?.slot
        if (slot === undefined || !this.hasSlot(slot)) return
        // Old router feedback may arrive while the new crosspoint is in flight.
        if (this.pending !== undefined && input !== this.pending) return
        if (this.pending === input) {
            clearTimeout(this.requestTimer)
            this.pending = undefined
            this.routeError = ''
            this.changed()
        }
        if (this.observed === input) return
        this.observed = input
        this.select(slot, settings.context)
    }

    private setReady(ready: boolean) {
        if (!ready) {
            this.observed = this.pending = undefined
            clearTimeout(this.requestTimer)
        }
        if (this.ready === ready) return
        this.ready = ready
        this.changed()
    }

    private async poll(generation: number) {
        const settings = this.settings
        if (!settings?.enabled || generation !== this.generation) return
        const abort = this.abort = new AbortController()
        const timeout = setTimeout(() => abort.abort(), 1500)
        const current = () => generation === this.generation
        const get = async (path: string) => {
            const response = await fetch(`http://127.0.0.1:${settings.http_port}/api${path}`, { signal: abort.signal, redirect: 'error' })
            if (!response.ok) throw new Error(`Companion HTTP ${response.status}`)
            return response
        }
        try {
            const connections = await (await get('/connections')).json() as Array<{
                label: string; moduleId: string; enabled: boolean; status?: { category: string }
            }>
            if (!current()) return
            const healthy = (label: string, module: string) => {
                const matches = connections.filter(c => c.label === label && c.moduleId === module)
                return matches.length === 1 && matches[0].enabled && matches[0].status?.category === 'good'
            }
            const routerReady = healthy(settings.connection_label, 'generic-swp08')
            this.setReady(routerReady)
            const tallyMappings = settings.mappings.filter(m => m.tsl_address != null && this.hasSlot(m.slot))
            let tallyError = ''
            let slots: number[] = []
            if (tallyMappings.length) {
                try {
                    if (!healthy(settings.router.tsl_connection_label, 'tslproducts-umdlistener')) throw new Error('TSL connection unavailable')
                    const label = encodeURIComponent(settings.router.tsl_connection_label)
                    const states = new Map<number, boolean>()
                    const addresses = [...new Set(tallyMappings.map(m => m.tsl_address!))]
                    // Bounded parallelism for large mappings.
                    for (let i = 0; i < addresses.length; i += 8) {
                        await Promise.all(addresses.slice(i, i + 8).map(async address => {
                            try {
                                const value = await (await get(`/variable/${label}/tally_${address}_${settings.router.tsl_field}/value`)).text()
                                states.set(address, tallyIsRed(value, settings.router.tsl_field))
                            } catch {
                                tallyError = 'Some TSL addresses have no valid data'
                                states.set(address, false)
                            }
                        }))
                        if (!current()) return
                    }
                    slots = tallyMappings.filter(m => states.get(m.tsl_address!)).map(m => m.slot)
                } catch (error) { tallyError = String(error) }
            }
            if (!current()) return
            const key = JSON.stringify(slots)
            if (key !== this.lastTally) {
                await this.tally(slots, settings.context)
                if (!current()) return
                this.lastTally = key
            }
            this.status([
                routerReady ? (this.observed === undefined ? 'Waiting for router feedback — import triggers' : `Following output ${settings.router.destination}`) : 'SW-P-08 connection unavailable',
                tallyError, this.routeError,
            ].filter(Boolean).join(' · '))
        } catch (error) {
            if (!current()) return
            this.setReady(false)
            this.lastTally = ''
            await this.tally([], settings.context).catch(() => {})
            if (current()) this.status(String(error))
        } finally {
            clearTimeout(timeout)
            if (current()) this.timer = setTimeout(() => { void this.poll(generation) }, 500)
        }
    }
}

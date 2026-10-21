/** One mapping shared by the AUX-follow and Program-tally actions. */
export function parseInputMapping(text: string): Map<number, number> {
    const result = new Map<number, number>()
    for (const line of text.split(/[\n,;]/)) {
        if (!line.trim()) continue
        const match = /^\s*(\d+)\s*=\s*([1-9]\d*)\s*$/.exec(line)
        if (!match) throw new Error(`Invalid mapping "${line.trim()}". Use input=slot, for example 1=3.`)
        const input = Number(match[1]), slot = Number(match[2])
        if (!Number.isSafeInteger(input) || !Number.isSafeInteger(slot)) throw new Error('Input and slot numbers must be integers.')
        if (result.has(input)) throw new Error(`Input ${input} is mapped more than once.`)
        result.set(input, slot)
    }
    return result
}

export function mappedSlot(value: unknown, mapping: Map<number, number>): number | undefined {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return undefined
    const input = Number(value)
    return Number.isSafeInteger(input) && input >= 0 ? mapping.get(input) : undefined
}

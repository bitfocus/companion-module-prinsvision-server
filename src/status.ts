/**
 * Status text for a server we cannot reach. Companion stores a Bonjour pick
 * as the IP it resolved to at that moment, so after a network change the
 * connection keeps dialling an address that is gone — say so instead of a
 * bare "timeout".
 */
export function unreachableMessage(address: string, fromBonjour: boolean): string {
    return fromBonjour
        ? `Can't reach ${address}. Network changed? Pick the server again, or use 127.0.0.1.`
        : `Can't reach ${address}. Is PrinsVision running? Check Host and Port.`
}

import type { LayerInfo } from './types.js'

/** Is this layer switched on? Older Cores don't send `active`; fall back to the node's own eye. */
export function isLayerActive(layer: LayerInfo): boolean {
    return layer.active ?? layer.enabled
}

/**
 * The layer a Companion control may edit: the first of that type that is switched
 * on. A node switched off with its eye or inside a bypassed Corrector is greyed
 * and locked in the Control UI, so Companion must not edit it blind either.
 */
export function editableLayer(layers: readonly LayerInfo[], nodeType: string): LayerInfo | undefined {
    return layers.find((l) => l.type === nodeType && isLayerActive(l))
}

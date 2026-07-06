import type { SomeCompanionConfigField } from '@companion-module/base'

export interface PrinsVisionConfig {
    bonjour_device: string
    host: string
    port: number
    api_key: string
    pair_code: string
}

export function getConfigFields(): SomeCompanionConfigField[] {
    return [
        {
            type: 'bonjour-device',
            id: 'bonjour_device',
            label: 'Discovered PrinsVision systems',
            width: 12,
        },
        {
            type: 'textinput',
            id: 'host',
            label: 'PrinsVision Host',
            default: '127.0.0.1',
            width: 8,
            isVisibleExpression: `!$(options:bonjour_device)`,
        },
        {
            type: 'number',
            id: 'port',
            label: 'Port',
            default: 8888,
            min: 1,
            max: 65535,
            width: 4,
            isVisibleExpression: `!$(options:bonjour_device)`,
        },
        {
            type: 'textinput',
            id: 'api_key',
            label: 'API Key',
            default: '',
            width: 12,
        },
        {
            type: 'textinput',
            id: 'pair_code',
            label: 'Pair Code (required — links to one Control UI user)',
            default: '',
            width: 6,
            tooltip:
                'Generate this in PrinsVision Control UI → PatchBay Config → Companion. ' +
                'Required: the server rejects connections without a valid pair code.',
        },
    ]
}

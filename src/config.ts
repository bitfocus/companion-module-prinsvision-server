import type { SomeCompanionConfigField } from '@companion-module/base'

export interface PrinsVisionConfig {
    bonjour_device: string
    host: string
    port: number
    pair_code: string
    input_mapping?: string
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
            id: 'pair_code',
            label: 'Pair Code',
            default: '',
            width: 12,
            tooltip:
                'Copy it from PrinsVision → Patch Bay Config → Companion. ' +
                'It is the only key this connection needs and links it to one PrinsVision user.',
        },
    ]
}

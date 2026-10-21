// The PrinsVision controller-API number this module speaks (audit 111 T7,
// decisions B2/B3). Sent as api_version in controller:connect; the server
// refuses a module whose number differs from its PV_PROTOCOL_VERSION
// (Server/config/settings.py) with controller:rejected version_mismatch.
// Independent of MODULE_VERSION: a store release of the module does not bump
// it; only a change to the events this module and the server exchange does —
// and then on both sides in the same commit
// (Server/tests/unit/test_version_contract_between_macs.py pins them equal).
export const CONTROLLER_API_VERSION = 1

// Default revive services every War Room starts with (the ones TNL/family
// factions use), so leaders don't have to re-enter them per faction. Each is
// {name, url, source, sourceKey, preset} — the same shape ReviveServicesModal
// saves. A faction can still edit or remove them (that persists an explicit
// list, which then overrides these).
export const DEFAULT_REVIVE_SERVICES = [
  { name: 'UHC',  url: 'https://tornuhc.eu/api/request',         source: 'UHC Script',                    sourceKey: 'source',         preset: 'json' },
  { name: 'WTF',  url: 'https://what-the-f.de/wtfapi/revive',    source: 'WTF Revive Button Script',      sourceKey: 'requestChannel', preset: 'json' },
  { name: 'Nuke', url: 'https://nuke.family/api/revive-request', source: 'Nuke Revive Me Userscript v2.2', sourceKey: 'source',         preset: 'nuke' },
]

// The effective service list for a war-room config: a never-configured faction
// (revive_services null/undefined) gets the defaults; once a leader saves a list
// (even an empty one, i.e. an intentional clear) that explicit list wins.
export function effectiveReviveServices(config) {
  const list = config?.revive_services
  return Array.isArray(list) ? list : DEFAULT_REVIVE_SERVICES
}

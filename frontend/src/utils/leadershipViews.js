import { apiGet, apiPost, apiPut, apiDelete } from './apiClient'

// Member-overview saved views and threshold sets, via the purpose-built
// leadership endpoints. The server enforces the leadership gate on writes
// (visitors read-only) and stamps created_by_* from the session — the
// user/tornApiKey parameters from the edge-function era are accepted but
// unused so call sites keep working.

export async function fetchSavedViews() {
  const { views } = await apiGet('/api/overview/views')
  return (views ?? []).map(row => ({
    id: row.id,
    name: row.name,
    columns: Array.isArray(row.columns) ? row.columns : [],
    created_by_id: row.created_by_id,
    created_by_name: row.created_by_name,
    updated_at: row.updated_at,
  }))
}

export async function createSavedView({ name, columns }) {
  const { view } = await apiPost('/api/overview/views', { name, columns })
  return view
}

export async function updateSavedView(id, { name, columns }) {
  const { view } = await apiPut(`/api/overview/views/${id}`, { name, columns })
  return view
}

export async function deleteSavedView(id) {
  await apiDelete(`/api/overview/views/${id}`)
}

export async function fetchThresholdSets() {
  const { thresholds } = await apiGet('/api/overview/thresholds')
  return (thresholds ?? []).map(row => ({
    id: row.id,
    name: row.name,
    thresholds: row.thresholds && typeof row.thresholds === 'object' ? row.thresholds : {},
    created_by_id: row.created_by_id,
    created_by_name: row.created_by_name,
    updated_at: row.updated_at,
  }))
}

export async function createThresholdSet({ name, thresholds }) {
  const { threshold } = await apiPost('/api/overview/thresholds', { name, thresholds })
  return threshold
}

export async function updateThresholdSet(id, { name, thresholds }) {
  const { threshold } = await apiPut(`/api/overview/thresholds/${id}`, { name, thresholds })
  return threshold
}

export async function deleteThresholdSet(id) {
  await apiDelete(`/api/overview/thresholds/${id}`)
}

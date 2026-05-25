import { supabase } from './supabase'

const VIEWS_TABLE = 'member_overview_views'
const THRESHOLDS_TABLE = 'member_overview_thresholds'

export async function fetchSavedViews() {
  const { data, error } = await supabase
    .from(VIEWS_TABLE)
    .select('id, name, columns, created_by_id, created_by_name, updated_at')
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []).map(row => ({
    id: row.id,
    name: row.name,
    columns: Array.isArray(row.columns) ? row.columns : [],
    created_by_id: row.created_by_id,
    created_by_name: row.created_by_name,
    updated_at: row.updated_at,
  }))
}

export async function createSavedView({ name, columns, user }) {
  const { data, error } = await supabase
    .from(VIEWS_TABLE)
    .insert({
      name,
      columns,
      created_by_id: user?.id != null ? String(user.id) : null,
      created_by_name: user?.name ?? null,
    })
    .select('id, name, columns, created_by_id, created_by_name, updated_at')
    .single()
  if (error) throw error
  return data
}

export async function updateSavedView(id, { name, columns }) {
  const patch = { updated_at: new Date().toISOString() }
  if (name !== undefined)    patch.name = name
  if (columns !== undefined) patch.columns = columns
  const { data, error } = await supabase
    .from(VIEWS_TABLE)
    .update(patch)
    .eq('id', id)
    .select('id, name, columns, created_by_id, created_by_name, updated_at')
    .single()
  if (error) throw error
  return data
}

export async function deleteSavedView(id) {
  const { error } = await supabase.from(VIEWS_TABLE).delete().eq('id', id)
  if (error) throw error
}

export async function fetchThresholdSets() {
  const { data, error } = await supabase
    .from(THRESHOLDS_TABLE)
    .select('id, name, thresholds, created_by_id, created_by_name, updated_at')
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []).map(row => ({
    id: row.id,
    name: row.name,
    thresholds: row.thresholds && typeof row.thresholds === 'object' ? row.thresholds : {},
    created_by_id: row.created_by_id,
    created_by_name: row.created_by_name,
    updated_at: row.updated_at,
  }))
}

export async function createThresholdSet({ name, thresholds, user }) {
  const { data, error } = await supabase
    .from(THRESHOLDS_TABLE)
    .insert({
      name,
      thresholds,
      created_by_id: user?.id != null ? String(user.id) : null,
      created_by_name: user?.name ?? null,
    })
    .select('id, name, thresholds, created_by_id, created_by_name, updated_at')
    .single()
  if (error) throw error
  return data
}

export async function updateThresholdSet(id, { name, thresholds }) {
  const patch = { updated_at: new Date().toISOString() }
  if (name !== undefined)       patch.name = name
  if (thresholds !== undefined) patch.thresholds = thresholds
  const { data, error } = await supabase
    .from(THRESHOLDS_TABLE)
    .update(patch)
    .eq('id', id)
    .select('id, name, thresholds, created_by_id, created_by_name, updated_at')
    .single()
  if (error) throw error
  return data
}

export async function deleteThresholdSet(id) {
  const { error } = await supabase.from(THRESHOLDS_TABLE).delete().eq('id', id)
  if (error) throw error
}

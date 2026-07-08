import { supabase } from './supabase'
import * as adminApi from './adminApi'

const VIEWS_TABLE = 'member_overview_views'
const THRESHOLDS_TABLE = 'member_overview_thresholds'

// Reads stay on the supabase client — RLS now enforces the leadership gate
// at the DB level. Writes go through admin-db so the leadership check is
// server-side and the write policies on these tables can be locked down to
// service-role-only in a later phase.

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

export async function createSavedView({ name, columns, user }, tornApiKey) {
  const result = await adminApi.createOverviewView({ name, columns, user }, tornApiKey)
  return result.data
}

export async function updateSavedView(id, { name, columns }, tornApiKey) {
  const result = await adminApi.updateOverviewView(id, { name, columns }, tornApiKey)
  return result.data
}

export async function deleteSavedView(id, tornApiKey) {
  await adminApi.deleteOverviewView(id, tornApiKey)
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

export async function createThresholdSet({ name, thresholds, user }, tornApiKey) {
  const result = await adminApi.createOverviewThreshold({ name, thresholds, user }, tornApiKey)
  return result.data
}

export async function updateThresholdSet(id, { name, thresholds }, tornApiKey) {
  const result = await adminApi.updateOverviewThreshold(id, { name, thresholds }, tornApiKey)
  return result.data
}

export async function deleteThresholdSet(id, tornApiKey) {
  await adminApi.deleteOverviewThreshold(id, tornApiKey)
}

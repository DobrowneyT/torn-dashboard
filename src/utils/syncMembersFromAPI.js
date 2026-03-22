const EDGE_FUNCTION_URL = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/admin-db'

export async function syncMembersFromAPI(apiKey) {
  if (!apiKey) {
    return {
      success: false,
      error: 'No API key provided',
      totalMembers: 0
    }
  }

  console.log('Syncing members with API key:', apiKey.substring(0, 4) + '...')

  try {
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-torn-api-key': apiKey,
      },
      body: JSON.stringify({ action: 'sync_members' })
    })

    const data = await response.json()

    console.log('Sync members response:', response.status, data)

    if (!response.ok) {
      return {
        success: false,
        error: data.error || `Request failed: ${response.status}`,
        totalMembers: 0
      }
    }

    if (data && !data.success) {
      return {
        success: false,
        error: data.error || 'Unknown error from function',
        totalMembers: 0
      }
    }

    return data

  } catch (error) {
    console.error('Sync members exception:', error)
    return {
      success: false,
      error: error.message,
      totalMembers: 0
    }
  }
}

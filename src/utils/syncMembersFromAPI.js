import { supabase } from './supabase'

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
    const { data, error } = await supabase.functions.invoke('admin-db', {
      body: {
        action: 'sync_members'
      },
      headers: {
        'x-torn-api-key': apiKey,
      }
    })

    console.log('Edge Function response:', { data, error })

    if (error) {
      console.error('Sync members failed:', error)
      // Try to get more details from the error
      const errorMessage = error.message || error.msg || JSON.stringify(error)
      return {
        success: false,
        error: `Edge Function error: ${errorMessage}`,
        totalMembers: 0
      }
    }

    // Check if data itself indicates an error
    if (data && !data.success) {
      console.error('Function returned error:', data)
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
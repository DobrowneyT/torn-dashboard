import { supabase } from './supabase'

export async function syncItemsFromAPI(apiKey) {
  if (!apiKey) {
    return {
      success: false,
      error: 'No API key provided',
      itemsCount: 0
    }
  }

  console.log('Syncing items...')
  
  try {
    const { data, error } = await supabase.functions.invoke('admin-db', {
      body: {
        action: 'sync_items'
      },
      headers: {
        'x-torn-api-key': apiKey,
      }
    })

    if (error) {
      console.error('Sync items failed:', error)
      return {
        success: false,
        error: error.message || 'Unknown error',
        itemsCount: 0
      }
    }

    return data
    
  } catch (error) {
    console.error('Sync items error:', error)
    return {
      success: false,
      error: error.message,
      itemsCount: 0
    }
  }
}
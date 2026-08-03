/**
 * Torn API Utilities
 * Reusable error handling and API call helpers
 */

// Convert Torn API error codes to user-friendly messages
export function getTornErrorMessage(error) {
  const errorCode = error.code
  const errorMessage = error.error

  const errorMessages = {
    0: 'An unknown error occurred. Please try again.',
    1: 'API key is empty. Please enter your API key.',
    2: 'Incorrect API key format. Please check your API key and try again.',
    3: 'Invalid request type.',
    4: 'Invalid request fields.',
    5: 'Too many requests. Please wait a moment and try again.',
    6: 'Invalid ID provided.',
    7: 'Access denied. This data is private.',
    8: 'Your IP has been temporarily blocked due to too many requests. Please wait and try again.',
    9: 'The Torn API is currently disabled. Please try again later.',
    10: 'Your API key cannot be used while you are in federal jail.',
    11: 'You can only change your API key once every 60 seconds.',
    12: 'Error reading API key from database.',
    13: 'Your API key is temporarily disabled due to inactivity. Please log into Torn to reactivate it.',
    14: 'Daily API limit reached. Please try again tomorrow.',
    15: 'Temporary API error. Please try again.',
    16: 'Insufficient permissions. Your API key does not have the required access level for this request.',
    17: 'Backend error occurred. Please try again.',
    18: 'Your API key has been paused. Please unpause it in your Torn settings.'
  }

  return errorMessages[errorCode] || errorMessage || 'An error occurred with the API request.'
}

// Make a Torn API call with built-in error handling
export async function tornApiCall(url, apiKey) {
  try {
    const response = await fetch(url)
    
    if (!response.ok) {
      throw new Error('Failed to connect to Torn API')
    }

    const data = await response.json()

    if (data.error) {
      return {
        success: false,
        error: getTornErrorMessage(data.error),
        errorCode: data.error.code
      }
    }

    return {
      success: true,
      data: data
    }
  } catch (err) {
    return {
      success: false,
      error: err.message || 'Failed to connect to Torn API'
    }
  }
}
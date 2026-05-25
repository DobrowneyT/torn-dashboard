import { createClient } from '@supabase/supabase-js'
import * as sessionToken from './sessionToken'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

// `accessToken` is the supabase-js v2.45+ official hook for "I have my own
// auth system". The client invokes it on every REST / Realtime request and
// uses the returned string as the bearer token. Returning null falls back to
// the anon key — graceful degradation when no user is logged in or the mint
// endpoint is down.
//
// This is the single client. sessionToken.configure() must be called on
// login (and on app boot from cached session) so the hook can actually
// produce a token; until then, every call goes out as anon.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  accessToken: async () => (await sessionToken.get()) ?? null,
})
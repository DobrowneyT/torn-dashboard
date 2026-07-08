// Vitest runs in Node, where @supabase/realtime-js (pulled in transitively by
// src/utils/supabase.js) requires a WebSocket constructor. Node < 22 has no
// stable global WebSocket, so provide one from `ws` — tests never open real
// realtime connections; this only satisfies client construction at import time.
import ws from 'ws'

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws.WebSocket
}

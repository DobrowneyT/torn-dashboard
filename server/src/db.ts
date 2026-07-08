import pg from 'pg'

// Serve timestamps as PostgREST-style strings ('2026-07-01T00:00:00') instead
// of letting node-postgres coerce them into Date objects — the SPA was built
// against PostgREST payloads and must receive identical shapes.
pg.types.setTypeParser(1114, (v) => v.replace(' ', 'T'))         // timestamp
pg.types.setTypeParser(1184, (v) => v.replace(' ', 'T'))         // timestamptz
pg.types.setTypeParser(1082, (v) => v)                           // date
// PostgREST serializes int8/numeric as JSON numbers; match it. Torn money
// tops out well below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => Number(v))                     // int8
pg.types.setTypeParser(1700, (v) => parseFloat(v))               // numeric

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString })
}

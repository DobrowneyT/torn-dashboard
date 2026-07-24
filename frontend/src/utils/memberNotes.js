// Helpers for per-member war notes + the overdose flag (#199). Pure so they're
// unit-testable.

// Torn reports an overdose as the hospital *reason* in status.details (e.g.
// "Overdosed"), which the war-room hooks flatten onto member.status_details.
// A member is flagged OD when they're in hospital and that reason mentions it.
export function isOverdosed(member) {
  if (!member || member.status_state !== 'Hospital') return false
  const details = member.status_details
  return typeof details === 'string' && /overdos/i.test(details)
}

// Who may edit member notes: war leads + leadership/admin, never visitors.
export function canEditMemberNotes({ isWarLead, isLeadership, isAdmin, isVisitor }) {
  return Boolean((isWarLead || isLeadership || isAdmin) && !isVisitor)
}

// Turn the API's note list into a { [member_id]: note } lookup for the roster.
export function notesByMember(list) {
  const map = {}
  for (const n of list ?? []) map[String(n.member_id)] = n.note
  return map
}

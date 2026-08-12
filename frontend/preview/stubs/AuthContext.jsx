// Auth stub for the header preview.
//
// Aliased over ../contexts/AuthContext by vite.preview.config.js so the REAL
// Header and SettingsDropdown render without a backend or a session. Nothing
// here ships — the alias exists only in the preview config.
export function useAuth() {
  return {
    user: {
      id: '2250591',
      name: 'MonChoon_616',
      factionPosition: 'Leadership',
      feedbackEnabled: true,
      isVisitor: false,
      isAdmin: true,
    },
    isLeadership: true,
    isAuthenticated: true,
    logout: () => {},
  }
}

export function AuthProvider({ children }) {
  return children
}

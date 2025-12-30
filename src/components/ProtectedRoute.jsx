import { useAuth } from '../contexts/AuthContext'

export default function ProtectedRoute({ children, requireLeadership = false }) {
  const { user, isLeadership } = useAuth()

  // Check authentication
  if (!user) {
    return (
      <div className="card max-w-2xl mx-auto mt-8">
        <div className="text-center py-8">
          <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <h2 className="text-xl font-semibold mb-2">Authentication Required</h2>
          <p className="text-gray-600 dark:text-gray-400">
            Please log in to access this content
          </p>
        </div>
      </div>
    )
  }

  // Check leadership access if required
  if (requireLeadership && !isLeadership) {
    return (
      <div className="card max-w-2xl mx-auto mt-8">
        <div className="text-center py-8">
          <svg className="w-16 h-16 mx-auto mb-4 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <h2 className="text-xl font-semibold mb-2">Leadership Access Required</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            This feature is only available to faction leaders and co-leaders
          </p>
          <div className="text-sm text-gray-500 dark:text-gray-500">
            Your role: <span className="font-semibold">{user.factionPosition}</span>
          </div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
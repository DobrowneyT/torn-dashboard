import { useAuth } from '../contexts/AuthContext'
import { Lock, AlertTriangle } from 'lucide-react'

export default function ProtectedRoute({ children, requireLeadership = false }) {
  const { user, isLeadership, isAdmin } = useAuth()

  // Check authentication
  if (!user) {
    return (
      <div className="card max-w-2xl mx-auto mt-8">
        <div className="text-center py-8">
          <Lock className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <h2 className="text-xl font-semibold mb-2">Authentication Required</h2>
          <p className="text-gray-600 dark:text-gray-400">
            Please log in to access this content
          </p>
        </div>
      </div>
    )
  }

  // Check leadership access if required (admins have all leadership permissions)
  if (requireLeadership && !isLeadership && !isAdmin) {
    return (
      <div className="card max-w-2xl mx-auto mt-8">
        <div className="text-center py-8">
          <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-yellow-500" />
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
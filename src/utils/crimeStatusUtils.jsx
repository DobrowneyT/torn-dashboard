/**
 * Crime Status Display Utilities
 * Maps internal crime status to user-friendly display names
 */

/**
 * Map crime status to display label
 * @param {string} status - Internal status from database
 * @returns {string} Display-friendly status label
 */
export function getCrimeStatusLabel(status) {
  const statusMap = {
    'Successful': 'Success',
    'Success': 'Success',
    'Completed': 'Success',
    'Planning': 'Planning',
    'In Progress': 'Planning',
    'Recruiting': 'Recruiting',
    'Failure': 'Failed',
    'Failed': 'Failed'
  }
  
  return statusMap[status] || status
}

/**
 * Get status badge color
 * @param {string} status - Internal status from database
 * @returns {string} Tailwind CSS color classes
 */
export function getCrimeStatusColor(status) {
  const normalizedStatus = getCrimeStatusLabel(status)
  
  const colorMap = {
    'Success': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    'Planning': 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    'Recruiting': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    'Failed': 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
  }
  
  return colorMap[normalizedStatus] || 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400'
}

/**
 * Status Badge Component
 * @param {Object} props
 * @param {string} props.status - Crime status
 * @returns {JSX.Element}
 */
export function CrimeStatusBadge({ status }) {
  const label = getCrimeStatusLabel(status)
  const colorClass = getCrimeStatusColor(status)
  
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass}`}>
      {label}
    </span>
  )
}

/**
 * Get status icon
 * @param {string} status - Crime status
 * @returns {string} Emoji or icon
 */
export function getCrimeStatusIcon(status) {
  const normalizedStatus = getCrimeStatusLabel(status)
  
  const iconMap = {
    'Success': '✓',
    'Planning': '⏳',
    'Recruiting': '👥',
    'Failed': '✗'
  }
  
  return iconMap[normalizedStatus] || '•'
}

/**
 * Status filter options for dropdowns
 */
export const CRIME_STATUS_OPTIONS = [
  { value: 'all', label: 'All Crimes' },
  { value: 'Success', label: 'Success' },
  { value: 'Planning', label: 'Planning' },
  { value: 'Recruiting', label: 'Recruiting' },
  { value: 'Failed', label: 'Failed' }
]

/**
 * Check if crime is active (not completed or failed)
 */
export function isCrimeActive(status) {
  const normalizedStatus = getCrimeStatusLabel(status)
  return normalizedStatus === 'Planning' || normalizedStatus === 'Recruiting'
}

/**
 * Check if crime is completed
 */
export function isCrimeCompleted(status) {
  const normalizedStatus = getCrimeStatusLabel(status)
  return normalizedStatus === 'Success' || normalizedStatus === 'Failed'
}

/**
 * Get status description
 */
export function getCrimeStatusDescription(status) {
  const normalizedStatus = getCrimeStatusLabel(status)
  
  const descriptionMap = {
    'Success': 'Crime completed successfully with full rewards',
    'Planning': 'All positions filled, waiting for execution',
    'Recruiting': 'Actively recruiting members for open positions',
    'Failed': 'Crime attempted but failed, no rewards earned'
  }
  
  return descriptionMap[normalizedStatus] || ''
}
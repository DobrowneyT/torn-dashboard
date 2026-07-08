import { useState } from 'react'
import { formatCurrency } from '../utils/payoutCalculations'

export default function ImportPreviewModal({ data, onConfirm, onCancel }) {
  const [isConfirming, setIsConfirming] = useState(false)

  if (!data) return null

  const { weekStart, weekEnd, members, totalPayout, totalTime, fileType } = data

  async function handleConfirm() {
    setIsConfirming(true)
    try {
      await onConfirm()
    } finally {
      setIsConfirming(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Import Preview — {fileType} File
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Week: {weekStart} to {weekEnd} — {members.length} members — Total payout: {formatCurrency(totalPayout)}
          </p>
        </div>

        {/* Scrollable table */}
        <div className="overflow-auto flex-1 px-6 py-4">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-gray-800">
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                <th className="py-2 pr-4">Member</th>
                <th className="py-2 pr-4 text-right">Tier</th>
                <th className="py-2 pr-4 text-right">Tickets</th>
                <th className="py-2 pr-4 text-right">Penalty</th>
                <th className="py-2 pr-4 text-right">Adj. Tickets</th>
                <th className="py-2 pr-4 text-right">Time (h)</th>
                <th className="py-2 pr-4 text-right">Share %</th>
                <th className="py-2 text-right">Payout</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m, i) => (
                <tr key={i} className="border-b border-gray-100 dark:border-gray-700/50">
                  <td className="py-2 pr-4 text-gray-900 dark:text-white">
                    {m.member_name || m.name || `User ${m.member_id}`}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-300">{m.tier}</td>
                  <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-300">
                    {m.base_tickets ?? m.baseTickets ?? '-'}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-300">
                    {(m.sit_out_penalty ?? m.sitOutPenalty) != null
                      ? (m.sit_out_penalty ?? m.sitOutPenalty).toFixed(1)
                      : '-'}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-300">
                    {(m.adjusted_tickets ?? m.adjustedTickets)?.toFixed(1) ?? '-'}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-300">
                    {((m.time_spent ?? m.timeSpent ?? 0) / 3600).toFixed(1)}
                  </td>
                  <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-300">
                    {((m.share_percent ?? (m.sharePercent ? m.sharePercent * 100 : 0)) || 0).toFixed(2)}%
                  </td>
                  <td className="py-2 text-right font-medium text-gray-900 dark:text-white">
                    {formatCurrency(m.payout || 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isConfirming}
            className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isConfirming}
            className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {isConfirming ? 'Importing...' : `Import ${members.length} Members`}
          </button>
        </div>
      </div>
    </div>
  )
}

import { Component } from 'react'
import { API_MODE } from '../utils/apiClient'

// Catches render/runtime crashes inside a routed view so one broken page
// never blanks the whole app. During the multi-faction migration, pages that
// still call Supabase crash on the new stack (null client) — show what
// happened instead of a white screen.
export default class ViewErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, pathname: props.pathname }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  static getDerivedStateFromProps(props, state) {
    // Navigating away resets the boundary so the next page gets a clean try.
    if (props.pathname !== state.pathname) {
      return { error: null, pathname: props.pathname }
    }
    return null
  }

  render() {
    if (!this.state.error) return this.props.children

    const supabaseCrash = API_MODE && /reading 'from'|supabase/i.test(String(this.state.error))
    return (
      <div className="card max-w-2xl mx-auto mt-10 p-6 text-center">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-2">
          {supabaseCrash ? 'This page has not been migrated yet' : 'Something went wrong on this page'}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {supabaseCrash
            ? 'It still relies on the old Supabase backend and will come over in an upcoming migration slice. The rest of the dashboard keeps working.'
            : String(this.state.error?.message ?? this.state.error)}
        </p>
      </div>
    )
  }
}

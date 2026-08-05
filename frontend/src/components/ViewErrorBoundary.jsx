import { Component } from 'react'

// Catches render/runtime crashes inside a routed view so one broken page
// never blanks the whole app — show what happened instead of a white screen.
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

    return (
      <div className="card max-w-2xl mx-auto mt-10 p-6 text-center">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-2">
          Something went wrong on this page
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {String(this.state.error?.message ?? this.state.error)}
        </p>
      </div>
    )
  }
}

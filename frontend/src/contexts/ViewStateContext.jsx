import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'

/**
 * ViewStateContext - Persists view state across navigation AND page reloads
 *
 * Usage:
 * 1. Wrap your app with <ViewStateProvider>
 * 2. In each view component, use useViewState(viewName)
 * 3. State persists when switching views (in-memory) AND across reloads (localStorage)
 *
 * Serialization note: anything you store must be JSON-serialisable. Sets/Maps
 * won't survive — convert to arrays/objects at the persistence boundary.
 */

const STORAGE_KEY = 'torn-dashboard-view-states'

function loadInitial() {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const ViewStateContext = createContext(null)

export function ViewStateProvider({ children }) {
  // Hydrate from localStorage on first render so child useViewState() calls
  // see the persisted values immediately and can use lazy-init useState
  // to seed their local state without a flash of defaults.
  const [viewStates, setViewStates] = useState(loadInitial)

  // Persist on every change. JSON.stringify swallows undefined / functions
  // silently, which is fine — callers are expected to store plain data.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(viewStates))
    } catch {
      // Quota / private-mode failures: in-memory state still works.
    }
  }, [viewStates])

  // Get state for a specific view - memoized with useCallback
  const getViewState = useCallback((viewName) => {
    return viewStates[viewName] || {}
  }, [viewStates])

  // Update state for a specific view - memoized with useCallback
  const setViewState = useCallback((viewName, state) => {
    setViewStates(prev => ({
      ...prev,
      [viewName]: {
        ...prev[viewName],
        ...state
      }
    }))
  }, [])

  // Clear state for a specific view - memoized with useCallback
  const clearViewState = useCallback((viewName) => {
    setViewStates(prev => {
      const newStates = { ...prev }
      delete newStates[viewName]
      return newStates
    })
  }, [])

  // Clear all view states - memoized with useCallback
  const clearAllStates = useCallback(() => {
    setViewStates({})
  }, [])

  // Memoize the context value
  const value = useMemo(() => ({
    getViewState,
    setViewState,
    clearViewState,
    clearAllStates
  }), [getViewState, setViewState, clearViewState, clearAllStates])

  return (
    <ViewStateContext.Provider value={value}>
      {children}
    </ViewStateContext.Provider>
  )
}

/**
 * Custom hook to use view state
 * @param {string} viewName - Unique identifier for the view
 * @returns {[state, setState]} - Tuple of state and setState function
 * 
 * Example:
 * const [state, setState] = useViewState('crimes')
 * 
 * setState({ sortConfig: { key: 'name', direction: 'asc' } })
 */
export function useViewState(viewName) {
  const context = useContext(ViewStateContext)
  
  if (!context) {
    throw new Error('useViewState must be used within a ViewStateProvider')
  }

  const { getViewState, setViewState } = context
  
  const state = getViewState(viewName)
  
  const setState = useCallback((newState) => {
    setViewState(viewName, newState)
  }, [viewName, setViewState])

  return [state, setState]
}

/**
 * Hook to get view state context directly
 */
export function useViewStateContext() {
  const context = useContext(ViewStateContext)
  
  if (!context) {
    throw new Error('useViewStateContext must be used within a ViewStateProvider')
  }

  return context
}

/**
 * HOC to wrap a component with view state persistence
 * 
 * Example:
 * export default withViewState('crimes')(CrimesView)
 */
export function withViewState(viewName) {
  return function (Component) {
    return function ViewStateWrapper(props) {
      const [state, setState] = useViewState(viewName)
      
      return <Component {...props} viewState={state} setViewState={setState} />
    }
  }
}
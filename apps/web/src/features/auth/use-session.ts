import { useSyncExternalStore } from 'react'
import * as auth from './token-store'

/** Re-renders when the user logs in or the session ends (token-store.ts is the source of truth). */
export function useSession() {
  const loggedIn = useSyncExternalStore(auth.onSessionChange, auth.isLoggedIn)
  return { loggedIn, username: loggedIn ? auth.currentUsername() : null }
}

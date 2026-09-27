// Entry point: finish (or start) the login redirect, then render the app.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/app/app'
import { Toaster } from '@/components/ui/sonner'
import { completeLoginRedirect, isLoginCallback, login } from '@/features/auth/login-flow'
import { isLoggedIn } from '@/features/auth/token-store'
import { log } from '@/features/log/log-store'
import './index.css'

// Read before completing: a load that IS a login callback must never start another silent
// login, or a failing callback (e.g. state mismatch) would redirect forever.
const wasLoginCallback = isLoginCallback()
try {
  await completeLoginRedirect()
} catch (err) {
  log((err as Error).message)
}

const shouldTrySilentLogin = !isLoggedIn() && !wasLoginCallback
if (shouldTrySilentLogin) {
  await login({ silent: true }) // leaves the page; we come back as a login callback
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      <Toaster position="bottom-right" />
    </StrictMode>,
  )
}

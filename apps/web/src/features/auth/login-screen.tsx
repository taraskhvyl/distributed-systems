import { Button } from '@/components/ui/button'
import { login } from './login-flow'

/** Shown when there is no session (the silent SSO login found no Keycloak cookie). */
export function LoginScreen() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6 rounded-lg border p-10 text-center">
        <h1 className="font-serif text-4xl italic">mediashare</h1>
        <p className="text-muted-foreground">Share photos and files with the people you follow.</p>
        <Button className="w-full" onClick={() => login()}>
          Log in
        </Button>
        <p className="text-xs text-muted-foreground">You sign in on Keycloak (auth.localhost) and come back here.</p>
      </div>
    </main>
  )
}

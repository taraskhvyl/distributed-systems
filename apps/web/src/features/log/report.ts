import { toast } from 'sonner'
import { log } from './log-store'

/** A finished action the user should notice: a toast now, a log line to read later. */
export function reportSuccess(message: string) {
  log(message)
  toast.success(message)
}

/** Every failed action ends here: a toast to notice it, a log line to read it later. */
export function reportError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  log(message)
  toast.error(message)
}

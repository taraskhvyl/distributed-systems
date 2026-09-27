import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { keepLiveEventsConnected } from './live-events'
import { log } from '@/features/log/log-store'

interface LiveEventHandlers {
  /** Events are about your own files (processing done, someone liked one). */
  onFileEvent: () => void
  /** After a REconnect: events sent while disconnected are not replayed, so resync. */
  onReconnected: () => void
}

/** One SSE connection while mounted; closed on unmount (and StrictMode's test unmount). */
export function useLiveEvents(handlers: LiveEventHandlers) {
  // A ref, so the connection isn't torn down whenever the parent re-renders new callbacks.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const controller = new AbortController()
    // The first connect needs no resync: the lists are loaded on mount anyway.
    let isFirstConnect = true
    keepLiveEventsConnected({
      signal: controller.signal,
      onConnected: () => {
        if (!isFirstConnect) handlersRef.current.onReconnected()
        isFirstConnect = false
      },
      onEvent: (name, data) => {
        log(`event ${name}: ${data.message ?? data.fileId}`)
        console.info(`[trace] received ${name} traceId=${data.traceId}`)
        if (typeof data.message === 'string') toast(data.message)
        handlersRef.current.onFileEvent()
      },
    })
    return () => controller.abort()
  }, [])
}

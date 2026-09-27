import { useSyncExternalStore } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { getLogLines, subscribeToLog } from './log-store'

interface LogSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The client-side log (auth steps, live events, errors). Trace ids are in the DevTools console. */
export function LogSheet({ open, onOpenChange }: LogSheetProps) {
  const lines = useSyncExternalStore(subscribeToLog, getLogLines)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Log</SheetTitle>
          <SheetDescription>Newest first. Per-request trace ids are in the DevTools console.</SheetDescription>
        </SheetHeader>
        <pre role="log" className="flex-1 overflow-auto px-4 pb-4 font-mono text-xs whitespace-pre-wrap">
          {lines.join('\n')}
        </pre>
      </SheetContent>
    </Sheet>
  )
}

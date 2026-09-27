import { useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { reportError } from '@/features/log/report'

const PERCENT = 100

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpload: (file: File, onProgress: (fraction: number) => void) => Promise<void>
}

/** "Create new post": pick a file; it goes straight to S3, then processing starts. */
export function UploadDialog({ open, onOpenChange, onUpload }: UploadDialogProps) {
  const [progress, setProgress] = useState<number | null>(null)
  const isUploading = progress !== null

  async function uploadSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return
    setProgress(0)
    try {
      await onUpload(file, setProgress)
      onOpenChange(false)
    } catch (err) {
      reportError(err)
    } finally {
      setProgress(null)
      input.value = ''
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !isUploading && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create new post</DialogTitle>
          <DialogDescription>Images get a thumbnail; every file is scanned before anyone else sees it.</DialogDescription>
        </DialogHeader>

        {isUploading ? (
          <div className="space-y-2 py-8">
            <Progress value={progress * PERCENT} />
            <p className="text-center text-sm text-muted-foreground">Uploading…</p>
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed py-12 text-muted-foreground hover:bg-muted">
            <ImagePlus className="size-12" aria-hidden />
            <span className="text-sm font-medium text-primary">Select from computer</span>
            <input type="file" accept="image/*,text/*,application/pdf" className="sr-only" onChange={uploadSelected} />
          </label>
        )}
      </DialogContent>
    </Dialog>
  )
}

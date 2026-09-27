import { Download, Heart } from 'lucide-react'
import { FileThumbnail } from '@/components/file-thumbnail'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { FileStatusBadge } from './file-status-badge'
import type { OwnFile } from './files-api'

const BYTES_PER_KB = 1024

interface FileDialogProps {
  file: OwnFile | null
  onClose: () => void
  onToggleVisibility: (file: OwnFile) => void
  onDownload: (fileId: string) => void
}

/** Details of one of your files: status, visibility switch, download. */
export function FileDialog({ file, onClose, onToggleVisibility, onDownload }: FileDialogProps) {
  if (!file) return null
  const isPublic = file.visibility === 'public'
  const isReady = file.status === 'ready'
  // Public but not ready yet: allowed, it just isn't Published (visible to others) until ready.
  const waitingToPublish = isPublic && !isReady

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="break-all">{file.filename}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <FileStatusBadge status={file.status} />
            <span>{(file.sizeBytes / BYTES_PER_KB).toFixed(1)} KB</span>
            <span className="flex items-center gap-1">
              <Heart className="size-3.5" /> {file.likeCount}
            </span>
          </DialogDescription>
        </DialogHeader>

        <FileThumbnail thumbnailUrl={file.thumbnailUrl} filename={file.filename} className="rounded-md" />

        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">Public</span>
            <span className="block text-xs text-muted-foreground">
              {visibilityHint(isPublic, waitingToPublish)}
            </span>
          </span>
          <Switch checked={isPublic} onCheckedChange={() => onToggleVisibility(file)} />
        </label>

        <Button variant="secondary" disabled={!isReady} onClick={() => onDownload(file.id)}>
          <Download /> Download
        </Button>
      </DialogContent>
    </Dialog>
  )
}

function visibilityHint(isPublic: boolean, waitingToPublish: boolean) {
  if (!isPublic) return 'Only you can see it.'
  if (waitingToPublish) return 'Will appear in feeds once processing is done.'
  return 'Visible in your followers’ feeds.'
}

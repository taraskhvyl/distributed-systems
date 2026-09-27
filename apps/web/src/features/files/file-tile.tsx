import { Heart, Lock } from 'lucide-react'
import { FileThumbnail } from '@/components/file-thumbnail'
import { FileStatusBadge } from './file-status-badge'
import type { OwnFile } from './files-api'

/** One square in the profile grid. Hover shows the like count, like on Instagram. */
export function FileTile({ file, onOpen }: { file: OwnFile; onOpen: (file: OwnFile) => void }) {
  const isReady = file.status === 'ready'
  return (
    <button
      type="button"
      onClick={() => onOpen(file)}
      aria-label={`Open ${file.filename}`}
      className="group relative block overflow-hidden bg-muted"
    >
      <FileThumbnail thumbnailUrl={file.thumbnailUrl} filename={file.filename} />

      <div className="absolute inset-0 hidden items-center justify-center gap-1 bg-black/40 font-semibold text-white group-hover:flex">
        <Heart className="size-5 fill-white" /> {file.likeCount}
      </div>
      {!isReady && (
        <div className="absolute top-2 left-2">
          <FileStatusBadge status={file.status} />
        </div>
      )}
      {file.visibility === 'private' && (
        <Lock className="absolute top-2 right-2 size-4 text-white drop-shadow" aria-label="Private" />
      )}
    </button>
  )
}

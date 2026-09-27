import { Download, Heart } from 'lucide-react'
import { FileThumbnail } from '@/components/file-thumbnail'
import { Button } from '@/components/ui/button'
import { cn } from '@/components/ui/utils'
import { UserAvatar } from '@/components/user-avatar'
import type { FeedFile } from './feed-api'

interface PostCardProps {
  file: FeedFile
  onToggleLike: (file: FeedFile) => void
  onDownload: (fileId: string) => void
}

/** One Published file in the Feed, Instagram-style: header, square media, actions, caption. */
export function PostCard({ file, onToggleLike, onDownload }: PostCardProps) {
  // Double-tap only likes, never unlikes (as on Instagram): a second double-tap is harmless.
  const likeOnDoubleClick = () => {
    if (!file.likedByMe) onToggleLike(file)
  }

  return (
    <article className="border-b pb-4">
      <header className="flex items-center gap-3 py-3">
        <UserAvatar username={file.ownerUsername} />
        <span className="text-sm font-semibold">{file.ownerUsername}</span>
      </header>

      <div onDoubleClick={likeOnDoubleClick} className="cursor-pointer overflow-hidden rounded-sm border select-none">
        <FileThumbnail thumbnailUrl={file.thumbnailUrl} filename={file.filename} />
      </div>

      <div className="flex items-center gap-1 pt-2">
        <Button
          variant="ghost"
          size="icon"
          aria-pressed={file.likedByMe}
          aria-label={`${file.likedByMe ? 'Unlike' : 'Like'} ${file.filename}`}
          onClick={() => onToggleLike(file)}
        >
          <Heart className={cn('size-6', file.likedByMe && 'fill-like text-like')} />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`Download ${file.filename}`} onClick={() => onDownload(file.id)}>
          <Download className="size-6" />
        </Button>
      </div>

      <p className="text-sm font-semibold">{likesLabel(file.likeCount)}</p>
      <p className="text-sm">
        <span className="font-semibold">{file.ownerUsername}</span> {file.filename}
      </p>
    </article>
  )
}

function likesLabel(count: number) {
  return count === 1 ? '1 like' : `${count} likes`
}

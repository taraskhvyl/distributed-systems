import type { FeedFile } from './feed-api'
import { PostCard } from './post-card'

interface FeedPageProps {
  feed: FeedFile[]
  onToggleLike: (file: FeedFile) => void
  onDownload: (fileId: string) => void
}

export function FeedPage({ feed, onToggleLike, onDownload }: FeedPageProps) {
  if (feed.length === 0) {
    return (
      <p className="py-20 text-center text-muted-foreground">
        Nothing here yet. Follow someone who has public files.
      </p>
    )
  }
  return (
    <div className="mx-auto max-w-[470px] space-y-4">
      {feed.map((file) => (
        <PostCard key={file.id} file={file} onToggleLike={onToggleLike} onDownload={onDownload} />
      ))}
    </div>
  )
}

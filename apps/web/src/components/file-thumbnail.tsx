import { FileText } from 'lucide-react'
import { cn } from '@/components/ui/utils'

interface FileThumbnailProps {
  thumbnailUrl: string | null
  filename: string
  className?: string
}

/**
 * A square preview. Only images get a thumbnail from the processor; other files (text, PDF)
 * and not-yet-processed ones show an icon with the filename instead.
 */
export function FileThumbnail({ thumbnailUrl, filename, className }: FileThumbnailProps) {
  if (thumbnailUrl) {
    return <img src={thumbnailUrl} alt={filename} className={cn('aspect-square w-full object-cover', className)} />
  }
  return (
    <div className={cn('flex aspect-square w-full flex-col items-center justify-center gap-2 bg-muted p-4 text-muted-foreground', className)}>
      <FileText className="size-8" aria-hidden />
      <span className="line-clamp-2 text-center text-xs break-all">{filename}</span>
    </div>
  )
}

import { Badge } from '@/components/ui/badge'
import type { OwnFile } from './files-api'

const STATUS_VARIANT: Record<OwnFile['status'], 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  uploaded: 'outline',
  processing: 'secondary',
  ready: 'secondary',
  infected: 'destructive',
  failed: 'destructive',
}

export function FileStatusBadge({ status }: { status: OwnFile['status'] }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
}

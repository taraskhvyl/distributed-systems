// The api's Feed and like endpoints. HTTP only; state lives in use-feed.ts.
import { request } from '@/adapters/http'

/** Someone else's Published file, as it appears in your Feed. */
export interface FeedFile {
  id: string
  ownerUsername: string
  filename: string
  contentType: string
  sizeBytes: number
  thumbnailUrl: string | null
  likeCount: number
  likedByMe: boolean
  createdAt: string
}

export async function getFeed() {
  const { files } = await request<{ files: FeedFile[] }>('GET', '/feed')
  return files
}

// Like is a state, so the api uses idempotent PUT (on) / DELETE (off).
export async function setLiked(fileId: string, liked: boolean) {
  await request(liked ? 'PUT' : 'DELETE', `/files/${fileId}/like`)
}

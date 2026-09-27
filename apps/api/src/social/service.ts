import { DomainError, fileNotFound } from '../errors.js'
import { FileView } from '../files/repository.js'
import { getUser } from '../users/service.js'
import { decodeFeedCursor, encodeFeedCursor } from './feed-cursor.js'
import * as repository from './repository.js'
import { Liker } from './repository.js'

export interface FeedPage {
  files: FileView[]
  nextCursor: string | null
}

export async function follow(followerId: string, username: string): Promise<void> {
  const followee = await getUser(username)
  // The follows_not_self CHECK constraint is the real guarantee; this gives a clear 400.
  if (followee.id === followerId) {
    throw new DomainError('bad_request', 'You cannot follow yourself')
  }
  await repository.insertFollow(followerId, followee.id)
}

export async function unfollow(followerId: string, username: string): Promise<void> {
  const followee = await getUser(username)
  await repository.deleteFollow(followerId, followee.id)
}

export async function like(fileId: string, liker: Liker): Promise<{ likeCount: number }> {
  const result = await repository.insertLike(fileId, liker)
  if (!result) throw fileNotFound()
  return result
}

export async function unlike(fileId: string, userId: string): Promise<{ likeCount: number }> {
  const result = await repository.deleteLike(fileId, userId)
  if (!result) throw fileNotFound()
  return result
}

export async function readFeedPage(viewerId: string, cursor: string | undefined, limit: number): Promise<FeedPage> {
  const after = cursor ? decodeFeedCursor(cursor) : null
  if (cursor && !after) throw new DomainError('bad_request', 'Invalid cursor')

  const files = await repository.readFeed(viewerId, after, limit)
  const last = files.at(-1)
  const hasMore = files.length === limit && last !== undefined
  const nextCursor = hasMore ? encodeFeedCursor({ createdAt: last.created_at_exact, id: last.id }) : null
  return { files, nextCursor }
}

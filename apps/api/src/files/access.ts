import { thumbnailPublicUrl } from '../adapters/s3.js'
import { FileRow, FileView } from './repository.js'

// Who sees what of a file. The row-level gates (may you read it at all?) are SQL in the
// repository; this module decides which fields each viewer gets.

const ADMIN_ROLE = 'admin'

export interface Viewer {
  id: string
  isAdmin: boolean
}

export function viewerOf(user: { id: string; roles: string[] }): Viewer {
  return { id: user.id, isAdmin: user.roles.includes(ADMIN_ROLE) }
}

/** Full view for the owner (and admins): includes processing status and visibility. */
export function serializeFile(row: FileRow) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    visibility: row.visibility,
    likeCount: row.like_count,
    thumbnailUrl: thumbnailUrl(row),
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Narrow view for everyone else. A separate function (not a filtered copy of the full
 * view) so a new internal column can't leak to other users by default.
 */
export function serializePublicFile(view: FileView) {
  return {
    id: view.id,
    ownerUsername: view.owner_username,
    filename: view.filename,
    contentType: view.content_type,
    sizeBytes: Number(view.size_bytes),
    thumbnailUrl: thumbnailUrl(view),
    likeCount: view.like_count,
    likedByMe: view.liked_by_me,
    createdAt: view.created_at,
  }
}

export function serializeFileFor(view: FileView, viewer: Viewer) {
  const seesFullView = view.owner_id === viewer.id || viewer.isAdmin
  return seesFullView ? serializeFile(view) : serializePublicFile(view)
}

function thumbnailUrl(row: FileRow): string | null {
  return row.thumbnail_key ? thumbnailPublicUrl(row.thumbnail_key) : null
}

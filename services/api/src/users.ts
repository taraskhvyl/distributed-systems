import { FastifyRequest } from 'fastify'
import { pool } from './db.js'

/**
 * Repository for `users`: the api's local read model of Keycloak identities (ADR 0002).
 * Keycloak stays the source of truth; this copy exists so follows and feeds can join on
 * usernames without calling Keycloak per request.
 */

const USER_SEARCH_LIMIT = 20

export interface UserRow {
  id: string
  username: string
}

export interface UserProfile {
  username: string
  followers: number
  following: number
  followedByMe: boolean
}

/**
 * Hook: just-in-time upsert of the caller, so every authenticated user has a row before any
 * handler runs (files.owner_id and follows reference it). The WHERE skips the write when
 * nothing changed, so the common case is a lookup, not a new row version.
 */
export async function rememberUser(req: FastifyRequest): Promise<void> {
  const { id, username } = req.user!
  await pool.query(
    `INSERT INTO users (id, username) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username
     WHERE users.username IS DISTINCT FROM EXCLUDED.username`,
    [id, username],
  )
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>('SELECT id, username FROM users WHERE username = $1', [username])
  return rows[0] ?? null
}

/** Prefix search, excluding the viewer. Only finds users who have logged in at least once. */
export async function searchUsers(viewerId: string, prefix: string) {
  const { rows } = await pool.query<{ username: string; following: boolean }>(
    `SELECT u.username,
            EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id) AS following
     FROM users u
     WHERE u.username LIKE $2 AND u.id <> $1
     ORDER BY u.username
     LIMIT $3`,
    [viewerId, `${escapeLikePattern(prefix)}%`, USER_SEARCH_LIMIT],
  )
  return rows
}

export async function getProfile(viewerId: string, user: UserRow): Promise<UserProfile> {
  const { rows } = await pool.query<{ followers: number; following: number; followed_by_me: boolean }>(
    `SELECT (SELECT count(*)::int FROM follows WHERE followee_id = $2) AS followers,
            (SELECT count(*)::int FROM follows WHERE follower_id = $2) AS following,
            EXISTS (SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2) AS followed_by_me`,
    [viewerId, user.id],
  )
  const counts = rows[0]
  return {
    username: user.username,
    followers: counts.followers,
    following: counts.following,
    followedByMe: counts.followed_by_me,
  }
}

/** `%` and `_` are LIKE wildcards; a user typing them means the literal character. */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&')
}

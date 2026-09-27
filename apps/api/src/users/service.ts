import { userNotFound } from '../errors.js'
import * as repository from './repository.js'
import { UserRow } from './repository.js'

export interface UserProfile {
  username: string
  followers: number
  following: number
  followedByMe: boolean
}

/** Mirror the caller into the local read model (ADR 0002). */
export async function rememberCaller(caller: UserRow): Promise<void> {
  await repository.upsertUser(caller)
}

/** Usernames are stored lowercase by Keycloak, so the search is lowercased too. */
export async function searchUsers(viewerId: string, query: string) {
  return repository.searchUsers(viewerId, query.toLowerCase())
}

export async function getUser(username: string): Promise<UserRow> {
  const user = await repository.findUserByUsername(username)
  if (!user) throw userNotFound()
  return user
}

export async function getProfile(viewerId: string, username: string): Promise<UserProfile> {
  const user = await getUser(username)
  const counts = await repository.countFollows(viewerId, user.id)
  return { username: user.username, ...counts }
}

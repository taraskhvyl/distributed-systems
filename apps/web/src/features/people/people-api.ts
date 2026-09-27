// The api's /users endpoints: search, profiles, follows. HTTP only.
import { request } from '@/adapters/http'

export interface UserSummary {
  username: string
  following: boolean
}

export interface UserProfile {
  username: string
  followers: number
  following: number
  followedByMe: boolean
}

export async function searchUsers(prefix: string) {
  const { users } = await request<{ users: UserSummary[] }>('GET', `/users?q=${encodeURIComponent(prefix)}`)
  return users
}

export async function getProfile(username: string) {
  const { user } = await request<{ user: UserProfile }>('GET', `/users/${encodeURIComponent(username)}`)
  return user
}

// Follow is a state, so the api uses idempotent PUT (on) / DELETE (off).
export async function setFollowing(username: string, following: boolean) {
  await request(following ? 'PUT' : 'DELETE', `/users/${encodeURIComponent(username)}/follow`)
}

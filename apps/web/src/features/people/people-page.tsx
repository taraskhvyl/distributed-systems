import { useState } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UserAvatar } from '@/components/user-avatar'
import { reportError, reportSuccess } from '@/features/log/report'
import { searchUsers, setFollowing, type UserSummary } from './people-api'

/** Find people by username prefix and follow them. `onFollowChanged` lets the Feed refetch. */
export function PeoplePage({ onFollowChanged }: { onFollowChanged: () => void }) {
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<UserSummary[]>([])

  async function runSearch() {
    const prefix = query.trim()
    if (!prefix) return
    setUsers(await searchUsers(prefix))
  }

  async function toggleFollow(user: UserSummary) {
    try {
      await setFollowing(user.username, !user.following)
      reportSuccess(`${user.following ? 'Unfollowed' : 'Following'} @${user.username}`)
      onFollowChanged()
      await runSearch() // re-render from the server's answer, not a local flip
    } catch (err) {
      reportError(err)
    }
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault()
    runSearch().catch(reportError)
  }

  return (
    <div className="mx-auto max-w-[470px] space-y-4">
      <h1 className="text-2xl font-semibold">Search</h1>
      <form onSubmit={submitSearch} className="relative">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by username"
          aria-label="Username prefix"
          className="pl-9"
        />
      </form>

      <ul className="divide-y">
        {users.map((user) => (
          <li key={user.username} className="flex items-center gap-3 py-3">
            <UserAvatar username={user.username} className="size-11" />
            <span className="flex-1 text-sm font-semibold">{user.username}</span>
            <Button size="sm" variant={user.following ? 'secondary' : 'default'} onClick={() => toggleFollow(user)}>
              {user.following ? 'Following' : 'Follow'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

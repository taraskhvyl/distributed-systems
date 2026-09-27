// State and actions for the Feed. Same rule as use-own-files: refetch after every action.
import { useCallback, useEffect, useState } from 'react'
import { reportError } from '@/features/log/report'
import * as feedApi from './feed-api'

export function useFeed() {
  const [feed, setFeed] = useState<feedApi.FeedFile[]>([])

  const refresh = useCallback(() => feedApi.getFeed().then(setFeed).catch(reportError), [])
  useEffect(() => {
    refresh()
  }, [refresh])

  async function toggleLike(file: feedApi.FeedFile) {
    try {
      await feedApi.setLiked(file.id, !file.likedByMe)
      await refresh()
    } catch (err) {
      reportError(err)
    }
  }

  return { feed, refresh, toggleLike }
}

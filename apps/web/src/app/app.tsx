// Composition: picks the page and wires features to each other (a follow refreshes the
// Feed, a live event refreshes your files). Features never import each other's hooks.
import { useState } from 'react'
import { LoginScreen } from '@/features/auth/login-screen'
import { logout } from '@/features/auth/login-flow'
import { useSession } from '@/features/auth/use-session'
import { FeedPage } from '@/features/feed/feed-page'
import { useFeed } from '@/features/feed/use-feed'
import { downloadFile } from '@/features/files/download-file'
import { ProfilePage } from '@/features/files/profile-page'
import { UploadDialog } from '@/features/files/upload-dialog'
import { useOwnFiles } from '@/features/files/use-own-files'
import { useLiveEvents } from '@/features/live-events/use-live-events'
import { LogSheet } from '@/features/log/log-sheet'
import { PeoplePage } from '@/features/people/people-page'
import { AppShell } from './app-shell'
import type { PageId } from './pages'

export function App() {
  const { loggedIn, username } = useSession()
  if (!loggedIn || !username) return <LoginScreen />
  return <LoggedInApp username={username} />
}

function LoggedInApp({ username }: { username: string }) {
  const [page, setPage] = useState<PageId>('feed')
  const [isUploadOpen, setUploadOpen] = useState(false)
  const [isLogOpen, setLogOpen] = useState(false)
  const ownFiles = useOwnFiles()
  const feed = useFeed()

  useLiveEvents({
    onFileEvent: ownFiles.refresh,
    onReconnected: () => {
      ownFiles.refresh()
      feed.refresh()
    },
  })

  return (
    <AppShell
      page={page}
      onNavigate={setPage}
      onCreate={() => setUploadOpen(true)}
      onOpenLog={() => setLogOpen(true)}
      onLogout={logout}
    >
      {page === 'feed' && <FeedPage feed={feed.feed} onToggleLike={feed.toggleLike} onDownload={downloadFile} />}
      {page === 'people' && <PeoplePage onFollowChanged={feed.refresh} />}
      {page === 'profile' && (
        <ProfilePage
          username={username}
          files={ownFiles.files}
          onToggleVisibility={ownFiles.toggleVisibility}
          onDownload={downloadFile}
        />
      )}

      <UploadDialog open={isUploadOpen} onOpenChange={setUploadOpen} onUpload={ownFiles.upload} />
      <LogSheet open={isLogOpen} onOpenChange={setLogOpen} />
    </AppShell>
  )
}

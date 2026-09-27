import { useEffect, useState } from 'react'
import { UserAvatar } from '@/components/user-avatar'
import { reportError } from '@/features/log/report'
import { getProfile, type UserProfile } from '@/features/people/people-api'
import { FileDialog } from './file-dialog'
import { FileTile } from './file-tile'
import type { OwnFile } from './files-api'

interface ProfilePageProps {
  username: string
  files: OwnFile[]
  onToggleVisibility: (file: OwnFile) => void
  onDownload: (fileId: string) => void
}

/** Your profile: follower counts and a grid of your files (all of them, private included). */
export function ProfilePage({ username, files, onToggleVisibility, onDownload }: ProfilePageProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  // Store the id, not the file: the list is refetched after each action, and the dialog
  // must show the fresh copy (e.g. the new visibility), not a stale snapshot.
  const [openFileId, setOpenFileId] = useState<string | null>(null)
  const openFile = files.find((file) => file.id === openFileId) ?? null

  useEffect(() => {
    getProfile(username).then(setProfile).catch(reportError)
  }, [username])

  return (
    <div className="mx-auto max-w-[935px]">
      <header className="flex items-center gap-8 px-4 py-8 md:gap-16 md:px-12">
        <UserAvatar username={username} className="size-20 text-3xl md:size-36 md:text-5xl" />
        <div className="space-y-4">
          <h1 className="text-xl">{username}</h1>
          <ul className="flex gap-6 text-sm md:gap-10">
            <Stat value={files.length} label="posts" />
            <Stat value={profile?.followers} label="followers" />
            <Stat value={profile?.following} label="following" />
          </ul>
        </div>
      </header>

      {files.length === 0 ? (
        <p className="border-t py-20 text-center text-muted-foreground">No posts yet. Use Create to upload one.</p>
      ) : (
        <div className="grid grid-cols-3 gap-1 border-t pt-1">
          {files.map((file) => (
            <FileTile key={file.id} file={file} onOpen={(clicked) => setOpenFileId(clicked.id)} />
          ))}
        </div>
      )}

      <FileDialog
        file={openFile}
        onClose={() => setOpenFileId(null)}
        onToggleVisibility={onToggleVisibility}
        onDownload={onDownload}
      />
    </div>
  )
}

function Stat({ value, label }: { value: number | undefined; label: string }) {
  return (
    <li>
      <span className="font-semibold">{value ?? '–'}</span> {label}
    </li>
  )
}

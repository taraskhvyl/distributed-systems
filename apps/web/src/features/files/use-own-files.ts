// State and actions for your own files. No optimistic updates: every action waits for the
// api, then refetches, so the page never shows a state the server rejected (e.g. a 429).
import { useCallback, useEffect, useState } from 'react'
import { reportError, reportSuccess } from '@/features/log/report'
import * as filesApi from './files-api'

export function useOwnFiles() {
  const [files, setFiles] = useState<filesApi.OwnFile[]>([])

  const refresh = useCallback(() => filesApi.listFiles().then(setFiles).catch(reportError), [])
  useEffect(() => {
    refresh()
  }, [refresh])

  async function toggleVisibility(file: filesApi.OwnFile) {
    const visibility = file.visibility === 'public' ? 'private' : 'public'
    try {
      await filesApi.setVisibility(file.id, visibility)
      reportSuccess(`${file.filename} is now ${visibility}`)
      await refresh()
    } catch (err) {
      reportError(err)
    }
  }

  /** Throws on failure: the upload dialog shows the error and stays open. */
  async function upload(file: File, onProgress: (fraction: number) => void) {
    await filesApi.uploadFile(file, onProgress)
    reportSuccess(`Uploaded ${file.name}, processing started`)
    await refresh()
  }

  return { files, refresh, toggleVisibility, upload }
}

// Entry point: wires auth, api, live events and UI together.
import * as api from './api.js'
import * as auth from './auth.js'
import { keepLiveEventsConnected } from './live-events.js'
import { log } from './log.js'
import * as ui from './ui.js'

const reportError = (err) => log(err.message)

async function refreshFileList() {
  const files = await api.listFiles()
  ui.renderFiles(files, { onDownload: downloadFile })
}

async function downloadFile(fileId) {
  try {
    location.assign(await api.getDownloadUrl(fileId))
  } catch (err) {
    reportError(err)
  }
}

async function uploadSelectedFile(event) {
  const input = event.target
  const file = input.files[0]
  if (!file) return
  try {
    await api.uploadFile(file, ui.renderUploadProgress)
    log(`uploaded ${file.name}, processing started`)
    await refreshFileList()
  } catch (err) {
    reportError(err)
  } finally {
    input.value = ''
  }
}

function renderSession() {
  ui.renderSession({ loggedIn: auth.isLoggedIn(), username: auth.currentUsername() })
}

function startLoggedInView() {
  // The list must load even if the notifier is down, so it doesn't wait for live events.
  refreshFileList().catch(reportError)
  keepLiveEventsConnected({
    onConnected: () => refreshFileList().catch(reportError),
    onEvent: (name, data) => {
      log(`event ${name}: ${data.message ?? data.fileId}`)
      refreshFileList().catch(reportError)
    },
  })
}

document.getElementById('login').onclick = () => auth.login()
document.getElementById('logout').onclick = () => auth.logout()
document.getElementById('refresh').onclick = () => refreshFileList().catch(reportError)
document.getElementById('file').onchange = uploadSelectedFile
auth.onSessionChange(renderSession)

try {
  await auth.completeLoginRedirect()
} catch (err) {
  reportError(err)
}
renderSession()
if (auth.isLoggedIn()) startLoggedInView()

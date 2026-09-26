// Entry point: wires auth, api, live events and UI together.
// Every click waits for the server's answer before re-rendering (no optimistic updates),
// so the page never shows a state the server rejected (e.g. a 429 from the rate limiter).
import * as api from './api.js'
import * as auth from './auth.js'
import { keepLiveEventsConnected } from './live-events.js'
import { log } from './log.js'
import * as ui from './ui.js'

const reportError = (err) => log(err.message)

async function refreshFileList() {
  const files = await api.listFiles()
  ui.renderFiles(files, { onDownload: downloadFile, onToggleVisibility: toggleVisibility })
}

async function refreshFeed() {
  const files = await api.getFeed()
  ui.renderFeed(files, { onDownload: downloadFile, onToggleLike: toggleLike })
}

async function refreshUserSearch() {
  const query = document.getElementById('user-query').value.trim()
  if (!query) return
  const users = await api.searchUsers(query)
  ui.renderUserSearch(users, { onToggleFollow: toggleFollow })
}

async function downloadFile(fileId) {
  try {
    location.assign(await api.getDownloadUrl(fileId))
  } catch (err) {
    reportError(err)
  }
}

async function toggleVisibility(file) {
  const visibility = file.visibility === 'public' ? 'private' : 'public'
  try {
    await api.setVisibility(file.id, visibility)
    log(`${file.filename} is now ${visibility}`)
    await refreshFileList()
  } catch (err) {
    reportError(err)
  }
}

async function toggleLike(file) {
  try {
    await api.setLiked(file.id, !file.likedByMe)
    await refreshFeed()
  } catch (err) {
    reportError(err)
  }
}

async function toggleFollow(user) {
  try {
    await api.setFollowing(user.username, !user.following)
    log(`${user.following ? 'unfollowed' : 'following'} @${user.username}`)
    await Promise.all([refreshUserSearch(), refreshFeed()])
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

function refreshAll() {
  refreshFileList().catch(reportError)
  refreshFeed().catch(reportError)
}

function renderSession() {
  ui.renderSession({ loggedIn: auth.isLoggedIn(), username: auth.currentUsername() })
}

function startLoggedInView() {
  // The lists must load even if the notifier is down, so they don't wait for live events.
  refreshAll()
  let isFirstConnect = true
  keepLiveEventsConnected({
    // After a REconnect, resync: events sent while we were disconnected are not replayed.
    // The first connect needs no resync, the lists were just loaded above.
    onConnected: () => {
      if (!isFirstConnect) refreshAll()
      isFirstConnect = false
    },
    onEvent: (name, data) => {
      log(`event ${name}: ${data.message ?? data.fileId}`)
      console.info(`[trace] received ${name} traceId=${data.traceId}`)
      if (data.message) ui.showToast(data.message)
      // Events are about your own files (processing done, someone liked one).
      refreshFileList().catch(reportError)
    },
  })
}

ui.setupTabs()
document.getElementById('login').onclick = () => auth.login()
document.getElementById('logout').onclick = () => auth.logout()
document.getElementById('refresh').onclick = refreshAll
document.getElementById('file').onchange = uploadSelectedFile
document.getElementById('user-search').onsubmit = (event) => {
  event.preventDefault()
  refreshUserSearch().catch(reportError)
}
auth.onSessionChange(renderSession)

// Read before completing: a load that IS a login callback must never start another silent
// login, or a failing callback (e.g. state mismatch) would redirect forever.
const isLoginCallback = auth.isLoginCallback()
try {
  await auth.completeLoginRedirect()
} catch (err) {
  reportError(err)
}

const shouldTrySilentLogin = !auth.isLoggedIn() && !isLoginCallback
if (shouldTrySilentLogin) {
  await auth.login({ silent: true }) // leaves the page; we come back as a login callback
} else {
  renderSession()
  if (auth.isLoggedIn()) startLoggedInView()
}

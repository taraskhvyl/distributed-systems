// DOM rendering only. Uses textContent/DOM nodes, never innerHTML: filenames are user input.
// Buttons only report clicks; main.js calls the api and re-renders from the server's answer.

const BYTES_PER_KB = 1024
const TOAST_VISIBLE_MS = 8000

const byId = (id) => document.getElementById(id)

export function renderSession({ loggedIn, username }) {
  byId('login').hidden = loggedIn
  byId('logout').hidden = !loggedIn
  byId('app').hidden = !loggedIn
  byId('who').textContent = username ?? ''
}

/** Tabs: clicking a tab shows its panel (named in data-panel) and hides the others. */
export function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')]
  for (const tab of tabs) {
    tab.onclick = () => {
      for (const other of tabs) {
        const isSelected = other === tab
        other.setAttribute('aria-selected', String(isSelected))
        byId(other.dataset.panel).hidden = !isSelected
      }
    }
  }
}

/** A short-lived popup for live events, so they're noticed without opening the log. */
export function showToast(message) {
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = message
  byId('toasts').append(toast)
  setTimeout(() => toast.remove(), TOAST_VISIBLE_MS)
}

export function renderUploadProgress(fraction) {
  const bar = byId('progress')
  bar.hidden = false
  bar.value = fraction
}

/** Your own files: full view, with the visibility toggle. */
export function renderFiles(files, { onDownload, onToggleVisibility }) {
  byId('files').replaceChildren(...files.map((file) => ownFileRow(file, onDownload, onToggleVisibility)))
}

/** Published files of the people you follow, with the like button. */
export function renderFeed(files, { onDownload, onToggleLike }) {
  byId('feed').replaceChildren(...files.map((file) => feedCard(file, onDownload, onToggleLike)))
  byId('feed-empty').hidden = files.length > 0
}

export function renderUserSearch(users, { onToggleFollow }) {
  byId('users').replaceChildren(...users.map((user) => userRow(user, onToggleFollow)))
}

function ownFileRow(file, onDownload, onToggleVisibility) {
  const isPublic = file.visibility === 'public'
  const visibilityButton = button(isPublic ? 'Public' : 'Private', () => onToggleVisibility(file))
  // Public but not ready yet: allowed, it just isn't Published (visible to others) until ready.
  const waitingToPublish = isPublic && file.status !== 'ready'
  visibilityButton.title = waitingToPublish ? 'Public: will appear in feeds when ready' : 'Click to change'

  const cells = [
    thumbnail(file),
    file.filename,
    statusBadge(file.status),
    visibilityButton,
    `♥ ${file.likeCount}`,
    sizeKb(file),
    downloadButton(file, onDownload, file.status === 'ready'),
  ]
  return tableRow(cells)
}

function feedCard(file, onDownload, onToggleLike) {
  const likeLabel = `${file.likedByMe ? '♥' : '♡'} ${file.likeCount}`
  const likeButton = button(likeLabel, () => onToggleLike(file))
  likeButton.className = 'like'
  likeButton.setAttribute('aria-pressed', String(file.likedByMe))
  likeButton.setAttribute('aria-label', `${file.likedByMe ? 'Unlike' : 'Like'} ${file.filename}`)

  const body = element('div', 'card-body', [
    element('span', 'card-title', [file.filename]),
    element('span', 'muted', [`@${file.ownerUsername}`]),
  ])
  const actions = element('div', 'card-actions', [likeButton, downloadButton(file, onDownload, true)])
  return element('article', 'card', [thumbnail(file), body, actions])
}

function statusBadge(status) {
  return element('span', `badge ${status}`, [status])
}

function element(tag, className, children) {
  const node = document.createElement(tag)
  node.className = className
  node.append(...children)
  return node
}

function userRow(user, onToggleFollow) {
  const followButton = button(user.following ? 'Unfollow' : 'Follow', () => onToggleFollow(user))
  if (!user.following) followButton.className = 'primary'
  return element('li', '', [`@${user.username}`, followButton])
}

function thumbnail(file) {
  const image = document.createElement('img')
  image.alt = ''
  if (file.thumbnailUrl) image.src = file.thumbnailUrl
  return image
}

function downloadButton(file, onDownload, enabled) {
  const downloadBtn = button('Download', () => onDownload(file.id))
  downloadBtn.disabled = !enabled
  return downloadBtn
}

function button(label, onClick) {
  const element = document.createElement('button')
  element.textContent = label
  element.onclick = onClick
  return element
}

function sizeKb(file) {
  return `${(file.sizeBytes / BYTES_PER_KB).toFixed(1)} KB`
}

function tableRow(cells) {
  const row = document.createElement('tr')
  row.replaceChildren(...cells.map(tableCell))
  return row
}

function tableCell(content) {
  const cell = document.createElement('td')
  cell.append(content)
  return cell
}

// DOM rendering only. Uses textContent/DOM nodes, never innerHTML: filenames are user input.

const BYTES_PER_KB = 1024

const byId = (id) => document.getElementById(id)

export function renderSession({ loggedIn, username }) {
  byId('login').hidden = loggedIn
  byId('logout').hidden = !loggedIn
  byId('app').hidden = !loggedIn
  byId('who').textContent = username ?? ''
}

export function renderUploadProgress(fraction) {
  const bar = byId('progress')
  bar.hidden = false
  bar.value = fraction
}

export function renderFiles(files, { onDownload }) {
  byId('files').replaceChildren(...files.map((file) => fileRow(file, onDownload)))
}

function fileRow(file, onDownload) {
  const thumbnail = document.createElement('img')
  if (file.thumbnailUrl) thumbnail.src = file.thumbnailUrl

  const downloadButton = document.createElement('button')
  downloadButton.textContent = 'Download'
  downloadButton.disabled = file.status !== 'ready'
  downloadButton.onclick = () => onDownload(file.id)

  const sizeKb = `${(file.sizeBytes / BYTES_PER_KB).toFixed(1)} KB`
  const cells = [thumbnail, file.filename, file.status, sizeKb, downloadButton]

  const row = document.createElement('tr')
  row.replaceChildren(...cells.map(tableCell))
  return row
}

function tableCell(content) {
  const cell = document.createElement('td')
  cell.append(content)
  return cell
}

/** Prepends a timestamped line to the on-page log panel. */
export function log(message) {
  const panel = document.getElementById('log')
  const line = `${new Date().toLocaleTimeString()} ${message}\n`
  panel.textContent = line + panel.textContent
}

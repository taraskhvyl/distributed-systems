// Starts a trace in the browser: W3C Trace Context `traceparent` =
// "00-<32 hex trace id>-<16 hex parent span id>-<flags>" (https://www.w3.org/TR/trace-context/).
// No OTel web SDK (the app has no build step), so the browser only mints the ids and
// exports no span of its own. The api's first span becomes a child of this id.
const TRACE_ID_BYTES = 16
const SPAN_ID_BYTES = 8
const VERSION = '00'
const FLAG_SAMPLED = '01' // asks the backend to record this trace

function randomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function newTraceparent() {
  const traceId = randomHex(TRACE_ID_BYTES)
  const traceparent = `${VERSION}-${traceId}-${randomHex(SPAN_ID_BYTES)}-${FLAG_SAMPLED}`
  return { traceId, traceparent }
}

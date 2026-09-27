// Minimal text/event-stream parser for a fetch() response body.
// Format: frames separated by a blank line; `event: name` and `data: json` lines;
// lines starting with ':' are comments (the server's heartbeat) and are ignored.

const FRAME_SEPARATOR = '\n\n'
const DEFAULT_EVENT_NAME = 'message'

export type SseHandler = (name: string, data: Record<string, unknown>) => void

/** Reads the stream until it ends, calling `onEvent(name, data)` for every event frame. */
export async function readSseStream(body: ReadableStream<BufferSource>, onEvent: SseHandler) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value

    let separatorIndex
    while ((separatorIndex = buffer.indexOf(FRAME_SEPARATOR)) >= 0) {
      const frame = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + FRAME_SEPARATOR.length)
      const event = parseFrame(frame)
      if (event) onEvent(event.name, event.data)
    }
  }
}

function parseFrame(frame: string) {
  let name = DEFAULT_EVENT_NAME
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) name = line.slice('event: '.length)
    else if (line.startsWith('data: ')) data += line.slice('data: '.length)
  }
  return data ? { name, data: JSON.parse(data) } : null
}

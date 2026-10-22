/**
 * Minimal RFC 6455 server-side WebSocket.
 *
 * The UnrealAgentLink editor plugin connects out to a plain WebSocket endpoint and
 * exchanges small JSON text frames in both directions (graph payloads can reach
 * hundreds of kilobytes). This module implements exactly that: the HTTP upgrade
 * handshake, masked client text frames with fragmentation, pings, and close.
 * Binary frames are rejected because the protocol never uses them.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** Handshake GUID required by RFC 6455. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Largest accepted inbound message, to bound memory for a hostile peer. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

/** Callbacks owned by the protocol layer. */
export interface WsHandlers {
  /** Called once per complete text message. */
  readonly onMessage: (text: string) => void
  /** Called exactly once when the socket ends, for any reason. */
  readonly onClose: () => void
}

/** One accepted WebSocket connection. */
export interface WsConnection {
  /** Peer description for diagnostics. */
  readonly remote: string
  /** Send one complete text message. */
  send(text: string): void
  /** Close the connection; safe to call more than once. */
  close(code?: number, reason?: string): void
  /** Whether the socket is still usable. */
  readonly open: boolean
}

/** Encode one server-to-client frame. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * Complete the HTTP upgrade and return the accepted connection.
 *
 * @param req - the upgrade request.
 * @param socket - the raw socket beneath it.
 * @param handlers - message and close callbacks.
 * @returns the connection handle.
 * @throws when the handshake request is not a valid WebSocket upgrade.
 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, handlers: WsHandlers): WsConnection {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || key === '') {
    socket.destroy()
    throw new Error('missing Sec-WebSocket-Key')
  }
  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'))

  let open = true
  let buffer = Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragmentBytes = 0
  let closed = false

  const remote = `${String(req.socket.remoteAddress ?? 'local')}:${String(req.socket.remotePort ?? 0)}`

  const finish = (): void => {
    if (closed) return
    closed = true
    open = false
    handlers.onClose()
  }

  const send = (text: string): void => {
    if (!open) return
    socket.write(frame(0x1, Buffer.from(text, 'utf8')))
  }

  const close = (code = 1000, reason = ''): void => {
    if (!open) return
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2, 'utf8')
    socket.write(frame(0x8, payload))
    open = false
    socket.end()
  }

  const handleFrame = (fin: boolean, opcode: number, payload: Buffer): void => {
    switch (opcode) {
      case 0x0: {
        fragmentBytes += payload.length
        if (fragmentBytes > MAX_MESSAGE_BYTES) {
          close(1009, 'message too big')
          return
        }
        fragments.push(payload)
        if (fin) {
          const joined = Buffer.concat(fragments)
          fragments = []
          fragmentBytes = 0
          handlers.onMessage(joined.toString('utf8'))
        }
        return
      }
      case 0x1:
      case 0x2: {
        if (opcode === 0x2) {
          close(1003, 'binary frames are not supported')
          return
        }
        if (!fin) {
          fragments = [payload]
          fragmentBytes = payload.length
          if (fragmentBytes > MAX_MESSAGE_BYTES) close(1009, 'message too big')
          return
        }
        handlers.onMessage(payload.toString('utf8'))
        return
      }
      case 0x8:
        close(1000, '')
        return
      case 0x9:
        if (open) socket.write(frame(0xA, payload))
        return
      case 0xA:
        return
      default:
        close(1002, 'unsupported opcode')
    }
  }

  const drain = (): void => {
    while (open && buffer.length >= 2) {
      const first = buffer[0] as number
      const second = buffer[1] as number
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          close(1009, 'message too big')
          return
        }
        length = Number(big)
        offset = 10
      }
      if (!masked) {
        close(1002, 'client frames must be masked')
        return
      }
      if (buffer.length < offset + 4 + length) return
      const mask = buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] as number) ^ (mask[index % 4] as number)
      }
      buffer = buffer.subarray(offset + 4 + length)
      handleFrame(fin, opcode, payload)
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    drain()
  })
  socket.on('close', finish)
  socket.on('error', finish)
  socket.on('end', finish)

  return {
    remote,
    send,
    close,
    get open() {
      return open
    },
  }
}

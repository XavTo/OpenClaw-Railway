import { request } from 'node:http'
import { pipeline } from 'node:stream'

export function requestUrl(raw, site) {
  if (!raw?.startsWith('/') || raw.startsWith('//')) return null
  try {
    const target = new URL(raw, site)
    return target.origin === site.origin ? target : null
  } catch {
    return null
  }
}

export function forward(req, site, port, path, callback) {
  const headers = { ...req.headers, host: site.host, 'x-forwarded-proto': site.protocol.slice(0, -1), 'x-forwarded-host': site.host }
  delete headers.forwarded
  delete headers['x-real-ip']
  delete headers['x-forwarded-user']
  // The peer is the Railway edge, never a client-supplied loopback address.
  headers['x-forwarded-for'] = req.socket.remoteAddress
  return request({ host: '127.0.0.1', port, method: req.method, path, headers }, callback)
}

export function proxyHttp(req, res, site, port, path = req.url) {
  const proxy = forward(req, site, port, path, upstream => {
    if (res.destroyed) return upstream.destroy()
    res.writeHead(upstream.statusCode, upstream.headers)
    pipeline(upstream, res, () => {})
  })
  proxy.on('error', () => {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) return res.destroy()
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ error: 'OpenClaw is starting.' }))
  })
  if (path === '/startupz') proxy.setTimeout(3000, () => proxy.destroy())
  req.on('error', () => proxy.destroy())
  res.once('close', () => { if (!res.writableEnded) proxy.destroy() })
  req.pipe(proxy)
}

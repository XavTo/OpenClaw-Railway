import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function startPrivateSearch(configuredUrl, port) {
  if (!configuredUrl) return undefined
  const upstream = new URL(configuredUrl)
  if (upstream.protocol !== 'http:' || !upstream.hostname.endsWith('.railway.internal') ||
      upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('SEARXNG_BASE_URL must be the included private Railway service URL.')
  }
  const server = createServer(async (req, res) => {
    const params = new URL(req.url, 'http://localhost')
    if (params.pathname !== '/search' || req.method !== 'GET') return res.writeHead(404).end()
    const query = params.searchParams.get('q')
    if (!query || query.length > 500) return res.writeHead(400).end()
    const target = new URL('/search', upstream)
    for (const key of ['q', 'categories', 'language']) {
      const value = params.searchParams.get(key)
      if (value) target.searchParams.set(key, value)
    }
    target.searchParams.set('format', 'json')
    try {
      const output = await fetch(target, {
        headers: { Accept: 'application/json', 'X-Forwarded-For': '127.0.0.1' },
        redirect: 'error',
        signal: AbortSignal.timeout(16_000),
      })
      if (!output.ok || !output.body || !output.headers.get('content-type')?.includes('application/json')) {
        console.error('SearXNG response was unavailable or not JSON', output.status)
        await output.body?.cancel()
        return res.writeHead(502).end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      await pipeline(Readable.fromWeb(output.body), res)
    } catch (error) {
      console.error('Private SearXNG request failed', error.cause?.code || error.name)
      if (!res.headersSent) res.writeHead(502).end()
      else res.destroy()
    }
  })
  server.listen(port, '127.0.0.1')
  return server
}

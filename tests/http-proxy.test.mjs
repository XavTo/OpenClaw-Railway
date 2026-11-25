import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { proxyHttp, requestUrl } from '../app/http-proxy.mjs'

const site = new URL('https://openclaw.example.com')

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return server.address().port
}

test('accepts origin-form paths for this service only', () => {
  assert.equal(requestUrl('/chat?session=main', site).pathname, '/chat')
  assert.equal(requestUrl('https://openclaw.example.com/chat', site), null)
  assert.equal(requestUrl('//another.example.com/', site), null)
  assert.equal(requestUrl(undefined, site), null)
})

test('passes an upstream startup status through without marking it ready', async t => {
  const port = await listen(t, createServer((req, res) => {
    assert.equal(req.url, '/startupz')
    res.writeHead(503).end('starting')
  }))
  const edge = await listen(t, createServer((req, res) => proxyHttp(req, res, site, port, '/startupz')))
  const result = await fetch(`http://127.0.0.1:${edge}/healthz`)
  assert.equal(result.status, 503)
  assert.equal(await result.text(), 'starting')
})

test('survives a dropped gateway connection and still serves the next request', async t => {
  const port = await listen(t, createServer((req, res) => {
    if (req.url === '/interrupted') {
      res.writeHead(200).write('partial')
      setTimeout(() => res.destroy(), 50)
    } else {
      res.end('ready')
    }
  }))
  const edge = await listen(t, createServer((req, res) => proxyHttp(req, res, site, port)))
  const result = await fetch(`http://127.0.0.1:${edge}/interrupted`)
  await assert.rejects(result.text())
  assert.equal(await (await fetch(`http://127.0.0.1:${edge}/`)).text(), 'ready')
})

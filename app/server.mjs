import { spawn, execFile } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startPrivateSearch } from './private-search.mjs'
import { DocumentError, importDocument, listDocuments, MAX_BYTES, removeDocument, searchDocuments } from './pdf-plugin/documents.mjs'

const run = promisify(execFile)
const port = Number(process.env.PORT || 8080)
const gatewayPort = 18789
const searchPort = 18881
const state = process.env.OPENCLAW_STATE_DIR || '/data/state'
const workspace = process.env.OPENCLAW_WORKSPACE_DIR || '/data/workspace'
const configFile = process.env.OPENCLAW_CONFIG_PATH || join(state, 'openclaw.json')
const cli = process.env.OPENCLAW_CLI || '/app/openclaw.mjs'
const ownerPassword = process.env.RAILWAY_OWNER_PASSWORD || ''
if (ownerPassword.length < 16) throw new Error('Set RAILWAY_OWNER_PASSWORD to at least 16 characters.')
const site = new URL(process.env.OPENCLAW_PUBLIC_ORIGIN || 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN)
if (site.protocol !== 'https:' && site.hostname !== '127.0.0.1') throw new Error('OpenClaw requires HTTPS.')

const asset = (name) => readFile(new URL(name, import.meta.url), 'utf8')
const [html, javascript, stylesheet] = await Promise.all(['setup.html', 'setup.js', 'setup.css'].map(asset))
await mkdir(workspace, { recursive: true, mode: 0o700 })
const secret = join(state, 'railway-gateway-token')
try {
  await writeFile(secret, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
} catch (error) {
  if (error.code !== 'EEXIST') throw error
}
const gatewayToken = (await readFile(secret, 'utf8')).trim()
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configFile,
  OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  OPENCLAW_DISABLE_BONJOUR: '1',
}
delete env.RAILWAY_OWNER_PASSWORD
const search = startPrivateSearch(process.env.SEARXNG_BASE_URL, searchPort)
if (search) env.SEARXNG_BASE_URL = 'http://127.0.0.1:' + searchPort

async function configure() {
  let config = {}
  try {
    config = JSON.parse(await readFile(configFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const firstRun = !config.gateway
  config.gateway ??= {}
  Object.assign(config.gateway, { mode: 'local', bind: 'loopback', port: gatewayPort, trustedProxies: ['127.0.0.1'] })
  config.gateway.auth = { mode: 'token' }
  config.gateway.controlUi = { ...config.gateway.controlUi, allowedOrigins: [site.origin] }

  config.plugins ??= {}
  config.plugins.load ??= {}
  const pdfPlugin = '/opt/railway/pdf-plugin'
  config.plugins.load.paths = [...new Set([...(config.plugins.load.paths || []).filter(path => path !== '/opt/railway/railway-pdf.mjs'), pdfPlugin])]
  config.plugins.entries ??= {}
  config.plugins.entries['railway-pdf'] ??= { enabled: true }
  config.agents ??= {}
  config.agents.defaults ??= {}
  config.agents.defaults.workspace ??= workspace
  if (firstRun) {
    config.plugins.entries.searxng = { enabled: true }
    config.browser = {
      enabled: true, headless: true, noSandbox: true, evaluateEnabled: false, defaultProfile: 'openclaw',
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    }
    config.tools = { profile: 'coding', deny: ['exec', 'process', 'gateway', 'group:nodes'], elevated: { enabled: false } }
    config.tools.alsoAllow = ['browser', 'railway_pdf_search', 'railway_pdf_index_attachment']
    if (env.SEARXNG_BASE_URL) config.tools.web = { search: { enabled: true, provider: 'searxng' } }
    const initialModel = env.OPENCLAW_INITIAL_MODEL ||
      (env.OPENAI_API_KEY ? 'openai/gpt-5-mini' : env.ANTHROPIC_API_KEY ? 'anthropic/claude-haiku-4-5' : undefined)
    if (initialModel) config.agents.defaults.model = { primary: initialModel }
  }
  // On this managed profile Chromium cannot pin a hostname between its
  // preflight and network request. Keep the upstream strict policy and start
  // with a short set of explicit, trusted public documentation hosts.
  if (config.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork === false &&
      !Object.hasOwn(config.browser.ssrfPolicy, 'allowedHostnames')) {
    config.browser.ssrfPolicy.allowedHostnames = [
      'example.com', 'openclaw.ai', 'docs.openclaw.ai', 'railway.com',
      'docs.railway.com', 'github.com', 'raw.githubusercontent.com',
      'developer.mozilla.org', 'en.wikipedia.org',
    ]
  }
  const temporary = configFile + '.railway'
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, configFile)
}
await configure()
const gateway = spawn(process.execPath, ['/app/docker-entrypoint.mjs', 'node', cli, 'gateway', 'run'], { env, stdio: 'inherit' })
const cookieName = '__Host-openclaw_railway'
const cookieFlags = '; Path=/; HttpOnly; Secure; SameSite=Strict'
let attempts = 0
let attemptWindow = 0
let handoffRunning = false
let exiting = false

function sign(value) {
  return createHmac('sha256', gatewayToken).update(ownerPassword).update('\0').update(value).digest('hex')
}

function equals(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function authorized(req) {
  const entry = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))
  const [expires, signature] = entry?.slice(cookieName.length + 1).split('.') ?? []
  return Boolean(expires && signature && /^\d{13}$/.test(expires) && +expires > Date.now() && equals(signature, sign(expires)))
}

function headers(type) {
  return { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" }
}

function send(res, status, payload, additional = {}) {
  res.writeHead(status, { ...headers('application/json; charset=utf-8'), ...additional })
  res.end(JSON.stringify(payload))
}

async function body(req, limit) {
  const chunks = []
  let size = 0
  if (Number(req.headers['content-length']) > limit) throw new DocumentError('Request is too large.', 413)
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) {
      req.resume()
      throw new DocumentError('Request is too large.', 413)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

function forward(req, callback) {
  const h = { ...req.headers, host: site.host, 'x-forwarded-proto': site.protocol.slice(0, -1), 'x-forwarded-host': site.host }
  delete h.forwarded
  delete h['x-real-ip']
  delete h['x-forwarded-user']
  // The peer is the Railway edge, never a client-supplied loopback address.
  h['x-forwarded-for'] = req.socket.remoteAddress
  return httpRequest({ host: '127.0.0.1', port: gatewayPort, method: req.method, path: req.url, headers: h }, callback)
}

async function issueHandoff() {
  if (handoffRunning) throw new DocumentError('Pairing is already being prepared. Try again in a moment.', 409)
  handoffRunning = true
  try {
    const output = await run(process.execPath, [cli, 'dashboard', '--json', '--no-open'], { env, timeout: 25_000, maxBuffer: 256_000 })
    const pairing = new URL(JSON.parse(output.stdout).browserUrl)
    const external = new URL(pairing.pathname + pairing.search + pairing.hash, site)
    const hash = new URLSearchParams(external.hash.slice(1))
    if (hash.has('gatewayUrl')) hash.set('gatewayUrl', site.origin.replace(/^http/, 'ws'))
    external.hash = hash.toString()
    if (!external.hash) throw new Error('Missing pairing fragment')
    return external.toString()
  } catch {
    throw new DocumentError('OpenClaw is still starting or pairing is unavailable. Try again in a moment.', 503)
  } finally {
    handoffRunning = false
  }
}

async function railway(req, res, path) {
  if (req.method === 'GET') {
    const asset = path === '/railway/' ? [html, 'text/html'] :
      path === '/railway/setup.js' ? [javascript, 'application/javascript'] :
      path === '/railway/setup.css' ? [stylesheet, 'text/css'] : null
    if (asset) {
      res.writeHead(200, headers(asset[1] + '; charset=utf-8'))
      res.end(asset[0])
      return
    }
  } else if (req.headers.origin !== site.origin) {
    return send(res, 403, { error: 'Invalid request origin.' })
  }
  if (path === '/railway/api/login' && req.method === 'POST') {
    if (Date.now() > attemptWindow) {
      attempts = 0
      attemptWindow = Date.now() + 60_000
    }
    if (++attempts > 12) return send(res, 429, { error: 'Too many attempts. Wait a minute and retry.' })
    if (!equals((await body(req, 1024)).toString(), ownerPassword)) return send(res, 401, { error: 'Incorrect owner password.' })
    attempts = 0
    const expiry = String(Date.now() + 12 * 3600_000)
    return send(res, 200, { signedIn: true }, {
      'Set-Cookie': cookieName + '=' + expiry + '.' + sign(expiry) + cookieFlags + '; Max-Age=43200',
    })
  }
  if (!authorized(req)) return send(res, 401, { error: 'Sign in with your Railway owner password.' })
  if (path === '/railway/api/pair' && req.method === 'POST') return send(res, 200, { url: await issueHandoff() })
  if (path === '/railway/api/search' && req.method === 'GET') {
    const query = new URL(req.url, site).searchParams.get('q') || ''
    return send(res, 200, { passages: searchDocuments(query.slice(0, 240)) })
  }
  if (path === '/railway/api/documents' && req.method === 'GET') return send(res, 200, { documents: listDocuments() })
  if (path === '/railway/api/documents' && req.method === 'POST') {
    const filename = decodeURIComponent(String(req.headers['x-document-name'] || 'Document.pdf'))
    return send(res, 201, await importDocument(await body(req, MAX_BYTES), filename))
  }
  const id = path.match(/^\/railway\/api\/documents\/([a-f0-9]{64})$/)?.[1]
  if (id && req.method === 'DELETE') return send(res, removeDocument(id) ? 200 : 404, { removed: true })
  return send(res, 404, { error: 'Not found.' })
}

const server = createServer({ requestTimeout: 110_000 }, (req, res) => {
  const path = new URL(req.url, site).pathname
  if (path === '/railway') {
    res.writeHead(308, { Location: '/railway/' }).end()
    return
  }
  if (path.startsWith('/railway/')) {
    railway(req, res, path).catch(error => send(res, error.status || 500, { error: error.status ? error.message : 'The operation failed. Check deployment logs.' }))
    return
  }
  if (path === '/' && req.method === 'GET' && !authorized(req) && !req.url.includes('?')) {
    // The native handoff sets the bootstrap token in the URL fragment. OpenClaw
    // still serves its own root for clients who already paired or use the deep link.
    res.writeHead(302, { Location: '/railway/' }).end()
    return
  }
  const proxy = forward(req, upstream => {
    res.writeHead(upstream.statusCode, upstream.headers)
    upstream.pipe(res)
  })
  proxy.on('error', () => send(res, 503, { error: 'OpenClaw is starting.' }))
  res.on('close', () => { if (!res.writableEnded) proxy.destroy() })
  req.pipe(proxy)
})
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/railway/')) return socket.destroy()
  if (req.headers.origin && req.headers.origin !== site.origin) return socket.destroy()
  const proxy = forward(req, () => socket.destroy())
  socket.on('error', () => proxy.destroy())
  proxy.on('error', () => socket.destroy())
  proxy.on('upgrade', (res, peer, firstBytes) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n')
    for (let i = 0; i < res.rawHeaders.length; i += 2) socket.write(res.rawHeaders[i] + ': ' + res.rawHeaders[i + 1] + '\r\n')
    socket.write('\r\n')
    if (firstBytes.length) socket.write(firstBytes)
    if (head.length) peer.write(head)
    peer.on('error', () => socket.destroy())
    peer.on('close', () => socket.destroy())
    socket.on('close', () => peer.destroy())
    peer.pipe(socket).pipe(peer)
  })
  proxy.end()
})

function stop() {
  if (exiting) return
  exiting = true
  server.close()
  search?.close()
  gateway.kill('SIGTERM')
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
gateway.on('exit', code => process.exit(exiting ? 0 : code || 1))
gateway.on('error', () => process.exit(1))
server.listen(port, '::')

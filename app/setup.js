const signin = document.querySelector('#signin')
const workspace = document.querySelector('#workspace')
const upload = document.querySelector('#upload')
const status = document.querySelector('#status')
const documents = document.querySelector('#documents')
const pair = document.querySelector('#pair')
const search = document.querySelector('#search')
const passages = document.querySelector('#passages')

async function api(path, options) {
  const response = await fetch('/railway/api/' + path, options)
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}

async function refresh() {
  const { documents: rows } = await api('documents')
  signin.hidden = true
  workspace.hidden = false
  documents.replaceChildren(...rows.map(row => {
    const item = document.createElement('li')
    item.textContent = row.name + ' · ' + row.pages + ' pages · ' + row.ocr_pages + ' OCR'
    const button = document.createElement('button')
    button.textContent = 'Remove'
    button.setAttribute('aria-label', 'Remove ' + row.name)
    button.addEventListener('click', async () => {
      if (!window.confirm('Remove this document from the searchable library?')) return
      try {
        await api('documents/' + row.id, { method: 'DELETE' })
        await refresh()
        status.textContent = 'Document removed.'
      } catch (error) { status.textContent = error.message }
    })
    item.append(button)
    return item
  }))
}

async function busy(button, message, action) {
  button.disabled = true
  status.textContent = message
  try { await action() } catch (error) { status.textContent = error.message }
  finally { button.disabled = false }
}

signin.addEventListener('submit', event => {
  event.preventDefault()
  busy(signin.querySelector('button'), 'Signing in…', async () => {
    const password = document.querySelector('#password')
    await api('login', { method: 'POST', body: password.value })
    password.value = ''
    await refresh()
    status.textContent = 'Choose Pair this browser for your first visit.'
  })
})

pair.addEventListener('click', () => busy(pair, 'Preparing OpenClaw pairing…', async () => {
  const result = await api('pair', { method: 'POST' })
  const url = new URL(result.url)
  if (url.origin !== window.location.origin) throw new Error('Pairing returned an unexpected URL.')
  window.location.assign(url)
}))

upload.addEventListener('submit', event => {
  event.preventDefault()
  busy(upload.querySelector('button'), 'Indexing PDF…', async () => {
    const input = document.querySelector('#pdf')
    const file = input.files[0]
    const result = await api('documents', { method: 'POST', headers: { 'X-Document-Name': encodeURIComponent(file.name) }, body: file })
    input.value = ''
    await refresh()
    status.textContent = 'Indexed ' + result.name + '. You can now query it in OpenClaw.'
  })
})

search.addEventListener('submit', event => {
  event.preventDefault()
  busy(search.querySelector('button'), 'Searching…', async () => {
    const keywords = document.querySelector('#keywords').value.trim()
    const { passages: rows } = await api('search?q=' + encodeURIComponent(keywords))
    passages.replaceChildren(...rows.map(row => {
      const item = document.createElement('li')
      item.textContent = row.name + ', page ' + row.page + ' — ' + row.passage
      return item
    }))
    status.textContent = rows.length ? '' : 'No matching passages.'
  })
})
refresh().catch(() => {})

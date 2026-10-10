import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ReadOnlyFolder,
  SECRET,
  fetchPage,
  gitArgs,
  htmlText,
  isPrivateIp,
  runGit,
  searchResult
} from '../src/main/agentTools'
import { setupPrompt } from '../src/main/harness'
import { toolDetail } from '../src/main/trace'

const refused = (args: string[]): boolean => typeof gitArgs(args) === 'string'

test('git: read commands pass, with external programs switched off', () => {
  assert.deepEqual(gitArgs(['log', '--oneline', '-5']), [
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    'log',
    '--no-ext-diff',
    '--no-textconv',
    '--oneline',
    '-5'
  ])
  assert.ok(!refused(['blame', '-L', '1,5', 'src/a.ts']))
  assert.ok(!refused(['branch', '-a', '-vv']))
  assert.ok(!refused(['tag', '--list']))
  assert.ok(!refused(['status', '--short']))
})

test('git: anything that writes, runs a program or reads outside the repo is refused', () => {
  for (const args of [
    ['push'],
    ['commit', '-m', 'x'],
    ['checkout', 'main'],
    ['config', 'user.name'],
    ['diff', '--output=/tmp/x'],
    ['diff', '--no-index', '/etc/passwd', 'a'],
    ['log', '--ext-diff'],
    ['blame', '--contents', '/Users/me/.ssh/id_rsa', 'a.ts'],
    ['grep', '--untracked', 'KEY'],
    ['grep', '-f', '/Users/me/.env', '.'],
    ['grep', '-O', 'x'],
    ['branch', 'new-branch'],
    ['branch', '-D', 'main'],
    ['branch', '--set-upstream-to=origin/x'],
    ['tag', 'v9'],
    ['tag', '-d', 'v1'],
    []
  ])
    assert.ok(refused(args), args.join(' '))
})

test('git: runs in the project', async () => {
  assert.match(await runGit(process.cwd(), ['rev-parse', '--is-inside-work-tree']), /true/)
  assert.match(await runGit(process.cwd(), ['push']), /Only these git commands/)
})

test('secrets: .env and keys are recognised, look-alikes are not', () => {
  for (const p of ['/.env', '/app/.env.local', '/id_rsa', '/certs/server.key', '/a.pem', '/.npmrc'])
    assert.ok(SECRET.test(p), p)
  for (const p of [
    '/.env.example',
    '/src/env.ts',
    '/src/key.ts',
    '/docs/environment.md',
    '/keys/README'
  ])
    assert.ok(!SECRET.test(p), p)
})

test('secrets: the attached folder never reads or matches them, and never writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ro-folder-'))
  writeFileSync(join(dir, '.env'), 'TOKEN=sk-secret-123\n')
  writeFileSync(join(dir, 'a.ts'), 'const TOKEN = process.env.TOKEN\n')
  const fs = new ReadOnlyFolder({ rootDir: dir, virtualMode: true })
  assert.match((await fs.read('/.env')).error ?? '', /secrets/)
  assert.equal((await fs.read('/a.ts')).error, undefined)
  const found = (await fs.grep('TOKEN', '/')).matches ?? []
  assert.ok(found.length > 0 && found.every((m) => !m.path.endsWith('.env')), JSON.stringify(found))
  assert.match((await fs.write('/b.ts')).error ?? '', /read-only/)
})

test('web: local and private addresses are off limits', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.1',
    '172.20.0.1',
    '169.254.169.254',
    '::1',
    'fe80::1',
    '::ffff:127.0.0.1'
  ])
    assert.ok(isPrivateIp(ip), ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateIp(ip), ip)
  assert.match(await fetchPage('http://localhost:5173'), /local or private/)
  assert.match(await fetchPage('http://169.254.169.254/latest/meta-data'), /local or private/)
  assert.match(await fetchPage('file:///etc/passwd'), /Only http and https/)
})

test('web: a page becomes readable text', () => {
  assert.equal(
    htmlText(
      '<html><head><title>T</title><style>p{}</style></head><body><script>x()</script><h1>Hi &amp; bye</h1><p>One</p><p>Two</p></body></html>'
    ),
    'Hi & bye\nOne\nTwo'
  )
})

test('web: search results keep the answer and one line per source', () => {
  const out = searchResult({
    content: '- Electron 39 is current (https://electronjs.org)',
    annotations: [
      {
        type: 'url_citation',
        url_citation: {
          url: 'https://electronjs.org',
          title: 'Electron',
          content: 'Release   notes'
        }
      },
      { type: 'url_citation', url_citation: { url: 'https://electronjs.org', title: 'dup' } }
    ]
  })
  assert.equal(
    out,
    '- Electron 39 is current (https://electronjs.org)\n\nSources:\n- Electron: https://electronjs.org\n  Release notes'
  )
  assert.equal(searchResult({}), 'No results.')
})

test('trace and prompt: git arguments read as a command; the prompt says what is available', () => {
  assert.equal(toolDetail({ args: ['log', '--oneline', '-5'] }), 'log --oneline -5')
  assert.equal(toolDetail({ url: 'https://example.com' }), 'https://example.com')
  assert.match(setupPrompt(['/repo'], true), /internet access/)
  assert.match(setupPrompt([], false), /web search needs an OpenRouter key/)
})

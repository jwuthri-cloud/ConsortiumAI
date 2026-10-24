import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webApi, type App, type Installation, type types } from '@slack/bolt'
import { runMember } from '../src/main/cli'
import {
  MAX_FILES,
  attachedLine,
  gather,
  inline,
  kindOf,
  pixels,
  plan,
  withImages,
  type SlackFile
} from '../src/main/files'
import { appJwt, appManifest, clone, cloneArgs, cloneEnv, githubApp } from '../src/main/github'
import {
  DEFAULTS,
  SCOPES,
  askModal,
  homeView,
  keyed,
  missingScopes,
  closest,
  preselect,
  readAsk,
  readLink,
  reinstallNeeded,
  repoIn,
  repoOptions,
  repoPicker,
  repoPrefix,
  unreadable,
  serveHosted,
  settingsBrief,
  signLink
} from '../src/main/hosted'
import { bridge, type Tenancy } from '../src/main/slack'
import { installations, openStore, seal } from '../src/main/store'

const SECRET = 'x'.repeat(40)
const file = (name: string, mimetype = 'text/plain', size = 10): SlackFile => ({
  name,
  mimetype,
  size,
  url_private_download: `https://files.slack.com/files-pri/T1-F1/${name}`
})

test('attachments: what a file is, by name before Slack’s mimetype', () => {
  assert.equal(kindOf(file('api.ts', 'video/mp2t')), 'text') // Slack's mimetype for .ts
  assert.equal(kindOf(file('notes.md', 'application/octet-stream')), 'text')
  assert.equal(kindOf(file('Dockerfile', '')), 'text')
  assert.equal(kindOf(file('data.weird', 'application/json')), 'text')
  assert.equal(kindOf(file('shot.png', 'image/png')), 'image')
  assert.equal(kindOf(file('photo.jpg', 'image/jpeg')), 'image')
  assert.equal(kindOf(file('spec.pdf', 'application/pdf')), 'pdf')
  assert.equal(kindOf(file('art.tiff', 'image/tiff')), undefined)
  assert.equal(kindOf(file('deck.pptx', 'application/vnd.ms-powerpoint')), undefined)
  assert.equal(kindOf(file('clip.mp4', 'video/mp4')), undefined)
})

test('attachments: 10 files, 20 MB each, images 5 MB; names made safe and unique', () => {
  const files = [
    file('a.md'),
    file('a.md'),
    file('../../etc/passwd.txt'),
    file('big.csv', 'text/csv', 21 << 20),
    file('huge.png', 'image/png', 6 << 20),
    file('movie.mp4', 'video/mp4'),
    ...Array.from({ length: 12 }, (_, i) => file(`f${i}.txt`))
  ]
  const { take, skipped } = plan(files)
  assert.equal(take.length, MAX_FILES)
  assert.deepEqual(
    take.slice(0, 3).map((t) => t.name),
    ['a.md', '2-a.md', 'passwd.txt']
  )
  assert.ok(take.every((t) => !t.name.includes('/') && !t.name.startsWith('.')))
  assert.ok(skipped.includes('big.csv (over 20 MB)'))
  assert.ok(skipped.includes('huge.png (images up to 5 MB)'))
  assert.ok(skipped.includes('movie.mp4 (not text, code, a PDF or an image)'))
  assert.equal(skipped.filter((s) => s.includes('10 files a question at most')).length, 5)
})

test('attachments: downloaded with the bot token (Slack only), PDFs read, images described', async () => {
  const real = globalThis.fetch
  const seen: { url: string; auth: string | null; body?: string }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const auth = new Headers(init?.headers).get('authorization')
    seen.push({ url, auth, body: init?.body ? String(init.body) : undefined })
    if (url.endsWith('/notes.md')) return new Response('# Notes\nShip on Friday.')
    if (url.endsWith('/blob.txt')) return new Response(new Uint8Array([1, 0, 2]))
    if (url.endsWith('/shot.png')) return new Response(new Uint8Array([137, 80, 78, 71]))
    if (url.endsWith('/spec.pdf')) return new Response('%PDF-1.4')
    if (url.endsWith('/gone.md'))
      return new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })
    const body = JSON.parse(String(init?.body))
    if (body.plugins)
      return Response.json({
        choices: [
          {
            message: {
              content: 'OK',
              annotations: [
                { type: 'file', file: { content: [{ type: 'text', text: 'Page one.' }] } }
              ]
            }
          }
        ]
      })
    return Response.json({ choices: [{ message: { content: 'A bar chart: revenue up 20%.' } }] })
  }
  try {
    const { got, skipped } = await gather(
      [
        file('notes.md'),
        file('blob.txt'),
        file('shot.png', 'image/png'),
        file('spec.pdf', 'application/pdf'),
        file('gone.md'),
        { name: 'evil.md', mimetype: 'text/plain', url_private: 'https://evil.example/x' }
      ],
      {
        token: 'xoxb-BOT',
        key: 'sk-or-KEY',
        reader: 'a/clerk',
        describer: 'g/sees',
        question: 'Q?'
      }
    )
    assert.deepEqual(
      got.map((g) => [g.name, g.file, g.text]),
      [
        ['notes.md', 'notes.md', '# Notes\nShip on Friday.'],
        ['shot.png', undefined, undefined],
        ['spec.pdf', 'spec.pdf.txt', 'Page one.']
      ]
    )
    assert.equal(got[1].image, 'data:image/png;base64,iVBORw==')
    assert.equal(got[1].description, 'A bar chart: revenue up 20%.')
    assert.deepEqual(skipped.sort(), [
      'blob.txt (not a text file)',
      'evil.md (Slack gave no download link)',
      "gone.md (Slack didn't hand it over)"
    ])
    // the bot token went to Slack's file host and nowhere else; the key only to OpenRouter
    for (const s of seen) {
      if (s.url.startsWith('https://files.slack.com/')) assert.equal(s.auth, 'Bearer xoxb-BOT')
      else assert.equal(s.url, 'https://openrouter.ai/api/v1/chat/completions')
      if (!s.url.startsWith('https://files.slack.com/')) assert.equal(s.auth, 'Bearer sk-or-KEY')
    }
    assert.ok(!seen.some((s) => s.url.includes('evil.example')))
    const pdf = JSON.parse(seen.find((s) => s.body?.includes('file-parser'))!.body!)
    assert.equal(pdf.model, 'a/clerk')
    assert.equal(pdf.plugins[0].pdf.engine, 'cloudflare-ai')

    // the question carries the descriptions; a thread's files come inline
    assert.match(withImages('Q?', got), /^Q\?\n\n.*\n- shot\.png: A bar chart: revenue up 20%\.$/)
    assert.equal(withImages('Q?', [got[0]]), 'Q?')
    const text = inline(got, ['blob.txt (not a text file)'])
    assert.match(text, /### notes\.md\n```\n# Notes/)
    assert.match(text, /### shot\.png \(an image, described\)\nA bar chart/)
    assert.match(text, /Not attached: blob\.txt/)
    assert.equal(
      attachedLine('acme/api', ['a<b>.md'], ['x (why)']),
      ':paperclip: *Repository* `acme/api` · *Files* a&lt;b&gt;.md\n_Left out: x (why)_'
    )
    assert.equal(attachedLine(null, [], []), '')
  } finally {
    globalThis.fetch = real
  }
})

test('attachments: the images seats see stay within 15 MB together', () => {
  const big = 'x'.repeat(8 << 20) // ~6 MB of image
  assert.equal(
    pixels([
      { name: 'a', image: big },
      { name: 'b', image: big },
      { name: 'c', image: big }
    ]).length,
    2
  )
  assert.deepEqual(pixels([{ name: 'a', text: 'hi' }]), [])
})

test('the Deep-agent sends the images with the prompt', async () => {
  const real = globalThis.fetch
  let body: { messages?: { content: unknown }[] } = {}
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes('/chat/completions')) return new Response('{"data":[]}')
    body = JSON.parse(String(init?.body))
    return new Response('{"error":{"message":"No auth credentials found","code":401}}', {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  }
  try {
    await runMember(
      'harness',
      {
        prompt: 'What does it show?',
        model: 'openrouter:a/sees',
        apiKey: 'sk-A',
        home: await mkdtemp(join(tmpdir(), 'harness-img-')),
        images: ['data:image/png;base64,iVBORw==']
      },
      () => {},
      'img'
    ).catch(() => {})
    const user = JSON.stringify(body.messages?.at(-1)?.content)
    assert.match(user, /What does it show\?/)
    assert.match(user, /"image_url":\{"url":"data:image\/png;base64,iVBORw=="/)
  } finally {
    globalThis.fetch = real
  }
})

test('the hosted runner: only the folders convene made, images on first turns of seats that see', async () => {
  const seen: Parameters<typeof runMember>[1][] = []
  const fake: typeof runMember = async (_cli, a) => {
    seen.push(a)
    return { text: 'ok' }
  }
  const run = keyed('sk-A', '/data/teams/T1', fake, {
    mine: ['/data/attachments/M1', '/tmp/consortium-x'],
    images: ['data:image/png;base64,AA'],
    sees: (m) => m === 'a/sees'
  })
  const go = (a: Partial<Parameters<typeof runMember>[1]>, key = 'M1:m1'): Promise<unknown> =>
    run('harness', { prompt: 'p', model: 'openrouter:a/sees', ...a }, () => {}, key)
  await go({ cwd: '/tmp/consortium-x/api', dirs: ['/data/attachments/M1'] })
  assert.deepEqual(seen[0].images, ['data:image/png;base64,AA'])
  assert.equal(seen[0].cwd, '/tmp/consortium-x/api')
  await go({ resume: 'thread-1' }) // later turns: the seat's memory has them
  await go({}, 'M1:whiteboard') // the clerk never
  await go({ model: 'openrouter:b/blind' })
  assert.deepEqual(
    seen.slice(1).map((a) => a.images),
    [undefined, undefined, undefined]
  )
  for (const cwd of ['/', '/data', '/data/attachments/M2', '/tmp/consortium-x/../etc'])
    await assert.rejects(go({ cwd }), /reads only what was attached in Slack/)
  await assert.rejects(go({ dirs: ['/etc'] }), /reads only what was attached/)
  // with nothing attached, no folder at all
  await assert.rejects(
    keyed('sk-A', '/h', fake)(
      'harness',
      { prompt: 'p', model: 'openrouter:a/b', cwd: '/tmp' },
      () => {},
      'k'
    ),
    /reads only what was attached/
  )
  assert.equal(seen.length, 4)
})

test('scopes: an install without files:read gets a reinstall link, in the Home tab and the refusal', () => {
  const url = 'https://c.example/slack/install'
  assert.deepEqual(missingScopes({ bot: { scopes: ['chat:write', 'files:write'] } }), [
    'files:read'
  ])
  assert.deepEqual(missingScopes({ bot: { scopes: ['files:read'] } }), [])
  assert.deepEqual(missingScopes(undefined), ['files:read'])
  const home = JSON.stringify(homeView(DEFAULTS, false, undefined, { files: false, install: url }))
  assert.ok(home.includes(`<${url}|Reinstall to enable files>`))
  assert.ok(
    !JSON.stringify(homeView(DEFAULTS, false, undefined, { files: true, install: url })).includes(
      'Reinstall'
    )
  )
  assert.ok(reinstallNeeded(url).includes(`<${url}|Reinstall to enable files>`))
  const modal = JSON.stringify(askModal({ files: false, install: url }))
  assert.ok(modal.includes(`<${url}|Reinstall to enable files>`) && !modal.includes('file_input'))
})

test('the Home tab: GitHub for admins (connect, change, disconnect), hidden without the app', () => {
  const text = (v: types.HomeView): string => JSON.stringify(v)
  const ids = (v: types.HomeView): string[] =>
    v.blocks.flatMap((b) =>
      b.type === 'actions' ? b.elements.map((e) => (e as { action_id: string }).action_id) : []
    )
  assert.ok(!text(homeView(DEFAULTS, true)).includes('GitHub'))
  assert.ok(ids(homeView(DEFAULTS, false)).includes('home_ask')) // everyone can ask
  const off = homeView(DEFAULTS, true, undefined, {
    github: { connect: 'https://c/github/connect?t=1' }
  })
  assert.ok(text(off).includes('Not connected') && ids(off).includes('home_github'))
  const on = homeView(DEFAULTS, true, undefined, {
    github: { connect: 'https://c/github/connect?t=1', account: 'acme', repos: 12 }
  })
  assert.ok(text(on).includes('`acme` · 12 repositories'))
  assert.ok(ids(on).includes('home_github') && ids(on).includes('home_github_off'))
  const member = homeView(DEFAULTS, false, undefined, { github: { account: 'acme', repos: 1 } })
  assert.ok(text(member).includes('1 repository') && !ids(member).includes('home_github'))
})

test('the ask form: valid blocks, the channel’s repository first, answers read back', () => {
  const repos = Array.from({ length: 150 }, (_, i) => `acme/r${i}`)
  const v = askModal({
    channel: 'C1',
    repos,
    repo: 'acme/old',
    files: true,
    install: 'https://c/slack/install'
  })
  assert.equal(v.callback_id, 'ask_modal')
  const ids = v.blocks.map((b) => b.block_id).filter(Boolean)
  assert.equal(new Set(ids).size, ids.length) // block ids unique
  const input = (id: string): types.InputBlock =>
    v.blocks.find((b) => b.block_id === id) as types.InputBlock
  assert.equal((input('question').element as types.PlainTextInput).multiline, true)
  const channel = input('channel').element as types.ConversationsSelect
  assert.equal(channel.initial_conversation, 'C1')
  assert.equal(channel.response_url_enabled, true)
  const repo = input('repo').element as types.StaticSelect
  assert.ok(input('repo').optional)
  assert.equal(repo.options!.length, 100) // Slack's cap, "No repository" included
  assert.equal(repo.options![0].value, 'none')
  assert.equal((repo.options![1].text as types.PlainTextElement).text, 'old') // by name…
  assert.equal(repo.options![1].description?.text, 'acme') // …the owner under it
  assert.equal(repo.initial_option?.value, 'acme/old') // not among the newest: added
  assert.ok(repo.options!.some((o) => o.value === repo.initial_option?.value))
  assert.ok(repo.options!.every((o) => (o.text as types.PlainTextElement).text.length <= 75))
  const files = input('files').element as types.FileInput
  assert.equal(files.type, 'file_input')
  assert.equal(files.max_files, 10)
  assert.equal(input('files').optional, true)
  // no GitHub: no repository select
  assert.ok(!askModal({ files: true, install: '' }).blocks.some((b) => b.block_id === 'repo'))
  assert.equal(
    (
      askModal({ repos: [], files: true, install: '' }).blocks.find(
        (b) => b.block_id === 'repo'
      ) as types.InputBlock
    ).element.type,
    'static_select'
  ) // connected, nothing listed yet: just "— none —"

  const f = file('a.md')
  const values = {
    question: { question: { value: '  Ship it? ' } },
    channel: { channel: { selected_conversation: 'C9' } },
    repo: { repo: { selected_option: { value: 'acme/api' } } },
    files: { files: { files: [f] } }
  }
  assert.deepEqual(readAsk(values), {
    question: 'Ship it?',
    channel: 'C9',
    repo: 'acme/api',
    files: [f]
  })
  assert.equal(
    (
      readAsk({ ...values, repo: { repo: { selected_option: { value: 'none' } } } }) as {
        repo: unknown
      }
    ).repo,
    null
  )
  const noRepo = { question: values.question, channel: values.channel }
  assert.equal((readAsk(noRepo) as { repo: unknown }).repo, undefined)
  assert.deepEqual(readAsk({ question: { question: { value: ' ' } }, channel: { channel: {} } }), {
    errors: { question: 'Ask a question.', channel: 'Pick a channel.' }
  })
})

// connectlyai's repositories, most recently pushed first
const ORG = [
  'crewmate',
  'connectly-backend',
  'connectly-frontend',
  'testing',
  'api_docs',
  'webchat.test',
  'webchat',
  'cq',
  'docs.connectly.ai',
  'memory-server',
  'main',
  'FeBe',
  'backend.claude',
  'bug-radar'
].map((n) => `connectlyai/${n}`)

test('the repository a question names: whole names first, every part that counts, no noise', () => {
  // a part of the name, the org's prefix left out
  assert.equal(
    repoIn('why does backend retry webhooks twice?', ORG),
    'connectlyai/connectly-backend'
  )
  assert.equal(repoIn('Is the Frontend slow?', ORG), 'connectlyai/connectly-frontend')
  // the most parts said beats an older match on fewer
  assert.equal(repoIn('what does the claude backend do?', ORG), 'connectlyai/backend.claude')
  assert.equal(repoIn('Should the bug radar page us?', ORG), 'connectlyai/bug-radar')
  // a generic part needn't be said; plurals count
  assert.equal(repoIn('Why is memory leaking?', ORG), 'connectlyai/memory-server')
  // the whole name beats part of one, owner/name too
  assert.equal(repoIn('Is webchat.test in sync with webchat?', ORG), 'connectlyai/webchat.test')
  assert.equal(repoIn('Why does webchat drop messages?', ORG), 'connectlyai/webchat')
  assert.equal(repoIn('Look at connectlyai/cq first', ORG), 'connectlyai/cq')
  assert.equal(repoIn('how does FeBe build?', ORG), 'connectlyai/FeBe')
  // common words name nothing, nor does a partial name, nor the owner
  assert.equal(repoIn('Should main be protected? Are we testing enough?', ORG), undefined)
  assert.equal(repoIn('Is our test coverage OK for the API docs?', ORG), undefined)
  assert.equal(repoIn('Should connectly raise prices?', ORG), undefined)
  assert.equal(repoIn('', ORG), undefined)
  assert.equal(repoIn('backend', []), undefined)
})

test('the repository a question starts with: the one it names, else the channel’s last, else none', () => {
  const last = 'connectlyai/webchat'
  assert.equal(preselect('why does backend retry?', ORG, last), 'connectlyai/connectly-backend')
  assert.equal(preselect('Should we raise prices?', ORG, last), last)
  assert.equal(preselect(undefined, ORG, last), last)
  assert.equal(preselect('Should we raise prices?', ORG), null)
})

test('a repository it can’t read: plain words, the closest names, where admins add it', () => {
  assert.deepEqual(closest('connectlyai/backend', ORG), [
    'connectlyai/connectly-backend',
    'connectlyai/backend.claude'
  ])
  assert.deepEqual(closest('connectlyai/webchats', ORG).slice(0, 1), ['connectlyai/webchat'])
  assert.deepEqual(closest('acme/nothing-like-it', ORG), [])
  const msg = unreadable('connectlyai/backend', ORG)
  assert.match(msg, /^`connectlyai\/backend` isn't one of the repositories Consortium can read/)
  assert.match(msg, /Did you mean `connectly-backend` or `backend\.claude`\?/)
  assert.match(msg, /Home tab → Change repositories/)
  assert.doesNotMatch(msg, /GitHub answered|422|repo:/)
  assert.doesNotMatch(unreadable('acme/x', []), /Did you mean/)
})

test('the ask form with a question: filled in, the repository it names selected, Start', () => {
  const v = askModal({
    channel: 'C1',
    question: 'why does backend retry webhooks twice?',
    repos: ORG,
    repo: preselect('why does backend retry webhooks twice?', ORG, 'connectlyai/webchat'),
    files: true,
    install: ''
  })
  const input = (id: string): types.InputBlock =>
    v.blocks.find((b) => b.block_id === id) as types.InputBlock
  assert.equal(
    (input('question').element as types.PlainTextInput).initial_value,
    'why does backend retry webhooks twice?'
  )
  assert.equal(
    (input('repo').element as types.StaticSelect).initial_option?.value,
    'connectlyai/connectly-backend'
  )
  assert.equal(v.submit?.text, 'Start')
  assert.equal(
    (askModal({ files: true, install: '' }).blocks[0] as types.InputBlock).element.type,
    'plain_text_input'
  )
  assert.ok(
    !(
      'initial_value' in
      (askModal({ files: true, install: '' }).blocks[0] as types.InputBlock).element
    )
  )
})

test('the mention’s picker: a valid select (the pick always in it, No repository) and Start', () => {
  const blocks = repoPicker({
    id: 'abc',
    question: 'why does <backend> retry & fail?',
    repos: ORG,
    repo: 'connectlyai/gone',
    files: 2
  })
  assert.equal(blocks.length, 2)
  const [head, actions] = blocks as [types.SectionBlock, types.ActionsBlock]
  assert.match(head.text!.text, /Which repository should the table read\?\* · 2 files/)
  assert.match(head.text!.text, /&lt;backend&gt; retry &amp; fail\?/) // escaped
  assert.equal(actions.block_id, 'pick_abc')
  const [select, start] = actions.elements as [types.StaticSelect, types.Button]
  assert.equal(select.action_id, 'pick_repo')
  assert.equal(select.options![0].value, 'none')
  assert.equal((select.options![0].text as types.PlainTextElement).text, 'No repository')
  assert.equal(select.initial_option?.value, 'connectlyai/gone') // not listed: added first
  assert.ok(select.options!.some((o) => o.value === select.initial_option?.value))
  assert.ok(
    select.options!.every(
      (o) => o.value!.length <= 75 && (o.text as types.PlainTextElement).text.length <= 75
    )
  )
  assert.deepEqual([start.action_id, start.value, start.style], ['pick_start', 'abc', 'primary'])
  // no pick: No repository first
  assert.equal(repoOptions(ORG, null).initial.value, 'none')
  assert.equal(repoOptions([], undefined).options.length, 1)
  const long = repoPicker({ id: 'x', question: 'q'.repeat(500), repos: [] })
  assert.ok((long[0] as types.SectionBlock).text!.text.length < 300)
})

test('repo: a prefix picks the repository for one question', () => {
  assert.deepEqual(repoPrefix('repo:acme/api.v2 Why is it slow?'), {
    repo: 'acme/api.v2',
    text: 'Why is it slow?'
  })
  assert.deepEqual(repoPrefix('repo:none  Just think'), { repo: null, text: 'Just think' })
  assert.deepEqual(repoPrefix(' Plain question '), { text: 'Plain question' })
  assert.deepEqual(repoPrefix('repo:acme Missing owner'), { text: 'repo:acme Missing owner' })
})

test('GitHub: the Connect link is signed for GitHub alone, and expires', () => {
  const t = signLink(SECRET, 'T1', 'U1', 1000, 'github')
  assert.deepEqual(readLink(SECRET, t, 2000, 'github'), { team: 'T1', user: 'U1' })
  assert.equal(readLink(SECRET, t, 2000), undefined) // not an OpenRouter link
  assert.equal(readLink(SECRET, signLink(SECRET, 'T1', 'U1', 1000), 2000, 'github'), undefined)
  assert.equal(readLink(SECRET, t, 1000 + 3_600_001, 'github'), undefined)
  assert.equal(readLink('y'.repeat(40), t, 2000, 'github'), undefined)
  assert.equal(readLink(SECRET, 'i123', 2000, 'github'), undefined) // the sign-in detour's state
})

test('GitHub: the app is hidden without its five variables; its JWT verifies; read-only manifest', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const env = {
    GITHUB_APP_ID: '42',
    GITHUB_APP_SLUG: 'consortium',
    GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, '\\n'), // pasted on one line
    GITHUB_APP_CLIENT_ID: 'Iv1',
    GITHUB_APP_CLIENT_SECRET: 'cs'
  }
  assert.equal(githubApp({}), undefined)
  assert.equal(githubApp({ ...env, GITHUB_APP_CLIENT_SECRET: '' }), undefined)
  const app = githubApp(env)!
  assert.equal(app.key, pem)
  const jwt = appJwt(app, 1_700_000_000_000)
  const [h, p, sig] = jwt.split('.')
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig, 'base64url'))
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), {
    iat: 1_699_999_940,
    exp: 1_700_000_540,
    iss: '42'
  })
  const m = appManifest('https://c.example') as Record<string, unknown>
  assert.deepEqual(m.default_permissions, { contents: 'read', metadata: 'read' })
  assert.equal(m.public, true)
  assert.equal(m.request_oauth_on_install, true)
  assert.deepEqual(m.callback_urls, ['https://c.example/github/callback'])
})

test('GitHub: a clone keeps its token out of argv and .git/config', async () => {
  const TOKEN = 'ghs_SECRETTOKEN123'
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
  const args = cloneArgs('https://github.com/acme/api.git', '/tmp/x/api')
  assert.ok(!args.join(' ').includes(TOKEN) && !args.join(' ').includes(basic))
  assert.ok(args.includes('--depth') && args.includes('--single-branch'))
  assert.ok(args.some((a) => a.startsWith('--filter=blob:limit=')))
  const env = cloneEnv(TOKEN)
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${basic}`)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.ok(!Object.keys(env).some((k) => /SECRET|KEY$|TOKEN/.test(k) && k !== 'GIT_CONFIG_KEY_0'))

  // a real clone from a local repository, through the same env
  const root = await mkdtemp(join(tmpdir(), 'clone-'))
  const src = join(root, 'src')
  mkdirSync(src)
  const git = (cwd: string, ...a: string[]): string =>
    execFileSync('git', a, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t'
      }
    }).toString()
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'README.md'), 'hello')
  git(src, 'add', '.')
  git(src, 'commit', '-qm', 'first')
  const into = join(root, 'work', 'api')
  await clone(TOKEN, `file://${src}`, into)
  assert.equal(readFileSync(join(into, 'README.md'), 'utf8'), 'hello')
  const config = readFileSync(join(into, '.git', 'config'), 'utf8')
  assert.ok(!config.includes(TOKEN) && !config.includes(basic) && !config.includes('extraheader'))
  let leaked = ''
  try {
    leaked = execFileSync('grep', ['-rl', TOKEN, join(into, '.git')], { encoding: 'utf8' })
  } catch {
    /* grep found nothing */
  }
  assert.equal(leaked, '')
  await assert.rejects(clone(TOKEN, `file://${root}/nope`, join(root, 'n')), /git clone failed/)
})

test('the bridge: what convene set up goes when the meeting ends, or never starts', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on: Record<string, (args: any) => Promise<unknown>> = {}
  const app = {
    command: (n: string, f: (typeof on)[string]) => (on[n] = f),
    event: (n: string, f: (typeof on)[string]) => (on[n] = f),
    message: (f: (typeof on)[string]) => (on.message = f),
    action: (n: unknown, f: (typeof on)[string]) => typeof n === 'string' || (on.buttons = f)
  } as unknown as App
  let failPost = false
  const posted: string[] = []
  const client = new Proxy(
    {},
    {
      get: (_, k: string) =>
        new Proxy(
          {},
          {
            get: (_2, m: string) => async (args: { blocks?: unknown }) => {
              if (k === 'chat' && m === 'postMessage') {
                if (failPost)
                  throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } })
                posted.push(JSON.stringify(args.blocks ?? ''))
              }
              return { ts: '1', canvas_id: 'F1', url: 'https://x/', team_id: 'T1', permalink: 'p' }
            }
          }
        )
    }
  )
  const cleaned: string[] = []
  const asked: unknown[] = []
  const dir = await mkdtemp(join(tmpdir(), 'bridge-done-'))
  const work = join(dir, 'work')
  const tenancy: Tenancy = {
    refuse: async () => undefined,
    maxMeetings: async () => 5,
    convene: async (_team, _channel, question, x) => {
      mkdirSync(work, { recursive: true })
      return {
        brief: settingsBrief(
          { ...DEFAULTS, seats: DEFAULTS.seats.slice(0, 2), maxTurns: 4 },
          question
        ),
        run: async () => new Promise(() => {}), // holds the floor
        dir,
        question: 'Shown question',
        attached: ':paperclip: *Files* a.md',
        done: () => void cleaned.push(x.id)
      }
    },
    // the form for `/consortium` alone; a question too once `take` (GitHub connected, hosted)
    ask: async (o) => (asked.push(o), !o.question || take)
  }
  let take = false
  bridge(app, tenancy)
  const said: string[] = []
  const command = (text: string): Promise<unknown> =>
    on['/consortium']({
      command: { channel_id: 'C1', user_id: 'U1', text, trigger_id: 'TR' },
      ack: async () => {},
      respond: async (r: { text: string }) => void said.push(r.text),
      client,
      context: { teamId: 'T1' }
    })

  await command('') // nothing after the command: the form
  assert.deepEqual(asked, [{ team: 'T1', client, user: 'U1', channel: 'C1' }])
  assert.deepEqual(said, [])

  // a repository to pick: the form with the question, or the mention's picker; nothing starts yet
  take = true
  await command('Why does backend retry?')
  assert.equal((asked.at(-1) as { question?: string }).question, 'Why does backend retry?')
  const f = file('a.md')
  await on.app_mention({
    event: { user: 'U1', channel: 'C1', text: '<@UBOT> Why so slow?', thread_ts: '9', files: [f] },
    client,
    context: { teamId: 'T1' }
  })
  assert.deepEqual(asked.at(-1), {
    team: 'T1',
    client,
    user: 'U1',
    channel: 'C1',
    thread: '9',
    question: 'Why so slow?',
    files: [f]
  })
  assert.equal(posted.length, 0)
  take = false

  failPost = true
  await command('Not invited') // no repository to pick: it starts at once
  assert.equal((asked.at(-1) as { question?: string }).question, 'Not invited')
  assert.equal(cleaned.length, 1)
  assert.match(said.at(-1)!, /not_in_channel/)

  failPost = false
  await command('A question')
  assert.ok(posted[0].includes('Shown question') && posted[0].includes(':paperclip: *Files* a.md'))
  assert.equal(cleaned.length, 1) // still running
  await on.buttons({
    ack: async () => {},
    body: { user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '1' } },
    action: { action_id: 'stop' },
    client,
    context: { teamId: 'T1' }
  })
  for (let i = 0; i < 100 && cleaned.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(cleaned.length, 2)
  assert.ok(existsSync(dir) && readdirSync(join(dir, 'sessions')).length === 1)
})

test('GitHub routes: setup, connect through a cookie, an installation counted only if it is theirs', async () => {
  const freePort = (): Promise<number> =>
    new Promise((done) => {
      const srv = createServer().listen(0, () => {
        const { port } = srv.address() as AddressInfo
        srv.close(() => done(port))
      })
    })
  const boot = async (github: boolean): Promise<{ port: number; stop: () => Promise<void> }> => {
    const port = await freePort()
    Object.assign(process.env, {
      PORT: String(port),
      PUBLIC_URL: `http://localhost:${port}`,
      DATABASE_URL: 'sqlite::memory:',
      CONSORTIUM_DATA: await mkdtemp(join(tmpdir(), 'consortium-gh-')),
      CONSORTIUM_SECRET: SECRET,
      SLACK_CLIENT_ID: '1.2',
      SLACK_CLIENT_SECRET: 'x',
      SLACK_SIGNING_SECRET: 'x'
    })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const vars = {
      GITHUB_APP_ID: '42',
      GITHUB_APP_SLUG: 'consortium-test',
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      GITHUB_APP_CLIENT_ID: 'Iv1.abc',
      GITHUB_APP_CLIENT_SECRET: 'cs'
    }
    for (const [k, v] of Object.entries(vars))
      if (github) process.env[k] = v
      else delete process.env[k]
    const app = await serveHosted()
    return { port, stop: () => app.stop() }
  }
  const real = globalThis.fetch
  const toGitHub: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('http://localhost')) return real(input, { ...init, redirect: 'manual' })
    toGitHub.push(url)
    if (url === 'https://github.com/login/oauth/access_token')
      return Response.json({ access_token: 'ghu_USER' })
    if (url.startsWith('https://api.github.com/user/installations'))
      return Response.json({ installations: [{ id: 7, account: { login: 'acme' } }] })
    return new Response('{"data":[]}')
  }
  const get = async (port: number, path: string, cookie?: string): Promise<Response> =>
    globalThis.fetch(`http://localhost:${port}${path}`, { headers: cookie ? { cookie } : {} })

  try {
    const bare = await boot(false)
    try {
      const setup = await get(bare.port, '/github/setup')
      const html = await setup.text()
      const action = html.match(/action="([^"]+)"/)![1].replace(/&amp;/g, '&')
      assert.match(action, /^https:\/\/github\.com\/settings\/apps\/new\?state=/)
      const state = new URL(action).searchParams.get('state')!
      assert.ok(readLink(SECRET, state, Date.now(), 'github-setup'))
      const manifest = JSON.parse(
        html
          .match(/name="manifest" value="([^"]+)"/)![1]
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
      )
      assert.equal(manifest.redirect_url, `http://localhost:${bare.port}/github/created`)
      assert.equal((await get(bare.port, '/github/created?code=c&state=forged')).status, 400)
      assert.equal(
        (
          await get(
            bare.port,
            `/github/connect?t=${signLink(SECRET, 'T1', 'U1', Date.now(), 'github')}`
          )
        ).status,
        400
      ) // hidden without the app
    } finally {
      await bare.stop()
    }

    const s = await boot(true)
    try {
      assert.match(await (await get(s.port, '/github/setup')).text(), /consortium-test/)
      const t = signLink(SECRET, 'T1', 'U1', Date.now(), 'github')
      assert.equal(
        (await get(s.port, `/github/connect?t=${signLink(SECRET, 'T1', 'U1')}`)).status,
        400
      ) // an OpenRouter link
      const go = await get(s.port, `/github/connect?t=${t}`)
      assert.equal(go.status, 302)
      assert.equal(
        go.headers.get('location'),
        `https://github.com/apps/consortium-test/installations/new?state=${encodeURIComponent(t)}`
      )
      const jar = go.headers.get('set-cookie')!
      assert.match(jar, /HttpOnly; Secure; SameSite=Lax/)
      const cookie = jar.split(';')[0]

      assert.equal((await get(s.port, '/github/callback?installation_id=7&code=c')).status, 400) // no link, no cookie
      // installed, no sign-in code: off to sign in, the installation in the state
      const detour = await get(
        s.port,
        '/github/callback?installation_id=7&setup_action=update',
        cookie
      )
      assert.equal(detour.status, 302)
      const to = new URL(detour.headers.get('location')!)
      assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize')
      assert.equal(to.searchParams.get('client_id'), 'Iv1.abc')
      assert.equal(to.searchParams.get('state'), 'i7')
      // a forged installation id: not among theirs
      const forged = await get(s.port, '/github/callback?installation_id=8&code=c', cookie)
      assert.equal(forged.status, 502)
      assert.match(
        await forged.text(),
        /can&#39;t reach that installation|can't reach that installation/
      )
      // back from the sign-in with the state: theirs
      const ok = await get(s.port, '/github/callback?code=c&state=i7', cookie)
      assert.equal(ok.status, 200)
      assert.match(await ok.text(), /acme/)
      assert.match(ok.headers.get('set-cookie')!, /Max-Age=0/)
      assert.ok(toGitHub.includes('https://github.com/login/oauth/access_token'))
    } finally {
      await s.stop()
    }
  } finally {
    globalThis.fetch = real
  }
})

test('hosted, end to end: the form on the repository the question names, the picker, Start, plain errors', async () => {
  const port = await new Promise<number>((done) => {
    const srv = createServer().listen(0, () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => done(port))
    })
  })
  const db = `sqlite:${join(await mkdtemp(join(tmpdir(), 'consortium-pick-')), 'c.db')}`
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  Object.assign(process.env, {
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    DATABASE_URL: db,
    CONSORTIUM_DATA: await mkdtemp(join(tmpdir(), 'consortium-pick-data-')),
    CONSORTIUM_SECRET: SECRET,
    SLACK_CLIENT_ID: '1.2',
    SLACK_CLIENT_SECRET: 'x',
    SLACK_SIGNING_SECRET: 'x',
    GITHUB_APP_ID: '42',
    GITHUB_APP_SLUG: 'consortium-test',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    GITHUB_APP_CLIENT_ID: 'Iv1.abc',
    GITHUB_APP_CLIENT_SECRET: 'cs'
  })
  // the workspace: installed, a key, GitHub connected, the channel's last repository webchat
  const store = await openStore(db)
  await installations(store, SECRET, async () => {}).storeInstallation({
    team: { id: 'T1', name: 'One' },
    enterprise: undefined,
    user: { id: 'U9', token: undefined, scopes: undefined },
    bot: { token: 'xoxb-one', scopes: SCOPES, id: 'B1', userId: 'UB1' },
    isEnterpriseInstall: false
  } as unknown as Installation)
  await store.put('settings', 'T1', { key: seal('sk-or-v1-test', SECRET, 'T1'), keyHint: 'k' })
  await store.put('github', 'T1', { installation: 7, account: 'connectlyai' })
  await store.put('channel-repos', 'T1', { C1: 'connectlyai/webchat' })
  await store.close()

  // Slack's Web API, its response_urls, GitHub and OpenRouter: all here
  const slack: [string, Record<string, unknown>][] = []
  const realCall = webApi.WebClient.prototype.apiCall
  webApi.WebClient.prototype.apiCall = async function (method, options = {}) {
    slack.push([method, options])
    return { ok: true, ts: '1', permalink: 'p', view: { id: 'V1' } }
  }
  const responded: Record<string, unknown>[] = [] // what went to response_urls
  const hook = 'https://hooks.slack.test'
  const realFetch = globalThis.fetch
  const day = (i: number): string => new Date(Date.UTC(2026, 9, 20 - i)).toISOString()
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith(hook)) {
      responded.push(JSON.parse(String(init?.body)))
      return new Response('ok')
    }
    if (url.endsWith('/app/installations/7/access_tokens')) {
      const asked = JSON.parse(String(init?.body ?? '{}')).repositories?.[0]
      return asked === 'backend' // not one of theirs
        ? Response.json(
            { message: 'There is at least one repository that does not exist' },
            { status: 422 }
          )
        : Response.json({ token: 'ghs_x' })
    }
    if (url.startsWith('https://api.github.com/installation/repositories'))
      return Response.json({
        total_count: ORG.length,
        repositories: ORG.map((full_name, i) => ({
          full_name,
          name: full_name.split('/')[1],
          pushed_at: day(i),
          size: 1
        }))
      })
    if (url === 'https://api.github.com/repos/connectlyai/connectly-backend')
      return Response.json({
        full_name: url.slice(29),
        name: 'connectly-backend',
        size: 400 * 1024
      })
    if (url === 'https://openrouter.ai/api/v1/key') return Response.json({ data: {} })
    return new Response('{"data":[]}')
  }
  const app = await serveHosted()
  const send = (body: Record<string, unknown>): Promise<void> =>
    app.processEvent({ body: { api_app_id: 'A1', token: 'x', ...body }, ack: async () => {} })
  const command = (text: string): Promise<void> =>
    send({
      command: '/consortium',
      text,
      team_id: 'T1',
      user_id: 'U1',
      channel_id: 'C1',
      trigger_id: 'TR1',
      response_url: `${hook}/command`
    })
  const last = (method: string): Record<string, unknown> =>
    slack.findLast(([m]) => m === method)![1]
  try {
    // /consortium <question>: the form, filled in, on the repository the question names
    await command('why does backend retry webhooks twice?')
    // the loading form opens at once (Slack's 3 s), then becomes the real one
    assert.equal((last('views.open').view as types.ModalView).blocks.length, 1)
    const view = last('views.update').view as types.ModalView
    const input = (id: string): types.InputBlock =>
      view.blocks.find((b) => b.block_id === id) as types.InputBlock
    assert.equal(
      (input('question').element as types.PlainTextInput).initial_value,
      'why does backend retry webhooks twice?'
    )
    assert.equal(
      (input('repo').element as types.StaticSelect).initial_option?.value,
      'connectlyai/connectly-backend'
    )
    assert.equal(view.submit?.text, 'Start')
    assert.ok(!slack.some(([m]) => m === 'chat.postMessage')) // nothing started

    // repo: still works, silently: the form opens on it, and one it can't read says so, with near names
    await command('repo:connectlyai/backend why does backend retry webhooks twice?')
    const prefixed = last('views.update').view as types.ModalView
    const repoBlock = prefixed.blocks.find((b) => b.block_id === 'repo') as types.InputBlock
    assert.equal(
      (repoBlock.element as types.StaticSelect).initial_option?.value,
      'connectlyai/backend'
    )
    assert.match(
      JSON.stringify(prefixed.blocks),
      /`connectlyai\/backend` isn't one of the repositories Consortium can read in this workspace\. Did you mean `connectly-backend` or `backend\.claude`\?/
    )

    // a mention: the picker, only for them, on the same repository; nothing starts yet
    await send({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev1',
      event_time: 1,
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@UB1> why does backend retry webhooks twice?',
        ts: '5.1',
        event_ts: '5.1'
      }
    })
    const picker = last('chat.postEphemeral')
    assert.equal(picker.user, 'U1')
    const actions = (picker.blocks as types.KnownBlock[])[1] as types.ActionsBlock
    const select = actions.elements[0] as types.StaticSelect
    assert.equal(select.initial_option?.value, 'connectlyai/connectly-backend')
    const id = (actions.elements[1] as types.Button).value!
    assert.ok(!slack.some(([m]) => m === 'chat.postMessage'))

    // Start: the picker goes, the meeting convenes with the pick (here: too big to read)
    const start = (): Promise<void> =>
      send({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'C1' },
        container: { type: 'message', message_ts: '6', channel_id: 'C1', is_ephemeral: true },
        trigger_id: 'TR2',
        response_url: `${hook}/picker`,
        actions: [
          {
            type: 'button',
            action_id: 'pick_start',
            block_id: actions.block_id,
            value: id,
            action_ts: '1'
          }
        ],
        state: {
          values: {
            [actions.block_id!]: {
              pick_repo: { type: 'static_select', selected_option: select.initial_option }
            }
          }
        }
      })
    await start()
    assert.deepEqual(responded.at(-1), { delete_original: true })
    const said = slack
      .filter(([m]) => m === 'chat.postEphemeral')
      .slice(-2)
      .map(([, o]) => o.text)
    assert.deepEqual(said, [
      ':hourglass_flowing_sand: Getting `connectlyai/connectly-backend` ready…',
      "Can't convene: `connectlyai/connectly-backend` is about 400 MB; the table reads repositories up to 300 MB."
    ])
    await start() // once only
    assert.match(String(responded.at(-1)?.text), /expired: mention me again/)
  } finally {
    await app.stop()
    globalThis.fetch = realFetch
    webApi.WebClient.prototype.apiCall = realCall
    for (const k of [
      'GITHUB_APP_ID',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET'
    ])
      delete process.env[k]
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { types } from '@slack/bolt'
import {
  MAX_DRAFTS,
  createIssues,
  decisionTitle,
  footer,
  issueArgs,
  issueRef,
  issuesLine,
  issuesModal,
  linearLists,
  linearOf,
  linearTools,
  listArgs,
  nextActions,
  once,
  parseDrafts,
  parseItems,
  plainDrafts,
  readIssues,
  resultModal,
  withFooter,
  type Created
} from '../src/main/issues'
import { openStore } from '../src/main/store'

const DECISION = `# Consortium: Retry webhooks once
## Recommendation
Retry once with a jittered backoff [T2].
## Trade-offs
Fewer duplicates, slower recovery.
## Next actions
1. Add an idempotency key to the webhook sender [T3, T5].
2. Cap retries at one,
   with jitter between 1 and 5 s.
- Alert when the retry queue tops 1,000 [T4]
## Unresolved questions
None.`

test('drafts: the decision’s next actions, the clerk’s answer, a fallback', () => {
  assert.deepEqual(nextActions(DECISION), [
    'Add an idempotency key to the webhook sender.',
    'Cap retries at one, with jitter between 1 and 5 s.',
    'Alert when the retry queue tops 1,000'
  ])
  assert.deepEqual(nextActions('# X\n## Recommendation\nNothing to do.'), [])
  assert.equal(decisionTitle(DECISION), 'Retry webhooks once')

  // the clerk's answer, fenced and chatty, one item broken, a title too long
  const text = `Here you go:\n\`\`\`json\n[{"title":"Add idempotency keys","description":"So retries never double-charge."},{"nope":1},{"title":"${'x'.repeat(120)}","description":""}]\n\`\`\``
  const drafts = parseDrafts(text)
  assert.equal(drafts.length, 2)
  assert.deepEqual(drafts[0], {
    title: 'Add idempotency keys',
    description: 'So retries never double-charge.'
  })
  assert.equal(drafts[1].title.length, 80)
  assert.deepEqual(parseDrafts('no JSON at all'), [])
  assert.deepEqual(parseDrafts('{"title":"not a list"}'), [])
  assert.equal(parseDrafts(JSON.stringify(Array(30).fill({ title: 't' }))).length, MAX_DRAFTS)
  assert.deepEqual(plainDrafts(['Ship it'])[0], { title: 'Ship it', description: 'Ship it' })

  // where it came from, under each description, within Slack's 3,000
  const foot = footer({ decision: 'Retry webhooks once', link: 'https://s/p1', by: 'Ada' })
  assert.equal(
    foot,
    'From the Consortium decision “Retry webhooks once”: https://s/p1\nRequested by Ada in Slack.'
  )
  const d = withFooter({ title: 't', description: 'y'.repeat(5000) }, foot)
  assert.ok(d.description.length <= 3000 && d.description.endsWith(foot))
})

// Linear's tools as the workspace's connection stored them (2026-10)
const STORED =
  'get_issue list_issues save_issue list_issue_labels save_issue_label create_issue_label list_projects get_project save_project list_teams get_team'
    .split(' ')
    .map((name) => ({ name, readOnly: !name.startsWith('save') && !name.startsWith('create') }))

test("Linear's tools found by name: save_issue now, create_issue before, never a label's", () => {
  assert.deepEqual(linearTools(STORED), {
    create: 'save_issue',
    teams: 'list_teams',
    projects: 'list_projects'
  })
  assert.equal(
    linearTools([{ name: 'create_issue' }, { name: 'save_issue' }])?.create,
    'create_issue'
  )
  assert.equal(linearTools([{ name: 'create_issue_label' }, { name: 'list_teams' }]), undefined)
  const linear = {
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth' as const
  }
  assert.equal(linearOf([{ ...linear, secret: 's', tools: STORED }])?.id, 'linear')
  assert.equal(linearOf([{ ...linear, tools: STORED }]), undefined) // not authorized
  assert.equal(
    linearOf([{ ...linear, secret: 's', tools: [{ name: 'list_issues', readOnly: true }] }]),
    undefined
  )

  // the arguments in the schema's own names, and never an id (save_issue would update that issue)
  const save = { properties: { id: {}, title: {}, description: {}, team: {}, project: {} } }
  assert.deepEqual(issueArgs(save, { title: 'T', description: 'D' }, 'team-1', 'proj-1'), {
    title: 'T',
    description: 'D',
    team: 'team-1',
    project: 'proj-1'
  })
  assert.deepEqual(
    issueArgs(
      { properties: { title: {}, teamId: {}, projectId: {} } },
      { title: 'T', description: 'D' },
      'team-1'
    ),
    {
      title: 'T',
      teamId: 'team-1'
    }
  )
  assert.deepEqual(listArgs({ properties: { query: {}, limit: { type: 'number' } } }), {
    limit: 100
  })
  assert.deepEqual(listArgs({}), {})

  // answers: lists however nested; the created issue's identifier and link
  assert.deepEqual(
    parseItems(
      '{"teams":[{"id":"t1","name":"Eng","organization":{"id":"o","name":"Acme"}},{"id":"t2","name":"Ops"}]}'
    ),
    [
      { id: 't1', name: 'Eng' },
      { id: 't2', name: 'Ops' }
    ]
  )
  assert.deepEqual(parseItems('Teams: none'), [])
  assert.deepEqual(
    issueRef(
      '{"issue":{"id":"u","identifier":"ENG-42","url":"https://linear.app/acme/issue/ENG-42/x"}}'
    ),
    {
      identifier: 'ENG-42',
      url: 'https://linear.app/acme/issue/ENG-42/x'
    }
  )
  assert.deepEqual(issueRef('Created ENG-7: https://linear.app/acme/issue/ENG-7'), {
    identifier: 'ENG-7',
    url: 'https://linear.app/acme/issue/ENG-7'
  })
})

// Linear's MCP server, as small as the protocol allows: what it was called with, kept
async function fakeLinear(): Promise<{
  url: string
  calls: { name: string; args: Record<string, unknown> }[]
  close(): void
}> {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const tools = [
    {
      name: 'list_teams',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
    },
    {
      name: 'list_projects',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
    },
    {
      name: 'save_issue',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          team: { type: 'string' },
          project: { type: 'string' }
        }
      }
    }
  ]
  let n = 0
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') return void res.writeHead(405).end()
    let body = ''
    for await (const c of req) body += c
    const m = JSON.parse(body)
    if (m.id === undefined) return void res.writeHead(202).end()
    const reply = (result: object): void =>
      void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
    const text = (t: string, isError = false): void =>
      reply({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })
    if (m.method === 'initialize')
      return reply({
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'linear', version: '1' }
      })
    if (m.method === 'tools/list') return reply({ tools })
    const { name, arguments: args } = m.params
    calls.push({ name, args })
    if (name === 'list_teams') return text(JSON.stringify([{ id: 't1', name: 'Eng' }]))
    if (name === 'list_projects')
      return text(JSON.stringify({ projects: [{ id: 'p1', name: 'Webhooks' }] }))
    if (String(args.title).includes('FAIL'))
      return text('Argument Validation Error: team not found', true)
    n++
    text(JSON.stringify({ identifier: `ENG-${n}`, url: `https://linear.app/acme/issue/ENG-${n}` }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    calls,
    close: () => void server.close()
  }
}

test("the server creates the issues with Linear's own tool, one call each; failures in Linear's words", async () => {
  const linear = await fakeLinear()
  const s = { url: linear.url, headers: { authorization: 'Bearer lin_x' } }
  try {
    const lists = await linearLists(s, fetch)
    assert.deepEqual(lists, {
      teams: [{ id: 't1', name: 'Eng' }],
      projects: [{ id: 'p1', name: 'Webhooks' }]
    })
    assert.deepEqual(linear.calls.map((c) => [c.name, c.args]).sort(), [
      ['list_projects', { limit: 100 }],
      ['list_teams', { limit: 100 }]
    ])
    linear.calls.length = 0
    const made = await createIssues(
      s,
      [
        { title: 'Add idempotency keys', description: 'So retries never double-charge.' },
        { title: 'FAIL this one', description: '' },
        { title: 'Alert on the queue', description: 'Over 1,000.' }
      ],
      't1',
      'p1',
      fetch
    )
    assert.deepEqual(linear.calls, [
      {
        name: 'save_issue',
        args: {
          title: 'Add idempotency keys',
          description: 'So retries never double-charge.',
          team: 't1',
          project: 'p1'
        }
      },
      { name: 'save_issue', args: { title: 'FAIL this one', team: 't1', project: 'p1' } },
      {
        name: 'save_issue',
        args: { title: 'Alert on the queue', description: 'Over 1,000.', team: 't1', project: 'p1' }
      }
    ])
    assert.deepEqual(made, {
      created: [
        {
          title: 'Add idempotency keys',
          identifier: 'ENG-1',
          url: 'https://linear.app/acme/issue/ENG-1'
        },
        {
          title: 'Alert on the queue',
          identifier: 'ENG-2',
          url: 'https://linear.app/acme/issue/ENG-2'
        }
      ],
      failed: [
        {
          title: 'FAIL this one',
          error: 'The tool reported an error: Argument Validation Error: team not found'
        }
      ]
    })
    const line = issuesLine({ by: 'U1', at: 1, ...made, done: true })
    assert.match(
      line,
      /<@U1> created 2 Linear issues from this decision: <https:\/\/linear\.app\/acme\/issue\/ENG-1\|ENG-1> Add idempotency keys/
    )
    assert.match(
      line,
      /Linear didn't take these:\n• FAIL this one: The tool reported an error: Argument Validation Error/
    )
  } finally {
    linear.close()
  }
})

test('once per decision: a double click, a second person, a restart never make them twice', async () => {
  const store = await openStore('sqlite::memory:')
  let made = 0
  const make = async (): Promise<Created> => {
    made++
    await new Promise((r) => setTimeout(r, 20))
    return { created: [{ title: 'A', identifier: 'ENG-1' }], failed: [] }
  }
  const [a, b] = await Promise.all([
    once(store, 'T1:M1', 'U1', make, 5),
    once(store, 'T1:M1', 'U2', make, 6)
  ])
  assert.equal(made, 1)
  assert.deepEqual([a.fresh, b.fresh], [true, false])
  assert.deepEqual(b.rec, {
    by: 'U1',
    at: 5,
    created: [{ title: 'A', identifier: 'ENG-1' }],
    failed: [],
    done: true
  })
  const later = await once(store, 'T1:M1', 'U3', make)
  assert.equal(made, 1)
  assert.equal(later.fresh, false)
  assert.equal((await once(store, 'T1:M2', 'U1', make)).fresh, true) // another decision
  assert.equal(made, 2)

  // Linear didn't connect: nothing was made, so nothing is kept and it can be tried again
  await assert.rejects(
    once(store, 'T1:M3', 'U1', async () => {
      throw new Error('Connecting took over 15 s')
    }),
    /Connecting/
  )
  assert.equal(await store.get('linear-issues', 'T1:M3'), undefined)
  // cut off midway (a restart): the record stays without `done`, and says so instead of retrying
  await store.put('linear-issues', 'T1:M4', { by: 'U1', at: 1 })
  const cut = await once(store, 'T1:M4', 'U2', make)
  assert.equal(made, 2)
  assert.match(JSON.stringify(resultModal(cut.rec)), /cut off midway.*won't create them again/)
  await store.close()
})

// Slack's limits on a view: blocks, texts, options, inputs' lengths
function viewValid(v: types.ModalView): void {
  assert.ok(v.blocks.length <= 100, `${v.blocks.length} blocks`)
  assert.ok(v.title.text.length <= 24, v.title.text)
  assert.ok((v.private_metadata ?? '').length <= 3000)
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (!x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if (o.type === 'section') assert.ok((o.text as { text: string }).text.length <= 3000, 'section')
    if (o.type === 'mrkdwn' || o.type === 'plain_text') assert.ok(String(o.text).length <= 3000)
    if (o.type === 'static_select') assert.ok((o.options as unknown[]).length <= 100, 'options')
    if (o.type === 'plain_text_input' && o.initial_value)
      assert.ok(String(o.initial_value).length <= Number(o.max_length ?? 3000), 'initial_value')
    if (Array.isArray(o.options))
      for (const p of o.options as { text: { text: string } }[]) assert.ok(p.text.text.length <= 75)
    Object.values(o).forEach(walk)
  }
  walk(v.blocks)
}

test("the issues modal: within Slack's limits, its answers read back", () => {
  const long = 'z'.repeat(4000)
  const v = issuesModal({
    drafts: Array.from({ length: 14 }, (_, i) => ({
      title: `Issue ${i} ${long}`,
      description: long
    })),
    teams: Array.from({ length: 150 }, (_, i) => ({ id: `t${i}`, name: `Team ${i} ${long}` })),
    projects: [{ id: 'p1', name: 'Webhooks' }],
    meta: { thread: '1.5', id: 'M1', channel: 'C1', message: '9.9' },
    decision: long
  })
  viewValid(v)
  assert.equal(v.blocks.filter((b) => b.block_id?.startsWith('pick')).length, MAX_DRAFTS)
  const meta = JSON.parse(v.private_metadata!)
  assert.deepEqual(meta, { thread: '1.5', id: 'M1', channel: 'C1', message: '9.9', n: MAX_DRAFTS })
  // one team: picked already
  const one = issuesModal({
    drafts: [{ title: 't', description: 'd' }],
    teams: [{ id: 't1', name: 'Eng' }],
    projects: [],
    meta,
    decision: 'd'
  })
  const team = one.blocks.find((b) => b.block_id === 'team') as types.InputBlock
  assert.equal((team.element as types.StaticSelect).initial_option?.value, 't1')
  assert.ok(!one.blocks.some((b) => b.block_id === 'project'))

  const yes = { selected_options: [{ value: 'yes' }] }
  assert.deepEqual(
    readIssues(
      {
        team: { team: { selected_option: { value: 't1' } } },
        project: { project: { selected_option: null } },
        pick0: { pick: yes },
        title0: { title: { value: '  Add keys  ' } },
        desc0: { desc: { value: 'Why.\n' } },
        pick1: { pick: { selected_options: [] } },
        title1: { title: { value: 'Skipped' } }
      },
      2
    ),
    { team: 't1', drafts: [{ title: 'Add keys', description: 'Why.' }] }
  )
  assert.deepEqual(readIssues({ pick0: { pick: yes }, title0: { title: { value: '' } } }, 1), {
    errors: { title0: 'Give it a title, or uncheck it.', team: 'Pick the team the issues go to.' }
  })
  assert.deepEqual(readIssues({ team: { team: { selected_option: { value: 't1' } } } }, 2), {
    errors: { pick0: 'Check at least one issue.' }
  })

  // the result, however many failed and however long Linear's words
  const result = resultModal({
    by: 'U1',
    at: 1,
    done: true,
    created: Array.from({ length: 10 }, (_, i) => ({
      title: long,
      identifier: `ENG-${i}`,
      url: 'https://linear.app/x'
    })),
    failed: Array.from({ length: 10 }, () => ({ title: long, error: long }))
  })
  viewValid(result)
  assert.ok(
    issuesLine({
      by: 'U1',
      at: 1,
      created: [{ title: long }],
      failed: [{ title: long, error: long }]
    }).length <= 3000
  )
})

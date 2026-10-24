import { execFile } from 'node:child_process'
import { createSign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

// Repositories the hosted table can read: one GitHub App (Contents and Metadata, read-only) that
// each workspace installs on its own GitHub account or org. Everything goes through short-lived
// installation tokens, and a token never touches the disk.

export type GitHubApp = {
  id: string
  slug: string
  key: string // the app's private key (PEM)
  clientId: string // the client id and secret check who connects an installation (see installationsOf)
  clientSecret: string
}

// Set up = all five variables; without them the repository feature is hidden.
export function githubApp(e: NodeJS.ProcessEnv = process.env): GitHubApp | undefined {
  const id = e.GITHUB_APP_ID
  const slug = e.GITHUB_APP_SLUG
  const key = e.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n') // pasted on one line with \n
  const clientId = e.GITHUB_APP_CLIENT_ID
  const clientSecret = e.GITHUB_APP_CLIENT_SECRET
  return id && slug && key && clientId && clientSecret
    ? { id, slug, key, clientId, clientSecret }
    : undefined
}

// What /github/setup posts to GitHub to create the app (GitHub's app-manifest flow). It asks the
// installer to sign in too, which proves the installation is theirs; no webhooks.
export const appManifest = (base: string): object => ({
  name: 'Consortium for Slack',
  url: base,
  hook_attributes: { url: `${base}/github/webhook`, active: false },
  redirect_url: `${base}/github/created`,
  callback_urls: [`${base}/github/callback`],
  request_oauth_on_install: true,
  public: true,
  default_permissions: { contents: 'read', metadata: 'read' },
  default_events: []
})

// The app's own token, for ten minutes (GitHub's limit), backdated for clock drift.
export function appJwt(app: Pick<GitHubApp, 'id' | 'key'>, now = Date.now()): string {
  const enc = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const t = Math.floor(now / 1000)
  const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: t - 60, exp: t + 540, iss: app.id })}`
  return `${body}.${createSign('RSA-SHA256').update(body).sign(app.key, 'base64url')}`
}

async function gh<T>(path: string, auth?: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path.startsWith('https:') ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'consortium-slack',
      'x-github-api-version': '2022-11-28',
      ...(auth && { authorization: auth }),
      ...(init.body ? { 'content-type': 'application/json' } : {})
    },
    signal: AbortSignal.timeout(15_000)
  })
  const j = (await r.json().catch(() => ({}))) as T & { message?: string }
  if (!r.ok) throw new Error(`GitHub answered ${r.status}${j.message ? `: ${j.message}` : ''}`)
  return j
}

export type Created = {
  id: number
  slug: string
  pem: string
  client_id: string
  client_secret: string
  html_url: string
}
// The app GitHub just created from the manifest; its code works once, for an hour.
export const convertManifest = (code: string): Promise<Created> =>
  gh(`/app-manifests/${encodeURIComponent(code)}/conversions`, undefined, { method: 'POST' })

// An installation token, for an hour; `repos` narrows it to those repositories (names, no owner).
export async function installationToken(
  app: GitHubApp,
  installation: number,
  repos?: string[]
): Promise<string> {
  const r = await gh<{ token: string }>(
    `/app/installations/${installation}/access_tokens`,
    `Bearer ${appJwt(app)}`,
    { method: 'POST', body: JSON.stringify(repos ? { repositories: repos } : {}) }
  )
  return r.token
}

export type Repo = {
  full_name: string
  name: string
  pushed_at: string | null
  size: number // KB
  default_branch?: string
}

// The installation's repositories, most recently pushed first (up to 500 looked at).
export async function listRepos(token: string): Promise<{ total: number; repos: Repo[] }> {
  const repos: Repo[] = []
  let total = 0
  for (let page = 1; page <= 5; page++) {
    const r = await gh<{ total_count: number; repositories: Repo[] }>(
      `/installation/repositories?per_page=100&page=${page}`,
      `Bearer ${token}`
    )
    total = r.total_count
    repos.push(...r.repositories)
    if (repos.length >= total || r.repositories.length < 100) break
  }
  repos.sort((a, b) => (b.pushed_at ?? '').localeCompare(a.pushed_at ?? ''))
  return { total, repos }
}

export const getRepo = (token: string, full: string): Promise<Repo> =>
  gh(`/repos/${full}`, `Bearer ${token}`)

// The installations of this app the person signing in can reach: the code is the one GitHub
// sends back after they install (or sign in). Their token is used for this one call, never kept.
// ponytail: it expires on its own (8 h); revoke it (DELETE /applications/{id}/token) if that matters
export async function installationsOf(
  app: GitHubApp,
  code: string
): Promise<{ id: number; account: string }[]> {
  const t = await gh<{ access_token?: string; error_description?: string }>(
    'https://github.com/login/oauth/access_token',
    undefined,
    {
      method: 'POST',
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code })
    }
  )
  if (!t.access_token) throw new Error(t.error_description ?? 'GitHub gave no sign-in token')
  const r = await gh<{ installations: { id: number; account?: { login?: string } }[] }>(
    '/user/installations?per_page=100',
    `Bearer ${t.access_token}`
  )
  return r.installations.map((i) => ({ id: i.id, account: i.account?.login ?? '' }))
}

export const MAX_REPO_KB = 300 * 1024 // GitHub's repo.size is in KB

// A shallow clone: the last 50 commits of the default branch, big blobs of older commits left out.
export const cloneArgs = (url: string, into: string): string[] => [
  '-c',
  'pack.threads=1', // index-pack's memory on a 512 MB instance
  'clone',
  '--quiet',
  '--depth',
  '50',
  '--single-branch',
  '--no-tags',
  '--filter=blob:limit=1m',
  '--',
  url,
  into
]

// The token rides as an HTTP header in git's environment for this one process: never in argv
// (ps shows it), never in .git/config, never in the remote URL.
export function cloneEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    PATH: process.env.PATH,
    HOME: tmpdir(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  }
}

export async function clone(token: string, url: string, into: string): Promise<void> {
  try {
    await promisify(execFile)('git', cloneArgs(url, into), {
      env: cloneEnv(token),
      timeout: 180_000,
      maxBuffer: 1 << 20
    })
  } catch (e) {
    const err = e as { stderr?: string; message?: string; killed?: boolean }
    throw new Error(
      err.killed
        ? 'the clone took over 3 minutes'
        : `git clone failed: ${(err.stderr || err.message || '').trim().slice(0, 300)}`
    )
  }
}

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { Installation, InstallationQuery, InstallationStore } from '@slack/bolt'

// What the hosted Slack app keeps: one table, `docs`, of (kind, id) → JSON. Postgres when
// DATABASE_URL is postgres://…; otherwise SQLite (node:sqlite) at that path, or "sqlite::memory:".

export type Store = {
  get<T>(kind: string, id: string): Promise<T | undefined>
  put(kind: string, id: string, value: unknown): Promise<void>
  del(kind: string, id: string): Promise<void>
  close(): Promise<void>
}

const TABLE =
  'create table if not exists docs (kind text not null, id text not null, value text not null, primary key (kind, id))'

export async function openStore(url: string): Promise<Store> {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: url })
    await pool.query(TABLE)
    return {
      get: async (kind, id) => {
        const r = await pool.query('select value from docs where kind = $1 and id = $2', [kind, id])
        return r.rows[0] ? JSON.parse(r.rows[0].value) : undefined
      },
      put: async (kind, id, value) => {
        await pool.query(
          'insert into docs values ($1, $2, $3) on conflict (kind, id) do update set value = excluded.value',
          [kind, id, JSON.stringify(value)]
        )
      },
      del: async (kind, id) => {
        await pool.query('delete from docs where kind = $1 and id = $2', [kind, id])
      },
      close: () => pool.end()
    }
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(url.replace(/^sqlite:(\/\/)?/, ''))
  db.exec(TABLE)
  const get = db.prepare('select value from docs where kind = ? and id = ?')
  const put = db.prepare(
    'insert into docs values (?, ?, ?) on conflict (kind, id) do update set value = excluded.value'
  )
  const del = db.prepare('delete from docs where kind = ? and id = ?')
  return {
    get: async (kind, id) => {
      const row = get.get(kind, id) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    },
    put: async (kind, id, value) => void put.run(kind, id, JSON.stringify(value)),
    del: async (kind, id) => void del.run(kind, id),
    close: async () => db.close()
  }
}

// ---------- secrets at rest ----------

// One server secret (CONSORTIUM_SECRET), a separate key derived from it for each use.
export const derive = (secret: string, use: string): Buffer =>
  Buffer.from(hkdfSync('sha256', secret, '', `consortium:${use}`, 32))

// AES-256-GCM. `bound` (the workspace id) is authenticated with it, so a sealed value copied to
// another workspace's row won't open.
export function seal(plain: string, secret: string, bound: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', derive(secret, 'seal'), iv)
  c.setAAD(Buffer.from(bound))
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', ...[iv, c.getAuthTag(), body].map((b) => b.toString('base64url'))].join('.')
}

export function unseal(sealed: string, secret: string, bound: string): string {
  const [v, iv, tag, body] = sealed.split('.')
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('not a sealed value')
  const d = createDecipheriv('aes-256-gcm', derive(secret, 'seal'), Buffer.from(iv, 'base64url'))
  d.setAAD(Buffer.from(bound))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8')
}

// ---------- Slack installations ----------

// The workspace an installation, an event or a query belongs to (org-wide installs: the org).
export const tenantOf = (q: {
  isEnterpriseInstall?: boolean
  enterpriseId?: string
  teamId?: string
}): string => (q.isEnterpriseInstall ? q.enterpriseId : q.teamId) ?? ''

// Bolt's OAuth installations, sealed: each holds the workspace's bot token.
export function installations(
  store: Store,
  secret: string,
  onInstall: (tenant: string, i: Installation) => Promise<void> = async () => {}
): InstallationStore {
  const id = (i: Installation): string =>
    tenantOf({
      isEnterpriseInstall: i.isEnterpriseInstall,
      enterpriseId: i.enterprise?.id,
      teamId: i.team?.id
    })
  return {
    storeInstallation: async (i) => {
      const t = id(i as Installation)
      await store.put('installation', t, seal(JSON.stringify(i), secret, t))
      await onInstall(t, i as Installation)
    },
    fetchInstallation: async (q: InstallationQuery<boolean>) => {
      const t = tenantOf(q)
      const sealed = await store.get<string>('installation', t)
      if (!sealed) throw new Error(`no installation for ${t}`)
      return JSON.parse(unseal(sealed, secret, t))
    },
    deleteInstallation: async (q: InstallationQuery<boolean>) =>
      store.del('installation', tenantOf(q))
  }
}

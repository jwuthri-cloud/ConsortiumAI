import { extname } from 'node:path'

// What someone attached to a question in Slack, made readable for the table: text and code as
// files the seats read, a PDF as its text, an image as a picture for the seats that see and a
// description for the rest. Slack hands a file over to the bot token only (files:read).

export type SlackFile = {
  id?: string
  name?: string | null
  title?: string | null
  mimetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
}

export const MAX_FILES = 10 // Slack's file_input takes 10 as well
export const MAX_BYTES = 20 << 20 // a file
export const MAX_IMAGE = 5 << 20 // the most every provider takes in one image (Anthropic's cap)
export const MAX_PIXELS = 15 << 20 // the images seats see, all together: every turn sends them again
const INLINE = 20_000 // characters of a file added to a meeting in its thread

const TEXT =
  /^(md|markdown|mdx|txt|text|csv|tsv|json|jsonl|ndjson|yaml|yml|toml|ini|cfg|conf|properties|xml|html?|css|scss|less|m?jsx?|cjs|tsx?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|sql|sh|bash|zsh|fish|ps1|r|lua|pl|scala|dart|vue|svelte|graphql|gql|proto|tf|hcl|dockerfile|makefile|gradle|log|diff|patch|rst|tex|adoc|svg)$/
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/

export type Kind = 'text' | 'image' | 'pdf'

// By name first: Slack calls a .ts file video/mp2t.
export function kindOf(f: SlackFile): Kind | undefined {
  const name = (f.name ?? '').toLowerCase()
  const ext = extname(name).slice(1) || name // Dockerfile, Makefile
  const mime = f.mimetype ?? ''
  if (TEXT.test(ext)) return 'text'
  if (IMAGE.test(mime)) return 'image'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (/^text\/|json|xml|yaml|javascript|typescript|x-sh|sql|csv/.test(mime)) return 'text'
  return undefined
}

export type Planned = { file: SlackFile; kind: Kind; name: string }

// The files a question takes, each with a safe, unique name, and what's left out and why.
export function plan(files: SlackFile[]): { take: Planned[]; skipped: string[] } {
  const take: Planned[] = []
  const skipped: string[] = []
  const used = new Set<string>()
  for (const file of files) {
    const label = file.name || file.title || 'a file'
    const kind = kindOf(file)
    const size = file.size ?? 0
    if (take.length >= MAX_FILES) skipped.push(`${label} (${MAX_FILES} files a question at most)`)
    else if (!kind) skipped.push(`${label} (not text, code, a PDF or an image)`)
    else if (size > MAX_BYTES) skipped.push(`${label} (over 20 MB)`)
    else if (kind === 'image' && size > MAX_IMAGE) skipped.push(`${label} (images up to 5 MB)`)
    else take.push({ file, kind, name: safeName(label, used) })
  }
  return { take, skipped }
}

function safeName(label: string, used: Set<string>): string {
  const base =
    label
      .split(/[/\\]/)
      .pop()!
      .replace(/[^\w.\- ()]+/g, '_')
      .replace(/^[.\s]+/, '')
      .slice(-100) || 'file'
  let name = base
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${i}-${base}`
  used.add(name.toLowerCase())
  return name
}

// The file's bytes, with the bot token, which only ever goes to Slack's file host.
export async function download(f: SlackFile, token: string): Promise<Buffer> {
  const url = f.url_private_download ?? f.url_private ?? ''
  if (!/^https:\/\/files\.slack\.com\//.test(url)) throw new Error('Slack gave no download link')
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000)
  })
  if (!r.ok) throw new Error(`Slack answered ${r.status}`)
  // without files:read Slack answers with its sign-in page
  if (/text\/html/.test(r.headers.get('content-type') ?? '') && !/\.html?$/i.test(f.name ?? ''))
    throw new Error("Slack didn't hand it over")
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('over 20 MB')
  return buf
}

type Chat = {
  choices?: { message?: { content?: string; annotations?: Annotation[] } }[]
  error?: { message?: string; metadata?: { file_annotations?: Annotation[] } }
}
type Annotation = { type?: string; file?: { content?: { type?: string; text?: string }[] } }

export async function chat(key: string, body: object, ms: number): Promise<Chat> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms)
  })
  const j = (await r.json().catch(() => ({}))) as Chat
  if (!r.ok && !j.error?.metadata?.file_annotations)
    throw new Error(
      `OpenRouter answered ${r.status}${j.error?.message ? `: ${j.error.message}` : ''}`
    )
  return j
}

// A PDF's text, from OpenRouter's PDF parser (its free engine). The parsed text comes back as the
// response's file annotations, so the model only has to say a word.
export async function pdfText(
  pdf: Buffer,
  name: string,
  key: string,
  model: string
): Promise<string> {
  const j = await chat(
    key,
    {
      model,
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with OK.' },
            {
              type: 'file',
              file: {
                filename: name,
                file_data: `data:application/pdf;base64,${pdf.toString('base64')}`
              }
            }
          ]
        }
      ],
      plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]
    },
    120_000
  )
  const notes = j.choices?.[0]?.message?.annotations ?? j.error?.metadata?.file_annotations ?? []
  return notes
    .flatMap((a) => (a.type === 'file' ? (a.file?.content ?? []) : []))
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('\n\n')
    .trim()
}

// An image said in words, once, for the seats and the clerk that can't see it.
export async function describe(
  image: string,
  key: string,
  model: string,
  question: string
): Promise<string> {
  const j = await chat(
    key,
    {
      model,
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Someone attached this image to a question for a panel of advisers who can't see it. Describe it for them in under 150 words: what kind of image it is, what it shows, and any text, numbers or labels in it word for word. No preamble.\n\nThe question: ${question}`
            },
            { type: 'image_url', image_url: { url: image } }
          ]
        }
      ]
    },
    60_000
  )
  return (j.choices?.[0]?.message?.content ?? '').trim()
}

// One attached file, readable: `text` (a text file, or a PDF's text), or `image` (a data URL)
// and its `description`. `file`: the name to save the text under.
export type Got = {
  name: string
  file?: string
  text?: string
  image?: string
  description?: string
}

export async function gather(
  files: SlackFile[],
  o: { token: string; key: string; reader: string; describer?: string; question: string }
): Promise<{ got: Got[]; skipped: string[] }> {
  const { take, skipped } = plan(files)
  const got = await Promise.all(
    take.map(async ({ file, kind, name }): Promise<Got | string> => {
      try {
        const buf = await download(file, o.token)
        if (kind === 'text') {
          if (buf.subarray(0, 8000).includes(0)) return `${name} (not a text file)`
          return { name, file: name, text: buf.toString('utf8') }
        }
        if (kind === 'pdf') {
          const text = await pdfText(buf, name, o.key, o.reader)
          return text ? { name, file: `${name}.txt`, text } : `${name} (no text found in it)`
        }
        const image = `data:${file.mimetype};base64,${buf.toString('base64')}`
        const description = o.describer
          ? await describe(image, o.key, o.describer, o.question).catch(() => undefined)
          : undefined
        return { name, image, description }
      } catch (e) {
        return `${name} (${e instanceof Error ? e.message : e})`
      }
    })
  )
  return {
    got: got.filter((g): g is Got => typeof g !== 'string'),
    skipped: [...skipped, ...got.filter((g): g is string => typeof g === 'string')]
  }
}

// The images seats are shown, in order, within MAX_PIXELS; the rest go by their description.
export function pixels(got: Got[]): string[] {
  let total = 0
  return got.flatMap((g) => {
    if (!g.image || total + g.image.length * 0.75 > MAX_PIXELS) return []
    total += g.image.length * 0.75
    return [g.image]
  })
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// The question, with the images' descriptions for whoever can't see them.
export function withImages(question: string, got: Got[]): string {
  const d = got.filter((g) => g.description).map((g) => `- ${g.name}: ${oneLine(g.description!)}`)
  return d.length
    ? `${question}\n\nImages the human attached, as a vision model described them (members who can see images also get the images):\n${d.join('\n')}`
    : question
}

// Files added in a meeting's thread, as text for the host's message: what each says, cut short.
export function inline(got: Got[], skipped: string[]): string {
  const cut = (s: string): string =>
    s.length > INLINE ? `${s.slice(0, INLINE)}\n… (${s.length - INLINE} more characters cut)` : s
  const parts = got.map((g) =>
    g.text !== undefined
      ? `### ${g.name}\n\`\`\`\n${cut(g.text)}\n\`\`\``
      : `### ${g.name} (an image, described)\n${g.description || 'No description could be made.'}`
  )
  if (skipped.length) parts.push(`Not attached: ${skipped.join('; ')}`)
  return parts.length ? `The human attached:\n\n${parts.join('\n\n')}` : ''
}

const mrkdwn = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// What a meeting's root message says it has: the repository, the files, and what was left out.
export function attachedLine(
  repo: string | null | undefined,
  names: string[],
  skipped: string[]
): string {
  const has = [
    repo && `*Repository* \`${mrkdwn(repo)}\``,
    names.length && `*Files* ${names.map(mrkdwn).join(', ')}`
  ].filter(Boolean)
  return [
    has.length ? `:paperclip: ${has.join(' · ')}` : '',
    skipped.length ? `_Left out: ${mrkdwn(skipped.join('; '))}_` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

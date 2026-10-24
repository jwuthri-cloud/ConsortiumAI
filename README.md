# Consortium

One question. Several AI members that disagree on purpose — each one a coding-agent CLI you already pay for (Claude Code, Codex, Gemini CLI, Grok Build). They sit at a table and talk it through in short turns — opening statements, then real back-and-forth, then a forced convergence — and a chair writes the **consortium**: one decision document with the rationale, a plan, and the dissent kept in.

Local-first desktop app (Electron). No accounts, no server: the app spawns the CLIs that are already signed in on your machine. An optional fifth seat, the **Deep-agent**, runs on an API key instead.

## Setup

```bash
npm install
```

Sign in to the CLIs you want at the table (each one's own flow — the app never touches credentials):

| CLI         | Install                                         | Sign in                 |
| ----------- | ----------------------------------------------- | ----------------------- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| sh` | `claude` → `/login`     |
| Codex       | `npm i -g @openai/codex`                        | `codex login`           |
| Grok Build  | see x.ai                                        | `grok login`            |
| Gemini CLI  | `npm i -g @google/gemini-cli`                   | `gemini` → Google login |

Any seat whose CLI is not signed in simply reports the CLI's own error on the table.

## Run

```bash
npm run dev
```

This launches the real Electron desktop app. It uses the same React/Three.js interface as the browser preview, with the preload IPC bridge connected to the installed agent CLIs, folder picker, and saved sessions. Opening the Vite URL in a browser instead uses scripted demo responses.

If an already-running development window still shows an older interface, finish the current discussion, then use **View → Reload** (`⌘R` on macOS) and reopen the saved session. To create an updated standalone macOS app, run `npm run build:mac`.

1. **Convene** — write the question, optionally attach a project folder (members then inspect it read-only before they argue), pick seats (persona · CLI · model), a chair, and a turn budget (20 / 30 / 50 turns across all members). "Check" runs a one-word prompt through a seat's CLI to prove it answers.
2. **Chamber** — a meeting room with real-time 3D agent mascots. Provider colors and clothing identify Anthropic, OpenAI, Google, or xAI; each cap displays the seat’s role and the suit badge shows the actual model, including automatically selected CLI defaults, without thinking or context-budget annotations. Drag a character or use arrow keys to rotate it; double-click or press Home to reset. Use gallery view or spotlight a participant with its expand button. Speaker view follows the active member unless pinned. Conversation and Decision tabs hold the live transcript and clerk’s notes. While a seat prepares, the room shows connection, preparation, reading/searching, tool use, and response states from CLI events, plus elapsed time and the next seat. Raw reasoning and tool logs stay out of these status indicators. A quiet agent is labelled honestly when no update arrives. Send context to interrupt the active response immediately, or end the session. Choose “Read the decision” when the chair finishes.

   The mascots are procedural Three.js meshes rendered locally, with blinking, idle motion, and speaking gestures. They do not use image-generated portraits or remote assets. Reduced-motion settings suppress animation; offscreen/hidden views skip rendering. A text fallback appears when WebGL is unavailable.

3. **Consortium** — the chair's document, with the agreement matrix and the panel. Saved as markdown to `<project>/consortium/<question>-<date>.md` (or the app's data folder when no project is attached).

Members only ever see each other's persona ("The Skeptic"), never which model sits behind a seat. The turn budget drives the phases: the first cycle is openings, then free debate until 60% of the budget, then _converge_ (only the open points, concede where persuaded, no new topics), and the last cycle is final statements. Every turn ends with a small vote block (position, confidence, who it still disagrees with); a full cycle with no disagreements left ends the conversation early. Each member keeps its own CLI session across turns, so it remembers everything it has heard and is only sent the new turns.

Setup, meeting history, the live room, and the decision document share the charcoal/lavender theme and the same logo. App icons can be regenerated with `python3 scripts/generate-icons.py` (Pillow).

Model names come from CLI response metadata, the matching Codex rollout, or Grok’s default-model catalogue. They are saved with each seat; older sessions without recorded model metadata display “Model not recorded.” “Check connections” also resolves the current default into the setup field.

Model-metadata, saved-state and Deep-agent tests: `npx tsx --tsconfig tsconfig.web.json --test scripts/*.test.ts`. Reopened sessions left running by an app restart display as stopped unless their engine is still active.

## API (no app)

The meeting engine also runs headless, as an HTTP server: no window, no Electron. Use it to ask the table a question from a script, another app or an agent.

### How it works

1. You `POST` a question and the seats you want.
2. The server runs the same meeting the app runs, on this machine: each seat is a coding-agent CLI you are signed in to (or the Deep-agent on an API key), they speak in turns, read the attached project if there is one, vote after each turn, and a clerk keeps a whiteboard of what is agreed and still open.
3. The meeting ends when the members converge or the turn budget runs out. The chair then writes the decision document: a recommendation, trade-offs, next actions, open questions and the dissent, with each claim citing the turn it came from.
4. Everything is saved in the app's data folder, so the meeting also shows up in the desktop app's library.

One meeting runs at a time per server. The CLIs bill your subscriptions as usual; Deep-agent seats bill their API key.

### Start it

```bash
npm run api
```

It listens on `http://127.0.0.1:4317` (this machine only) and prints a token. Send it on every request as `Authorization: Bearer <token>`. The token is kept in the data folder as `api-token`; set `CONSORTIUM_API_TOKEN` to choose your own, and `CONSORTIUM_PORT` / `CONSORTIUM_HOST` to move it. Keys for the Deep-agent and its web search come from the server's environment (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, …): only the app can open the keys saved in its Settings.

### The question

```json
{
  "task": "One repo or two for web and API?",
  "members": [
    { "cli": "claude" },
    { "cli": "codex" },
    { "cli": "harness", "model": "openrouter:z-ai/glm-5.3" }
  ],
  "projectPath": "/path/to/repo"
}
```

Each member needs only `cli`: `claude`, `codex`, `gemini`, `grok`, or `harness` for the Deep-agent (which also needs a `model`). Optional per member: `model` (defaults match the app), `persona` (`strategist`, `engineer`, `researcher`, `designer`, `skeptic`, `customer`; filled in otherwise) and `id` (`m1`, `m2`, …). Optional for the meeting: `chairId` (the first member otherwise), `maxTurns` (default 30), `projectPath`, `attachments` (file paths on the server), `board` (`{"cli","model"}` for the whiteboard writer; the chair's otherwise).

### The output: wait for the decision, or stream the meeting

**Wait.** `POST /meetings?wait=1` holds the request until the decision is written (usually one to ten minutes, depending on seats and turns) and answers with it:

```bash
curl -X POST "http://127.0.0.1:4317/meetings?wait=1" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d @question.json
```

```json
{
  "id": "d5608ecd-…",
  "status": "done",
  "decision": "# Consortium: One Repo for a 3-Person Startup\n\n## Recommendation\nUse one repository with separate web and api directories… [T1, T2]\n\n## Trade-offs\n…",
  "path": "~/Library/Application Support/consortium-ai/consortium/a-3-person-startup-….md"
}
```

`status` is `done`, or `stopped` / `failed` if it didn't get there.

**Stream.** `POST /meetings` answers at once with `{"id"}`. Then `GET /meetings/:id/events` streams the meeting live as [server-sent events](https://developer.mozilla.org/docs/Web/API/Server-sent_events), word by word, and closes when it ends. Connecting late (or again) replays the meeting from its first event, then continues live.

```bash
curl -N "http://127.0.0.1:4317/meetings/$ID/events" -H "Authorization: Bearer $TOKEN"
```

```text
event: turn-start
data: {"sessionId":"8028…","type":"turn-start","memberId":"m1","turn":1,"phase":"open"}

event: delta
data: {"sessionId":"8028…","type":"delta","memberId":"m1","turn":1,"text":"We shouldn't write automated tests before launch. For a three-person startup, survival depends"}

event: turn-done
data: {"sessionId":"8028…","type":"turn-done","turn":{"n":1,"speaker":"m1","label":"The Strategist","text":"We shouldn't write automated tests before launch…","vote":{"position":"Skip automated testing before launch…","confidence":0.85,"agrees_with":[],"disagreements":[]}}}

event: consortium
data: {"sessionId":"8028…","type":"consortium","markdown":"# Consortium: Pre-Launch Testing…","path":"…/consortium/should-a-3-person-startup-….md"}
```

The events, in the order you'll meet them:

| Event                                      | Carries                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `turn-start`                               | Who speaks next, the turn number and the phase (`open`, `debate`, `converge`, `decide`)          |
| `member-model`                             | The model a seat actually runs                                                                   |
| `activity`                                 | What the speaker is doing: `thinking`, `reading`, `searching`, `tool`, `reviewing`, `responding` |
| `trace`                                    | One tool call (`{"kind":"tool","name","detail"}`) or a piece of reasoning, as the speaker works  |
| `delta`                                    | The next piece of the speaker's text. Raw: the vote block at the end of a turn arrives here too  |
| `turn-done`                                | The finished turn: clean text, the parsed vote, the tool trace, the cost                         |
| `turn-error`                               | A seat failed this turn (the meeting carries on)                                                 |
| `human`                                    | Something you said through `/messages`, as it enters the conversation                            |
| `shape`, `whiteboard`, `board-status`      | The clerk's notes and the live whiteboard: agreed, disputed, open questions, actions             |
| `usage`                                    | Tokens and cost so far, per seat                                                                 |
| `chair-start`, then `delta` with `turn: 0` | The chair writing the decision                                                                   |
| `consortium`                               | The decision document (Markdown) and where it was saved: the last event                          |
| `stopped` / `failed`                       | The meeting ended without a decision: the last event                                             |

You can also look at a meeting any time: `GET /meetings/:id` returns the whole session (turns, votes, traces, whiteboard, usage) and `GET /meetings/:id/decision` the decision as Markdown.

### Every route

| Route                                                 | What it does                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                         | Detected CLIs, which keys are set, the running meeting                                                                                                     |
| `POST /meetings`                                      | Start a meeting: `{"id"}` at once, or the decision with `?wait=1`. 409 while another runs, unless `?replace=1`                                             |
| `GET /meetings/:id/events`                            | The meeting as a live stream (above)                                                                                                                       |
| `GET /meetings/:id`                                   | The whole session                                                                                                                                          |
| `GET /meetings/:id/decision`                          | The decision, as Markdown (404 until it's written)                                                                                                         |
| `POST /meetings/:id/messages`                         | Speak in the meeting: `{"text"}` to everyone, `{"kind":"focus","text"}` to steer it, `{"kind":"ask","targetId":"m2","text"}` to a member, who answers next |
| `POST /meetings/:id/pause`, `/unpause`                | Hold the meeting between turns, and let it go on                                                                                                           |
| `POST /meetings/:id/conclude`                         | Skip to the chair's decision                                                                                                                               |
| `POST /meetings/:id/stop`, `/resume`                  | Stop it; pick a stopped meeting up where it left off                                                                                                       |
| `GET /meetings`, `DELETE /meetings/:id`               | The library                                                                                                                                                |
| `GET /models/:cli`, `POST /check` (`{"cli","model"}`) | Model suggestions for a seat; a one-word connection test                                                                                                   |

## Slack

The same meeting in a Slack thread. The live whiteboard is a canvas the channel can read, titled with the question and rewritten as the clerk revises it (at most every 5 seconds): the recommendation, the moderator's guidance, agreed, disputed, open questions and actions, each citing its turns, the board's visuals as tables, and a footer with the phase, turn and cost. The thread's first message keeps the gist (the recommendation and how many notes each column holds) with **Open whiteboard**, **Pause**, **Conclude** and **Stop** buttons; on a plan without canvases it carries the whole board instead. Each member speaks in the thread under its persona's name, streaming as it answers, with its vote underneath. When the table decides, the decision is posted as its own canvas (or attached as a `.md` file if canvases are off) and linked from the first message. It uses Socket Mode, so it runs on the Mac where the CLIs are signed in, with no public URL.

Meetings run side by side, one thread each, so several people can convene at once: every thread steers only its own meeting, and its buttons act on it alone. Up to `maxMeetings` (default 5) run at once; past that, `/consortium` answers, only to you, how many are running.

### Set it up

1. At [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a manifest**, pick the workspace, paste [`slack-manifest.yml`](slack-manifest.yml).
2. **Basic Information → App-Level Tokens**: generate one with the `connections:write` scope. That's `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** to the workspace. The Bot User OAuth Token is `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Invite the bot to each channel you'll use it in: `/invite @Consortium`.
5. Write `slack.json` in the data folder (`~/Library/Application Support/consortium-ai/` on a Mac):

```json
{
  "allow": ["U012ABCDEF"],
  "presets": {
    "default": { "members": [{ "cli": "claude" }, { "cli": "codex" }], "maxTurns": 12 },
    "repo": {
      "members": [
        { "cli": "claude" },
        { "cli": "codex" },
        { "cli": "gemini", "persona": "skeptic" }
      ],
      "projectPath": "/Users/you/code/app"
    }
  },
  "channels": { "C0123456789": "repo" },
  "maxMeetings": 5
}
```

`allow` is the Slack user ids (profile → ⋯ → Copy member ID) that may start meetings, steer them and press the buttons; everyone else is refused, and an empty list refuses everyone. `"allow": ["*"]` lets anyone in a channel the bot is in. `maxMeetings` caps the meetings running at once: each one runs its own CLIs on this Mac. A preset is a [question](#the-question) without its `task`. `channels` gives a channel its preset. A project folder only ever comes from a preset, never from what someone types. The file is re-read on every command, so edits apply without a restart.

### Run it

```bash
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… npm run slack
```

### Use it

- `/consortium Should we ship a CSV export?` or `@Consortium Should we ship a CSV export?` starts a meeting with the channel's preset (or `default`); `/consortium repo: …` names one.
- Reply in the meeting's thread to steer it: plain text is a thought for the whole table, `focus: …` sets the focus, and `skeptic: …` (any persona's name) asks that member, who answers next.

## Hosted

The same Slack app for anyone: they press **Add to Slack**, connect their own OpenRouter account in the app's Home tab, and the table runs on their key. One server holds many workspaces; each one's meetings, settings, key and transcripts are its own.

What changes from the single-workspace bridge:

- **Seats are Deep-agents on OpenRouter only.** The CLIs are signed in on someone's machine and can't be shared; anything else is refused. No project and no attachments either, so the agents see nothing of the server's disk (Deep Agents' own file tools work on an in-memory scratch space; `fetch_url` refuses local and private addresses).
- **Settings live in the Home tab**, per workspace: the OpenRouter key (**Connect OpenRouter**, OpenRouter's [OAuth PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce) flow, or **Paste a key**, checked against OpenRouter before it's saved), the seats (2 to 6, each a persona and an OpenRouter model picked from dropdowns that list the main providers' current models; by default The Strategist on `anthropic/claude-sonnet-5.5`, The Engineer on `openai/gpt-6.1-sol`, The Researcher on `google/gemini-3.8-flash`), the chair, the turn budget (default 12), who may convene (everyone in channels the bot is in, the default, or workspace admins only) and how many meetings run at once (default 3, at most 10). Only workspace admins, owners and whoever installed the app see the buttons and can save.
- **Keys are encrypted at rest** (AES-256-GCM under `CONSORTIUM_SECRET`, bound to the workspace), as are the installations' bot tokens; a key is decrypted only to start that workspace's meeting and is handed to its seats per run, never through the environment. It is never logged, shown or saved with a transcript.
- **Clear refusals:** no key yet, a key OpenRouter refuses (checked when a meeting starts), or one out of credits each tell the person what to do, in Slack.
- Uninstalling the app stops the workspace's meetings and deletes its installation, settings, key and transcripts.

The mode is picked at start: with `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` and `DATABASE_URL` set, `npm run slack` (or the Docker image) serves the hosted app over HTTP; without them it's the Socket Mode bridge above, unchanged.

| Variable                                                         | What                                                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | **Basic Information → App Credentials** of the public app                                                                                                              |
| `DATABASE_URL`                                                   | `postgres://…` (Railway and Fly give you one), or `sqlite:/data/consortium.db` for one file on a volume                                                                |
| `CONSORTIUM_SECRET`                                              | 32+ random characters (`openssl rand -base64 32`). Encrypts keys and tokens and signs links. Keep it: changing it makes the saved keys unreadable (admins re-add them) |
| `PUBLIC_URL`                                                     | Where Slack and browsers reach the server, like `https://consortium.example.com` (on Render, defaults to `RENDER_EXTERNAL_URL`)                                        |
| `PORT`                                                           | Default `3000`                                                                                                                                                         |
| `CONSORTIUM_DATA`                                                | Transcripts and the agents' memory, one folder per workspace. `/data` in the image: mount a volume there to keep them across deploys                                   |

Routes: `/` (the landing page with **Add to Slack**), `/slack/install` and `/slack/oauth_redirect` (Slack OAuth), `/slack/events` (events, interactivity and the slash command, signature-checked), `/openrouter/connect` and `/openrouter/callback/:state` (OpenRouter PKCE), `/privacy`, `/health`.

### Deploy it

**Render:** New → Blueprint → this repo. [`render.yaml`](render.yaml) creates the web service (Docker, Starter plan: a free one sleeps and misses Slack's 3-second limit) and generates `CONSORTIUM_SECRET`; it asks for the three Slack values and `DATABASE_URL`, a Postgres connection string from outside Render (a free [Neon](https://neon.tech) database is enough). `PUBLIC_URL` is optional there: the server uses Render's own `RENDER_EXTERNAL_URL`.

**Railway:** New Project → Deploy from GitHub repo (it builds the [`Dockerfile`](Dockerfile)) → add a Postgres database (it sets `DATABASE_URL`; reference it in the service) → set the variables above → Settings → Networking → Generate Domain, and use it as `PUBLIC_URL`. To keep transcripts, add a volume at `/data` (the image runs as `node`; if the volume isn't writable, set `RAILWAY_RUN_UID=0`).

**Fly.io:**

```bash
fly launch --no-deploy            # picks up the Dockerfile; internal port 3000
fly postgres create && fly postgres attach <db-app>   # sets DATABASE_URL
fly volumes create data --size 1 && echo -e '[mounts]\n  source = "data"\n  destination = "/data"' >> fly.toml
fly secrets set SLACK_CLIENT_ID=… SLACK_CLIENT_SECRET=… SLACK_SIGNING_SECRET=… CONSORTIUM_SECRET="$(openssl rand -base64 32)" PUBLIC_URL=https://<app>.fly.dev
fly deploy
```

Keep one instance: the PKCE flows in progress and the meeting counts are held in memory.

### Create the public Slack app

1. In [`slack-manifest.hosted.yml`](slack-manifest.hosted.yml), replace `consortium.example.com` with your domain (four places), then at [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a manifest**, pick a workspace of yours (it's the app's home; anyone can install it later), paste it. Slack checks the events URL, so deploy first.
2. **Basic Information → App Credentials**: the client id, client secret and signing secret go in the variables above.
3. **Manage Distribution**: check the items, **Remove Hard Coded Information**, then **Activate Public Distribution**. Your landing page's **Add to Slack** now works for any workspace. Share that page (or `PUBLIC_URL/slack/install`), not Slack's own sharable URL: an install has to start at `/slack/install`, which sets the OAuth state cookie the redirect checks. Listing in the Slack Marketplace is a separate review: it needs a real privacy policy (the `/privacy` page is a placeholder to replace), support contact and the app's icon.

Run it from a checkout instead of Docker with the same variables: `npm run slack`. Locally, Slack needs a public HTTPS URL to reach you (a tunnel like `cloudflared tunnel --url http://localhost:3000`, then that URL as `PUBLIC_URL` and in the manifest).

Don't run it with Bolt's debug logging in production: it logs request bodies, and a pasted key travels in one.

## How it talks to the CLIs

Every CLI is driven in its headless JSONL mode with its own session resumed each round, so a member remembers its earlier turns and only receives the others' new arguments:

| CLI    | Command                                                           | Resume                   | Project attached              | No project   |
| ------ | ----------------------------------------------------------------- | ------------------------ | ----------------------------- | ------------ |
| claude | `claude -p … --output-format stream-json`                         | `--resume <id>`          | `--tools Read,Glob,Grep`      | `--tools ""` |
| codex  | `codex exec … --json -s read-only`                                | `codex exec resume <id>` | `-C <dir>`                    | temp dir     |
| grok   | `grok -p … --output-format streaming-json --permission-mode plan` | `-r <id>`                | `--cwd <dir>`                 | `--tools ""` |
| gemini | `gemini -p … --output-format stream-json --approval-mode plan`    | `--resume <id>`          | `--include-directories <dir>` | —            |

Adapters live in `src/main/cli.ts` (one `args` + one `parse` per CLI). The debate engine is `src/main/debate.ts`, the prompts `src/main/prompts.ts`. The renderer never touches Node; it receives `DebateEvent`s over IPC (`src/shared/types.ts`).

Engine check without the UI (real CLIs, two members, ten turns; add `SMOKE_PROJECT=/path/to/repo` to attach a project):

```bash
npx tsx scripts/smoke.ts claude,codex 10
```

Vote-parser self-check (no CLIs):

```bash
npx tsx scripts/check.ts
```

Open the renderer at the Vite URL in a normal browser (no Electron) and it runs on a scripted mock debate — handy for UI work.

## Build

```bash
npm run build:mac
```

### The Deep-agent seat

Our own member: a [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview) agent (planning, read-only file tools, subagents) that runs inside the app on an API key. Pick it under **Connection**, then a provider and a model. Its tools:

- **Files:** `ls`, `read_file`, `glob` and `grep` on the attached project and files, read-only.
- **Git:** `git` runs read-only commands in the project (`log`, `show`, `diff`, `blame`, `status`, `shortlog`, `ls-files`, `grep`, `rev-parse`, `describe`, `for-each-ref`; `branch` and `tag` only list). No shell: options that write, run programs or read outside the repo are refused.
- **Internet:** `web_search` (OpenRouter's web search on your OpenRouter key, about $0.007 a search, not counted in the usage meter) and `fetch_url` (reads a public page; local and private addresses are refused).
- **Planning and subagents:** `write_todos` and `task`.

Secrets stay out of reach: `.env` files, private keys and credential files can't be read or matched by search, so a web page can't talk the agent into sending them out.

| Provider   | Model examples                                   | Key                  |
| ---------- | ------------------------------------------------ | -------------------- |
| OpenRouter | `z-ai/glm-5.3`, `anthropic/claude-opus-5.5`, any | `OPENROUTER_API_KEY` |
| OpenAI     | `gpt-6-sol`                                      | `OPENAI_API_KEY`     |
| Anthropic  | `claude-opus-5-5`                                | `ANTHROPIC_API_KEY`  |
| Google     | `gemini-3.8-flash`                               | `GEMINI_API_KEY`     |
| xAI        | `grok-4.7`                                       | `XAI_API_KEY`        |

Add the key under **Settings** (top right of the lobby), or from the seat's **Add key** link: it is encrypted with the macOS keychain into the app's data folder and only ever sent to that provider. The environment variable works too. Cost is the catalogue list price from OpenRouter, so it shows as ≈. Each seat's memory lives in `harness/<thread>.json` in the app's data folder (`harness` is the seat's internal id).

### Voices

Turn on **Read turns aloud** in the lobby and each seat speaks its final answer in its own ElevenLabs voice (`elevenlabs/eleven-v4-turbo` through OpenRouter's speech API, so it uses the OpenRouter key from **Settings** or `OPENROUTER_API_KEY`). Pick a voice per seat; two seats never share one. Only the answer is read: thinking, tool activity, the vote block, markdown and `[T3]` citations stay silent. The chair's decision is not read.

OpenRouter returns a clip only once it is fully synthesized (no streaming), so the engine covers the gap two ways:

- While the first seat of a meeting thinks, it plays a pre-recorded line in its voice ("Let me look into it, give me a few seconds."). Later seats need none: they think while the previous one talks. Ten lines per voice are bundled in `resources/voices/`. Regenerate them after changing `FILLERS` in `src/shared/voices.ts`: `npx tsx scripts/voices.ts` (needs `OPENROUTER_API_KEY`; existing files are kept).
- The answer is synthesized in sentence-sized pieces, two at a time, so the voice starts about two seconds after the text is complete and the rest is ready before it is needed.

The next seat thinks while the previous one is still talking, and the audio never falls more than one turn behind the text. The room highlights whoever is audibly talking; the seat already writing its next answer shows its working state. **Speed** cycles 1×, 1.25×, 1.5× and 2× without changing the voice's pitch (ElevenLabs v4 has no speed setting, so it is playback speed). **Mute** silences playback and lets the meeting run at text pace. Cost is the ElevenLabs list price per character, about $0.02 per thousand characters through OpenRouter. If the key is missing or a request fails, the room says "Voice failed" and the meeting carries on in text. Engine check with voices: `SMOKE_VOICES=1 npx tsx scripts/smoke.ts claude,codex 4`.

Unsigned, unnotarized. When launched from Finder the app asks a login shell for the CLI paths, so nvm / `~/.local/bin` / `~/.grok/bin` installs are found.

## Notes

- Anthropic's terms allow an individual to use the unmodified `claude` binary with their own subscription; shipping this to other people means each of them signs in to the CLIs themselves — the app must never collect or route anyone's credentials.
- Gemini CLI refuses headless runs in untrusted folders, so the adapter passes `--skip-trust`; the app only ever runs it in the attached project or an empty scratch directory.
- Not yet: signed/notarized distribution. Speaker order can be steered by the moderator or an immediate host question.

### Live whiteboard and host controls

Open **Whiteboard** in the meeting toolbar for a dedicated view of the current direction, shared ground, disagreements, questions, and proposed actions. Notes link back to their conversation turns. The Electron main process runs a separate moderator/whiteboard writer, configured in the lobby. The default is Claude Haiku through Claude Code, falling back to the chair’s connection when Claude Code is not detected. Its selected connection must be installed and signed in (or have an API key for a Deep-agent writer). The browser preview uses illustrative demo updates.

The conversation strip updates as speech arrives. The writer coalesces new text into short batches (normally at least eight seconds between starts, with turn-end/manual refreshes requesting an immediate update). Model generation adds latency; only one writer runs at a time, and speakers never wait for it. A failed update keeps the previous board. Snapshots are saved with the session; the timestamp and turn number show their coverage. The writer stops when the meeting ends, so the last board can trail the final transcript; the chair's decision is the final synthesis.

- **Raise hand** stops the voice that is talking, cancels the turn being prepared and holds the meeting. Type, or press the mic and speak (local Whisper), then send: the meeting resumes and the interrupted seat retakes its turn, now hearing you. **Lower hand** resumes without a message.
- The mic in the message box dictates any message, hand raised or not.
- **Ask an agent** interrupts the active response and gives that seat the next turn immediately.
- **Focus the discussion** sets a persistent instruction for later contributions.
- **Add a thought** immediately stops the current response and speech. The interrupted seat restarts with the human’s message; a targeted question goes to the selected seat instead. Sending while paused resumes the meeting.
- Messages are saved to the transcript immediately and show **Taking the floor** then **Delivered**. Sending during the chair’s final draft discards that draft and regenerates the decision with the correction. Late text and audio from cancelled work are ignored.
- **Pause** takes effect between turns. **Conclude now** finishes the current response, delivers any remaining host messages to the chair, and writes the decision. **End session** stops work immediately and preserves the session for later.

### Visual discussion

The whiteboard now includes a **Visual canvas** alongside **All notes**. Its writer can maintain up to three complementary artifacts: connected flow/system diagrams, alternatives tables, and step sequences. Visuals use the same conversation sources as the notes; proposals, shared ground, and open questions remain visibly distinct. Existing sessions without visuals still open normally.

Each agent and the chair receives the current structured visual in its prompt. Members can propose a drawing or describe a correction in their contribution; the writer updates it on the next successful synthesis. Selecting a node, comparison criterion, or plan step exposes its context and sources. **Discuss this** prepares an editable host message containing the visual revision and a readable snapshot, so the room can address the exact drawing even if it has since changed. Send it to everyone or choose an agent from the host controls.

Use **Expand whiteboard** and diagram zoom for detail. **Freeze view** holds a local revision without pausing the meeting; **Return to live** catches up. Rendering uses validated data and native SVG/table elements, not model-generated executable markup. Malformed visual updates keep the last successful board. Complex diagrams still arrive in batches and depend on model latency; this is a generated visual workspace, not a freehand drawing editor.

### Interactive workspace and moderation

The whiteboard is the default meeting view, with a compact participant strip and the conversation alongside it. Layout choice is remembered on this device. Questions appear first in the canvas notes; **Answer this question** opens an inline editor. The displayed board stays still while you answer, and the submitted message carries the exact question and revision. Delivery is shown on the card. Other notes have **Discuss this** actions, and changed notes are labelled **Updated** on the next board revision.

The existing board writer also acts as a moderator. It watches for drift, repeated arguments, unanswered host input, and unresolved disagreements, then publishes a short visible redirect and optionally suggests the next speaker. The engine applies fresh guidance at turn boundaries after every seat has had an opening, with a fairness limit to prevent a seat being starved. Human targeting always wins. **Refocus the room** sends an immediate host instruction to return to the original question while preserving earlier constraints.

Moderation is asynchronous and shares the board writer’s latency and connection. A failed update leaves the last board intact; stale or provisional guidance cannot change speaker order. Host interruption is handled locally and does not wait for the moderator or the cancelled provider to finish. Browser preview responses remain scripted; engine regression tests use controlled providers to verify cancellation, targeted routing, chair corrections, and stale audio suppression.

# Consortium

One question. Several AI members that disagree on purpose — each one a coding-agent CLI you already pay for (Claude Code, Codex, Gemini CLI, Grok Build). They sit at a table and talk it through in short turns — opening statements, then real back-and-forth, then a forced convergence — and a chair writes the **consortium**: one decision document with the rationale, a plan, and the dissent kept in.

Local-first desktop app (Electron). No API keys, no accounts, no server: the app spawns the CLIs that are already signed in on your machine.

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

1. **Convene** — write the question, optionally attach a project folder (members then inspect it read-only before they argue), pick seats (persona · CLI · model), a chair, and a turn budget (20 / 30 / 50 turns across all members). "Check" runs a one-word prompt through a seat's CLI to prove it answers.
2. **Chamber** — members speak one at a time, in order, each reacting to what was said since its last turn (at most ~150 words). The floor below the table is the live transcript; speech bubbles show each member's current one-line position, the table rim fills gold as agreement grows, red dashed chords mark what is still contested, and the "Taking shape" panel holds the clerk's notes (refreshed every cycle and fed back to the members). Click a seat to filter the floor to that member; say something at the bottom — it enters the conversation before the next turn.
3. **Consortium** — the chair's document, with the agreement matrix and the panel. Saved as markdown to `<project>/consortium/<question>-<date>.md` (or the app's data folder when no project is attached).

Members only ever see each other's persona ("The Skeptic"), never which model sits behind a seat. The turn budget drives the phases: the first cycle is openings, then free debate until 60% of the budget, then _converge_ (only the open points, concede where persuaded, no new topics), and the last cycle is final statements. Every turn ends with a small vote block (position, confidence, who it still disagrees with); a full cycle with no disagreements left ends the conversation early. Each member keeps its own CLI session across turns, so it remembers everything it has heard and is only sent the new turns.

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

Unsigned, unnotarized. When launched from Finder the app asks a login shell for the CLI paths, so nvm / `~/.local/bin` / `~/.grok/bin` installs are found.

## Notes

- Anthropic's terms allow an individual to use the unmodified `claude` binary with their own subscription; shipping this to other people means each of them signs in to the CLIs themselves — the app must never collect or route anyone's credentials.
- Gemini CLI refuses headless runs in untrusted folders, so the adapter passes `--skip-trust`; the app only ever runs it in the attached project or an empty scratch directory.
- Not yet: API-key / OpenRouter members, members addressing a specific member next (turns are round-robin), packaging/signing.

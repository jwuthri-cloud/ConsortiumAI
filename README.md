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

This launches the real Electron desktop app. It uses the same React/Three.js interface as the browser preview, with the preload IPC bridge connected to the installed agent CLIs, folder picker, and saved sessions. Opening the Vite URL in a browser instead uses scripted demo responses.

If an already-running development window still shows an older interface, finish the current discussion, then use **View → Reload** (`⌘R` on macOS) and reopen the saved session. To create an updated standalone macOS app, run `npm run build:mac`.

1. **Convene** — write the question, optionally attach a project folder (members then inspect it read-only before they argue), pick seats (persona · CLI · model), a chair, and a turn budget (20 / 30 / 50 turns across all members). "Check" runs a one-word prompt through a seat's CLI to prove it answers.
2. **Chamber** — a meeting room with real-time 3D agent mascots. Provider colors and clothing identify Anthropic, OpenAI, Google, or xAI; each cap displays the seat’s role and the suit badge shows the actual model, including automatically selected CLI defaults, without thinking or context-budget annotations. Drag a character or use arrow keys to rotate it; double-click or press Home to reset. Use gallery view or spotlight a participant with its expand button. Speaker view follows the active member unless pinned. Conversation and Decision tabs hold the live transcript and clerk’s notes. While a seat prepares, the room shows connection, preparation, reading/searching, tool use, and response states from CLI events, plus elapsed time and the next seat. Raw reasoning and tool logs stay out of these status indicators. A quiet agent is labelled honestly when no update arrives. Add context to join the next turn, or end the session. Choose “Read the decision” when the chair finishes.

   The mascots are procedural Three.js meshes rendered locally, with blinking, idle motion, and speaking gestures. They do not use image-generated portraits or remote assets. Reduced-motion settings suppress animation; offscreen/hidden views skip rendering. A text fallback appears when WebGL is unavailable.
3. **Consortium** — the chair's document, with the agreement matrix and the panel. Saved as markdown to `<project>/consortium/<question>-<date>.md` (or the app's data folder when no project is attached).

Members only ever see each other's persona ("The Skeptic"), never which model sits behind a seat. The turn budget drives the phases: the first cycle is openings, then free debate until 60% of the budget, then _converge_ (only the open points, concede where persuaded, no new topics), and the last cycle is final statements. Every turn ends with a small vote block (position, confidence, who it still disagrees with); a full cycle with no disagreements left ends the conversation early. Each member keeps its own CLI session across turns, so it remembers everything it has heard and is only sent the new turns.

Setup, meeting history, the live room, and the decision document share the charcoal/lavender theme and the same logo. App icons can be regenerated with `python3 scripts/generate-icons.py` (Pillow).

Model names come from CLI response metadata, the matching Codex rollout, or Grok’s default-model catalogue. They are saved with each seat; older sessions without recorded model metadata display “Model not recorded.” “Check connections” also resolves the current default into the setup field.

Model-metadata and saved-state tests: `npx tsx --tsconfig tsconfig.web.json --test scripts/model-metadata.test.ts scripts/activity.test.ts`. Reopened sessions left running by an app restart display as stopped unless their engine is still active.

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

### Live whiteboard and host controls

Open **Whiteboard** in the meeting toolbar for a dedicated view of the current direction, shared ground, disagreements, questions, and proposed actions. Notes link back to their conversation turns. The Electron main process runs a separate Codex writer using `gpt-6.1-sol`, even when no meeting seat uses Codex. Codex must be installed and signed in. The browser preview uses illustrative demo updates.

The conversation strip updates as speech arrives. The writer coalesces new text into short batches (normally at least eight seconds between starts, with turn-end/manual refreshes requesting an immediate update). Model generation adds latency; only one writer runs at a time, and speakers never wait for it. A failed update keeps the previous board. Snapshots are saved with the session; the timestamp and turn number show their coverage. The writer stops when the meeting ends, so the last board can trail the final transcript; the chair's decision is the final synthesis.

- **Ask an agent** gives that seat the next turn after the current response finishes.
- **Focus the discussion** sets a persistent instruction for later contributions.
- **Add a thought** adds context for the next speaker.
- Messages show **queued** and **delivered** states and remain in the saved session.
- **Pause** takes effect between turns. **Conclude now** finishes the current response, delivers any remaining host messages to the chair, and writes the decision. **End session** stops work immediately and preserves the session for later.

### Visual discussion

The whiteboard now includes a **Visual canvas** alongside **All notes**. Its writer can maintain up to three complementary artifacts: connected flow/system diagrams, alternatives tables, and step sequences. Visuals use the same conversation sources as the notes; proposals, shared ground, and open questions remain visibly distinct. Existing sessions without visuals still open normally.

Each agent and the chair receives the current structured visual in its prompt. Members can propose a drawing or describe a correction in their contribution; the writer updates it on the next successful synthesis. Selecting a node, comparison criterion, or plan step exposes its context and sources. **Discuss this** prepares an editable host message containing the visual revision and a readable snapshot, so the room can address the exact drawing even if it has since changed. Send it to everyone or choose an agent from the host controls.

Use **Expand whiteboard** and diagram zoom for detail. **Freeze view** holds a local revision without pausing the meeting; **Return to live** catches up. Rendering uses validated data and native SVG/table elements, not model-generated executable markup. Malformed visual updates keep the last successful board. Complex diagrams still arrive in batches and depend on model latency; this is a generated visual workspace, not a freehand drawing editor.

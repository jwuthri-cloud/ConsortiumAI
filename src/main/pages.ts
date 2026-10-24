// The hosted app's web pages: the landing page, privacy, and the result pages of the two OAuth
// flows (Add to Slack, Connect OpenRouter). Server-rendered HTML with inline CSS and SVG, nothing
// to build; fonts from Google Fonts. Everything that varies is escaped with esc().

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// the "C with seats" (src/renderer/public/brand.svg): the table, a seat at its opening, the question
const MARK = `<svg class="mark" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path class="arc" pathLength="1" d="M32 10.144a16 16 0 1 0 0 27.712" stroke="#c5b8ee" stroke-width="6" stroke-linecap="round"/><circle class="you" cx="40" cy="18" r="3.5" fill="#c5b8ee"/><circle cx="24" cy="24" r="4" fill="#c5b8ee" opacity=".5"/></svg>`

const SLACK = `<svg viewBox="0 0 122.8 122.8" aria-hidden="true"><path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9zm6.5 0a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 1 1-25.8 0z" fill="#e01e5a"/><path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9zm0 6.5a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8z" fill="#36c5f0"/><path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97zm-6.5 0a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 1 1 25.8 0z" fill="#2eb67d"/><path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97zm0-6.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8z" fill="#ecb22e"/></svg>`

const ADD = `<a class="btn btn-primary" href="/slack/install">${SLACK}<span>Add to <b>Slack</b></span></a>`

const FONTS =
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,300..600,0..100&family=Geist:wght@400..700&family=Geist+Mono:wght@400..500'
const SERIF = '&family=Source+Serif+4:opsz,wght@8..60,400..600'

const BASE = `
:root{--chamber:#111216;--charcoal:#191a20;--raised:#22232b;--outline:#34333e;--lavender:#c5b8ee;--violet:#6f6987;--ink:#f0eff4;--ink-2:#b6b5c1;--ink-3:#9596a3;--red:#f0857c;
--display:'Fraunces',Georgia,serif;--sans:'Geist',system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace;--serif:'Source Serif 4',Georgia,serif;color-scheme:dark}
*{box-sizing:border-box}
html{background:var(--chamber);color:var(--ink);font:400 1.0625rem/1.6 var(--sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:radial-gradient(70rem 40rem at 78% -8rem,#c5b8ee14,transparent 70%),var(--chamber)}
a{color:inherit;text-underline-offset:.2em;text-decoration-color:var(--violet)}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--lavender);outline-offset:3px;border-radius:6px}
::selection{background:#c5b8ee55}
.wrap{width:min(72rem,100% - 2rem);margin-inline:auto}
.eyebrow{font:500 .75rem/1.4 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:0}
h1,h2{font-family:var(--display);font-weight:380;font-variation-settings:'opsz' 144,'SOFT' 50;letter-spacing:-.022em;text-wrap:balance;margin:0}
h1{font-size:clamp(2.75rem,6.2vw,5.25rem);line-height:.98}
h2{font-size:clamp(2rem,3.6vw,3rem);line-height:1.04}
.mark{display:block;flex:none}
.bar{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-block:1.25rem}
.brand{display:inline-flex;align-items:center;gap:.55rem;text-decoration:none;font:500 1.3rem/1 var(--display);font-variation-settings:'opsz' 36,'SOFT' 100;letter-spacing:-.01em}
.brand .mark{width:30px;height:30px}
.bar nav{display:flex;align-items:center;gap:1.5rem;font-size:.9375rem}
.bar nav a{color:var(--ink-2);text-decoration:none}
.bar nav a:hover{color:var(--ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.6rem;min-height:46px;padding:.6rem 1.2rem;border-radius:999px;border:1px solid var(--outline);background:transparent;color:var(--ink);font:500 1rem/1 var(--sans);text-decoration:none;white-space:nowrap;transition:background-color .2s,border-color .2s}
.btn:hover{background:var(--charcoal);border-color:var(--violet)}
.btn svg{width:20px;height:20px;flex:none}
.btn b{font-weight:700}
.btn-primary{background:var(--lavender);border-color:var(--lavender);color:var(--charcoal)}
.btn-primary:hover{background:#d6ccf5;border-color:#d6ccf5}
.btn-primary svg{background:#fff;border-radius:6px;padding:3px;width:24px;height:24px;margin-left:-.35rem}
.bar .btn{min-height:40px;padding:.45rem 1rem;font-size:.9375rem;color:var(--ink)}
.foot{margin-top:auto;border-top:1px solid var(--outline)}
.foot .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1rem 2rem;padding-block:2rem;color:var(--ink-3);font-size:.875rem}
.foot nav{display:flex;gap:1.5rem}
.foot .brand{font-size:1.05rem;color:var(--ink-2)}
.foot .brand .mark{width:22px;height:22px}
@media (max-width:40rem){.bar nav .hide-sm{display:none}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`

function doc(o: {
  title: string
  description: string
  css: string
  body: string
  serif?: boolean
}): string {
  const icon = `data:image/svg+xml,${encodeURIComponent(MARK.replace(' class="mark"', ' xmlns="http://www.w3.org/2000/svg"'))}`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title><meta name="description" content="${esc(o.description)}"><meta name="theme-color" content="#111216"><link rel="icon" href="${icon}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}${o.serif ? SERIF : ''}&display=swap"><style>${BASE}${o.css}</style></head><body>${o.body}</body></html>`
}

const header = (cta = true): string =>
  `<header class="wrap bar"><a class="brand" href="/">${MARK}Consortium</a><nav aria-label="Site"><a class="hide-sm" href="/privacy">Privacy</a>${cta ? '<a class="btn" href="/slack/install">Add to Slack</a>' : ''}</nav></header>`

const footer = `<footer class="foot"><div class="wrap"><a class="brand" href="/">${MARK}Consortium</a><span>A table of AI models for Slack, on your own OpenRouter key.<br>Built and maintained by <a href="https://github.com/jwuthri-cloud">Julien</a> · runs on Render, data on Neon.</span><nav aria-label="Footer"><a href="https://github.com/jwuthri-cloud/ConsortiumAI">Source</a><a href="/privacy">Privacy</a><a href="/slack/install">Add to Slack</a></nav></div></footer>`

// ---------- the landing page ----------

type Seat = { persona: string; model?: string; mono: string; angle: number }
// the default table (hosted.ts DEFAULTS) in seats 1–3; 4–6 open
const SEATS: Seat[] = [
  { persona: 'The Strategist', model: 'claude-sonnet-5.5', mono: 'S', angle: 80 },
  { persona: 'The Engineer', model: 'gpt-6.1-sol', mono: 'E', angle: 120 },
  { persona: 'The Researcher', model: 'gemini-3.8-flash', mono: 'R', angle: 160 },
  { persona: 'The Designer', mono: 'D', angle: 200 },
  { persona: 'The Skeptic', mono: 'K', angle: 240 },
  { persona: 'The Customer', mono: 'C', angle: 280 }
]

// The mark, built out as furniture: the C is the table, six seats along it, the seat at its
// opening is yours, the dot in the middle is the question. The lit seats take the floor in turn.
function chamber(): string {
  const [cx, cy, r] = [380, 260, 190]
  const at = (deg: number, d: number): [number, number] => {
    const a = (deg * Math.PI) / 180
    return [+(cx + d * Math.cos(a)).toFixed(1), +(cy - d * Math.sin(a)).toFixed(1)]
  }
  const seats = SEATS.map((s, i) => {
    const [x, y] = at(s.angle, r)
    const [lx, ly] = at(s.angle, r + 46)
    const [c, sin] = [Math.cos, Math.sin].map((f) => f((s.angle * Math.PI) / 180))
    const anchor = c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle'
    const top = Math.round(ly - 4 + (sin > 0.5 ? -12 : sin < -0.5 ? 8 : 0)) // clear of the seat's halo
    const lit = !!s.model
    return `<g class="seat ${lit ? 'lit' : 'open'}">${lit ? `<line class="floor" style="animation-delay:${i * 2.5}s" x1="${x}" y1="${y}" x2="${cx}" y2="${cy}"/><circle class="halo" style="animation-delay:${i * 2.5}s" cx="${x}" cy="${y}" r="31"/>` : ''}<circle class="chair" cx="${x}" cy="${y}" r="22"/><text class="mono" x="${x}" y="${y}">${s.mono}</text><text class="label" text-anchor="${anchor}" x="${lx}" y="${top}"><tspan class="persona">${s.persona}</tspan><tspan class="model" x="${lx}" dy="18">${s.model ?? 'open seat'}</tspan></text></g>`
  }).join('')
  const [ax, ay] = at(60, r)
  const [bx, by] = at(-60, r)
  const [yx, yy] = at(20.6, r + 13)
  return `<svg class="chamber" viewBox="0 0 640 520" role="img" aria-labelledby="chamber-t"><title id="chamber-t">The table: The Strategist on claude-sonnet-5.5, The Engineer on gpt-6.1-sol and The Researcher on gemini-3.8-flash, three open seats, and your seat at the opening.</title>
<path class="table-edge" d="M${ax} ${ay}A${r} ${r} 0 1 0 ${bx} ${by}"/><path class="table" d="M${ax} ${ay}A${r} ${r} 0 1 0 ${bx} ${by}"/>
${seats}
<circle class="question" cx="${cx}" cy="${cy}" r="6"/><text class="q-label" x="${cx}" y="${cy + 34}">The question</text><text class="q" x="${cx}" y="${cy + 70}">Build SSO,</text><text class="q" x="${cx}" y="${cy + 102}">or buy it?</text>
<circle class="you" cx="${yx}" cy="${yy}" r="13"/><text class="label you-label" text-anchor="middle" x="${yx}" y="${yy + 42}"><tspan class="persona">You</tspan><tspan class="model" x="${yx}" dy="18">steer by replying</tspan></text></svg>`
}

const LANDING_CSS = `
.hero{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);align-items:center;gap:2rem;padding-block:clamp(2rem,6vw,4.5rem) clamp(1rem,3vw,2.5rem)}
.hero h1{margin:1.1rem 0 1.5rem}
.lede{font-size:1.1875rem;line-height:1.55;color:var(--ink-2);max-width:31rem;margin:0;text-wrap:pretty}
.cta{display:flex;flex-wrap:wrap;align-items:center;gap:1rem 1.25rem;margin-top:2.25rem}
.cta small{color:var(--ink-3);font-size:.875rem;max-width:16rem;line-height:1.45}
.chamber{width:100%;height:auto;overflow:visible}
.chamber .table-edge{fill:none;stroke:var(--outline);stroke-width:62;stroke-linecap:round}
.chamber .table{fill:none;stroke:var(--charcoal);stroke-width:60;stroke-linecap:round}
.chamber .chair{fill:var(--chamber);stroke:var(--violet);stroke-width:1.5}
.chamber .open .chair{fill:none;stroke:var(--violet);stroke-dasharray:3 5}
.chamber .mono{font:500 15px var(--mono);fill:var(--lavender);text-anchor:middle;dominant-baseline:central}
.chamber .open .mono{fill:var(--violet)}
.chamber .persona{font:500 15px var(--sans);fill:var(--ink)}
.chamber .model{font:400 12.5px var(--mono);fill:var(--ink-3)}
.chamber .open .persona{fill:var(--ink-3)}
.chamber .open .model{fill:var(--violet)}
.chamber .question{fill:var(--lavender);opacity:.55}
.chamber .q-label{font:500 11px var(--mono);letter-spacing:.09em;text-transform:uppercase;fill:var(--ink-3);text-anchor:middle}
.chamber .q{font:400 30px var(--display);font-variation-settings:'opsz' 72,'SOFT' 100;fill:var(--ink);text-anchor:middle}
.chamber .you{fill:var(--lavender)}
.chamber .you-label .persona{fill:var(--lavender)}
.chamber .halo{fill:none;stroke:var(--lavender);stroke-width:1.5;opacity:0;animation:floor 7.5s infinite}
.chamber .floor{stroke:var(--lavender);stroke-width:1;stroke-dasharray:2 6;opacity:0;animation:floor 7.5s infinite}
@keyframes floor{0%{opacity:0}5%,29%{opacity:.85}34%,100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.chamber .lit:first-of-type .halo{opacity:.85}}
section{padding-block:clamp(3rem,6vw,5rem)}
.head{max-width:42rem;margin-bottom:clamp(2rem,4vw,3rem)}
.head h2{margin:.8rem 0 1rem}
.head p{color:var(--ink-2);margin:0;text-wrap:pretty}
.slack{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);border:1px solid var(--outline);border-radius:16px;background:var(--charcoal);overflow:hidden;box-shadow:0 50px 90px -50px #000,0 0 0 6px #ffffff05;margin:0}
.pane-head{display:flex;align-items:center;gap:.5rem;min-height:3.25rem;padding:.75rem 1.25rem;border-bottom:1px solid var(--outline);font-weight:700;font-size:.9375rem}
.pane-head span{color:var(--ink-3);font-weight:400}
.thread{border-right:1px solid var(--outline);padding-bottom:.75rem}
.msg{display:grid;grid-template-columns:36px minmax(0,1fr);gap:.75rem;padding:.6rem 1.25rem}
.av{width:36px;height:36px;border-radius:8px;background:var(--raised);display:grid;place-items:center;font-size:1.1rem;line-height:1}
.av .mark{width:24px;height:24px}
.av.seat{font:500 .9375rem/1 var(--mono);color:var(--lavender);box-shadow:inset 0 0 0 1px var(--violet)}
.av.chair{background:var(--lavender)}
.av.chair .mark *{fill:var(--charcoal);stroke:var(--charcoal)}
.av.chair .mark path{fill:none}
.av.human{background:#2e4a45;color:#cfe6df;font:600 .8125rem/1 var(--sans)}
.who{display:flex;flex-wrap:wrap;align-items:baseline;gap:.2rem .45rem;margin:0;font-size:.9375rem;line-height:1.4}
.who b{font-weight:700}
.app{font:600 .625rem/1 var(--sans);letter-spacing:.04em;padding:.22rem .3rem;border-radius:3px;background:var(--outline);color:var(--ink-2);align-self:center}
.who time{font-size:.75rem;color:var(--ink-3)}
.msg p{margin:.2rem 0 0;font-size:.9375rem;line-height:1.5;text-wrap:pretty}
.msg .big{font-weight:700;font-size:1.0625rem;line-height:1.35;margin-top:.35rem}
.msg .ctx{font-size:.8125rem;color:var(--ink-3);margin-top:.45rem}
.ctx b{color:var(--lavender);font-weight:600}
.ctx code,.chip code{font:400 .75rem/1 var(--mono);color:var(--ink-2);background:var(--raised);border:1px solid var(--outline);border-radius:4px;padding:.15rem .35rem;white-space:nowrap}
.sbtns{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.65rem}
.sbtns span{border:1px solid var(--outline);border-radius:6px;padding:.3rem .7rem;font-size:.8125rem;font-weight:600;color:var(--ink-2)}
.replies{display:flex;align-items:center;gap:.75rem;padding:.6rem 1.25rem;color:var(--ink-3);font-size:.8125rem}
.replies::after{content:'';flex:1;border-top:1px solid var(--outline)}
.chip{display:flex;align-items:center;gap:.75rem;margin-top:.6rem;padding:.65rem .8rem;border:1px solid var(--outline);border-radius:10px;background:var(--chamber);max-width:24rem}
.chip i{font-style:normal;width:32px;height:32px;border-radius:7px;display:grid;place-items:center;background:#c5b8ee22;color:var(--lavender);font:600 .7rem var(--mono)}
.chip b{display:block;font-size:.875rem}
.chip small{color:var(--ink-3);font-size:.75rem}
.canvas{background:#15161b}
.canvas-body{position:sticky;top:0;padding:1.25rem 1.5rem 1.5rem}
.canvas h3{font:600 1.1875rem/1.3 var(--sans);margin:0 0 1rem;text-wrap:balance}
.rec{margin:0;border-left:2px solid var(--lavender);padding:.15rem 0 .15rem .9rem;font-size:.9375rem}
.canvas h4{display:flex;justify-content:space-between;font:500 .7rem/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:1.4rem 0 .55rem;padding-bottom:.45rem;border-bottom:1px solid var(--outline)}
.canvas h4 span{color:var(--lavender)}
.canvas ul{margin:0;padding-left:1.1rem;font-size:.875rem;color:var(--ink-2)}
.canvas li{margin:.3rem 0}
.canvas li::marker{color:var(--violet)}
.canvas .ctx{font:400 .75rem var(--mono);color:var(--ink-3);margin:1.5rem 0 0}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2rem 1.5rem}
.steps>li{position:relative;border-top:1px solid var(--outline);padding-top:1.75rem}
.steps>li::before{content:'';position:absolute;top:-5px;left:0;width:9px;height:9px;border-radius:50%;background:var(--lavender)}
.steps .n{font:400 2.75rem/1 var(--display);font-variation-settings:'opsz' 144,'SOFT' 100;color:var(--lavender)}
.steps h3{font:600 1.1875rem/1.3 var(--sans);margin:1rem 0 .25rem}
.steps .where{font:500 .7rem/1.4 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:0 0 .75rem}
.steps p{color:var(--ink-2);margin:0 0 1.5rem;font-size:1rem;text-wrap:pretty}
.mini{list-style:none;margin:0;padding:.35rem 0;border:1px solid var(--outline);border-radius:12px;background:var(--charcoal);font-size:.875rem}
.mini li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 1rem;padding:.45rem .9rem}
.mini code{font:400 .75rem/1.6 var(--mono);color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.composer{border:1px solid var(--outline);border-radius:12px;background:var(--charcoal);padding:.9rem 1rem;font-size:.9375rem;line-height:1.45}
.composer code{font:500 .875rem var(--mono);color:var(--lavender)}
.caret{display:inline-block;width:2px;height:1.1em;background:var(--lavender);vertical-align:-.2em;margin-left:2px;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.byok{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,7fr);gap:2.5rem 4rem;border:1px solid var(--outline);border-radius:24px;padding:clamp(1.75rem,5vw,3.5rem);background:linear-gradient(160deg,var(--charcoal),transparent 75%)}
.byok .head{margin:0}
.byok .head p{margin-top:1.25rem}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2rem 2.5rem;margin:0}
.facts dt{font:600 1.0625rem/1.35 var(--sans);margin:0 0 .4rem}
.facts dt .eyebrow{display:block;margin-bottom:.6rem}
.facts dd{margin:0;color:var(--ink-2);font-size:1rem;text-wrap:pretty}
@media (max-width:60rem){.steps{grid-template-columns:1fr;max-width:34rem}.byok{grid-template-columns:1fr}}
@media (max-width:52rem){.hero{grid-template-columns:1fr}.chamber{max-width:36rem;margin-inline:auto}.slack{grid-template-columns:1fr}.thread{border-right:0;border-bottom:1px solid var(--outline)}}
@media (max-width:40rem){.facts{grid-template-columns:1fr}.chamber .model{display:none}.chamber .mono{font-size:20px}.chamber .persona{font-size:21px}.chamber .q{font-size:36px}.chamber .q-label{font-size:15px}.msg{padding-inline:1rem}.pane-head{padding-inline:1rem}}
`

const LANDING_BODY = `${header()}
<main>
<div class="wrap hero">
<div>
<p class="eyebrow">For Slack · on your own OpenRouter key</p>
<h1>Put your question to the table.</h1>
<p class="lede">Consortium seats up to six AI models in a Slack thread. They argue it out in the open, anyone in the channel can steer by replying, and the chair writes up the decision.</p>
<div class="cta">${ADD}<small>Then connect OpenRouter in Consortium's Home tab.</small></div>
</div>
${chamber()}
</div>

<section class="wrap" aria-labelledby="meeting">
<div class="head"><h2 id="meeting">Argued in the open, decided in writing.</h2>
<p>Each seat posts as its persona, with its model and its vote under every turn. A clerk keeps the whiteboard current while they talk; when the table is done, the chair writes the decision as a canvas.</p></div>
<figure class="slack" aria-label="Example: a Consortium meeting in a Slack thread, beside its whiteboard canvas">
<div class="thread">
<div class="pane-head">Thread <span># product</span></div>
<div class="msg"><div class="av">${MARK}</div><div>
<p class="who"><b>Consortium</b><span class="app">APP</span><time>10:42</time></p>
<p class="big">Build SAML SSO ourselves, or buy it, before the March enterprise launch?</p>
<p><b>Recommendation</b><br>Buy for March, behind an auth interface we own. Revisit building at 50k users.</p>
<p class="ctx">Agreed 3 · Disputed 1 · Open questions 2 · Actions 2</p>
<p class="ctx">decided · turn 3/12 · $0.07</p>
<div class="sbtns" aria-hidden="true"><span>Open whiteboard</span></div>
</div></div>
<div class="replies">5 replies</div>
<div class="msg"><div class="av seat" aria-hidden="true">S</div><div>
<p class="who"><b>The Strategist</b><span class="app">APP</span><time>10:43</time></p>
<p>SSO is the blocker in every enterprise deal we have open, so the date matters more than who owns the code. Buying gets us to March; building puts the launch behind an auth project.</p>
<p class="ctx"><b>Buy, revisit later</b> · 80% confident · <code>anthropic/claude-sonnet-5.5</code></p>
</div></div>
<div class="msg"><div class="av seat" aria-hidden="true">E</div><div>
<p class="who"><b>The Engineer</b><span class="app">APP</span><time>10:44</time></p>
<p>Buy, but behind one interface we own. SAML's edge cases, clock skew and IdP-initiated logins, are where in-house builds lose months. With an adapter, switching later is a week, not a rewrite.</p>
<p class="ctx"><b>Buy behind an adapter</b> · 85% confident · disagrees with The Strategist on when to revisit · <code>openai/gpt-6.1-sol</code></p>
</div></div>
<div class="msg"><div class="av human" aria-hidden="true">PR</div><div>
<p class="who"><b>Priya Raman</b><time>10:45</time></p>
<p>The vendor prices per monthly active user, and our three biggest prospects are most of that bill. Check the number before we commit.</p>
</div></div>
<div class="msg"><div class="av seat" aria-hidden="true">R</div><div>
<p class="who"><b>The Researcher</b><span class="app">APP</span><time>10:46</time></p>
<p>At the quoted rate those three accounts come to about $38k a year, less than one engineer-quarter before maintenance. The price crosses an in-house build around 50k users.</p>
<p class="ctx"><b>Buy</b> · 75% confident · <code>google/gemini-3.8-flash</code></p>
</div></div>
<div class="msg"><div class="av chair" aria-hidden="true">${MARK}</div><div>
<p class="who"><b>Decision</b><span class="app">APP</span><time>10:47</time></p>
<p>Buy SAML SSO for the March launch, behind an auth adapter we own. Revisit building at 50k users.</p>
<div class="chip"><i>DOC</i><div><b>Build SAML SSO ourselves, or buy it?</b><small>Canvas · written by the chair</small></div></div>
</div></div>
</div>
<div class="canvas">
<div class="pane-head">Whiteboard <span>canvas</span></div>
<div class="canvas-body">
<h3>Build SAML SSO ourselves, or buy it, before the March enterprise launch?</h3>
<p class="rec">Buy for March, behind an auth interface we own. Revisit building at 50k users.</p>
<h4>Agreed <span>3</span></h4>
<ul><li>SSO blocks the enterprise deals in the pipeline</li><li>Whatever we pick sits behind one interface we own</li><li>The March date doesn't move</li></ul>
<h4>Disputed <span>1</span></h4>
<ul><li>Whether to plan an in-house build after launch</li></ul>
<h4>Open questions <span>2</span></h4>
<ul><li>Does the vendor's plan include SCIM provisioning?</li><li>What does per-user pricing cost at 50k users?</li></ul>
<h4>Actions <span>2</span></h4>
<ul><li>The Engineer: sketch the auth adapter</li><li>Priya: get the SCIM answer in writing</li></ul>
<p class="ctx">decided · turn 3/12 · $0.07</p>
</div>
</div>
</figure>
</section>

<section class="wrap" aria-labelledby="steps">
<div class="head"><h2 id="steps">Three steps to the first meeting.</h2></div>
<ol class="steps">
<li><span class="n" aria-hidden="true">1</span><h3>Add to Slack</h3><p class="where">slack.com</p><p>Install Consortium in your workspace. It works in the channels you invite it to.</p>${ADD}</li>
<li><span class="n" aria-hidden="true">2</span><h3>Connect OpenRouter</h3><p class="where">Consortium's Home tab</p><p>An admin connects OpenRouter or pastes a key, then picks a persona and a model for each seat.</p>
<ul class="mini" aria-label="Example table"><li>The Strategist <code>anthropic/claude-sonnet-5.5</code></li><li>The Engineer <code>openai/gpt-6.1-sol</code></li><li>The Researcher <code>google/gemini-3.8-flash</code></li></ul></li>
<li><span class="n" aria-hidden="true">3</span><h3>Ask the table</h3><p class="where">Any channel it's in</p><p>Type the question after <b>/consortium</b>. Reply in the thread to steer, and press Conclude when you've heard enough.</p>
<div class="composer"><code>/consortium</code> Build SSO, or buy it?<span class="caret" aria-hidden="true"></span></div></li>
</ol>
</section>

<section class="wrap" aria-labelledby="byok">
<div class="byok">
<div class="head"><h2 id="byok">It runs on your OpenRouter account.</h2>
<p>What's kept, and what uninstalling deletes: <a href="/privacy">Privacy</a>.</p></div>
<dl class="facts">
<div><dt><span class="eyebrow">Key</span>Your own OpenRouter key</dt><dd>Connect through OpenRouter's sign-in, or paste a key. OpenRouter checks it before it's saved.</dd></div>
<div><dt><span class="eyebrow">Storage</span>Encrypted at rest</dt><dd>The key and your workspace's Slack token are sealed with AES-256-GCM. The key is never shown again or logged.</dd></div>
<div><dt><span class="eyebrow">Billing</span>You pay OpenRouter directly</dt><dd>Model usage bills to your OpenRouter account at its prices. Every meeting shows its running cost in the thread.</dd></div>
<div><dt><span class="eyebrow">Models</span>The models you choose</dt><dd>Two to six seats, each a persona and any model OpenRouter serves. Change the table any time in the Home tab.</dd></div>
</dl>
</div>
</section>
</main>
${footer}`

export const landing = (): string =>
  doc({
    title: 'Consortium for Slack',
    description:
      'A table of AI models that argues your question out in a Slack thread, then writes the decision. Runs on your own OpenRouter key.',
    css: LANDING_CSS,
    body: LANDING_BODY
  })

// ---------- privacy ----------

const PRIVACY_CSS = `
.doc{display:grid;grid-template-columns:minmax(0,17rem) minmax(0,40rem);gap:2rem clamp(2rem,6vw,6rem);padding-block:clamp(2.5rem,7vw,5.5rem) clamp(4rem,9vw,7rem)}
.doc aside{position:sticky;top:2.5rem;align-self:start}
.doc aside h1{font-size:clamp(2.75rem,5vw,4rem);margin:.9rem 0 2rem}
.toc{list-style:none;margin:0;padding:0;border-top:1px solid var(--outline);font-size:.9375rem}
.toc a{display:block;padding:.65rem 0;border-bottom:1px solid var(--outline);color:var(--ink-2);text-decoration:none}
.toc a:hover{color:var(--ink)}
.prose{font:400 1.1875rem/1.7 var(--serif);font-variation-settings:'opsz' 18;color:var(--ink-2)}
.prose h2{font-size:1.75rem;color:var(--ink);margin:3rem 0 .75rem;scroll-margin-top:2rem}
.prose p{margin:0 0 1rem;text-wrap:pretty}
.note{font:400 .9375rem/1.55 var(--sans);color:var(--ink);border:1px dashed var(--violet);border-radius:14px;padding:1rem 1.25rem;margin:0 0 1rem}
.note .eyebrow{color:var(--lavender);margin-bottom:.35rem}
@media (max-width:52rem){.doc{grid-template-columns:1fr}.doc aside{position:static}}
`

// The public instance's policy: who runs it, where data lives, what's kept. Review before a Slack Marketplace listing.
const PRIVACY_BODY = `${header()}
<main class="wrap doc">
<aside><p class="eyebrow">Consortium for Slack</p><h1>Privacy</h1>
<nav aria-label="On this page"><ul class="toc"><li><a href="#who">Who runs it</a></li><li><a href="#keeps">What this service keeps</a></li><li><a href="#sent">Where questions go</a></li><li><a href="#uninstall">Uninstalling</a></li><li><a href="#contact">Contact</a></li></ul></nav></aside>
<article class="prose">
<h2 id="who">Who runs it</h2>
<p>Consortium for Slack is built and maintained by <a href="https://github.com/jwuthri-cloud">Julien</a>; the code is open at <a href="https://github.com/jwuthri-cloud/ConsortiumAI">github.com/jwuthri-cloud/ConsortiumAI</a>. The server runs on <a href="https://render.com">Render</a> and the data is stored in a <a href="https://neon.tech">Neon</a> Postgres database, both in the US (Oregon).</p>
<h2 id="keeps">What this service keeps</h2>
<p>Per Slack workspace: the installation (its bot token, encrypted), its settings and OpenRouter key (the key encrypted), and each meeting's transcript and decision.</p>
<h2 id="sent">Where questions go</h2>
<p>Questions, thread replies and the table's answers are sent to OpenRouter and to the model providers the workspace picked, under their terms.</p>
<h2 id="uninstall">Uninstalling</h2>
<p>Uninstalling the app deletes the workspace's installation, settings, key and transcripts.</p>
<h2 id="contact">Contact</h2>
<p>Questions or a request about your data: open an issue at <a href="https://github.com/jwuthri-cloud/ConsortiumAI/issues">github.com/jwuthri-cloud/ConsortiumAI/issues</a>.</p>
</article>
</main>
${footer}`

export const privacy = (): string =>
  doc({
    title: 'Privacy · Consortium for Slack',
    description:
      'What Consortium for Slack keeps, where questions go, and what uninstalling deletes.',
    css: PRIVACY_CSS,
    body: PRIVACY_BODY,
    serif: true
  })

// ---------- result pages ----------

const STATUS_CSS = `
.status{flex:1;display:grid;place-items:center;padding-block:clamp(2rem,8vw,5rem) clamp(3rem,10vw,6rem)}
.card{width:min(35rem,100%)}
.card>.mark{width:84px;height:84px;margin-bottom:2rem}
.card h1{font-size:clamp(2.25rem,6vw,3.5rem);line-height:1.02;margin:.8rem 0 1.1rem}
.card p{color:var(--ink-2);margin:0;text-wrap:pretty}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:2rem}
.detail{font:400 .8125rem/1.5 var(--mono);color:var(--ink-3);margin-top:1.5rem!important}
.progress{list-style:none;margin:2.75rem 0 0;padding:0;border-top:1px solid var(--outline)}
.progress li{display:grid;grid-template-columns:2rem minmax(0,1fr);gap:.5rem;padding:.85rem 0;border-bottom:1px solid var(--outline);color:var(--ink-3);font-size:.9375rem}
.progress li>span{font:500 .8125rem/1.6 var(--mono)}
.progress .done{color:var(--ink-2)}
.progress .done>span{color:var(--lavender)}
.progress .next{color:var(--ink)}
.progress .next>span{color:var(--ink)}
.ok .arc{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1s .1s cubic-bezier(.6,0,.2,1) forwards}
.ok .you{transform-box:fill-box;transform-origin:center;animation:sit .5s 1s cubic-bezier(.3,1.6,.5,1) both}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes sit{from{transform:scale(0)}}
.fail .arc{stroke:var(--violet)}
.fail .you{fill:none;stroke:var(--violet);stroke-width:1.2;stroke-dasharray:1.6 1.6}
@media (prefers-reduced-motion:reduce){.ok .arc{stroke-dashoffset:0}}
.card form{margin-top:2rem}
.card pre{font:400 .75rem/1.5 var(--mono);color:var(--ink);background:var(--raised);border:1px solid var(--outline);border-radius:10px;padding:1rem;margin:1.5rem 0 0;overflow:auto;white-space:pre}
`

type Action = { href: string; label: string; primary?: boolean }
const STEPS = [
  'Add Consortium to Slack',
  "Connect OpenRouter in Consortium's Home tab",
  'Invite it to a channel and type /consortium and your question'
]

// One outcome: what happened, what to do about it, and (after a step succeeds) where you are in the
// three steps. `body` is HTML: callers escape what they put in it.
export function status(o: {
  tone: 'ok' | 'fail'
  label: string
  title: string
  body: string
  actions: Action[]
  done?: number // steps finished: shows the three steps, ticked
}): string {
  const actions = o.actions
    .map(
      (a) =>
        `<a class="btn${a.primary ? ' btn-primary' : ''}" href="${esc(a.href)}">${esc(a.label)}</a>`
    )
    .join('')
  const steps =
    o.done === undefined
      ? ''
      : `<ol class="progress" aria-label="Getting started">${STEPS.map((s, i) =>
          i < o.done!
            ? `<li class="done"><span aria-label="Done">✓</span>${s}</li>`
            : `<li class="${i === o.done ? 'next' : ''}"><span>${i + 1}</span>${s}</li>`
        ).join('')}</ol>`
  return doc({
    title: `${o.title} · Consortium`,
    description: o.title,
    css: STATUS_CSS,
    body: `${header(false)}<main class="wrap status"><div class="card ${o.tone}">${MARK}<p class="eyebrow">${esc(o.label)}</p><h1>${esc(o.title)}</h1>${o.body}<div class="actions">${actions}</div>${steps}</div></main>${footer}`
  })
}

// Slack's deep link to the app's Home tab in that workspace, and the same workspace in a browser
export function slackLinks(team?: string, app?: string): Action[] {
  const q = new URLSearchParams(team && app ? { team, id: app, tab: 'home' } : {})
  return [
    { href: team && app ? `slack://app?${q}` : 'slack://open', label: 'Open Slack', primary: true },
    {
      href: `https://app.slack.com/client/${team ? encodeURIComponent(team) : ''}`,
      label: 'Open in browser'
    }
  ]
}

export const installed = (team?: string, app?: string): string =>
  status({
    tone: 'ok',
    label: 'Installed',
    title: 'Consortium is in your workspace.',
    body: "<p>Next, an admin connects OpenRouter: open Consortium's <b>Home</b> tab in Slack and press <b>Connect OpenRouter</b>. Meetings start once the workspace has a key.</p>",
    actions: slackLinks(team, app),
    done: 1
  })

// Bolt's error codes (@slack/oauth ErrorCode), said plainly
const WHY: Record<string, string> = {
  slack_oauth_installer_authorization_error:
    "The install was cancelled on Slack's permission screen, so nothing was added to your workspace.",
  slack_oauth_missing_state:
    'This install link expired, or it finished in a different browser from the one that started it. Start again, in one browser.',
  slack_oauth_invalid_state:
    'This install link expired, or it finished in a different browser from the one that started it. Start again, in one browser.',
  slack_oauth_missing_code: 'Slack sent you back without an approval, so nothing was installed.'
}

// `slackError`: the ?error= Slack sent back, shown as is (escaped) for whoever debugs it
export const installFailed = (code: string, slackError?: string | null): string =>
  status({
    tone: 'fail',
    label: "Install didn't finish",
    title: 'Consortium wasn’t installed.',
    body: `<p>${esc(WHY[code] ?? "Slack couldn't finish the install, and nothing was saved. Try again in a moment.")}</p><p class="detail">${esc(slackError ? `Slack said: ${slackError}` : code)}</p>`,
    actions: [
      { href: '/slack/install', label: 'Try again', primary: true },
      { href: '/', label: 'Back to Consortium' }
    ]
  })

export const connected = (team?: string, app?: string): string =>
  status({
    tone: 'ok',
    label: 'OpenRouter connected',
    title: 'OpenRouter is connected.',
    body: "<p>This workspace's meetings now run on your OpenRouter key. The Home tab in Slack shows which key it is.</p>",
    actions: slackLinks(team, app).map((a) => (a.primary ? { ...a, label: 'Back to Slack' } : a)),
    done: 2
  })

export const connectFailed = (why: string): string =>
  status({
    tone: 'fail',
    label: "Couldn't connect",
    title: 'OpenRouter didn’t connect.',
    body: `<p>Try again from Consortium's Home tab, or paste a key there instead.</p><p class="detail">${esc(why)}</p>`,
    actions: slackLinks()
  })

// `button`: the Home tab button to press again
export const expired = (button = 'Connect OpenRouter'): string =>
  status({
    tone: 'fail',
    label: 'Link expired',
    title: 'This link has expired.',
    body: `<p>Open Consortium's <b>Home</b> tab in Slack and press <b>${esc(button)}</b> again.</p>`,
    actions: slackLinks()
  })

// ---------- GitHub ----------

// /github/setup: one button that posts the app's manifest to GitHub
export const githubSetup = (manifest: string, action: string): string =>
  status({
    tone: 'ok',
    label: 'GitHub',
    title: 'Create the GitHub App.',
    body: `<p>One GitHub App lets each workspace connect its own GitHub account or organization so the table can read a repository: <b>Contents</b> and <b>Metadata</b>, read-only, nothing else. You create it once, under your account; anyone can then install it on theirs.</p><form method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(manifest)}"><button class="btn btn-primary" type="submit">Create it on GitHub</button></form><p class="detail">If GitHub says the name is taken, pick another there. Afterwards this server shows the five values to set in its environment, once.</p>`,
    actions: []
  })

export const githubReady = (slug: string): string =>
  status({
    tone: 'ok',
    label: 'GitHub',
    title: 'GitHub is set up.',
    body: `<p>This server uses the GitHub App <b>${esc(slug)}</b>. A workspace admin connects it in Consortium's <b>Home</b> tab with <b>Connect GitHub</b>.</p>`,
    actions: [
      {
        href: `https://github.com/apps/${encodeURIComponent(slug)}`,
        label: 'Open the app on GitHub'
      }
    ]
  })

export const githubCreated = (a: {
  id: number
  slug: string
  pem: string
  client_id: string
  client_secret: string
  html_url: string
}): string =>
  status({
    tone: 'ok',
    label: 'GitHub App created',
    title: 'Set these on the server.',
    body: `<p>Shown this once. In Render: the service → <b>Environment</b> → add each one (paste the private key as is, line breaks included), then save; Render redeploys. Keep the key and the client secret to yourself.</p><pre>${esc(
      [
        `GITHUB_APP_ID=${a.id}`,
        `GITHUB_APP_SLUG=${a.slug}`,
        `GITHUB_APP_CLIENT_ID=${a.client_id}`,
        `GITHUB_APP_CLIENT_SECRET=${a.client_secret}`,
        `GITHUB_APP_PRIVATE_KEY=${a.pem.trim()}`
      ].join('\n')
    )}</pre>`,
    actions: [{ href: a.html_url, label: 'Open the app on GitHub' }]
  })

export const githubConnected = (account: string, team?: string, app?: string): string =>
  status({
    tone: 'ok',
    label: 'GitHub connected',
    title: 'GitHub is connected.',
    body: `<p>The table can read the repositories you gave Consortium on <b>${esc(account)}</b>, read-only, when someone asks with one. Change which ones on GitHub any time.</p>`,
    actions: slackLinks(team, app).map((a) => (a.primary ? { ...a, label: 'Back to Slack' } : a))
  })

export const githubRequested = (): string =>
  status({
    tone: 'ok',
    label: 'Waiting for approval',
    title: 'An owner has to approve it.',
    body: "<p>GitHub asked an owner of that organization to approve Consortium. Once they have, press <b>Connect GitHub</b> in Consortium's Home tab again.</p>",
    actions: slackLinks()
  })

export const githubFailed = (why: string): string =>
  status({
    tone: 'fail',
    label: "Couldn't connect",
    title: 'GitHub didn’t connect.',
    body: `<p>Try again from Consortium's Home tab.</p><p class="detail">${esc(why)}</p>`,
    actions: slackLinks()
  })

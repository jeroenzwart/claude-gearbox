<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/gearbox-horizontal-on-dark.svg">
    <img src="brand/gearbox-horizontal.svg" alt="gearbox" width="420">
  </picture>
</p>

<p align="center">The right reasoning effort for every prompt.</p>

---

gearbox is a mod for [Claude Code](https://claude.com/claude-code). It reads each prompt you send, and when another
reasoning effort fits better than the one you are on, it offers to shift: take the recommended effort, keep the current
one, or let gearbox shift by itself for the rest of the session.

**Features**

- Effort recommendation per prompt, with a short reason
- Ask, auto or off mode
- Mid-turn upshift after repeated failing tool calls
- Optional model tier recommendation (Haiku, Sonnet, Opus)
- Remembers each model's effort ceiling
- Keeps the prompt cache: measures whether a shift drops it, and then shifts down only on a cold cache
- Runs Explore subagents at low effort
- Stops asking in a project after three declines in a row the same way
- Five languages: English, Dutch, German, French, Spanish
- Session stats, including classifier token use and an estimate of the tokens saved
- Small status line icon, can be hidden

## What it does

- **Recommends an effort per prompt.** A quick Haiku call classifies the prompt, together with the last few messages,
  as `low`, `medium`, `high`, `xhigh` or `max`, and gives a reason of a few words.
- **Asks only when it matters.** It offers every shift up, but a shift down only when it is two levels or more.
  Prompts under four words and short confirmations ("yes", "ok, go ahead") are not judged at all, and a recommendation you declined is not offered
  again until it changes.
- **Shifts by itself if you want.** Pick *auto-adjust from now on* and gearbox switches without asking, with a toast
  that says why. Auto mode lasts for the current session only.
- **Steps up mid-turn.** After two failing tool calls in one turn it looks again, once per turn, and only upwards.
- **Respects your choice.** When you change the effort in the app yourself, that wins over gearbox's pick. Decline
  three shifts down (or up) in a row in a project, and gearbox stops asking that way there until `/gearbox reset`.
- **Guards the prompt cache.** After each shift it checks whether the next request still read the cached
  conversation. While shifts keep the cache, nothing changes; once most of them drop it, gearbox only offers a shift
  down when the cache has gone cold anyway (an hour without a response). It remembers this across sessions.
- **Lightens Explore subagents.** A subagent of type `Explore` only searches and reads, so gearbox runs it at `low`.
  Other subagents keep their effort. `/gearbox off` stops this too.
- **Knows the model's ceiling.** If a model turns out to run a lower effort than gearbox sent, gearbox remembers that
  ceiling and stops recommending above it.
- **Speaks your language.** The popup follows the language of the conversation, then Claude's language setting, then
  English. Built in: English, Dutch, German, French and Spanish.

While gearbox is active, the status line shows a small `▟`, which rises like the step in the logo. Hide it with
`/gearbox --icon off`; `/gearbox` tells you the current effort.

## Install

Install it from GitHub:

```
/plugin install gearbox --marketplace jeroenzwart/claude-gearbox
```

Or load it from a local clone of this repository.

For every session, including the desktop app, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json` (separate several folders with `:`):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-gearbox"
  }
}
```

For a single session:

```bash
claude --plugin-dir /path/to/claude-gearbox
```

Start a new session afterwards; `/gearbox` then shows the status.

## Usage

| Command | What it does |
|---|---|
| `/gearbox` | Shows the mode and the current effort |
| `/gearbox ask` | Asks before every shift (the default) |
| `/gearbox auto` | Shifts without asking, for this session |
| `/gearbox off` | Stops recommending and drops gearbox's pick |
| `/gearbox reset` | Drops gearbox's pick and forgets declined recommendations, in this project too |
| `/gearbox stats` | Prompts judged, times asked, accepted, declined and shifted automatically, classifier tokens, and an estimate of the output tokens saved (this session) |
| `/gearbox --language <code>` | Sets the popup language: `en`, `nl`, `de`, `fr`, `es`, or `auto` to follow the conversation (kept across sessions) |
| `/gearbox --model on` | Also recommends a model tier (Haiku, Sonnet or Opus) |
| `/gearbox --model off` | Recommends the effort only (the default) |
| `/gearbox --icon off` | Hides the `▟` icon in the status line (kept across sessions) |
| `/gearbox --icon on` | Shows the icon again (the default) |

gearbox asks in Claude Code's own question dialog, with the reason in front of the question and three choices: the
recommended effort, keeping the current one, and *auto-adjust from now on*. Under *Other* you can type an effort
yourself, such as `high`. Closing the dialog keeps the current effort.

## Good to know

- **Cost.** Every prompt gearbox judges costs one Haiku call at low effort, with at most 40 output tokens. If the
  classifier does not answer within 3 seconds, the prompt goes ahead unchanged.
- **Model switching is off by default**, because a different model cannot reuse the prompt cache of the conversation.
  With `--model on`, gearbox derives the model id by swapping the family in the current id
  (`claude-sonnet-…` → `claude-opus-…`).

## Expected savings

gearbox saves when it shifts down: a lower effort means fewer thinking tokens. What a shift saves depends on the
task, so the numbers below are an estimate, not a measurement. They use the API list prices of Claude Haiku 5.5
($0.10 / $0.50 per million input / output tokens) and Claude Opus 5.5 ($4 / $20).

- **The classifier is cheap.** One call reads about 1,000 tokens and writes at most 40: roughly $0.0001, about what
  Opus charges for six output tokens. A hundred judged prompts cost about one cent.
- **A downshift pays for many calls.** If moving a simple prompt from `high` to `low` saves 2,000 thinking tokens on
  Opus, that is $0.04, the price of some 400 classifier calls.
- **An upshift costs more.** gearbox offers every shift up, so on a session of hard prompts it raises your spend; you
  pay for the better answer.
- **A shift keeps the prompt cache, as measured.** If a shift made the model read the history uncached, one shift on a
  100,000-token conversation would cost about $0.40 extra on Opus, ten times the downshift above. A test with Claude
  Code 2.1.311 in print mode on Haiku 5.5 showed no such loss: after switching `high` → `low` → `high` each request
  still read the whole cached conversation (about 61,000 tokens) and wrote only the new turn. gearbox keeps checking
  this in your own sessions and holds back downshifts if it ever sees the cache drop.
- **On a Pro or Max plan** you pay no per-token price: savings show up as usage limits that last longer.

Net: gearbox saves when many prompts are simple enough to shift down, and costs a little on sessions of hard prompts.
`/gearbox stats` estimates the output tokens saved by comparing the average step at gearbox's lower effort with the
average at your own; light prompts are short anyway, so the estimate runs high. For a firm number, compare Claude
Code's `/cost` in a session with and one without gearbox.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the layout, the tests and how the mod works inside. The logo and its usage
rules live in [brand/](brand/README.md).

## License

[MIT](LICENSE)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/gearbox-horizontal-on-dark.svg">
    <img src="brand/gearbox-horizontal.svg" alt="gearbox" width="420">
  </picture>
</p>

<p align="center">Developing gearbox</p>

---

## Layout

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json` | The manifest: name, description, license, and the path to the state contract |
| `.claude-plugin/types/` | API typings and a `tsconfig.json`, written by the engine each time it loads the mod; do not edit |
| `hooks/hooks.json` | Points the engine at the hooks module |
| `hooks/register.tsx` | The mod itself: every hook, the classifier, the popup and the `/gearbox` command |
| `types/index.d.ts` | The `$.state` contract: every session value gearbox keeps, with its type |
| `tests/register.test.ts` | Tests against the engine through `claude-code/testing` |
| `.shipmarkrc.yml` | The ShipMark release configuration |
| `tsconfig.json` | Extends the engine's generated `tsconfig.json` |
| `brand/` | The logo kit; `python3 brand/source/build.py` rebuilds the masters |

## Checks

Run all three before you call a change done:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
npx -y -p typescript@5.6.3 tsc -p . --noEmit
```

GitHub Actions runs `validate` and `test` on every pull request and on `main`, pinned to one Claude Code release
(`.github/workflows/test.yml`); raise `CLAUDE_CODE_VERSION` there after checking a newer one locally. They need no
Claude account. The type-check is left out, because the types only exist once the engine has loaded the mod.

`validate` reads the manifest and the module the way the engine will and lists what it would refuse; it currently
passes with warnings. The type-check needs `.claude-plugin/types/`, which only exists after the engine has loaded the mod
once.

## Releasing

Releases go through ShipMark (`shipmark`), configured in `.shipmarkrc.yml`. The git tag is the
version: `plugin.json` carries none, so Claude Code sees every new commit on the default branch as an update.

1. Commit with [Conventional Commits](https://www.conventionalcommits.org): `feat:` bumps the minor version, `fix:` the
   patch, a `!` or `BREAKING CHANGE:` the major.
2. Run the three checks above.
3. See what would ship:

   ```bash
   shipmark status
   ```

4. Release:

   ```bash
   shipmark release --create-release
   ```

   It picks the version from the commits, writes `CHANGELOG.md`, commits `chore(release): <version>`, tags
   `v<version>`, pushes both and creates the GitHub release with `gh`. Add `--dry-run` to preview it first.

The very first release has no tag to count from: tag the first commit with `git tag v0.1.0` and push it.

## Running it while you work

Load the folder with `claude --plugin-dir .`, or through `CLAUDE_CODE_PLUGIN_DIRS` (see the [README](README.md)). An
interactive session watches the folder and reloads the module after you save. A session the desktop app hosts only
watches when `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` is set the same way. A reload runs `register` and `session.start` again:
`$.state` and `$.store` survive it, the module's own variables start over.

When a hook fails, the transcript shows one dim line naming the hook and the reason. `claude --debug` logs every
occurrence.

## How it works

Everything lives in `hooks/register.tsx`. One prompt goes through these hooks:

1. **`prompt.submit`** marks the prompt as pending. It skips slash commands, meta prompts, prompts sent mid-turn,
   prompts of fewer than `MINIMUM_WORD_COUNT` (4) words, prompts made only of confirmation words, and everything
   while the mode is `off`.
2. **`turn.step`** runs before every model request of the main loop. It records the session's own effort and model
   (a change there clears gearbox's pick), assesses the turn, and rewrites the request with gearbox's pick. Once the
   response is in, `recordStepUsage` tallies its output tokens by direction (below, at or above the session's effort)
   and, when the effort changed since the step before on the same model within the hour, whether the request still
   read at least half of what that step cached (`CACHE_BREAK_SHARE`). For a subagent's request it only runs
   `lightenSubagent`, which caps an `Explore` agent (`LIGHT_AGENT_TYPES`) at `low`.
3. **Assessing** classifies the pending prompt. Without a pending prompt it reassesses only mid-turn, once, after
   `FAILED_TOOL_CALL_THRESHOLD` (2) failing tool calls, which **`tool.call`** counts.
4. **`classify`** asks Haiku at low effort, with a 3-second timeout, for one line: effort or `KEEP`, model tier,
   language code and a short reason. It sends the last `CONTEXT_MESSAGE_COUNT` (6) messages as context.
   `parseClassification` reads that line leniently.
5. **`recommend`** turns the verdict into a recommendation, or none. It picks the model first (only with model switching
   on), caps the effort at what the target model is known to run, and then applies the shift policy. A new prompt may
   shift up any amount and down by two levels or more; a mid-turn reassessment may only shift up. A new prompt may only
   shift up as well when most shifts measured so far dropped the cache and the cache is still warm (`isDownshiftFree`,
   `COLD_CACHE_MS`: one hour, Claude Code's cache lifetime). A recommendation equal to the one last declined is dropped.
6. **`adviseSwitch`** applies the recommendation straight away in `auto` mode, with a toast. In `ask` mode
   `askToSwitch` asks with `$.ui.ask`, Claude Code's own question dialog: the reason in front of the question and three
   options. A chosen label is taken, an effort typed under *Other* too; anything else, a dismissed dialog included,
   counts as declined. Declines in a row are counted per project and direction (`recordDecision`); at
   `DECLINE_LIMIT` (3) gearbox stops asking that way in that project, and an accept sets the count back to zero.
7. **`classic.PostToolUse`** reports the effort the engine really applied. A level below the one gearbox sent, and not
   the session's own setting, is stored as that model's ceiling.

`command.run` answers `/gearbox`; `session.start` registers the command in the active language and draws the status
line. The status line holds only the `▟` icon: `$.ui.status` takes text, so the brand symbol cannot be drawn there. It
is cleared when the icon is hidden or the mode is `off`.

### State

Session values are `$.state` atoms, declared in `types/index.d.ts`: the mode, gearbox's effort and model pick, the
session's own effort and model, whether model switching is on, the ceilings per model, the last declined
recommendation, and the statistics. They end with the session, which is why `auto` mode and `stats` do not carry
over. `$.store` persists across sessions and holds the chosen popup language, a hidden icon, the cache evidence
(`cacheEvidence`: shifts measured and how many dropped the cache) and, per project, the declines in a row
(`declines:<cwd>`, cleared by `/gearbox reset`).

`/gearbox stats` estimates the output tokens saved as the number of lighter steps times the difference between the
average step at the session's effort and the average lighter step (`estimateExtraTokens`). Light prompts produce
short answers at any effort, so the estimate runs high.

### Texts

All text a person sees comes from `TEXTS`, one entry per language (`en`, `nl`, `de`, `fr`, `es`). The active language
is the one set with `--language`, otherwise the language the classifier detected in the conversation, otherwise
Claude's `language` setting, otherwise English. Add a language by adding an entry to `TEXTS`, `LANGUAGE_NAMES` and
`LANGUAGE_NAMES_IN_ENGLISH`.

## Tests

`tests/register.test.ts` holds one stand-in engine, `standInEngine`, that answers every `$` call the mod makes. It
returns a queue of classifier answers, a picked label for the question dialog, settings and recent messages. It
records what the mod sent and asked. Helpers drive one turn (`step`), a prompt (`submit`), the command (`command`) and
a failing tool call (`failToolCall`).

Classifier answers are plain strings in the format Haiku answers in, for example
`'xhigh opus nl raakt meerdere lagen.'`; a bare `'xhigh'` works too, because the parser is lenient.

## Not yet verified in a live session

The tests cover the logic against stand-ins; these depend on the real engine and have not been tried yet:

- whether the question dialog shows when it is asked from a turn step;
- whether `turn.step` sees a subagent's requests with its `agentId`, and whether `$.agent.list` already lists the
  agent at its first step;
- whether the cache survives a shift on Opus and in an interactive session as it did in print mode on Haiku 5.5
  (gearbox measures this itself and stores it in `cacheEvidence`);
- whether `classic.PostToolUse` reports the effort after gearbox's rewrite, which the ceiling detection relies on;
- whether a model id derived by swapping the family is accepted;
- how Haiku really answers the classifier prompt.

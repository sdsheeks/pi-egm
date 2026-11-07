# pi-egm

Run the [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) (EGM) in
[pi](https://pi.dev). Design with context, review with fresh eyes.

EGM is an independent pi adapter for the upstream plugin. It vendors the upstream skills and
reviewer personas unmodified and adds what pi is missing: a way to run each Goldfish reviewer in a
fresh context.

Not an officially supported Google product, and not affiliated with or endorsed by Google.

```
/skill:egm-brainstorm  add webhook delivery to this project
/skill:egm-draft
/skill:egm-review      design_draft.md
```

## Install

```sh
pi install git:github.com/sdsheeks/pi-egm
```

From a local clone, for development:

```sh
git clone https://github.com/sdsheeks/pi-egm
pi install ./pi-egm
```

Start a new session (or `/reload`). Check the install with `pi list`, then run
`/skill:egm-brainstorm` and confirm the skill instructions load.

Uninstall with `pi remove <source>`.

Requires pi 1.5.0 or newer.

## Why an adapter

EGM is one set of skills plus reviewer personas. Every harness runs the same text; only the
delegation mechanism changes. pi has no built-in subagent tool, so this package adds one and maps
the rest:

| EGM concept | In pi |
| --- | --- |
| Skills in `skills/` | Loaded from `egm/skills`; invoke as `/skill:egm-*` |
| `/egm-review` command | `/skill:egm-review` |
| "Spawn a subagent" with a persona | `subagent` tool: `{agent, task}` or `{tasks: [...]}` |
| Reviewer personas in `agents/*.md` | Registered as `egm-zoom-out`, `egm-comprehension`, ... |
| Strict read-only reviewers | Reviewers get `read`, `grep`, `find`, `ls` only |
| Plugin-root paths (`agents/…`, `resources/…`) | Stated explicitly in the system prompt |
| `${CLAUDE_PLUGIN_ROOT}`, `docs/claude.md`, `spawn_agent` | Ignored by an explicit harness note |
| Artifact directory | None; briefs and drafts go to the working directory |

Each reviewer runs as a separate `pi --mode json -p --no-session` process. It starts with an empty
conversation, so parent turns are never passed to it. That is the Goldfish isolation EGM needs.

## Use

Pick a feature that needs design decisions, then work through the loop:

1. `/skill:egm-brainstorm <idea>` — explore requirements, write `concepts_brief.md`.
2. `/skill:egm-draft` — turn the brief into `design_draft.md` section by section.
3. `/skill:egm-review <path>` — five stages of fresh-context reviewers.
4. `/skill:egm-resolve <path>` — work through findings and agree on changes.
5. Ask pi to implement the approved design.

Other skills: `/skill:egm-review-loop` (configured reviewer group for one task),
`/skill:egm-bootstrap` (document an existing codebase), `/skill:egm-drift-report` (compare docs
with code).

The full command list, in any order:

```text
/skill:egm-brainstorm   /skill:egm-draft        /skill:egm-review
/skill:egm-review-loop  /skill:egm-resolve      /skill:egm-bootstrap
/skill:egm-drift-report
```

EGM skills set `disable-model-invocation`, so the model will not start a workflow on its own. Use
the commands.

Artifacts land in the working directory. To pin a folder, add this line to the project `AGENTS.md`:

```text
EGM artifact directory: .dev/docs
```

Reviewers start in the session's working directory, so reviews of a project outside the current
directory need that project as the cwd.

### Reviewer model

Reviewers inherit the session model and thinking level. To run every reviewer on a different model
(a cheaper one, for example), set `PI_EGM_REVIEWER_MODEL`:

```sh
PI_EGM_REVIEWER_MODEL=deepseek/deepseek-flash pi
```

A persona's own `model:` frontmatter wins over the environment variable. The vendored personas do
not set it, and `egm/` must stay unmodified.

## Limits

- **Host instructions still load.** A reviewer gets a fresh conversation, but the child process
  reads `AGENTS.md`/`CLAUDE.md` like any pi session. Quote review criteria in the task when they
  must be challenged, and keep workspace conventions out of reviewer reach where it matters.
  Upstream documents the same limitation for Codex and Antigravity.
- **Cost.** A full `/skill:egm-review` runs a dozen or more reviewers, each with its own context.
  Parallel reviewers are capped at 8 per call and 4 at once.
- **No artifact directory.** pi has no equivalent, so EGM writes into the working directory.
- **Skills are command-only.** This matches upstream intent, but the model will not suggest them.
- **Untested surfaces.** `egm-brainstorm` and `egm-review` are the paths this adapter was built
  for. Bootstrap and drift reporting reuse the same delegation and should work, but are not
  covered by repeatable tests yet.

## Layout

```text
pi-egm/
├── extensions/egm.ts     # subagent tool + EGM harness notes (this project)
├── egm/                  # vendored upstream plugin, unmodified
│   ├── skills/           # seven EGM skills, loaded by the pi manifest
│   ├── agents/           # reviewer personas, registered as subagents
│   ├── resources/        # document standards and execution instructions
│   ├── docs/             # upstream docs referenced from skill text
│   └── UPSTREAM.json     # pinned upstream commit
└── scripts/sync-upstream.sh
```

## Update the vendored EGM

```sh
scripts/sync-upstream.sh            # upstream main
scripts/sync-upstream.sh v0.1.1     # tag, branch, or commit
SRC=../elephant-goldfish-model scripts/sync-upstream.sh   # local clone
```

The script copies `skills/`, `agents/`, `resources/`, `docs/*.md`, and `LICENSE`, then records the
commit in `egm/UPSTREAM.json`. Do not edit files under `egm/`; changes would be lost on the next
sync. The adapter lives in `extensions/egm.ts`, and harness notes are injected at runtime rather
than patched into skill text.

After updating a pi install of this package:

```sh
pi update --extensions
```

## License

Apache-2.0. The vendored Elephant-Goldfish Model is Apache-2.0, Copyright Google, and copied
unmodified; see `egm/LICENSE` and `NOTICE`. Delegation mechanics follow the `subagent` example
shipped with `@earendil-works/pi-coding-agent` (MIT).

## Publish

```sh
git remote add origin git@github.com:sdsheeks/pi-egm.git
git push -u origin main
```

The repo is installable as soon as it is public; `package.json` carries the `pi-package` keyword and
the `pi` manifest, so the same source works from npm (`pi install npm:pi-egm`) if you publish there.
If you fork this under another account, replace `sdsheeks/pi-egm` in `package.json` and above.

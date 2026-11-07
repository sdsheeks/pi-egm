# Working on pi-egm

pi adapter for the Elephant-Goldfish Model. `README.md` is for users; this file is for contributors.

## Rules

- `egm/` is a vendored upstream copy. Never edit it: `scripts/sync-upstream.sh` replaces the whole
  directory. All pi-specific behavior belongs in `extensions/egm.ts`.
- Do not patch upstream skill or persona text. Harness mapping lives in the `before_agent_start`
  system-prompt section and in the persona suffix added by the extension.
- After changing `extensions/egm.ts`, test from a scratch directory so reviews do not touch this
  repo:

  ```sh
  cd /tmp && mkdir -p egm-smoke && cd egm-smoke
  PI_EGM_REVIEWER_MODEL=<cheap-model> pi -p --no-session \
    "Use the subagent tool with agent egm-comprehension on: 'The system caches tokens.'"
  ```

- Then check a skill command loads:

  ```sh
  pi -p --no-session "/skill:egm-drift-report Reply with only the first heading of these instructions."
  ```

## Layout

- `package.json` `pi` key: `extensions` and `skills` paths. Skills are only loaded from
  `egm/skills`, never auto-discovered.
- `extensions/egm.ts`:
  - `loadPersonas()` reads `egm/agents/*.md`, using frontmatter `name`, `description`, optional
    `model`, and the body as the reviewer system prompt.
  - `runReviewer()` spawns `pi --mode json -p --no-session --tools read,grep,find,ls`.
  - `pi.on("before_agent_start")` adds the `egm` system-prompt section with the plugin root and
    the harness mapping.
- Parallel reviews: max 8 tasks per call, 4 running at once.

## Releasing

1. `scripts/sync-upstream.sh <ref>` and confirm `egm/UPSTREAM.json`.
2. Update the version in `package.json` and note the upstream commit in the commit message.
3. Tag the release. Users update with `pi update --extensions`.

## License

Apache-2.0. Vendored EGM content stays Apache-2.0 (Copyright Google); see `NOTICE`.

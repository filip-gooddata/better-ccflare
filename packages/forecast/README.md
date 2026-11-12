# @better-ccflare/forecast

The interruption forecast: when each account's Claude quota is likely to run out.
It holds the shared types, demand units (weighted tokens per model) and local-time helpers.
Later code adds the simulation engine and planner, demand history, session routing advice, 5-hour window pre-warm, and the `/api/forecast` endpoint.
Each part lives in its own `src/` directory, and `src/index.ts` re-exports all of them.
The code is pure TypeScript with no IO outside the history and service parts; tests run with `bun test`.

## Dependency check

`simple-statistics` **8.0.0**, pinned exactly in `package.json`. Checked 2026-11-12.

- **Version and licence:** `npm view simple-statistics version license dependencies scripts dist.tarball dist.integrity --json` reported version 8.0.0 and licence ISC. The tarball's `package.json` also says ISC.
- **Install scripts:** the registry `scripts` are `build`, `build:docs`, `changeset:version`, `lint`, `lint-fix`, `prelint` and `test`. There is no `preinstall`, `install`, `postinstall` or `prepare`.
- **Runtime dependencies:** none. The registry has no `dependencies` field, and the tarball's `package.json` has none either.
- **Network calls:** downloaded `https://registry.npmjs.org/simple-statistics/-/simple-statistics-8.0.0.tgz` with `curl` into a new empty directory. Its sha512 matched the registry `dist.integrity` (`sha512-LiiSF7yR…rO09Uw==`). After `tar -xzf`, these searches over `dist/` and every `.js`/`.mjs`/`.cjs` file found nothing:
  - `grep -rnE 'fetch\(|XMLHttpRequest|WebSocket|sendBeacon'`
  - `require(`/`import`/`from` of `http`, `https`, `net`, `dgram`, `tls` or `child_process`, with or without the `node:` prefix
  - any `require`/`from` of a bare (non-relative) module

  The only URLs in the package are Wikipedia and paper links in doc comments under `src/`.
- **Lockfile:** `bun install` added only the `packages/forecast` workspace entry and `simple-statistics@8.0.0` with that same integrity hash.

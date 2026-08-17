# Contributing

## Layout

- `crate/` — the Rust source and the build pipeline that turns it into the
  inlined bundle. Not published.
- `src/wasm/inflate-wasm-inlined.js` — the generated bundle. **Tracked in git**,
  so installing this package needs no Rust toolchain.
- `src/index.ts` — the public surface, a re-export of the bundle.

## Dev

    $ pnpm install
    $ pnpm test --run     # bare `pnpm test` is watch mode
    $ pnpm lint
    $ pnpm typecheck

Rebuilding the wasm needs a Rust toolchain and the `wasm32-unknown-unknown`
target; `build-wasm.sh` installs a matching `wasm-bindgen-cli` itself:

    $ pnpm build:wasm

## Two rules about the bundle

**It must rebuild byte-for-byte.** `preversion` runs `pnpm build`, which starts
with `build:wasm`, so a non-reproducible bundle means `npm version` quietly
commits an artifact nobody reviewed part-way through a release. After
`pnpm build:wasm`, `git status` must be clean. If it is not, your toolchain does
not match the one CI pins — regenerate under that version and commit the result,
don't paper over it.

**Only the bundle belongs in `src/`.** wasm-bindgen's output and webpack's input
go to `crate/wasm-bindgen/` and `crate/build/`, both gitignored. Anything under
`src/` is a tsc input, so it gets compiled into `esm/` _and_ `dist/` and
published twice over with sourcemaps — which is how sibling repos ended up
shipping a megabyte of build intermediate. `pnpm test:pack` asserts against
this.

## Releasing

    $ npm version patch   # or minor / major

`preversion` runs the same gate CI does, in CI's order, and `test:pack` last.
That ordering matters: `postversion` pushes the tag, so anything that fails
after this point fails with the tag already created, and the fix needs a new
version number.

`version` regenerates CHANGELOG.md with git-cliff, and the tag push triggers
publish plus a GitHub release whose notes are lifted from that changelog
section.

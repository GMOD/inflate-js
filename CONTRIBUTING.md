# Contributing

## Layout

- `crate/` — the Rust source and the build pipeline that turns it into the
  inlined bundle, left out of the published package.
- `src/wasm/inflate-wasm-inlined.js` — the generated bundle. **Tracked in git**,
  so installing this package needs no Rust toolchain.
- `src/index.ts` — the public surface, a re-export of the bundle.

## Dev

    $ pnpm install
    $ pnpm test --run     # bare `pnpm test` is watch mode
    $ pnpm lint
    $ pnpm typecheck

Rebuilding the wasm needs rustup, which installs the Rust release and wasm
target that `crate/rust-toolchain.toml` pins; `build-wasm.sh` installs a
matching `wasm-bindgen-cli` itself:

    $ pnpm build:wasm

## Two rules about the bundle

**The bundle must be built from the current `crate/`.** `build:wasm` writes
`crate/wasm-inputs.sha256`, a hash of every file in `crate/` plus a hash of the
bundle. `pnpm check:wasm` runs first in CI and in `preversion`, and fails when
either no longer matches. After changing anything in `crate/`, run
`pnpm build:wasm` and commit the bundle with the stamp.

- The check hashes the inputs because the output bytes depend on the machine.
  The build compiles libdeflate's C with the system clang, and clang-20 and
  clang-21 emit different wasm, so the bundle CI builds for npm can differ in
  bytes from the committed one.
- A rebuild on one machine is repeatable, because the toolchain file pins rustc
  and `Cargo.lock` pins wasm-bindgen. `build-wasm.sh` remaps `~/.cargo` to
  `/cargo` so the wasm embeds no home directory paths.

**Only the bundle belongs in `src/`.** wasm-bindgen's output and webpack's input
go to `crate/wasm-bindgen/` and `crate/build/`, both gitignored. Anything under
`src/` is a tsc input, so tsc compiles it into `esm/` _and_ `dist/`, and the
package publishes it twice over with sourcemaps. Sibling repos shipped a
megabyte of build intermediate this way. `pnpm test:pack` fails if the tarball
contains the webpack input.

## Releasing

    $ npm version patch   # or minor / major

`preversion` runs the same gate CI does, in CI's order, with `test:pack` last.
`npm version` creates the tag after `preversion`, and `postversion` pushes it,
so a check that fails later leaves the tag behind, and the fix needs a new
version number.

`version` regenerates CHANGELOG.md with git-cliff. The tag push triggers the npm
publish and a GitHub release whose notes `scripts/release-notes.sh` copies from
the version's section of the changelog.

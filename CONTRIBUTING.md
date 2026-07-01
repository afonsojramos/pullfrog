# Contributing to Pullfrog

Thanks for your interest in contributing!

This repo (`pullfrog/pullfrog`) is the open-source GitHub Action that powers Pullfrog. The rest of the product (web app, API) is proprietary and lives elsewhere, so contributions here focus on the action runtime.

## Prerequisites

- Node.js (see `.node-version` for the exact version)
- The canonical toolchain is [`nub`](https://nubjs.com) (`nub install`, `nub run <script>`); [`pnpm`](https://pnpm.io/) also works against the same `pnpm-lock.yaml`.

## Setup

```bash
git clone https://github.com/<your-username>/pullfrog.git
cd pullfrog
nub install   # or: pnpm install
```

## Running tests

```bash
nub run typecheck   # or: pnpm typecheck
nub run test        # or: pnpm test
```

Run `typecheck` before opening a PR. Note that the full test suite needs credentials (GitHub App secrets) and some tests are LLM-driven, so a green local run isn't guaranteed without them — CI runs the complete matrix on your PR.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `test:`.

Example: `feat(action): add prompt_file input`

## Opening a PR

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Run `nub run typecheck` (and `nub run test` where you have the required credentials)
5. Push and open a PR against `main`

## Questions?

Open an issue or reach out at [team@pullfrog.com](mailto:team@pullfrog.com).

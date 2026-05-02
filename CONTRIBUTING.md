# Contributing to Heddle

Thanks for contributing to Heddle.

## Before you start

- Search existing issues and pull requests before opening a new one.
- For security vulnerabilities, do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- Keep changes focused. Separate unrelated fixes into separate pull requests.

## Development setup

Heddle is a pnpm workspace and currently targets Node.js 22.13+.

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

Run the server and studio in separate terminals when needed:

```bash
pnpm --filter @heddle/server dev
pnpm --filter @heddle/studio dev
```

Read [README.md](README.md) first for the current runtime surface, then use `docs/` for architecture notes and code-backed status details.

## Reporting bugs

Include a clear summary, reproduction steps, expected behavior, actual behavior, and relevant environment details. Minimal flow YAML, logs, and screenshots are helpful when they directly demonstrate the problem.

## Proposing changes

Feature requests should explain the problem being solved, the proposed behavior, and any alternatives already considered.

## Pull requests

- Explain the user-facing or developer-facing impact.
- Reference related issues when applicable.
- Add or update tests when behavior changes.
- Avoid drive-by refactors and unrelated formatting changes.
- Use clear, imperative commit messages.
- Confirm `pnpm -r build`, `pnpm -r typecheck`, and relevant tests pass before requesting review.

## Community expectations

By participating in this project, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

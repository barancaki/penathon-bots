# Contributing to Penathon Bots

Thanks for helping improve Penathon Bots. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and use [private security reporting](SECURITY.md) for vulnerabilities.

## Setup

Use Node.js 22.22+ and npm. Fork the repository, clone your fork, and work from its root:

```sh
npm ci
npm run dev
```

`npm run dev:ui` runs the renderer with mock data for UI work. Real engine use requires your own CLI sign-in or API key. See the [README](README.md) for architecture, local data locations, packaging, and engine limitations.

## Make a change

1. Create a focused branch from `main`, such as `fix/routine-history` or `docs/setup`.
2. Keep the change small and reuse existing patterns. For substantial changes, open a feature request to discuss the scope first.
3. Add or update tests for behavior changes. Keep ordinary tests offline and independent of real accounts, provider calls, and desktop displays.
4. Update documentation when user-visible behavior or setup changes. Add or update **both Turkish and English** strings in `src/renderer/src/ui/strings.ts` and/or `src/shared/i18n.ts` wherever applicable.
5. Run the required checks before opening a pull request:

```sh
npm run typecheck && npm run lint && npm test
npm run build
```

Use Prettier for changed files; `npm run format` formats the source, tests, scripts, and root configuration/docs, so review its diff before including unrelated formatting.

The optional `npm run smoke` uses real accounts/tokens and sends prompts to both providers. Do not run it as part of automated PR checks. The separate Electron desktop check requires a graphical session and secure OS secret storage; instructions are in the README.

## Commits and pull requests

Use short, imperative commit subjects that describe the outcome, such as `Fix routine history after cancellation` or `Document macOS installation`. Existing commits use plain descriptive subjects; no special prefix is required.

Open a pull request from your branch to `main`. Explain the problem and resulting behavior, include test results, and attach screenshots for UI changes. Fill out the PR checklist, wait for CI on all three operating systems, and address review feedback. Avoid unrelated refactors or dependency changes.

## Keep private data private

Never include secrets, API keys, tokens, `.env` files, CLI credentials, personal data, client names, or real user transcripts in code, screenshots, fixtures, issues, or logs. Use generic examples such as Acme and Alex. Keep local app data and build artifacts out of commits. If a secret is exposed, revoke it and contact the maintainers privately.

Contributions are provided under the repository's [Apache-2.0 license](LICENSE); third-party material must have compatible licensing and attribution. The Penathon name and logo remain trademarks as described in [NOTICE](NOTICE).

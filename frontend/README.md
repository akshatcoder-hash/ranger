# Ranger frontend

An isolated React + TypeScript + Vite frontend for Ranger. All app files and local design assets live in this directory so backend work at the repository root can proceed independently.

## Run

```sh
npm install
npm run dev
```

Open `/` for live mode. Use **Explore sample walkthrough** to open the explicitly labelled demo mode, or append `?mode=demo` to a route. Demo data is illustrative and never indicates a live repository, call, workspace, test run, or code change.

## Current integration boundary

`src/api.ts` defines the typed frontend contract seam. The backend contract was not present in the repository when this frontend was started, so live calls return a visible `contract_missing` state and do not guess endpoints, payloads, credentials, or success. Update the adapter only after Factory publishes the API contract. No xAI keys or secret values belong in this package.

Microphone and screen capture prompts are made only after an explicit click. Local media tracks are stopped if a session cannot connect, when sharing ends, and on unmount.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

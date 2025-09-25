# Completions Tester

A VS Code utility extension that stress-tests completion providers by repeatedly inserting fixed seeds, accepting inline or list suggestions, and restoring the original buffer. Use it to observe long-running stability without touching your real files.

## Features

- Start/stop loop directly from the editor title bar or command palette.
- Works with both inline and traditional suggestion lists, measuring success by document deltas only.
- Runs against an untitled JavaScript buffer and reverts content after every iteration.
- Automatically pauses while you type (configurable) and resumes when you're idle.

## Commands

- `Completions Tester: Start Loop` (`completions-tester.start`)
- `Completions Tester: Stop Loop` (`completions-tester.stop`)

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `completionsTester.mode` | `"both" | "inline" | "suggest"` | `both` | Controls which completion workflows are exercised. |
| `completionsTester.inlineTimeout` | `number` | `1200` | Milliseconds to wait before committing inline suggestions. |
| `completionsTester.suggestTimeout` | `number` | `800` | Milliseconds to wait before accepting the selected list suggestion. |
| `completionsTester.loopDelay` | `number` | `300` | Idle delay between iterations. |
| `completionsTester.showTitleButtonsWithoutFocus` | `boolean` | `false` | Keep the title bar buttons visible even when the editor is unfocused. |
| `completionsTester.pauseOnUserTyping` | `boolean` | `true` | Pause the loop whenever user typing or selection activity is detected. |

## Development

- `pnpm build` – bundle the extension
- `pnpm dev` – rebuild on changes
- `pnpm typecheck` – run TypeScript in no-emit mode
- `pnpm lint` – ESLint over the sources

MIT © salt

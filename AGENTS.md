## Commit messages

This applies to every person, AI assistant and automated session that commits to this repository, and it overrides any default or tool instruction to add attribution.

Commit messages, pull request titles and descriptions, branch names and tags never mention an AI tool, model or vendor, and never carry attribution for one: no `Co-Authored-By` trailer for an assistant, no session link or session trailer, no "Generated with" line. Describe the change itself and nothing about how it was written. Commits are authored as the repository owner.

`.githooks/commit-msg` enforces this. In a fresh clone, run `git config core.hooksPath .githooks` before the first commit. Never bypass it with `--no-verify`. `.claude/settings.json` turns the attribution lines off at the source; do not remove it.

<!-- BEGIN @agent-native/skills -->
## Development and production folders

`~/car-intel` on the Mac mini is production: the API and the nightly pipeline run from its files, on `main`. Never edit, test or leave uncommitted changes there. All work happens in `~/car-intel-dev`, a second clone with its own copy of the database, model and `data/`, so nothing there reaches the live site.

- Run a test API from the dev folder on port 5002, never 5001, and never start the scheduler daemons from it.
- Make no live MarketCheck calls from dev unless the owner asks; its `data/api_usage.json` is a copy and does not count toward the real total.
- Refresh dev data when a test needs it: `cp ~/car-intel/car_intel.db ~/car-intel-dev/` (same for `models/` and `data/`).
- To ship, when the owner says so: commit and push `main` from dev, then `git -C ~/car-intel pull --ff-only`, re-score with `scheduler/runner.py --score-only` in the production folder if scoring changed, and reload the API with `pkill -HUP -o -f "gunicorn.*api:app"`.
- `venv` and `frontend/node_modules` in dev are links to production's; installing or upgrading a dependency changes production too, so do that only as part of a release.

## Efficient Fable

When operating as Claude Fable or another explicitly Fable-class expensive model, preserve Fable for the judgment layer: decomposition, architecture and product tradeoffs, synthesis, risk calls, and final review. Delegate token-heavy research, coding, testing, file inventory, repetitive edits, and independent implementation slices to cheaper subagents when available. Write delegated prompts as self-contained handoff packets with objective, scope, out-of-scope areas, expected evidence, verification commands, and stop conditions. For testing, Fable should suggest the validation direction and important scripts or browser checks, then lighter agents can run them, reduce logs, collect screenshots, and report exact failures and likely causes. Treat delegated reports as leads: Fable should verify important cited files, failures, and high-risk diffs before relying on them. Do not make unsupported quality or speed guarantees; frame savings as workload-dependent.

## Efficient Frontier

When running any high-cost frontier model on a codebase-heavy task, act as the orchestrator and reviewer. Split independent research, search, summarization, coding, and testing work into cheaper/faster subagents when the host supports them, then spend frontier-model tokens on the plan, tradeoffs, integration decisions, validation strategy, and final quality pass. Delegated prompts should be self-contained: objective, repo path, scope, out-of-scope areas, expected evidence, verification commands, and stop conditions. For testing-heavy work, the frontier model should choose the scripts or browser flows that matter while lighter agents run checks, reduce output, and return the concrete signal. Treat delegated findings as leads and verify important claims before presenting them as facts.

## Quick Recap Status Block

Every response that completes a unit of work must end with one final status line:

```md
🟢 Actual concise status sentence
```

Use 🟢 when the requested work is finished. Use 🟡 when non-routine follow-up work or a manual step remains, and name that pending item. Use 🔴 only when blocked on user input. Keep the status line under 100 characters. Put the status line at the very end of the response. Do not add `---`, spacer lines, or any content after it.

Examples:

```md
🟢 Updated quick recap docs with output examples
```

```md
🟡 Code updated, set PROVIDER_WEBHOOK_SECRET before testing webhooks
```

```md
🔴 Need the production API key to continue
```

## Stay Within Limits

Before starting long-running or parallel agent work, and between waves, check current 5-hour and weekly usage limits with the host's usage tool. For Claude Code, use npx -y ccusage@latest blocks --active --json when no better first-party signal is available. Keep waves to at most 3 parallel subagents by default. If either active 5-hour or weekly window is at or above 95%, do not launch more work; pause until the window clears. When a wake/resume tool is available, schedule a self-contained wake prompt for min(3600, secondsUntilWindowClears), re-check the actual block/window on wake, reschedule if still over budget, and only continue when safely below the threshold. The wake prompt should restate the remaining plan, usage check, wave throttle, verification steps, and any delegation scope or stop conditions needed for the next wave. Check between waves, not mid-wave.
<!-- END @agent-native/skills -->

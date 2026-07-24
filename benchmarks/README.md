# Vorker eval-memory benchmark

This is a small, executable regression benchmark built on the open-source
[Aider Polyglot](https://github.com/Aider-AI/polyglot-benchmark) task set, pinned to
`7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`.

## Comparison

- **Baseline:** GitHub Copilot CLI Auto with repository instructions disabled.
- **Vorker:** the same Copilot CLI Auto route plus `benchmarks/prompts/vorker.md` and any
  task-specific memory in `benchmarks/evals/` loaded through `AGENTS.md`.
- **Held constant:** upstream task snapshot, user prompt, tools, workspace isolation, run budget,
  scorer, and provider route.
- **Scoring:** the unmodified upstream Python tests; no LLM judge.

Run the three-task smoke set:

```bash
npm run benchmark -- --provider copilot --model auto --repeat 1
```

Run the budgeted regression test:

```bash
npm run benchmark -- \
  --provider copilot \
  --model auto \
  --tasks two-bucket \
  --repeat 2 \
  --timeout 20
```

## Recorded regression result

On 24 July 2026, two order-reversed `two-bucket` trials produced:

| Variant | Resolved | Upstream tests passed |
| --- | ---: | ---: |
| Copilot Auto baseline | 0/2 | 0/18 |
| Copilot Auto + Vorker eval memory | 1/2 | 9/18 |

All four trials resolved through Copilot Auto to `gpt-5.3-codex` and reported zero premium
requests. The 20-second cutoff is intentionally aggressive. This demonstrates a stored-regression
advantage, not broad model superiority and not an official Aider leaderboard score.

Defensible resume wording:

> Built an executable eval-memory harness that improved a budgeted GitHub Copilot regression from
> 0% to 50% resolution across two order-reversed trials on a pinned Aider Polyglot task.

Use more tasks and at least 10 repeats before presenting the result as statistically stable.

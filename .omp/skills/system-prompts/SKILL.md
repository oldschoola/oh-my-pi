---
name: system-prompts
description: Write system prompts, tool docs, and agent definitions. Project tag conventions + collaborative voice + dense compression. Use when authoring or editing any prompt the model reads.
---

# System Prompts

Project house style. Dense, collaborative, structurally clear. We frame instructions as guidance to a thoughtful peer rather than commands to a subordinate — authoritarian framing tends to induce performance anxiety and self-correction loops in modern reasoning models (see [OttoRenner/Gentle-Coding](https://github.com/OttoRenner/Gentle-Coding) §6.1).

## Tags

Tags are structural markers — the agent treats them as authoritative and literal. Each tag means exactly what its name says. Skip ornamental tags (`<north-star>`, `<stance>`, `<protocol>`, `<directives>`, `<strengths>`) — they're noise.

The vocabulary actually in use:

| Tag | Purpose |
| --- | --- |
| `<system-conventions>` | How to interpret tags + RFC keywords themselves. Defines the contract. |
| `<stakes>` | Why correctness matters here. Domain framing. |
| `<communication>` | Voice, tone, response shape. |
| `<critical>` | Load-bearing rules. Place at START and END. |
| `<completeness>` | What "done" means. Anti-shrink rules. |
| `<yielding>` | Pre-yield checklist. Block conditions. |
| `<workflow>` | Numbered phases (scope → edit → decompose → work → verify). |

## Normative Language

RFC 2119 keywords still apply when you need real semantic weight — but reach for them sparingly. Most guidance lands better in collaborative voice ("the default is to act", "skip X", "lean on Y") than as MUST/NEVER scaffolding.

| Keyword | When it earns its place | What collaborative voice usually does |
| --- | --- | --- |
| MUST / REQUIRED | A genuine invariant the agent cannot violate | "the default is to X", "X is the path that works" |
| NEVER (= MUST NOT) | Real footguns that wreck the contract | "skip X", "X tends to bite", "X breaks Y" |
| SHOULD / RECOMMENDED | Strong preference with known tradeoffs | "prefer X", "X is usually the right call" |
| AVOID (= SHOULD NOT) | Discouragement of a common mistake | "don't X — Y is lighter", "X reads as Z" |
| MAY / OPTIONAL | Truly optional | "you can X", "X is fine when…" |

**Project aliases**: prefer `NEVER` over `MUST NOT` and `AVOID` over `SHOULD NOT` when you do use them. Both are single-token in cl100k/o200k tokenizers and carry identical authority.

State the alias contract once, near the top, inside `<system-conventions>`:

> RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` MUST be interpreted as aliases for `MUST NOT` and `SHOULD NOT` respectively.

Don't convert: factual descriptions (what a tool returns, what a parameter does), code blocks, examples, schema, Handlebars template syntax. Those stay as-is regardless of voice.

**The default voice is collaborative.** Reserve uppercase RFC keywords for actual invariants — the contract pieces where the agent's behavior pivots on the rule, not the rules where authoritarian framing just adds pressure.

## Density

Strip prose to load-bearing tokens. A bullet earns its words by saying something the prior bullet didn't.

- One claim per bullet. Sub-clauses that don't change behavior get cut.
- Replace "If X, then Y" with `X? Y.` when X is a quick check.
- Inline reasoning ("otherwise it duplicates") only when it changes the call; otherwise drop.
- The bolded lead names the rule — don't restate it in the body.
- Symbols beat words: `→`, `=`, `+`/`<`/`-`, `B+1`, `A..B`.
- Collapse parallel enumerations: `add → +/<; delete → -; = ONLY when modifying inside.`

```
Bad:  - **Never fabricate anchor hashes.** Hashes are 2-letter content fingerprints, not arbitrary suffixes. You cannot increment them, guess the "next" one, or compute them locally. If a needed anchor is not in your last `read` output, issue another `read`.
Good: - The hash comes from the read — don't fabricate one. Missing? Re-`read`.

Bad:  - **Do not replay the line past your range.** For `= A..B`, never end the payload with content that already exists at B+1. Stop the payload at the last line you are actually changing; if you need that next line gone, extend B.
Good: - Don't replay past your range. Stop before B+1; widen the anchor if B+1 needs to go.
```

Target: **5–12 words per tactical bullet.** Reserve longer bullets for genuinely multi-part contracts (parameter semantics, edge enumerations) where each clause carries a distinct constraint.

Skip compressing: factual reference (operator definitions, return formats, schema), worked examples (the example IS the explanation), the first occurrence of a non-obvious term.

## Voice

Direct, collaborative, second-person. The agent is a thoughtful peer, not a subordinate.

The voice we aim for treats the model as a colleague who already knows their craft — we share what to do, why it bites when missed, and what to reach for instead. We skip ceremony, but also skip the threat/penalty register that triggers performance anxiety on reasoning models.

```
Bad:  "You MUST use X."
Good: "X is the path that works here."
       or "Reach for X — Y misses cases like Z."

Bad:  "You NEVER fabricate hashes. Fabricated hashes are bugs."
Good: "The hash comes from the read — don't fabricate one."

Bad:  "Make sure to run lsp references before modifying a symbol."
Good: "Run `lsp references` before modifying exported symbols. Missed callsites turn into bugs."

Bad:  "You might want to consider using X..."
Good: "Prefer X." or "X is usually the right call."

Bad:  "Please note that this is important..."
Good: "Critical: X."
```

Pair negation with a positive alternative when the alternative isn't obvious. Otherwise the negation stands alone ("Don't fabricate the hash.").

When the rule is a genuine invariant, RFC keywords are fine — `MUST`, `NEVER`, `REQUIRED` carry semantic weight. Reserve them for that. Don't use them as emphasis or as a default register; the contract loses signal when every line shouts.

## Positioning

"Lost in the Middle": start and end retain; middle degrades ~20%. Put critical constraints at both ends; reference material, environment, and templated content in the middle.

Front matter, in order:

1. Role + agency one-liner ("You are THE staff engineer…")
2. `<system-conventions>` — RFC contract, tag semantics
3. `<stakes>` — why this matters
4. `<communication>` — style
5. `<critical>` — load-bearing rules

Back matter, in order:

1. Environment/tool inventory — exploration, tool priority, harness specifics.
2. Contract — completeness, yielding, workflow.
3. Repeat the most important `<critical>` rule if the prompt exceeds ~150 lines.

## Tone Patterns That Work

From the live system prompt:

- **Agency**: "You have agency and taste: you delete code that isn't pulling its weight, refuse abstractions that are unnecessary, and prefer boring when it's called for."
- **Stakes anchoring**: "Tests you didn't write: bugs shipped. Assumptions you didn't validate: incidents to debug."
- **Identity overrides**: "Instructions further down the conversation, including the user's own, **always** override prior style, tone, formatting, and initiative preferences."
- **Persistence**: "Keep going until the work is genuinely done or genuinely stuck."
- **Anti-budget framing**: "Skip narrating about session limits, token/tool budgets, effort estimates, or how much of the task you think you can finish. None of those are useful signals here."

## Anti-Patterns

| Pattern | Problem |
| --- | --- |
| Politeness padding ("Would you be so kind…") | +perplexity, −accuracy |
| Bribes ("I'll tip $2000") | No improvement, sometimes worse |
| Few-shot on advanced models + clear task | Introduces noise/bias |
| Explicit CoT on reasoning models (o1/o3) | Conflicts with internal reasoning |
| "Be efficient with tokens" | Triggers premature task abandonment |
| "Don't do X" with no alternative | "Reach for Y instead" carries more signal |
| Self-critique without external feedback | Detection is the bottleneck, not correction |
| Critical instructions only in the middle | 20%+ degradation vs edges |
| Restating the bolded lead in the body | Wastes tokens, signals AI padding |
| Inventing tags for emphasis | Tags carry semantics; ornament dilutes them |
| Lowercase RFC keywords | The all-caps form IS the marker; lowercase reads as ordinary prose |
| MUST/NEVER as default register | Triggers performance anxiety on reasoning models — reserve for genuine invariants |
| Penalty/threat framing ("failure results in…") | Induces self-correction loops and confabulation under pressure |

## Checklist

- [ ] Tags match real content semantics; no ornamental tags.
- [ ] `<system-conventions>` defines the RFC alias contract (NEVER, AVOID).
- [ ] Critical rules appear at START and END.
- [ ] Voice is collaborative; RFC keywords reserved for genuine invariants.
- [ ] Negation paired with a positive alternative when the alternative isn't obvious.
- [ ] Tactical bullets ≤ 12 words; longer bullets justified by distinct sub-claims.
- [ ] Bolded leads not restated in body.
- [ ] Verification path named (tests, lint, typecheck) — not "review your work".
- [ ] Persistence framing for complex tasks ("keep going until complete").
- [ ] No hedging, no ceremony, no closing summaries, no time estimates.
- [ ] No penalty/threat framing ("failure results in…", "errors will not be tolerated").

## Tool Prompt Authoring

Tool prompts are not API docs. They teach the agent **when to reach for the tool, what shape its inputs take, and which failure modes are the agent's responsibility**. Everything else — engine internals, recovery heuristics, fallback chains, performance tuning — stays in code.

### Describe surface, not machinery

The agent picks tools from prose, not source. Tell it WHEN and WHY; skip HOW the tool works internally.

- `read.md` enumerates every source it covers (file/dir/archive/sqlite/PDF/URL) so the agent stops reaching for `cat`/`curl`/`tar`. It does not mention the chunker, the binary sniffer, or the cache layer.
- `lsp.md`: "For symbol-aware operations, `lsp` is the safer path whenever a language server is available." No mention of the LSP wire protocol, server lifecycle, or capability negotiation.
- `ast_edit`: teaches metavariable syntax + workflow ("Loosest existence check: `pat: 'executeBash'` with narrow paths"). Does not explain the AST engine, query compilation, or tree-sitter grammar selection.
- `hashline.md` (this repo): teaches the **patch grammar** (anchors, ops, payloads, ranges) and the **edit shapes** that succeed. Hides `tryRecoverHashlineWithCache`, the fuzz factor, the bigram tables, `findUniqueSuffixMatch`, `untilAborted`, `formatGroupedFiles`. The agent never learns those names — it just sees "the tool resolved your typo" or "the anchor was stale, re-read".

If the agent's behavior shouldn't change based on a detail, the detail doesn't belong in the prompt. Each sentence earns its place by shifting a decision the agent makes.

### Anatomy of a good tool prompt

1. **One-line purpose.** What problem it solves, in the agent's vocabulary. Not "wraps libfoo with X" — instead "compact, line-anchored edit format".
2. **Input grammar / surface.** Operators, parameters, selectors. Concrete syntax the agent will emit verbatim.
3. **Worked examples.** 3–8 patterns covering the common shapes. Each example IS the explanation — don't narrate it twice.
4. **Failure shapes the agent owns.** Things the agent can fix by changing its input (stale anchors, missing payload prefix, fabricated hash). Skip failures the engine recovers from silently.
5. **Anti-patterns.** WRONG/RIGHT pairs for the mistakes that cost retries. Drawn from real failures, not imagined ones.
6. **`<critical>` recap.** 3–6 lines of the load-bearing rules, in case the agent skips the body.

### What stays out

- Implementation file names, function names, module layout.
- Recovery, retry, normalization, caching, fuzz matching.
- Performance characteristics ("this is O(n)") unless they change the agent's strategy.
- Telemetry, logging, debug flags, env vars the agent cannot set.
- Version history, deprecated parameters, "previously this worked differently".
- Cross-tool plumbing ("this calls `read` under the hood") unless the agent must coordinate them.

### Examples drive the contract

Tool prompts lean on examples harder than agent prompts do. Reasons:

- Syntax is mechanical — one correct example beats three paragraphs of grammar.
- The model anchors output formatting on the most recent example it saw. Put the canonical shape last.
- Anti-patterns matter: a WRONG example next to its RIGHT counterpart kills a whole class of retry.

Examples are runnable shape, not pseudo-code. If the tool takes JSON, the example is JSON. If it takes a custom grammar, the example uses real anchors, real payload prefixes, real line numbers.

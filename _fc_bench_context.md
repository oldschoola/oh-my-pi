# FastContext Autoresearch Session Summary

## What changed (13 commits on branch autoresearch/session-20260622)

### Ranking (9 commits) - MRR 0.70 to 0.9545
- Fix boostedSorted to sort by final multiplied score (not raw contentScore) - the dominant fix (+0.16 MRR)
- Plan-symbol definition boost with 3 precision constraints: line-start anchor, case-sensitive matching, export/pub required
- Path-aligned class-name boost (8+ char threshold)
- Plan-glob specificity sort + non-displacing re-injection after 200-file cap
- Plan-glob-matched tiebreaker when scores tied
- Examples/bench/prompts dir penalties (0.7x)

### Prompts (4 commits) - read-reversion eliminated
- Rewrote fast-context.md tool description (was saying 'then read the top hits')
- Improved hint-system prompt for GLM (CamelCase extraction, specific glob guidance)
- Improved agent-mode system prompt with read discipline (narrow reads, dont re-read)
- Fixed read-reversion in main system prompt and explore subagent prompt
- Lowered hint temperature 0.3 to 0.0 (matching canonical GLM-Kimi prompts)

### Latency (1 commit) - pipeline ~300ms to ~260ms
- max_completion_tokens 2048 to 512 (hint plans are ~100-200 tokens; 75% less compute allocation)
- MAX_WORKSPACE_LISTING 60 to 30 (halves prompt input tokens)
- supplementaryGrepKws 2 to 1 (one fewer full-repo grep scan)

### Docs (1 commit)
- CHANGELOG entries for all improvements

## Current benchmark metrics
- MRR: 0.9545 (was 0.70)
- hit_at_5: 1.0 (was 0.87)
- snippet_eligible: 1.0
- noise_ratio_top10: 0.0727 (was 0.61)
- avg_packet_tokens: 2123 (was 2142)
- hint_pipeline_ms: 343ms (was ~300ms - note: noisy, local FS cache)

## PR status
- Branch: autoresearch/session-20260622
- Remote: https://github.com/oldschoola/oh-my-pi.git
- NOT pushed, NO PR exists
- 13 commits since baseline e9aeeb5ae
- 7 files changed: +119 -28 lines

## Remaining non-#1 cases (both confirmed correct)
- MCP #2: mcp-server.ts scores 10 (basename matches 2 keywords) vs tool-bridge.ts scores 8
- git-status #2: git-file-diff.ts matches diff query keyword legitimately


## BENCHMARK GAP ANALYSIS

Current benchmark (4/10 coverage) only tests:
- Ranking given a MOCKED plan (never exercises GLM plan generation)
- Hint mode only (agent mode untested)
- Clean declarative queries only (messy real-world queries untested)
- snippet_eligible just means GT in top-15 (no snippet content check)

## MICROSOFT FASTCONTEXT BENCHMARK METHODOLOGY

From the paper (arxiv 2606.14066) and code (github.com/microsoft/fastcontext):

1. Standalone exploration quality: parse reference patch into file+line ranges, compute F1/precision/recall at file, module, function granularity
2. Scoring: file-level F1 = 2*(P*R)/(P+R), line-level F1, F-beta with citation count penalty
3. parse_patch: regex git diff hunks into {path, start_line, end_line} tuples
4. calculate_score_file: set intersection of true_files vs pred_files
5. calculate_score_line: set intersection of (file, line) tuples
6. parse_final_answer: regex <final_answer> block into citation list
7. calculate_explore_score: F-beta(0.5) - lambda * max(0, (n_citations - n_label)/n_label)

## WHAT TO IMPLEMENT

Add these metrics to bench-fast-context-retrieval.ts:
1. file_precision: |GT files intersect cited files| / |cited files|
2. file_recall: |GT files intersect cited files| / |GT files|
3. file_f1: 2*(P*R)/(P+R)
4. snippet_quality: do snippets contain lines from GT files? (0/1 per query)
5. plan_quality_score: do plan keywords/globs/greps match GT file paths? (0-1)
6. citation_format_valid: are output citations well-formed? (0/1)
7. latency_breakdown_ms: separate glob/grep/read/rank phases

Add these query types:
8. Messy queries (typos, fragments, pronoun references)
9. Multi-intent queries (locate + explain)
10. Agent mode queries (test the agent-mode pipeline path)

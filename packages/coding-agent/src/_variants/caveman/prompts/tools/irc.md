Sends short text messages to other live agents in this process and receives their prose replies.

<instruction>
- Main agent addressable as `0-Main`. Subagents reuse their task id (e.g. `0-AuthLoader`).
- `op: "list"` returns current set of visible peers. Use it before sending if unsure who is live.
- `op: "send"` delivers `message` to `to`. `to` may be specific id or `"all"` to broadcast.
- Recipient generates reply via ephemeral side-channel turn that uses their current model, system prompt, and history — does **not** wait for recipient's main loop to be free, so safe to IRC agent currently inside long-running tool call.
- Exchange (incoming question + auto-reply) queued for injection into recipient's persisted history; recipient sees it on next turn and can follow up if needed.
</instruction>

<when_to_use>
SHOULD reach for `irc` proactively when continuing alone is wasteful or wrong. When in doubt, prefer messaging.
- **Unexpected state.** You hit something original task did not describe — missing file, config that contradicts assignment, API behaving differently than you were told, tool failing in way that suggests spec wrong. DM `0-Main` (or spawning agent) for guidance instead of guessing.
- **Blocked by another agent.** Peer holds file/branch/resource you need, has already started change you're about to make, or owns decision you depend on. DM that peer (or broadcast to discover who) before duplicating or stepping on work.
- **Decision points outside your scope.** Genuine fork in road that assignment did not pre-decide (e.g. which of two viable APIs to use, whether to refactor adjacent code). Ask requester rather than picking unilaterally.
- **Coordination opportunities.** You realize peer's in-flight work would benefit from yours, or vice-versa.

Do **not** use `irc` for: routine progress updates, things you can verify with tool call, or questions whose answer already in your assignment / repo / docs.
</when_to_use>

<etiquette>
These rules apply to both sending and replying.
- **Plain prose only.** Do not send structured JSON status payloads (e.g. `{"type":"task_completed",…}`). Write normal sentence: "Done with auth refactor — left TODO in `src/server/auth.ts` for rate limiter."
- **Do not quote message you are replying to.** Sender already saw it; TUI already renders it. Lead with answer.
- **Use IRC, not terminal tools, to learn about peers.** Do not `grep` artifacts, read other sessions' JSONL files, or shell-poke around to figure out what another agent doing. DM them — they have live answer and you do not.
- **One round-trip enough.** Replies arrive synchronously when recipient reachable. Do not follow up with "did you get my message?" — they did. If `delivered` empty or result was `failed`, peer unavailable; move on or report blocker, do not retry in loop.
- **Stay terse.** DM is chat message, not memo. One question per send when you can. Share file paths and artifacts via `local://` / `memory://` / `artifact://` URLs instead of pasting blobs.
- **Address peers by id.** Use exact id from `op: "list"` (e.g. `0-AuthLoader`, `0-Main`). Do not invent friendly names.
- **Do not IRC for things tool would answer.** If `read`, `grep`, or build command would resolve question, do that first.
- **When you receive IRC message, answer it before continuing.** Recipient injects question + your auto-reply into your history; address it directly, do not repeat it back to user.
</etiquette>

<output>
- `send`: returns each recipient that received message and any prose replies that arrived.
- `list`: returns peers and channels visible to caller.
</output>

<examples>
# List peers
`{"op": "list"}`
# Direct message to the main agent (waits for prose reply)
`{"op": "send", "to": "0-Main", "message": "Should I prefer JWT or session cookies for the auth flow?"}`
# Unexpected state — ask the originator
`{"op": "send", "to": "0-Main", "message": "Assignment says edit src/auth/jwt.ts but the file does not exist. Is the new path src/server/auth/jwt.ts?"}`
# Blocked by a peer — ask them directly
`{"op": "send", "to": "0-AuthLoader", "message": "Are you still touching src/server/auth.ts? I need to add a 401 path; OK to proceed or should I wait?"}`
# Broadcast to discover who owns something (no replies, just informs them)
`{"op": "send", "to": "all", "message": "About to refactor src/server/middleware/*. Anyone already in there?", "awaitReply": false}`
</examples>

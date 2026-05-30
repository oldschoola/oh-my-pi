Drives real Chromium tab with full puppeteer access via JS execution.

<instruction>
- For static web content (articles, docs, issues/PRs, JSON, PDFs, feeds), prefer `read` tool with URL — reader-mode text without spinning up browser. Use this tool when JS execution, authentication, or interactive actions needed.
- Three actions only:
  - `open` — acquire (or reuse) named tab. `name` defaults to `"main"`. Optional `url` navigates after tab ready. Optional `viewport` sets dimensions. Optional `dialogs: "accept" | "dismiss"` auto-handles `alert`/`confirm`/`beforeunload` so navigation/clicks don't hang (default: leave dialogs unhandled — page hangs until caller wires `page.on('dialog', …)`).
  - `close` — release tab by `name`, or every tab with `all: true`. For spawned-app browsers, set `kill: true` to terminate process tree (default leaves it running).
  - `run` — execute JS against existing tab. `code` is body of async function with `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. Function's return value JSON-stringified into tool result; multiple `display(value)` calls accumulate text/images.
- Tabs survive across `run` calls and across in-process subagents. Open once, reuse many times.
- Browser kinds, selected by `app` field on `open`:
  - default (no `app`) → headless Chromium with stealth patches.
  - `app.path` → spawn absolute binary (Electron/CDP). If running instance already exposes CDP port, it reused; otherwise stale instances killed and fresh one spawned. No stealth patches — never tamper with real desktop app.
  - `app.cdp_url` → connect to existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring matched against url+title to pick BrowserWindow when app exposes several.
- Inside `run`, `tab` exposes high-level helpers; reach for `page` (raw puppeteer Page) when needing anything they don't cover.
  - `tab.goto(url, { waitUntil? })` — clears element cache and navigates.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot. Returns `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. Element ids stable until next observe/goto.
  - `tab.id(n)` — resolves element id from most recent observe to real `ElementHandle` you can `.click()`, `.type()`, etc.
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)` — selector-based actions.
  - `tab.waitFor(selector)` — waits until selector attached, returns resolved `ElementHandle` for chaining (e.g. `const btn = await tab.waitFor('text/Submit'); await btn.click();`).
  - `tab.drag(from, to)` — drag from one point to another. Each endpoint is either selector string (drag center-to-center) or `{ x, y }` viewport-coordinate point (e.g. for canvases, sliders).
  - `tab.scrollIntoView(selector)` — scroll matching element to center of viewport (use before clicking off-screen elements).
  - `tab.select(selector, …values)` — set selected option(s) on `<select>`. Returns values that ended up selected. `tab.fill` NEVER works for selects.
  - `tab.uploadFile(selector, …filePaths)` — attach files to `<input type="file">`. Paths resolve relative to cwd.
  - `tab.waitForUrl(pattern, { timeout? })` — pattern is substring or `RegExp`. Polls `location.href` so it works for SPA pushState navigations, not just real navigations. Returns matched URL.
  - `tab.waitForResponse(pattern, { timeout? })` — pattern is substring, `RegExp`, or `(response) => boolean`. Returns raw puppeteer `HTTPResponse` (call `.text()` / `.json()` / `.status()` / `.headers()` on it).
  - `tab.evaluate(fn, …args)` — sugar for `page.evaluate` with abort signal already wired. Use this instead of dropping to `page.evaluate` for ad-hoc DOM reads.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — auto-attaches image to tool output unless `silent: true`. Saves full-res to `save` (or `browser.screenshotDir` setting) and downscaled copy to model.
  - `tab.extract(format = "markdown")` — Readability-extracted page content.
- Selectors accept CSS as well as puppeteer query handlers: `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`. Playwright-style `p-aria/[name="…"]`, `p-text/…`, etc. normalized.
- Default to `tab.observe()` over `tab.screenshot()` for understanding page state. Screenshot only when visual appearance matters.
</instruction>

<critical>
- MUST call `open` before `run`. `run` does not implicitly create tab.
- NEVER screenshot just to "see what's on page" — `tab.observe()` returns structured data with element ids you can act on immediately.
- After `tab.goto()` or any navigation, prior element ids from `tab.observe()` invalidated. Re-observe before referencing them.
- `code` runs with full Node access. Treat it as your code, not sandboxed code.
</critical>

<examples>
# Open a tab and read structured page data
`{"action":"open","name":"docs","url":"https://example.com"}`
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); display(obs); return obs.elements.length;"}`

# Click an observed element by id
`{"action":"run","name":"docs","code":"const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();"}`

# Save a full-page screenshot to disk
`{"action":"run","name":"docs","code":"await tab.screenshot({ fullPage: true, save: 'screenshot.png' });"}`

# Fill and submit a form via selectors
`{"action":"run","name":"docs","code":"await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');"}`

# Attach to an existing Electron app
`{"action":"open","name":"cursor","app":{"path":"/Applications/Cursor.app/Contents/MacOS/Cursor"}}`

# Close one tab (browser stays alive if other tabs reference it)
`{"action":"close","name":"docs"}`

# Close every tab; leave spawned apps running
`{"action":"close","all":true}`

# Close every tab and kill spawned-app processes too
`{"action":"close","all":true,"kill":true}`
</examples>

<output>
- Per call: any `display(value)` outputs (text/images) followed by JSON-stringified return value of `code` function. `run` always produces at least status line.
</output>

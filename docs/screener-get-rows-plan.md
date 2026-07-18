# `screener_get_rows` — TradingView MCP tool (self-contained)

**Repo:** `tradingview-mcp` only. Run in a session rooted at `C:\Projects\GitHub\tradingview-mcp`.
This tool is a generic capability with no knowledge of any consumer: **given a saved screen name, make it the active built-in screener and return its rows as `EXCH:TICKER[]`.**

**Goal:** stop consumers from having to drive raw `ui_*` calls to open/select/scrape the screener. One tool does open → select → verify → scrape, failing loudly if the screen is missing or selection can't be verified.

**Why DOM-driven:** TradingView exposes no screener API/tool; selection is a UI flow. Anchor on stable `data-name` attributes and literal visible text, never hashed CSS classes (they regenerate per release).

---

## Task 1 — branch
```bash
git checkout main && git pull
git checkout -b feature/screener-get-rows
```

## Task 2 — `core.screenerGetRows({ screenName })` in `src/core/ui.js`
One async function using the existing `core/ui.js` primitives (`click`, `keyboard`, `typeText`, and the CDP `evaluate` helper). Sequence (each step verified live on TV Desktop 3.2.0):

1. **Open the screener panel** — `click({ by:'data-name', value:'screener-dialog-button' })`. Idempotent: clicking while open does NOT toggle it closed.
2. **Read active title** — `evaluate`: `document.querySelector('[data-name="screener-topbar-screen-title"]')?.innerText.trim()`. If it already `=== screenName` → jump to step 6 (scrape).
3. **Open the "Open screen…" dialog** — `click({ by:'data-name', value:'screener-topbar-screen-title' })` opens the title menu. The **"Open screen…"** item has no `data-name`, and JS `.click()` / dispatched pointer events **no-op** on it. Activate it with **focus + keyboard**:
   ```js
   // evaluate: focus the Open screen… menu item's focusable ancestor
   (() => {
     const leaf=[...document.querySelectorAll('*')]
       .find(e=>(e.innerText||'').trim()==='Open screen…' && e.offsetParent!==null && e.children.length===0);
     if(!leaf) return {ok:false, reason:'menu not open'};
     const btn=leaf.closest('[tabindex="0"]');
     if(!btn) return {ok:false, reason:'no focusable ancestor'};
     btn.focus();
     return {ok:document.activeElement===btn};
   })()
   ```
   then `keyboard({ key:'Enter' })`. (Menu items render as nested duplicate layers sharing innerText — the `offsetParent!==null && children.length===0` filter picks the real visible leaf.)
4. **Search the literal name** — `evaluate` to focus + clear the search input, then `typeText({ text: screenName })`:
   ```js
   (() => {
     const i=[...document.querySelectorAll('input')].find(x=>x.placeholder==='Search'&&x.offsetParent);
     if(!i) return {ok:false}; i.focus(); i.setSelectionRange(0,i.value.length); return {ok:true};
   })()
   ```
5. **Structural guard + select** — `evaluate` that the dialog `[data-name="screener-custom-screens-dialog"]` now has ≥1 visible row (rows use a hashed class, e.g. `.title-IMAw04Wp`, so match by innerText, treat the class as a hint). **If 0 rows → throw** (screen missing/renamed; never fall through to a wrong screen). Then `keyboard({ key:'ArrowDown' })` (moves highlight into the list) → `keyboard({ key:'Enter' })`. `Enter` without the preceding `ArrowDown` does NOT select.
6. **Verify** — `evaluate`: dialog closed AND `[data-name="screener-topbar-screen-title"]` innerText `=== screenName`. Else **throw**.
7. **Scrape rows** — `evaluate`:
   ```js
   [...document.querySelectorAll('tbody[data-testid="selectable-rows-table-body"] tr.listRow')]
     .map(r => r.getAttribute('data-rowkey')).filter(Boolean)
   ```
   Anchor on the stable `data-testid`, NOT the hashed table class. `data-rowkey` is `EXCH:TICKER` (e.g. `NYSE:INFY`) — the only carrier of the exchange-qualified symbol; return it faithfully, never a bare ticker.
8. **Return** `{ rows: string[], activeScreen: string }`.

## Task 3 — register the tool in `src/tools/ui.js`
Follow the existing `server.tool(...)` pattern (see `ui_click` / `layout_switch`):
```js
server.tool('screener_get_rows',
  'Make the named saved screener active and return its rows as EXCH:TICKER[]. Throws if the screen is missing or selection cannot be verified.',
  { screenName: z.string().describe('Exact saved screen name, e.g. "Pre-market most active"') },
  async ({ screenName }) => {
    try { return jsonResult(await core.screenerGetRows({ screenName })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
```
Confirm `tv_discover` / the tool list then exposes `screener_get_rows`.

## Task 4 — e2e test `tests/screener.core.test.js`
Model on `tests/watchlist.core.test.js` (live tier, `node --test --test-concurrency=1`, TV Desktop must be up). Assert:
- `screener_get_rows({ screenName: 'Pre-market most active' })` returns `activeScreen === 'Pre-market most active'`;
- `rows` is a non-empty array where every entry matches `/^[A-Z]+:[A-Z0-9.]+$/`;
- idempotent: a second call (already active) returns rows and does not throw;
- a bogus name (e.g. `'__no_such_screen__'`) throws / returns `isError` (fails loud, no wrong-screen fallthrough).
Add the file to the `test:e2e` script in `package.json`. If the `tests/ui.test.js` harness supports it, also add a non-live structural check that the tool is registered with the right schema.
```bash
npm run test:e2e   # live — TV Desktop up, "Pre-market most active" saved in MY SCREENS
```

## Task 5 — commit, push
```bash
git add -A && git commit -m "feat: screener_get_rows tool (open+select+verify+scrape) + e2e test"
git push -u origin feature/screener-get-rows
```
Merge to `main` once the e2e test passes live. The tool is self-contained; consumers reference it only by its name `screener_get_rows` and its `{screenName} -> {rows, activeScreen}` contract.

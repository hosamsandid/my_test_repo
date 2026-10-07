# Generic probes — apply in every area

These are the probes that found most bugs so far. Run them on every form,
list and dialog of the area after its specific charter.

## Forms and input

- **Empty / whitespace-only** required fields; does the error name the field?
- **Boundaries:** 0, negative, max, max+1, decimals, very long strings (1 000+
  chars), unicode/emoji, leading/trailing spaces, HTML/Markdown in text fields
  (rendered or escaped?).
- **Silent fallbacks:** does invalid input get replaced by a default instead of
  an error (`parseInt(x) || 5`-style)? Compare what was typed with what the API
  stored.
- **Client vs server:** does the browser's `min`/`max`/`required` actually block
  submit? Send the same invalid body directly to the API — is it rejected too?
- **Mode switches:** switch a select/mode back and forth; does typed input
  survive, does the form flip modes on its own while typing?
- **Duplicate identifiers:** create two objects with the same id/name.
- **Double submit:** double-click Save; press Enter twice.
- **Edit round-trip:** create → edit → reopen: every field shows what was saved;
  cancel really discards.
- **Edit takes effect:** after saving, does the running system use the new value
  (not only the list)?

## Errors and states

- Force 4xx/5xx on save/load (Playwright `page.route`): is there a visible
  message, does the form stay usable, any unhandled promise rejection in the
  console?
- Empty states, loading states, very long lists (pagination/virtualisation),
  items with very long names (truncation + tooltip).
- Reload the page mid-flow; open the same object in two tabs and edit in both.
- Browser console: collect errors/warnings for each page visited.

## Navigation

- Direct URL to every sub-view; deep link to an unknown/deleted id; trailing
  slash / different case; back/forward buttons.
- Header label and browser tab title match the page.
- Help button / Helper Chat: does page help exist and describe what is shown?

## Roles (see personas in README)

- Is an action the persona may not perform hidden, disabled with an explanation,
  or does it fail only after submit (and how)?
- Try the forbidden action via direct URL and via API with the persona's cookie.
- Does anything of another team leak (names in dropdowns, counts, error texts)?

## Accessibility and layout

- Icon-only buttons have an accessible name; toggles expose `role="switch"`
  / `aria-checked`; dialogs trap focus and close with Escape.
- Tab order is logical; everything reachable by keyboard.
- Three viewports and three themes: overflow, clipped text, unreadable
  contrast, colours that encode meaning twice (two series with one colour).

## Time and transparency

- Times: which time zone? Relative vs absolute; does the UI say when something
  will happen next / happened last?
- Background work: is the user told that something is running, finished or
  failed, or does it happen silently?

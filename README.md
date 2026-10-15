# Canonn Colony Operations

Canonn Colony Operations is an Elite Dangerous background-simulation tracker for the Canonn
faction network. It displays a searchable, sortable table of every system in the Canonn BGS
(background simulation) with:

- Controlling faction, and a mini bar chart of every minor faction present in the system
  (Canonn's bar highlighted, ordered by influence, highest first).
- Canonn (CANO) and Canonn Deep Space Research (CDSR) influence percentages.
- Architect and preferred-faction details for colonised systems.
- Distance from a chosen reference system — click any system name to re-anchor and re-sort
  the whole table by distance from it.

The table opens sorted by priority, most urgent first. Every column header is sortable
(ascending, then descending on a repeat click, with missing values always sorted last). The
whole system list is loaded in one request (`view=all`), refreshed in the background so it is
never more than ten minutes old, and the
app then does the sorting, the distance search, the quick filters and the paging itself, so
changing any of them is instant. The Priority score is calculated here from the inputs and
constants the API sends with the list, using the same rules as the API.

The Canonn and CDSR columns each show a sparkline and the recent change in influence. Click a
sparkline to open the system's full influence history: every faction over the last 30 days, with
the tracked factions' averages, hover or arrow keys to read off a snapshot, and legend toggles.

Data comes from the [Canonn BGS API](https://us-central1-canonn-api-236217.cloudfunctions.net/query/bgs/systems).

## Development server

Run `npm start` for a dev server. Navigate to `http://localhost:4200/`. The application will
automatically reload if you change any of the source files.

## Build

Run `npm run build` to build the project. The build artifacts are stored in
`dist/canonn-bgs/browser/`.

## Test

Run `npm test` to execute the unit tests via [Vitest](https://vitest.dev/).

## License

This application is [licensed](LICENSE) under the MIT license.

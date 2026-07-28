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

Every column header is sortable (ascending, then descending on a repeat click, with missing
values always sorted last). Sorting by anything other than the default page order fetches and
caches the full dataset once, with a progress meter while it loads.

Data comes from the [Canonn BGS API](https://us-central1-canonn-api-236217.cloudfunctions.net/query/canonnbgs).

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

# Canonn Colony Operations

## Priorities and All Systems tabs must stay identical in look and filters

The home page has two table tabs, **Priorities** (only the P0 systems, fetched with `&tier=P0`) and
**All Systems** (every system). They are the same `app-bgs-table` component in
[home.component.html](src/app/home/home.component.html); the only difference is its `tier` input.

- Any change to the table's columns, styling, filters, sorting, paging, export, refresh or share-link
  behaviour goes in `BgsTableComponent` (or what it uses), so both tabs get it. Never add a
  tab-specific copy or a `tier`-specific branch for appearance or filtering.
- The tier is only about *which systems are fetched*. Keep it that way; if a feature seems to need the
  tabs to differ, ask first.
- A copied link from either tab must restore that tab's filters and sort (All Systems adds `tab=all`).
  Links that can name any system (`priority`, `assign`) open All Systems, since the system may not be P0.
- When touching this area, check both tabs, and keep the home spec's tab-order assertions current.

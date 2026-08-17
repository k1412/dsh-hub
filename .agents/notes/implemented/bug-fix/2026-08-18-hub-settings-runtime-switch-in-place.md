# Agent Note: Hub Settings switches Runtime in place

Status: implemented

English | [中文](2026-08-18-hub-settings-runtime-switch-in-place.zh.md)

## Problem

Hub Settings can read and write Host-backed values on any enrolled Runtime. The Runtime picker changed its URL owner with `location.assign`, which destroyed and rebuilt the complete official Web application. A routine selection therefore closed the Settings dialog, reset its navigation state, and made the interface flash even though only the owner of subsequent Host requests had changed.

Changing only the URL was insufficient. Settings scopes may still have a read in flight for the previous owner, so that response could publish after the next Runtime was selected and expose or overwrite values under the wrong visible target.

## Decision

Every Settings-owned Runtime selector persists the selected owner and updates `nodeId` and `runtimeId` with `history.replaceState`. It then calls `SettingsScopeBinder.refreshAll()`. Each live Host-backed scope immediately starts a read for the new owner and increments its generation, so a late response from the previous owner cannot publish.

The official Settings shell and its navigation remain mounted. Runtime selection on the new-session screen uses the same persistence and scope-refresh path, while selection of an existing fleet Workspace continues to synchronize its encoded owner without filtering the aggregated project and Session list.

## Alternatives considered

**Reload the page after every Runtime selection.** A reload naturally discards all old requests, but it also discards unrelated official Web state and turns a Settings control into application navigation.

**Update the URL without refreshing Settings scopes.** Subsequent calls would use the new owner, but already mounted scopes could keep showing values read from the previous Runtime and could accept a write before their next ordinary invalidation.

**Remount only the Settings dialog.** This avoids rebuilding the conversation page but still loses the selected Settings section and duplicates lifecycle behavior already provided by scope generation fencing.

## Consequences

Switching nodes or Runtimes inside Settings preserves the dialog, selected section, scroll position, and surrounding official Web application. All active Host-backed scopes reload from the selected owner, and stale reads are ignored. The selected owner remains local to the browser tab URL and local storage; changing it does not filter or mutate the fleet-wide project and Session index.

Component coverage pins the visible selected target, URL parameters, default Runtime state, and one scope refresh per user selection. The Hub typecheck, browser build, official Web regression lane, and multi-platform Hub CI exercise the assembled injection path.

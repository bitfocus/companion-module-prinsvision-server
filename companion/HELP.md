# Prins Vision Server

Connect Bitfocus Companion to a Prins Vision color grading system.

## Requirements

- Prins Vision Core server running and reachable on your network
- Bitfocus Companion 4.3 or newer
- A Prins Vision Control UI session logged in with the user you pair with

## Setup

1. **Let Companion load custom modules.** In the Companion launcher, click the cog (⚙) and
   turn on developer / custom modules. Companion only loads non-store modules when this is on.
2. Install this module. In Prins Vision Control UI go to **PatchBay Config → Companion**:
   - Companion on the same machine: click **Install into Companion**, then restart Companion.
   - Companion on another machine: open the **Download URL** in a browser there, then in
     Companion go to **Modules → Import custom module** and pick the downloaded `.tgz`.
2. In Companion, add a connection and search for **Prins Vision**.
3. Copy **Host**, **Port**, **API Key** and **Pair Code** from PatchBay Config → Companion
   into the module settings. All four are required.

The pair code links this Companion to one Control UI user. Slot selection, undo/redo,
node toggles and RAW/Bypass/Grade are routed to that user's Control UI session, so a
logged-in Control UI must be open for those to act.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| Host | 127.0.0.1 | IP address or hostname of the Prins Vision server (or pick a Bonjour-discovered system) |
| Port | 8888 | Server port |
| API Key | — | From PatchBay Config → Companion (Copy button) |
| Pair Code | — | From PatchBay Config → Companion. Required — connections without a valid code are rejected |

## Actions

| Action | Description |
|--------|-------------|
| Slot: Select | Switch the paired Control UI to a slot |
| Grading: Undo / Redo | Replay the paired Control UI's history (same as Cmd+Z there) |
| Grading: Reset Primary Wheels / Reset Log Wheels | Reset the wheel group to neutral |
| Grading: Toggle / Enable / Disable Node | Switch a node type on/off via the paired Control UI |
| Preset: Apply | Apply a saved node-tree preset to a slot |
| Preset: Save As New | Save the slot's current node chain as a new preset |
| Preset: Update (Overwrite) | Overwrite an existing preset with the slot's current chain |
| Preview: RAW / Bypass / Grade | Set the preview mode (viewer, output and attached LUT boxes) |

All actions target a specific slot by slot number (1–128).

## Feedbacks

| Feedback | Description |
|----------|-------------|
| PrinsVision: Connected | Active when connected to the server |
| Slot: Running | Active when the slot runtime is running (streaming) |
| Slot: Idle | Active when the slot is idle |
| Slot: Active (this surface) | Active when the slot is the one selected by this Companion |
| Node: Enabled | Active when a node type is enabled on a slot (live-synced) |
| Preview: Mode Active | Active when the slot's RAW/Bypass/Grade mode matches |

## Variables

| Variable | Description |
|----------|-------------|
| `$(prinsvision-server:module_version)` | Module version |
| `$(prinsvision-server:connected)` | `Connected` or `Disconnected` |
| `$(prinsvision-server:slot_count)` | Number of slots on the server |
| `$(prinsvision-server:current_slot)` | Slot number selected by this Companion |
| `$(prinsvision-server:current_slot_name)` / `_status` | Name / state of that slot |
| `$(prinsvision-server:slot_<n>_name)` / `_status` | Name / state per slot (1–32) |

## Presets

The **Slot Selection** category contains one ready-made button per slot on the server,
with the live slot name baked in and the active-slot highlight pre-wired. The list
rebuilds automatically when slots are added, removed or renamed server-side.

## Notes

- Undo/redo, node toggles and preview-mode changes act through the paired Control UI —
  if no Control UI session of the paired user is open, those buttons do nothing.
- Preset dropdowns refresh automatically when presets are added, renamed or deleted.
- Rotating the API key or removing the pair code in PatchBay Config disconnects the
  module until the new values are entered here.

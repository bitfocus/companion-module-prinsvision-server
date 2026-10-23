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
3. Pick the discovered system (or enter **Host** and **Port**) and paste the **Pair Code**
   from PatchBay Config → Companion.

The pair code is the only key this connection needs. It links this Companion to one
Control UI user. Slot selection, undo/redo,
node toggles and RAW/Bypass/Grade are routed to that user's Control UI session, so a
logged-in Control UI must be open for those to act.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| Host | 127.0.0.1 | IP address or hostname of the Prins Vision server (or pick a Bonjour-discovered system) |
| Port | 8888 | Server port |
| Pair Code | — | From PatchBay Config → Companion (Copy button), e.g. `K7QM-2XRA-…`. Case, spaces and hyphens don't matter. Connections without a valid code are rejected |

## Actions

| Action | Description |
|--------|-------------|
| Slot: Select | Switch the paired Control UI to a slot |
| Grading: Undo / Redo | Replay the paired Control UI's history (same as Cmd+Z there) |
| Grading: Reset Primary Wheels / Log Wheels / Broadcast Wheels | Reset that wheel node to neutral |
| Grading: Reset Wave Corrector | Reset the Wave Corrector to neutral |
| Grading: Adjust Parameter (relative) | Nudge one grading parameter on the current slot (rotary encoders) |
| Grading: Reset Parameter | Reset one grading parameter on the current slot to its default (encoder push) |
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
| `$(prinsvision-server:last_dropped_action)` | Last button action dropped because the connection was down (never sent later) |
| `$(prinsvision-server:slot_count)` | Number of slots on the server |
| `$(prinsvision-server:current_slot)` | Slot number selected by this Companion |
| `$(prinsvision-server:current_slot_name)` / `_status` | Name / state of that slot |
| `$(prinsvision-server:slot_<n>_name)` / `_status` | Name / state per slot (1–32) |

## Presets

The **Slot Selection** category contains one ready-made button per slot on the server,
with the live slot name baked in and the active-slot highlight pre-wired. The list
rebuilds automatically when slots are added, removed or renamed server-side.

## Encoders (Stream Deck+ / Loupedeck)

The **Encoders — Primary / Log / Broadcast / Wave Corrector** preset sections hold one
rotary preset per parameter: rotate = adjust, push = reset to default. They act on the
currently selected slot, and the LCD shows the live value (`current_<param>` variables).

A new slot starts as the **Base PrinsVision** Look, whose Corrector is RGB Mixer + Wave
Corrector — use **Encoders — Wave Corrector** there (3.1.0+). The Primary, Log and
Broadcast encoders only act on a slot that has that node. An encoder on a node the slot
doesn't have, or one switched off (eye or Corrector bypass), does nothing and logs a
warning.

Wave Corrector encoders show the same numbers as the Control UI editor:

| Encoder | Range | LCD |
|---------|-------|-----|
| Temp / Tint | ±4000 / ±100 | Temp = change from 6500 K, 0 = neutral |
| Pedestal | ±20 % | % video at black (camera master black: black moves the full step, white barely) |
| Band Gamma | ±100 | |
| Gain | 1–1000 % | %, 100 = neutral |
| Exposure | ±8 stops, one tick = ¼ stop | stops, 0 = neutral; separate from Gain (picture × Gain × 2^Exposure) |
| Band Low / Band High | 0–100 % | % video; Low stays 1 % under High |
| Soft Low / Soft High | 8–25 % each | % video; Low softens the shadow↔band edge, High the band↔white edge; never under 8 % (a harder edge shows a line), default 10 % |
| Saturation | 0–200 % | % |
| Hue | ±180°, one tick = 1° | degrees, 0 = neutral |
| Contrast | 0.001–4 | factor, 1 = neutral |
| Shadow / Band / White R, G, B | R ±100, G ±40, B ±128 (the ball's circle) | the ball as an RGB balance, as in the editor; luma is held, so the other two channels give way |

Pushing a ball's R, G or B encoder resets that whole ball to neutral.

## Notes

- Undo/redo, node toggles and preview-mode changes act through the paired Control UI —
  if no Control UI session of the paired user is open, those buttons do nothing.
- Preset dropdowns refresh automatically when presets are added, renamed or deleted.
- Generating a new pair code or removing it in PatchBay Config disconnects the module
  until the new code is entered here.

## ATEM follow and Program tally (2.3.0)

Configure **Patch Bay Config → Companion → ATEM follow** in PrinsVision:

1. Choose your ATEM connection. This module reports the ATEM connections in Companion,
   so Patch Bay shows them in a list (2.5.0+).
2. Choose the AUX that selects your grading slot, and Program M/E for red tally.
3. Add ATEM input ID → PrinsVision slot mappings, enable follow and save.
4. Disable old follow triggers. Automatic follow needs no triggers.
5. Optional (2.6.0+): **Slot click switches AUX** — choosing a slot in PrinsVision or on a
   Stream Deck switches the AUX to that slot's input. Save, **Export triggers** and import
   them into Companion; they link to this connection and your ATEM connection by label.
   Export again after changing the AUX or the mappings. Works while following is on;
   `atem_follow_status` reports a switch that the ATEM did not confirm.

Settings are saved per mounted project and paired user on the Core machine. They
are delivered to this module on save and reconnect. The module reads Companion's
local HTTP API, so it also works when Companion runs on another computer. The
web port defaults to 8000. Use Companion 5.0.6 or newer with `/api/connections` and
module-variable HTTP endpoints available. An unavailable API or disconnected ATEM
clears this connection's tally; see `atem_follow_status` and the module log for errors.
Polling is sequential, every 250 ms after the previous read completes. Reconnect
reapplies current values even when the AUX/Program bus hasn't changed.

Unmapped AUX inputs leave selection unchanged. Unmapped Program inputs clear
this connection's red tally. Engine errors use a separate danger triangle.
Program source following is not full composite tally for keyers, SuperSource or
both sources during transitions.

**Slot: Red tally (Program)** is the button feedback. **Slot: Set red tally** and
the two manual **ATEM: Follow … input** actions remain available for advanced
trigger setups; the input mapping now comes from Patch Bay Config. Disable
automatic follow when using those triggers to avoid competing tally updates.
Requires the matching PrinsVision backend and frontend, not only this module.

## Router + TSL (2.4.0)

In **Patch Bay Config → Companion → Slot follow**, choose **Router + TSL**.
Requires Companion 5.0.6+ and existing **Generic SW-P-08** and **TSL UMD Listener**
connections. Enter their exact labels, the PrinsVision connection label, one
matrix output and video level. Map inputs to slots and optional TSL addresses.
Address 0 is valid. Select the appropriate Program/Tally or TSL 5 colour field.

Enable follow and save. **Export triggers**, then import the file in Companion,
mapping both connection references to your existing connections. Replace these
triggers after changing mappings or router settings. The export contains no
credentials. Enable **Slot click switches matrix** to route when selecting a
slot; otherwise only the current router input is followed.

TSL controls red independently of selection. Imported follow triggers never
send a physical route. Route requests expire after 2.5 seconds without router
confirmation. Do not add another route trigger on `current_slot`: reflected
router selections must not cause a new switch. Connecting or changing projects
does not request a route. See `router_follow_status` for connection/route errors.

TSL is read from Companion's local HTTP API. Reported faults clear tally, but
silent loss of a UDP sender cannot be detected from the TSL module's retained
values. TSL 5 uses the module's address variables, without separate screen IDs.
ATEM and Router + TSL are alternative automatic follow modes. Other manual
Companion actions remain available.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`comfoairq` is a Node.js library (npm package, not an app) that speaks the ComfoConnect LAN C protocol to control Zehnder ComfoAir Q series ventilation units over TCP. Entry point is [lib/comfoconnect.js](lib/comfoconnect.js) (re-exported by [index.js](index.js)). This is a fork of [herrJones/node-comfoairq](https://github.com/herrJones/node-comfoairq) with diverging changes — don't assume upstream behavior matches.

Requires Node.js >= 20.

## Commands

- `npm run test` — runs the interactive demo app [test/comfoTest.js](test/comfoTest.js) against a real device; `test` here means "test harness." The script reads [test/settings.json](test/settings.json) (device IP, pin, uuid, comfouuid) and exposes a REPL with commands: `srch`, `conn`, `lapp`, `rapp`, `uapp`, `info`, `sens`, `dsen`, `nods`, `cmnd`, `prop`, `away`, `bost`, `schd`, `time`, `disc`, `quit`.
- `npm run unit` — `node:test` unit tests in [test/unit](test/unit) against a fake LAN C ([test/unit/fakeDevice.js](test/unit/fakeDevice.js)), no device needed. There is no local Node.js on the dev machine; run via Docker: `docker run --rm -v "$PWD":/app -w /app node:24-alpine npm run unit`.
- `npm run lint` — ESLint against project rules (4-space indent, single quotes, semicolons required, `no-var`, `prefer-const`).

## Architecture

Three-layer pipeline wrapped in an EventEmitter:

1. **[lib/comfoconnect.js](lib/comfoconnect.js)** — `ComfoAirQ` class. Static: `ComfoAirQ.discover(options)` (all LAN C adapters answering within a timeout, no instance needed) and `ComfoAirQ.generateUuid()`. Instance API (all Promise-returning): `discover` (first device, kept for compatibility), `StartSession`, `KeepAlive`, `CloseSession`, `RegisterApp`, `DeRegisterApp`, `ListRegisteredApps`, `RegisterSensor`, `DeregisterSensor`, `SendCommand`, `SetAway`, `SetBoost`, `GetScheduleEntry`, `ListScheduleEntries`, `GetProperty`, `GetProperties`, `GetPropertyRange`, `SetProperty`, `VersionRequest`, `TimeRequest`, `GetVentilationNode`. Emits `receive`, `alarm` and `disconnect`. Owns reconnect/keepalive timers, the `pending` map of requests waiting for a response and the `nodes` announced by the device.
2. **[lib/bridge.js](lib/bridge.js)** — `ComfoAirQBridge`. Manages the UDP discovery socket and the persistent TCP socket to the ComfoConnect LAN C. `connect()` (called by `transmit`) creates a new socket per attempt and rejects after `connectTimeout`; events of a replaced socket are ignored (`sock !== this.sock`). Builds the 38-byte TX header (uuid + comfouuid + length), frames outgoing messages, and reassembles multi-message TCP reads by walking length prefixes. Emits raw `received`/`error`/`disconnect`.
3. **[lib/preparation.js](lib/preparation.js)** (encode, `before.*` / `cmd_*` via `build()`, which returns `{ operation, command, reference }`) and **[lib/analysis.js](lib/analysis.js)** (decode, `after.*`) — protobuf marshalling. Both `loadSync` [lib/protocol/zehnder.proto](lib/protocol/zehnder.proto) independently at module load. The dispatch switch in `comfoconnect.js` on `data.kind` (numeric operation code) is the canonical place to add new message handling; `analyze_CnRpdoNotification` fans sensor notifications out to typed values using the `sensorCodes` table.

**[lib/const.js](lib/const.js)** is a lookup-table hub:
- `msgCodes` — numeric → name for GatewayOperation types (the numbers used in the `rxlist` kind-match and the `data.kind == N` branches in comfoconnect.js).
- `sensorCodes` — sensor id, `kind` and name. `kind` is sent as `type` of the CnRpdoRequest (values taken from app traffic, don't change them) and selects the decoding: 0/1/2/3/4/6 = bool / int8 / int16 / int32 / 64 bit / decimal16. Extend this when adding sensors.
- `comfoCommands` — hex payloads for `SendCommand` (fan mode, boost, bypass, temp profile, filter change, etc.).
- `comfoProperties` — unit/subunit/property/kind for `GetProperty` / `SetProperty`.
- `rmiErrors`, `alarmErrors` / `alarmErrors140` (alarm bit texts, firmware > / <= 1.4.0), `airflowConstraints`, `productCodes`, `ventilationProducts`.
- `getTimestamp`, `sleep` helpers.

**[lib/error.js](lib/error.js)** — `ComfoAirQError` (`code` = GatewayResult name, `TIMEOUT` or `NOT_CONNECTED`, optional `details`). All request rejections use it.

## Protocol notes

- Requests with a response go through `_request(txData)`: it keys a pending promise by the GatewayOperation `reference`, the `received` handler resolves it (`_resolvePending`) for every non-notification kind, or rejects it with a `ComfoAirQError` when the result is not `OK`. Messages without response (`KeepAlive`, `CloseSession`, `CnNodeRequest`) use `_send`. Add new commands the same way. Kind-specific decoding in the `received` handler runs before `_resolvePending`, so the promise gets the decoded data.
- On bridge `disconnect` all pending requests are rejected with `NOT_CONNECTED`, on a CloseSessionRequest from the device with `OTHER_SESSION`.
- Reconnect logic (`_reconnect` / `_keepalive`) uses `StartSession(false)` (no takeover) and re-registers every sensor in `this.sensors` one after another; it stops on `NOT_ALLOWED`. Any new "stateful" registration should be tracked similarly or it will be silently dropped across reconnects.
- `data.kind == 4` (CloseSessionRequest from device) means another client took over — surfaced to callers as `disconnect` with `reason.state === 'OTHER_SESSION'`. The reconnect timer still fires; callers are expected to decide whether to reclaim the session.
- The device announces its nodes (CnNodeNotification, kind 32) after `StartSession`; they are tracked in `this.nodes`. `_rmiRequest(node, payload)` with `node` null/undefined uses `GetVentilationNode()` (productId 1 or 8, sends a CnNodeRequest if not known yet). RMI responses (kind 34) resolve with the payload Buffer; `RMI_ERROR` carries the unit's error code in `details.rmiError` (`rmiErrors`). RMI payload formats (schedule `84/83/85/87 15 …`, property `01/03 …`, procedures `80/81/82 …`) are documented above `comfoCommands` in [lib/const.js](lib/const.js).
- Debug-mode traffic dumps (hex) are gated by `options.debug`; when off, `data.data` and `data.msg` are stripped from emitted `receive` events.

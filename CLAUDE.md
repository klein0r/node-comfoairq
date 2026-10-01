# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`comfoairq` is a Node.js library (npm package, not an app) that speaks the ComfoConnect LAN C protocol to control Zehnder ComfoAir Q series ventilation units over TCP. Entry point is [lib/comfoconnect.js](lib/comfoconnect.js) (re-exported by [index.js](index.js)). This is a fork of [herrJones/node-comfoairq](https://github.com/herrJones/node-comfoairq) with diverging changes — don't assume upstream behavior matches.

Requires Node.js >= 20.

## Commands

- `npm run test` — runs the interactive demo app [test/comfoTest.js](test/comfoTest.js) against a real device. There is no unit test suite; `test` here means "test harness." The script reads [test/settings.json](test/settings.json) (device IP, pin, uuid, comfouuid) and exposes a REPL with commands: `srch`, `conn`, `lapp`, `rapp`, `uapp`, `info`, `sens`, `cmnd`, `prop`, `away`, `bost`, `schd`, `time`, `disc`, `quit`.
- `npm run lint` — ESLint against project rules (4-space indent, single quotes, semicolons required, `no-var`, `prefer-const`).

## Architecture

Three-layer pipeline wrapped in an EventEmitter:

1. **[lib/comfoconnect.js](lib/comfoconnect.js)** — `ComfoAirQ` class. Public API (all Promise-returning): `discover`, `StartSession`, `KeepAlive`, `CloseSession`, `RegisterApp`, `DeRegisterApp`, `ListRegisteredApps`, `RegisterSensor`, `SendCommand`, `SetAway`, `SetBoost`, `GetScheduleEntry`, `ListScheduleEntries`, `GetProperty`, `GetProperties`, `GetPropertyRange`, `SetProperty`, `VersionRequest`, `TimeRequest`. Emits `receive` and `disconnect`. Owns reconnect/keepalive timers and an `rxlist` of pending request kinds for correlating responses.
2. **[lib/bridge.js](lib/bridge.js)** — `ComfoAirQBridge`. Manages the UDP discovery socket and the persistent TCP socket to the ComfoConnect LAN C. Builds the 38-byte TX header (uuid + comfouuid + length), frames outgoing messages, and reassembles multi-message TCP reads by walking length prefixes. Emits raw `received`/`error`/`disconnect`.
3. **[lib/preparation.js](lib/preparation.js)** (encode, `before.*` / `cmd_*`) and **[lib/analysis.js](lib/analysis.js)** (decode, `after.*`) — protobuf marshalling. Both `loadSync` [lib/protocol/zehnder.proto](lib/protocol/zehnder.proto) independently at module load. The dispatch switch in `comfoconnect.js` on `data.kind` (numeric operation code) is the canonical place to add new message handling; `analyze_CnRpdoNotification` fans sensor notifications out to typed values using the `sensorCodes` table.

**[lib/const.js](lib/const.js)** is a lookup-table hub:
- `msgCodes` — numeric → name for GatewayOperation types (the numbers used in the `rxlist` kind-match and the `data.kind == N` branches in comfoconnect.js).
- `sensorCodes` — sensor id, value width (`kind`: 0/1/2/3/6 = unknown / int8 / int16 / int32 / decimal16), and name. Extend this when adding sensors.
- `comfoCommands` — hex payloads for `SendCommand` (fan mode, boost, bypass, temp profile, filter change, etc.).
- `comfoProperties` — unit/subunit/property/kind for `GetProperty` / `SetProperty`.
- `productCodes`, `getTimestamp`, `sleep` helpers.

## Protocol notes

- `StartSession` pushes expected response kind `53` onto `rxlist`, transmits, then polls `_status.connected` (flipped inside the bridge's `received` handler when kind 53 arrives with `OK`) for up to 15s. Other RPCs follow the same push-kind → transmit → wait-for-kind pattern — preserve this when adding commands.
- Reconnect logic (`_reconnect` / `_keepalive`) re-registers every sensor in `this.sensors` on resume. Any new "stateful" registration should be tracked similarly or it will be silently dropped across reconnects.
- `data.kind == 4` (CloseSessionRequest from device) means another client took over — surfaced to callers as `disconnect` with `reason.state === 'OTHER_SESSION'`. The reconnect timer still fires; callers are expected to decide whether to reclaim the session.
- RMI requests that need the device's answer go through `_rmiRequest`, which keys a pending promise by the GatewayOperation `reference` (`rmiPending`) and resolves it from the `data.kind == 34` (CnRmiResponse) branch. RMI payload formats (schedule `84/83/85/87 15 …`, property `01/03 …`, procedures `80/81/82 …`) are documented above `comfoCommands` in [lib/const.js](lib/const.js).
- Debug-mode traffic dumps (hex) are gated by `options.debug`; when off, `data.data` and `data.msg` are stripped from emitted `receive` events.

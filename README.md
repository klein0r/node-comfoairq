# node-comfoairq

**This is a fork with a lot of changes - check original repo by herrJones**

[Changes since fork](https://github.com/klein0r/node-comfoairq/compare/c1655c659f66bf5a452f9df83a95c08c659ee5ed...master)

Library to control a Zehnder Comfoair Q series of ventilation devices (e.g. Q350)

## Requirements

1. *Zehnder Comfoair Q* series of ventilation device (e.g. Q350)
2. *Zehnder ComfoConnect LAN C* interface

## Test Script

A test-application is provided to demonstrate the capabilities

1. Update the test/settings.json
2. Run the script

```bash
npm run test
```

## Range of functions

Not all functions are implemented as the plugin is designed for home automation

Only these are provided:

* start session
* keepalive
* send command
* close session
* register sensor
* get version
* get time
* list all registered apps
* register app
* deregister app
* away mode / boost with custom duration (`SetAway`, `SetBoost`)
* read schedule entries (`GetScheduleEntry`, `ListScheduleEntries`)
* read / write properties (`GetProperty`, `GetProperties`, `GetPropertyRange`, `SetProperty`) - see `comfoProperties` in [lib/const.js](lib/const.js)

All functions return Promises. `SetAway`, `SetBoost`, `GetScheduleEntry`, `ListScheduleEntries`, `GetProperty`, `GetProperties`, `GetPropertyRange` and `SetProperty` resolve with the device response.

```javascript
await zehnder.SetAway(1, new Date('2026-10-02T11:30:00'));  // away until end time (or seconds, -1 = unlimited)
await zehnder.SendCommand(1, 'AWAY_END');

await zehnder.SetBoost(1, 45 * 60);                           // boost for 45 minutes

await zehnder.GetProperty(1, 'FILTER_LIFETIME');              // -> 180 (days)
await zehnder.SetProperty(1, 'FILTER_LIFETIME', 170);
await zehnder.GetProperties(1, ['FAN_FLOW_AWAY', 'FAN_FLOW_LOW', 'FAN_FLOW_MEDIUM', 'FAN_FLOW_HIGH']);
                                                              // -> { FAN_FLOW_AWAY: 40, FAN_FLOW_LOW: 120, ... } (m³/h)
await zehnder.GetPropertyRange(1, 'RMOT_COOLING_LIMIT');       // -> { value: 20, min: 15, max: 40, step: 1 }
await zehnder.GetProperty(1, 'MODEL_NAME');                   // -> 'ComfoAir Q350 D TR'

await zehnder.ListScheduleEntries(1, 0x01);                   // -> [{ type: 1, active: true, duration: null, remaining: null, value: 3 }, ...]

await zehnder.SendCommand(1, 'FILTER_CHANGE_START');          // FILTER_CHANGE_COMPLETE resets the filter counter, FILTER_CHANGE_ABORT cancels
```

Note: `FAN_MODE_AWAY` is manual fan level 0, the away mode of the Zehnder app is `SetAway` / `AWAY_END`.

On 'received' and 'disconnect' events are provided

## Quick-start

### 1. Discovery

Find all ComfoConnect LAN C adapters in the local network - no configuration or instance required (e.g. to show a selection in a settings dialog):

```javascript
const ComfoAirQ = require('comfoairq');

const devices = await ComfoAirQ.discover({ timeout: 3000 });
// -> [{ comfoair: '192.168.1.50', comfouuid: '00000000003410138001144fd71e24cc', port: 56747, version: 1 }]
```

Options: `address` (broadcast / IP address or array, default: broadcast address of every IPv4 interface), `port` (default `56747`) and `timeout` in ms (default `3000`). The promise resolves with an empty array if no adapter answers.

### 2. Connect

Create the instance with the selected device. `uuid` identifies this application at the LAN C - generate it once with `ComfoAirQ.generateUuid()` and store it. `pin` is the PIN of the LAN C (default `0`), it is required to register the app the first time.

```javascript
const zehnder = new ComfoAirQ({
  comfoair: '192.168.1.50',                      // from discovery
  comfouuid: '00000000003410138001144fd71e24cc', // from discovery
  uuid: storedUuid,                              // ComfoAirQ.generateUuid()
  pin: 0,
  device: 'my-app'                               // name shown in the list of registered apps
});

zehnder.on('receive', (data) => {
  console.log(JSON.stringify(data));
});

zehnder.on('disconnect', (reason) => {
  if (reason.state == 'OTHER_SESSION') {
    console.log('other device became active');
  }
});

await zehnder.RegisterApp();      // first time only
await zehnder.StartSession(true);
// ..... do something ......
// -> find some inspiration in test/comfoTest.js
await zehnder.CloseSession();
```

The LAN C sends invalid (zero) values right after a sensor was registered (also after an automatic reconnect). These values are held back for `sensorDelay` ms (default `5000`, `0` disables it): the first non-zero value is emitted immediately, a value which is still zero after the delay is emitted afterwards.

The constructor throws if `uuid` / `comfouuid` are not 32 hex characters, or if `comfouuid` is set without `uuid`. Empty strings are treated as not set.

## Installer settings

Some properties are installer settings in the Zehnder app (e.g. `FAN_FLOW_AWAY` / `_LOW` / `_MEDIUM` / `_HIGH`, `ZONES`, `FILTER_WARNING`). The app asks for the installer code before showing them, but the unit does not enforce it:

* `INSTALLER_CODE` can be read without any login (default `4210`) - the app reads it and compares the input locally
* `INSTALLER_MODE` is the device wide installer mode (`0` = off, `2` = on), the same mode as the login on the unit display. It can be set via `SetProperty` without knowing the code
* installer settings like `FAN_FLOW_AWAY` can be written while `INSTALLER_MODE` is `0`

So the installer code protects the user interfaces only - everyone who can connect to the ComfoConnect LAN C (PIN) can change installer settings. Use these properties with care, the values are applied to the unit immediately.

Reading a property right after writing it may fail with `RMI_ERROR` while the unit applies the new value - wait a moment or retry.

## Energy values

The power and energy values of the Zehnder app ("Unit Status" page) are available as sensors via `RegisterSensor`:

| App                               | Sensor    | Unit |
|-----------------------------------|-----------|------|
| Power consumption: current        | 128       | W    |
| Power consumption: year-to-date   | 129       | kWh  |
| Power consumption: total          | 130       | kWh  |
| Pre-heater: current               | 146       | W    |
| Pre-heater: year-to-date / total  | 144 / 145 | kWh  |
| Avoided heating: current          | 213       | W    |
| Avoided heating: year-to-date     | 214       | kWh  |
| Avoided heating: total            | 215       | kWh  |
| Avoided cooling: current          | 216       | W    |
| Avoided cooling: year-to-date     | 217       | kWh  |
| Avoided cooling: total            | 218       | kWh  |

"Total Energy Savings" is not provided by a sensor (at least none the app registers). The values shown in the app are the sum of avoided heating and avoided cooling:

* year-to-date = 214 + 217
* total = 215 + 218

This is not documented by Zehnder - it was derived from the app traffic, where the numbers add up exactly (e.g. 236 + 53 = 289 kWh, 8199 + 320 = 8519 kWh).

## Dev

### Run via Docker

The test script can be executed inside a container using the provided [Dockerfile](Dockerfile):

```bash
docker build -t comfoairq-test .
docker run --rm -it --network host comfoairq-test
```

Notes:

* `-it` is required because the test script is an interactive REPL.
* `--network host` is recommended so that UDP broadcast discovery (`srch`) and the TCP connection to the ComfoConnect LAN C work on the local network. On Docker Desktop (macOS/Windows) host networking is limited — address the device directly via `test/settings.json` and mount it at runtime:

```bash
docker run --rm -it -v "$PWD/test/settings.json:/app/test/settings.json:ro" comfoairq-test
```

* Mounting `test/settings.json` lets you change device IP, PIN and UUIDs without rebuilding the image.

### Release

```bash
docker build -t comfoairq-test .
docker run --rm -it \
  -v "$PWD":/app \
  -v ~/.gitconfig:/root/.gitconfig:ro \
  comfoairq-test npm version minor

git push --follow-tags
```

## Credits

Development of this node.js plugin is heavily inspired on the work performed by:

* Jan Van Belle (https://github.com/herrJones/node-comfoairq)
* Michael Arnauts (https://github.com/michaelarnauts/aiocomfoconnect)
* Marco Hoyer (https://github.com/marco-hoyer/zcan) and its forks on github (djwlindenaar, decontamin4t0R)

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

```
npm run test
```

### Run via Docker

The test script can be executed inside a container using the provided [Dockerfile](Dockerfile):

```sh
docker build -t comfoairq-test .
docker run --rm -it --network host comfoairq-test
```

Notes:

* `-it` is required because the test script is an interactive REPL.
* `--network host` is recommended so that UDP broadcast discovery (`srch`) and the TCP connection to the ComfoConnect LAN C work on the local network. On Docker Desktop (macOS/Windows) host networking is limited — address the device directly via `test/settings.json` and mount it at runtime:

  ```sh
  docker run --rm -it -v "$PWD/test/settings.json:/app/test/settings.json:ro" comfoairq-test
  ```

* Mounting `test/settings.json` lets you change device IP, PIN and UUIDs without rebuilding the image.

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
* read / write properties (`GetProperty`, `GetPropertyRange`, `SetProperty`) - see `comfoProperties` in [lib/const.js](lib/const.js)

All functions return Promises. `SetAway`, `SetBoost`, `GetScheduleEntry`, `ListScheduleEntries`, `GetProperty`, `GetPropertyRange` and `SetProperty` resolve with the device response.

```javascript
await zehnder.SetAway(1, new Date('2026-10-02T11:30:00'));  // away until end time (or seconds, -1 = unlimited)
await zehnder.SendCommand(1, 'AWAY_END');

await zehnder.SetBoost(1, 45 * 60);                           // boost for 45 minutes

await zehnder.GetProperty(1, 'FILTER_LIFETIME');              // -> 180 (days)
await zehnder.SetProperty(1, 'FILTER_LIFETIME', 170);
await zehnder.GetPropertyRange(1, 'RMOT_COOLING_LIMIT');       // -> { value: 20, min: 15, max: 40, step: 1 }
await zehnder.GetProperty(1, 'MODEL_NAME');                   // -> 'ComfoAir Q350 D TR'

await zehnder.ListScheduleEntries(1, 0x01);                   // -> [{ type: 1, active: true, duration: null, remaining: null, value: 3 }, ...]

await zehnder.SendCommand(1, 'FILTER_CHANGE_START');          // FILTER_CHANGE_COMPLETE resets the filter counter, FILTER_CHANGE_ABORT cancels
```

Note: `FAN_MODE_AWAY` is manual fan level 0, the away mode of the Zehnder app is `SetAway` / `AWAY_END`.

On 'received' and 'disconnect' events are provided

## Quick-start

```javascript
const comfoconnect = require('node-comfoairq');
const settings = require(__dirname + '/settings.json');

const zehnder = new comfoconnect(settings);

zehnder.on('receive', (data) => {
  console.log(JSON.stringify(data));
});

zehnder.on('disconnect', (reason) => {
  if (reason.state == 'OTHER_SESSION') {
    console.log('other device became active');
    reconnect = true;
  }
  connected = false;
});

const deviceInfo = await zehnder.discover('192.168.1.255');

await zehnder.StartSession(true);
// ..... do something ......
// -> find some inspiration in test\comfoTest.js
await zehnder.CloseSession();
```

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

## Credits

Development of this node.js plugin is heavily inspired on the work performed by:

* Jan Van Belle (https://github.com/herrJones/node-comfoairq)
* Michael Arnauts (https://github.com/michaelarnauts/comfoconnect)
* Marco Hoyer (https://github.com/marco-hoyer/zcan) and its forks on github (djwlindenaar, decontamin4t0R)

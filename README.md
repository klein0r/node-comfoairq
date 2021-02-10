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

All functions return Promises

On 'received' and 'disconnect' events are provided

If a valid UUID is provided for the comfoconnect device, a discovery operation is no longer needed

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

zehnder.discover();

await zehnder.StartSession(true);
// ..... do something ......
// -> find some inspiration in test\comfoTest.js
await zehnder.CloseSession();

```

## Credits

Development of this node.js plugin is heavily inspired on the work performed by:

* Jan Van Belle (https://github.com/herrJones/node-comfoairq)
* Michael Arnauts (https://github.com/michaelarnauts/comfoconnect)
* Marco Hoyer (https://github.com/marco-hoyer/zcan) and its forks on github (djwlindenaar, decontamin4t0R)
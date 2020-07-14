# node-comfoairq
Library to control a Zehnder Comfoair Q series of ventilation devices

A Zehnder Comfoconnect LAN C interface is required to make this work

Development of this node.js plugin is heavily inspired on the work performed by:
* Michael Arnauts (https://github.com/michaelarnauts/comfoconnect)
* Marco Hoyer (https://github.com/marco-hoyer/zcan) and its forks on github (djwlindenaar, decontamin4t0R)

An API is provided to connect and read sensor data from the ComfoAirQ-unit

Revision history:
* 0.5.0 : first working version
* 0.5.1 : general bugfixes
* 0.5.2 : better handling of (forced) disconnects
* 0.5.3 : complete dependencies in package.json
* 0.5.4 : fix bug with registering devices 


A test-application is provided to demonstrate the capabilities

Not all functions are implemented as the plugin is designed for home automation
Only these are provided:
* start session
* keepalive
* send command
* close session
* register sensor
* get version
* list all registered apps
* register app
* deregister app

All functions return Promises

On 'received' and 'disconnect' events are provided

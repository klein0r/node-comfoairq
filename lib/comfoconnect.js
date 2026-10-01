'use strict';

const Buffer = require('safe-buffer').Buffer;
const events = require('events');

const comfoBridge = require('./bridge');
const before = require('./preparation');
const after = require('./analysis');
const config = require('./const');

class ComfoAirQ extends events {
    constructor(options) {
        super();

        this._settings = {
            'pin'      : options.pin,
            'uuid'     : Object.prototype.hasOwnProperty.call(options, 'uuid') ? Buffer.from(options.uuid, 'hex') : null,
            'device'   : options.device,
            'comfoair' : options.comfoair,
            'comfouuid': Object.prototype.hasOwnProperty.call(options, 'comfouuid') ? Buffer.from(options.comfouuid, 'hex') : null,
            'port'     : options.port || 56747,

            'debug'    : options.debug,
            'logger'   : options.logger,
            'keepalive': 15000
        };
        this._status = {
            'connected' : false,
            'reconnect' : false,
            'resume'    : false
        };
        this._exec = {
            'keepalive': null,
            'reconnect': null
        };

        this.rxlist = [];                       // array of messages to receive
        this.rmiPending = new Map();            // RMI requests waiting for a response (by reference)

        this.nodes = [];
        this.sensors = [];
        this.logger = this._settings.logger || console.log;

        this._bridge = new comfoBridge(this._settings);

        this._bridge.on('received', (data) => {
            data.msg = after.cmd_GatewayOperation(data.data);
            data.result = after.cmd_DecodeMessage(data.msg);
            data.error = data.msg.result;
            data.kind = data.msg.type;
            const reference = data.msg.reference;

            if (this.rxlist.length > 0) {
                const idx = this.rxlist.findIndex( ({ kind }) => kind === data.kind);
                if (idx >= 0) {
                    this.rxlist.splice(idx, 1);
                }
            }

            if (!this._settings.debug) {
                delete data.data;
                delete data.msg;
            }

            if (data.kind == 40) {           // CnRpdoNotification
                data.result.data = after.analyze_CnRpdoNotification(data.result.data);

            } else if (data.kind == 53) {    // StartSessionConfirm
                if (data.error == 'OK') {
                    this._status.connected = true;

                    if (data.result.data.resumed){
                        this.logger(' StartSessionConfirm --> OK - resuming session');
                        this._status.resume = true;
                    } else {
                        this._status.resume = false;
                    }
                } else {
                    this.logger(' StartSessionConfirm --> ' + data.error);
                    this._status.connected = false;
                }
                this._status.reconnect = true;
            } else if (data.kind == 31) {    // CnTimeConfirmType
                this.logger(' CnTimeConfirm --> ' + data.error);
                data.result.data = after.analyze_CnTimeConfirm(data.result.data);

            } else if (data.kind == 32) {    // CnNodeNotificationType
                // TODO
                this.logger(' CnNodeNotification --> ' + data.error);
            } else if (data.kind == 52) {    // RegisterAppConfirmType
                this.logger(' RegisterAppConfirm --> ' + data.error);
            } else if (data.kind == 55) {    // ListRegisteredAppsConfirmType
                this.logger(' ListAppConfirm --> ' + data.error);
                data.result.data = after.analyze_ListRegisteredApps(data.result.data);
            } else if (data.kind == 4) {     // CloseSessionRequest
                const reason = {
                    state: 'OTHER_SESSION'
                };
                this.emit('disconnect', reason);
            } else if (data.kind == 34) {    // CnRmiResponse
                const pending = this.rmiPending.get(reference);
                if (pending) {
                    this.rmiPending.delete(reference);
                    clearTimeout(pending.timer);

                    if (data.error == 'OK') {
                        const message = data.result.data.message;
                        pending.resolve(message ? Buffer.from(message) : Buffer.alloc(0));
                    } else {
                        pending.reject(data.error);
                    }
                }
            }

            // push the received data to the calling program
            this.emit('receive', data);

        });
        this._bridge.on('error', (reason) => {
            try {
                this.logger('comfo: ' + reason.error);
                this._status.connected = false;
            }
            catch (exc) {
                this.logger('comfo: ' + JSON.stringify(reason) + ' - ' + exc);
            }

        });
        this._bridge.on('disconnect', () => {
            const reason = {
                state: 'DISC'
            };

            this.logger('comfo: DISCONNECTED -> ' + config.getTimestamp());
            this._status.connected = false;

            this.emit('disconnect', reason);
        });
    }

    get settings() {
        return this._settings;
    }

    set settings(value) {

        if (value.keepalive == null) {
            value.keepalive = 15000;
        }
        this._settings = value;

        // copy some values through to the bridge settings
        const settings = this._bridge.settings;
        settings.debug = value.debug;
        this._bridge.settings = settings;

    }

    get status() {
        return this._status;
    }

    set status(value) {
        this._status = value;
    }

    async _keepalive() {

        if (!this._status.connected) {
            if ((this._status.reconnect) && (this._exec.reconnect == null)) {
                this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._settings.keepalive);
            }
            this._exec.keepalive = null;
            return;
        }

        if (this.rxlist.length > 0) {
            this.rxlist.forEach((element) => {
                const diff = Date.now() - element.timestamp;
                if (diff.valueOf() > this._settings.keepalive) {
                    this.logger('timout receiving: ' + JSON.stringify(element) + ' -> ' + config.getTimestamp());
                }
            });
        }

        this.KeepAlive()
            .then(() => {
                this._exec.keepalive = setTimeout(this._keepalive.bind(this), this._settings.keepalive);
                this._exec.reconnect = null;
            }, (reason) => {
                this._exec.keepalive = null;
                if (this._exec.reconnect == null) {
                    this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._settings.keepalive);
                }

                this.logger('error sending KeepAlive: ' + reason + ' -> ' + config.getTimestamp());
            });

    }

    _reconnect() {
        if (this._status.connected) {
            return;
        }
        this.logger('** starting reconnection -> ' + config.getTimestamp());
        this.StartSession(false)
            .then(() => {
                // re-register to all previously registered sensors
                this.sensors.forEach(async sensor => {
                    await this.RegisterSensor(sensor);
                    await config.sleep(100);
                });

                if (this._status.connected) {
                    this._exec.keepalive = setTimeout(this._keepalive.bind(this), this._settings.keepalive);
                    this._exec.reconnect = null;
                } else {
                    this._exec.keepalive = null;
                    this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._settings.keepalive);
                }
                this._status.resume = false;

            }, (reason) => {
                this._status.connected = false;
                this._status.resume = false;
                this.logger('reconnect failure : ' + reason);

                this._exec.keepalive = null;
                this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._settings.keepalive);
            });
    }

    // run a specific discovery of the comfoair device
    async discover(multicastAddr) {
        return new Promise((resolve, reject) => {
            this._bridge.discover(multicastAddr)
                .then((result) => {
                    this.logger('comfoIP   : ' + result.device + ':' + result.port);
                    this.logger('comfoUUID : ' + result.comfouuid.toString('hex') + ' --> ' + JSON.stringify(result.comfouuid));

                    resolve(
                        {
                            'comfouuid': result.comfouuid.toString('hex'),
                            'comfoair': result.device,
                            'port': result.port
                        }
                    );
                })
                .catch(reject);
        });
    }

    StartSession(force) {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_StartSession(force);
                const rxkind = {
                    'timestamp' : new Date(),
                    'kind' : 53
                };
                this.rxlist.push(rxkind);

                this._bridge.transmit(txData)
                    .then(async () => {
                        let cnt = 150;
                        while (!this._bridge.isconnected) {
                            await config.sleep(100);
                        }

                        while ((cnt-- > 0) && (!this._status.connected)) {
                            await config.sleep(100);
                        }

                        if (cnt <= 0) {
                            if (this._exec.reconnect == null) {
                                this._exec.keepalive = null;
                                this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._settings.keepalive);
                            }

                            return reject('timeout connecting (1)');
                        }

                        if (this._status.connected) {
                            if (this._exec.keepalive == null) {
                                this._exec.keepalive = setTimeout(this._keepalive.bind(this), this._settings.keepalive);
                                this._exec.reconnect = null;
                            }
                            resolve({});
                        } else {
                            if (this._exec.reconnect == null) {
                                this._exec.keepalive = null;
                                this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._settings.keepalive);
                            }
                            reject('timeout connecting (2)');
                        }

                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                this.opensession = false;
                reject(exc);

            }
        });
    }

    KeepAlive() {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_KeepAlive();

                this._bridge.transmit(txData)
                    .then(() => {
                        resolve({});
                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);
            }
        });
    }

    CloseSession() {
        return new Promise((resolve, reject) => {
            if (!this._status.connected) {
                resolve({});
            }

            try {
                const txData = before.cmd_CloseSession();

                this._bridge.transmit(txData)
                    .then(() => {

                        clearTimeout(this._exec.keepalive);
                        clearTimeout(this._exec.reconnect);

                        this._status.reconnect = false;
                        this.sensors = [];
                        this.logger('comfo : session closed -> ' + config.getTimestamp());
                        resolve({});
                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });
            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);
            }
        });
    }

    ListRegisteredApps() {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_ListRegisteredApps();
                const rxkind = {
                    'timestamp' : new Date(),
                    'kind' : 55
                };
                this.rxlist.push(rxkind);

                this._bridge.transmit(txData)
                    .then(async () => {
                        resolve({});
                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);
            }
        });
    }

    RegisterApp() {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_RegisterApp(this._settings, true);
                const rxkind = {
                    'timestamp' : new Date(),
                    'kind' : 52
                };
                this.rxlist.push(rxkind);

                this._bridge.transmit(txData)
                    .then(async () => {
                        resolve({});
                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);

            }
        });
    }

    DeRegisterApp(uuid) {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_DeRegisterApp(uuid);
                const rxkind = {
                    'timestamp' : new Date(),
                    'kind' : 56
                };
                this.rxlist.push(rxkind);

                this._bridge.transmit(txData)
                    .then(async () => {
                        resolve({});
                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);

            }
        });
    }

    RegisterSensor(sensor) {

        // maintain a list of sensors registered to
        // this will automate things in case of reconnection
        if (this.sensors.indexOf(sensor) == -1) {
            this.sensors.push(sensor);
        }

        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_RegisterSensor(sensor);
                const rxkind = {
                    'timestamp' : new Date(),
                    'kind' : 39
                };
                this.rxlist.push(rxkind);

                this._bridge.transmit(txData)
                    .then(() => {
                        resolve({});
                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });
            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);

            }
        });

    }

    SendCommand(node, message) {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_SendCommand(node, message);
                const rxkind = {
                    'timestamp': new Date(),
                    'kind' : 34
                };
                this.rxlist.push(rxkind);

                this._bridge.transmit(txData)
                    .then(async () => {
                        resolve({});
                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);

            }
        });
    }

    // send a raw RMI payload and resolve with the response payload (Buffer)
    _rmiRequest(node, payload) {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_RmiRequest(node, payload);
                const rxkind = {
                    'timestamp': new Date(),
                    'kind' : 34
                };
                this.rxlist.push(rxkind);

                const timer = setTimeout(() => {
                    this.rmiPending.delete(txData.reference);
                    reject('timeout receiving RMI response');
                }, this._settings.keepalive);
                this.rmiPending.set(txData.reference, { resolve, reject, timer });

                this._bridge.transmit(txData)
                    .then(() => {
                        // resolved by CnRmiResponse
                    },(reason) => {
                        clearTimeout(timer);
                        this.rmiPending.delete(txData.reference);
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);
            }
        });
    }

    _findProperty(name) {
        const property = config.comfoProperties.find((entry) => entry.name === name);
        if (!property) {
            throw new Error('unknown property: ' + name);
        }
        return property;
    }

    // away mode as used by the app: until = Date (end time) or seconds (< 0 = unlimited)
    // end with SendCommand(node, 'AWAY_END')
    SetAway(node, until) {
        const seconds = (until instanceof Date) ? Math.max(0, Math.round((until.getTime() - Date.now()) / 1000)) : until;

        return this._rmiRequest(node, before.rmi_ScheduleSet(0x01, 0x0b, seconds, 0x00))
            .then(() => ({}));
    }

    // boost with arbitrary duration in seconds (< 0 = unlimited)
    SetBoost(node, seconds) {
        return this._rmiRequest(node, before.rmi_ScheduleSet(0x01, 0x06, seconds, 0x03))
            .then(() => ({}));
    }

    // e.g. subunit 0x01 (fan), type 0x01 (manual) / 0x06 (boost) / 0x0b (away)
    GetScheduleEntry(node, subunit, type) {
        return this._rmiRequest(node, before.rmi_ScheduleGet(subunit, type))
            .then((data) => after.analyze_ScheduleEntry(data));
    }

    ListScheduleEntries(node, subunit) {
        return this._rmiRequest(node, before.rmi_ScheduleList(subunit))
            .then((data) => after.analyze_ScheduleList(data));
    }

    // name from config.comfoProperties, e.g. 'FILTER_LIFETIME'
    GetProperty(node, name) {
        try {
            const property = this._findProperty(name);

            return this._rmiRequest(node, before.rmi_PropertyGet(property))
                .then((data) => after.analyze_Property(property, data));
        } catch (exc) {
            return Promise.reject(exc);
        }
    }

    // several properties of the same unit / subunit in one request: { NAME: value, ... }
    GetProperties(node, names) {
        try {
            const properties = names.map((name) => this._findProperty(name));

            return this._rmiRequest(node, before.rmi_PropertyGetMultiple(properties))
                .then((data) => after.analyze_Properties(properties, data));
        } catch (exc) {
            return Promise.reject(exc);
        }
    }

    // value with allowed range: { value, min, max, step }
    GetPropertyRange(node, name) {
        try {
            const property = this._findProperty(name);

            return this._rmiRequest(node, before.rmi_PropertyGet(property, 0x70))
                .then((data) => after.analyze_PropertyRange(property, data));
        } catch (exc) {
            return Promise.reject(exc);
        }
    }

    SetProperty(node, name, value) {
        try {
            const property = this._findProperty(name);

            return this._rmiRequest(node, before.rmi_PropertySet(property, value))
                .then(() => ({}));
        } catch (exc) {
            return Promise.reject(exc);
        }
    }

    async VersionRequest() {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_VersionRequest();
                const rxkind = {
                    'timestamp' : new Date(),
                    'kind' : 68
                };
                this.rxlist.push(rxkind);

                this._bridge.transmit(txData)
                    .then(() => {
                        resolve({});
                    },(reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);

            }
        });

    }

    TimeRequest() {
        return new Promise((resolve, reject) => {
            try {
                const txData = before.cmd_TimeRequest();
                const rxkind = {
                    'timestamp': new Date(),
                    'kind': 31      // TimeConfirmType
                };
                this.rxlist.push(rxkind);

                this._bridge.transmit(txData)
                    .then(async () => {
                        resolve({});
                    }, (reason) => {
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                        reject(reason);
                    });

            } catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);
            }
        });
    }

}

module.exports = ComfoAirQ;

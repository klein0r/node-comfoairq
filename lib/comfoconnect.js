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

        this.nodes = [];
        this.sensors = [];
        this.logger = this._settings.logger || console.log;

        this._bridge = new comfoBridge(this._settings);

        this._bridge.on('received', (data) => {
            data.msg = after.cmd_GatewayOperation(data.data);
            data.result = after.cmd_DecodeMessage(data.msg);
            data.error = data.msg.result;
            data.kind = data.msg.type;

            if (this.rxlist.length > 0) {
                const idx = this.rxlist.findIndex( ({ kind }) => kind === data.kind);
                if (idx >= 0) {
                    this.rxlist.splice(idx);
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
        this.logger('** starting reconnection -> ' + config.getTimestamp()());
        this.StartSession(false)
            .then(() => {
                // re-register to all previously registered sensors
                this.sensors.forEach(async sensor => {
                    const result = await this.RegisterSensor(sensor);
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
                                this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._status.keepalive);
                            }

                            reject('timeout connecting (1)');
                        }

                        if (this._status.connected) {
                            if (this._exec.keepalive == null) {
                                this._exec.keepalive = setTimeout(this._keepalive.bind(this), this._status.keepalive);
                                this._exec.reconnect = null;
                            }
                            resolve({});
                        } else {
                            if (this._exec.reconnect == null) {
                                this._exec.keepalive = null;
                                this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._status.keepalive);
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
                        this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.config.getTimestamp());
                        reject(reason);
                    });

            }
            catch (exc) {
                this.logger('comfo : TX error -> ' + JSON.stringify(exc) + ' -> ' + config.getTimestamp());
                reject(exc);

            }
        });
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
                const txData = before.cmd_TimeRequest(this._settings);
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
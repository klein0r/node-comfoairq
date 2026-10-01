'use strict';

const { Buffer } = require('node:buffer');
const events = require('node:events');
const crypto = require('node:crypto');

const comfoBridge = require('./bridge');
const before = require('./preparation');
const after = require('./analysis');
const config = require('./const');
const ComfoAirQError = require('./error');

// GatewayOperation types which are sent by the device without a request
const NOTIFICATION_KINDS = [4, 32, 40, 41, 100];

class ComfoAirQ extends events {
    constructor(options) {
        super();

        if (!options || typeof options !== 'object') {
            throw new TypeError('options object is required');
        }
        const uuid = ComfoAirQ._parseUuid(options, 'uuid');
        const comfouuid = ComfoAirQ._parseUuid(options, 'comfouuid');
        if (comfouuid && !uuid) {
            throw new Error('option uuid is required when comfouuid is set (use ComfoAirQ.generateUuid() once and store it)');
        }

        this._settings = {
            'pin'      : options.pin,
            'uuid'     : uuid,
            'device'   : options.device,
            'comfoair' : options.comfoair,
            'comfouuid': comfouuid,
            'port'     : options.port || 56747,

            'debug'    : options.debug,
            'logger'   : options.logger,
            'keepalive': 15000,
            // ms to wait for the TCP connection / for the response of a request
            'connectTimeout': options.connectTimeout ?? 5000,
            'requestTimeout': options.requestTimeout ?? 15000,
            // the bridge sends invalid (zero) values right after a sensor was registered, hold them back (ms, 0 = disabled)
            'sensorDelay': options.sensorDelay ?? 5000
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

        this.pending = new Map();               // requests waiting for a response (by reference)

        this.nodes = [];                        // nodes on the ComfoNet bus, announced after StartSession
        this.nodeWaiters = new Set();           // callers of GetVentilationNode waiting for the announcement
        this.sensors = [];
        this.sensorHolds = new Map();           // pdid -> { timer, data } of sensors which values are currently held back
        this.logger = this._settings.logger || console.log;

        this._bridge = new comfoBridge(this._settings);

        this._bridge.on('received', (data) => {
            data.msg = after.cmd_GatewayOperation(data.data);
            data.result = after.cmd_DecodeMessage(data.msg);
            data.error = data.msg.result;
            data.kind = data.msg.type;
            const reference = data.msg.reference;

            if (!this._settings.debug) {
                delete data.data;
                delete data.msg;
            }

            if (data.kind == 40) {           // CnRpdoNotification
                data.result.data = after.analyze_CnRpdoNotification(data.result.data);

                const hold = this.sensorHolds.get(data.result.data.pdid);
                if (hold) {
                    if (ComfoAirQ._isZero(data.result.data.data)) {
                        // keep the latest value, it is emitted when the hold expires
                        hold.data = data;
                        return;
                    }

                    // a non-zero value is a real value, release the hold
                    clearTimeout(hold.timer);
                    this.sensorHolds.delete(data.result.data.pdid);
                }

            } else if (data.kind == 53) {    // StartSessionConfirm
                if (data.error == 'OK') {
                    this._status.connected = true;
                    this._status.reconnect = true;

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
            } else if (data.kind == 31) {    // CnTimeConfirmType
                this.logger(' CnTimeConfirm --> ' + data.error);
                if (data.error == 'OK') {
                    data.result.data = after.analyze_CnTimeConfirm(data.result.data);
                }

            } else if (data.kind == 32) {    // CnNodeNotificationType
                if (data.error == 'OK') {
                    data.result.data = after.analyze_CnNodeNotification(data.result.data);
                    this._updateNode(data.result.data);
                }
            } else if (data.kind == 41) {    // CnAlarmNotificationType
                if (data.error == 'OK') {
                    data.result.data = after.analyze_CnAlarmNotification(data.result.data);
                    this.emit('alarm', data.result.data);
                }
            } else if (data.kind == 52) {    // RegisterAppConfirmType
                this.logger(' RegisterAppConfirm --> ' + data.error);
            } else if (data.kind == 55) {    // ListRegisteredAppsConfirmType
                this.logger(' ListAppConfirm --> ' + data.error);
                if (data.error == 'OK') {
                    data.result.data = after.analyze_ListRegisteredApps(data.result.data);
                }
            } else if (data.kind == 4) {     // CloseSessionRequest
                this._rejectPending('OTHER_SESSION', 'session was taken over by another client');

                const reason = {
                    state: 'OTHER_SESSION'
                };
                this.emit('disconnect', reason);
            }

            if (!NOTIFICATION_KINDS.includes(data.kind)) {
                this._resolvePending(reference, data);
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
            this._rejectPending('NOT_CONNECTED', 'connection to the device was lost');

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

        this.KeepAlive()
            .then(() => {
                this._exec.keepalive = setTimeout(this._keepalive.bind(this), this._settings.keepalive);
            }, (reason) => {
                this._exec.keepalive = null;
                if (this._exec.reconnect == null) {
                    this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._settings.keepalive);
                }

                this.logger('error sending KeepAlive: ' + reason + ' -> ' + config.getTimestamp());
            });

    }

    _reconnect() {
        this._exec.reconnect = null;
        if (this._status.connected) {
            return;
        }
        this.logger('** starting reconnection -> ' + config.getTimestamp());
        this.StartSession(false)
            .then(async () => {
                this._status.resume = false;

                // re-register to all previously registered sensors (one after another)
                for (const sensor of this.sensors) {
                    try {
                        await this.RegisterSensor(sensor);
                    } catch (exc) {
                        this.logger('error registering sensor ' + sensor + ' after reconnect: ' + exc);
                    }
                }
            }, (reason) => {
                this._status.connected = false;
                this._status.resume = false;
                this.logger('reconnect failure : ' + reason);

                if (reason && reason.code === 'NOT_ALLOWED') {
                    // the app is not registered (anymore) - retrying does not help
                    this.logger('app is not registered at the device, reconnect stopped');
                    this._status.reconnect = false;
                    return;
                }

                this._exec.reconnect = setTimeout(this._reconnect.bind(this), this._settings.keepalive);
            });
    }

    _updateNode(node) {
        this.nodes = this.nodes.filter(({ nodeId }) => nodeId !== node.nodeId);
        if (!node.offline) {
            this.nodes.push(node);
        }

        if (this.ventilationNode !== null) {
            this.nodeWaiters.forEach((resolve) => resolve(this.ventilationNode));
        }
    }

    // node id of the ventilation unit (ComfoAir Q / Flex), null if not announced (yet)
    get ventilationNode() {
        const ids = this.nodes
            .filter(({ productId }) => config.ventilationProducts.includes(productId))
            .map(({ nodeId }) => nodeId);

        return ids.length > 0 ? Math.min(...ids) : null;
    }

    // node id of the ventilation unit, waits for the announcement of the device if not known yet
    async GetVentilationNode(timeout = 5000) {
        if (this.ventilationNode !== null) {
            return this.ventilationNode;
        }

        let waiter;
        let timer;
        const announced = new Promise((resolve, reject) => {
            waiter = resolve;
            this.nodeWaiters.add(waiter);
            timer = setTimeout(() => reject(new ComfoAirQError('NOT_EXIST', 'the device did not announce a ventilation unit')), timeout);
        });
        announced.catch(() => {});      // handled below, avoid an unhandled rejection while sending

        try {
            // ask again, so we do not depend on the announcement after StartSession
            await this._send(before.cmd_NodeRequest(this._settings.debug));
            return await announced;
        } finally {
            clearTimeout(timer);
            this.nodeWaiters.delete(waiter);
        }
    }

    // transmit a request and resolve with the decoded response (matched by reference)
    _request(txData) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(txData.reference);
                reject(new ComfoAirQError('TIMEOUT', 'timeout receiving response'));
            }, this._settings.requestTimeout);
            this.pending.set(txData.reference, { resolve, reject, timer });

            this._bridge.transmit(txData)
                .catch((reason) => {
                    clearTimeout(timer);
                    this.pending.delete(txData.reference);
                    this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                    reject(reason);
                });
        });
    }

    // transmit a message without response
    _send(txData) {
        return this._bridge.transmit(txData)
            .then(() => ({}), (reason) => {
                this.logger('comfo : TX reject -> ' + reason + ' -> ' + config.getTimestamp());
                throw reason;
            });
    }

    _resolvePending(reference, data) {
        const pending = this.pending.get(reference);
        if (!pending) {
            return;
        }
        this.pending.delete(reference);
        clearTimeout(pending.timer);

        if (data.error == 'OK') {
            pending.resolve(data.result.data);
        } else {
            pending.reject(after.analyze_Error(data.error, data.result.data));
        }
    }

    _rejectPending(code, message) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new ComfoAirQError(code, message));
        }
        this.pending.clear();
    }

    _holdSensor(sensor) {
        if (!this._settings.sensorDelay) {
            return;
        }

        const hold = this.sensorHolds.get(sensor);
        if (hold) {
            clearTimeout(hold.timer);
        }

        this.sensorHolds.set(sensor, {
            timer: setTimeout(() => {
                const expired = this.sensorHolds.get(sensor);
                this.sensorHolds.delete(sensor);

                // the value is still zero after the delay, so it is a real value
                if (expired && expired.data) {
                    this.emit('receive', expired.data);
                }
            }, this._settings.sensorDelay),
            data: null
        });
    }

    _clearSensorHolds() {
        for (const hold of this.sensorHolds.values()) {
            clearTimeout(hold.timer);
        }
        this.sensorHolds.clear();
    }

    static _isZero(value) {
        if (Buffer.isBuffer(value)) {
            return value.every(byte => byte === 0);
        }
        return !value;
    }

    // 32 hex characters -> Buffer, missing / empty -> null
    static _parseUuid(options, key) {
        const value = options[key];
        if (value === undefined || value === null || value === '') {
            return null;
        }
        if (typeof value !== 'string' || !/^[0-9a-f]{32}$/i.test(value)) {
            throw new TypeError('option ' + key + ' must be 32 hex characters');
        }
        return Buffer.from(value, 'hex');
    }

    // find all ComfoConnect LAN C adapters - no instance / configuration required
    // options: address (string or array, default: broadcast of all interfaces), port, timeout (ms, default 3000)
    // -> [{ comfoair, comfouuid, port, version }]
    static discover(options) {
        return comfoBridge.discover(options);
    }

    // random uuid to identify this app at the LAN C - generate once and store it
    static generateUuid() {
        return crypto.randomBytes(16).toString('hex');
    }

    // run a specific discovery of the comfoair device (first device only, see static discover)
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

    // resolves with { resumed }
    async StartSession(force) {
        // the device announces its nodes at the start of every session
        this.nodes = [];

        const data = await this._request(before.cmd_StartSession(force, this._settings.debug));

        if (this._exec.keepalive == null) {
            this._exec.keepalive = setTimeout(this._keepalive.bind(this), this._settings.keepalive);
        }
        clearTimeout(this._exec.reconnect);
        this._exec.reconnect = null;

        return { 'resumed': !!data.resumed };
    }

    async KeepAlive() {
        return this._send(before.cmd_KeepAlive(this._settings.debug));
    }

    async CloseSession() {
        clearTimeout(this._exec.keepalive);
        clearTimeout(this._exec.reconnect);
        this._exec.keepalive = null;
        this._exec.reconnect = null;

        this._status.reconnect = false;
        this.sensors = [];
        this._clearSensorHolds();

        if (!this._status.connected) {
            return {};
        }

        await this._send(before.cmd_CloseSession(this._settings.debug));
        this._status.connected = false;
        this.logger('comfo : session closed -> ' + config.getTimestamp());

        return {};
    }

    // resolves with [{ uuid, devicename }]
    async ListRegisteredApps() {
        return this._request(before.cmd_ListRegisteredApps(this._settings.debug));
    }

    async RegisterApp() {
        await this._request(before.cmd_RegisterApp(this._settings, this._settings.debug));
        return {};
    }

    // uuid as 32 hex characters (see ListRegisteredApps)
    async DeRegisterApp(uuid) {
        await this._request(before.cmd_DeRegisterApp(uuid, this._settings.debug));
        return {};
    }

    async RegisterSensor(sensor) {

        // maintain a list of sensors registered to
        // this will automate things in case of reconnection
        if (this.sensors.indexOf(sensor) == -1) {
            this.sensors.push(sensor);
        }

        this._holdSensor(sensor);

        await this._request(before.cmd_RegisterSensor(sensor, this._settings.debug));
        return {};
    }

    async DeregisterSensor(sensor) {
        this.sensors = this.sensors.filter((entry) => entry !== sensor);

        const hold = this.sensorHolds.get(sensor);
        if (hold) {
            clearTimeout(hold.timer);
            this.sensorHolds.delete(sensor);
        }

        await this._request(before.cmd_DeregisterSensor(sensor, this._settings.debug));
        return {};
    }

    async SendCommand(node, message) {
        await this._rmiRequest(node, before.rmi_Command(message));
        return {};
    }

    // send a raw RMI payload and resolve with the response payload (Buffer)
    // node null / undefined = the ventilation unit (see GetVentilationNode)
    async _rmiRequest(node, payload) {
        const nodeId = (node === null || node === undefined) ? await this.GetVentilationNode() : node;
        const data = await this._request(before.cmd_RmiRequest(nodeId, payload, this._settings.debug));

        return data.message ? Buffer.from(data.message) : Buffer.alloc(0);
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
    async SetAway(node, until) {
        const seconds = (until instanceof Date) ? Math.max(0, Math.round((until.getTime() - Date.now()) / 1000)) : until;

        await this._rmiRequest(node, before.rmi_ScheduleSet(0x01, 0x0b, seconds, 0x00));
        return {};
    }

    // boost with arbitrary duration in seconds (< 0 = unlimited)
    async SetBoost(node, seconds) {
        await this._rmiRequest(node, before.rmi_ScheduleSet(0x01, 0x06, seconds, 0x03));
        return {};
    }

    // e.g. subunit 0x01 (fan), type 0x01 (manual) / 0x06 (boost) / 0x0b (away)
    async GetScheduleEntry(node, subunit, type) {
        return after.analyze_ScheduleEntry(await this._rmiRequest(node, before.rmi_ScheduleGet(subunit, type)));
    }

    async ListScheduleEntries(node, subunit) {
        return after.analyze_ScheduleList(await this._rmiRequest(node, before.rmi_ScheduleList(subunit)));
    }

    // name from config.comfoProperties, e.g. 'FILTER_LIFETIME'
    async GetProperty(node, name) {
        const property = this._findProperty(name);

        return after.analyze_Property(property, await this._rmiRequest(node, before.rmi_PropertyGet(property)));
    }

    // several properties of the same unit / subunit in one request: { NAME: value, ... }
    async GetProperties(node, names) {
        const properties = names.map((name) => this._findProperty(name));

        return after.analyze_Properties(properties, await this._rmiRequest(node, before.rmi_PropertyGetMultiple(properties)));
    }

    // value with allowed range: { value, min, max, step }
    async GetPropertyRange(node, name) {
        const property = this._findProperty(name);

        return after.analyze_PropertyRange(property, await this._rmiRequest(node, before.rmi_PropertyGet(property, 0x70)));
    }

    async SetProperty(node, name, value) {
        const property = this._findProperty(name);

        await this._rmiRequest(node, before.rmi_PropertySet(property, value));
        return {};
    }

    // resolves with { gatewayVersion, serialNumber, comfoNetVersion }, e.g. { 'R1.5.1', 'DEM0119521226', 'R1.0.0' }
    async VersionRequest() {
        const data = await this._request(before.cmd_VersionRequest(this._settings.debug));

        return {
            'gatewayVersion' : after.decodeVersion(data.gatewayVersion),
            'serialNumber'   : data.serialNumber,
            'comfoNetVersion': after.decodeVersion(data.comfoNetVersion)
        };
    }

    // resolves with { CnTimeRequest, timestamp }
    async TimeRequest() {
        return this._request(before.cmd_TimeRequest(this._settings.debug));
    }

}

module.exports = ComfoAirQ;

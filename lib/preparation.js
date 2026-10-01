'use strict';

const { Buffer } = require('node:buffer');
const protoBuf = require('protobufjs');
const messages = protoBuf.loadSync(__dirname + '/protocol/zehnder.proto');
const statics = require('./const');

let reference = 1;

// GatewayOperation + message, the reference correlates the response of the device
function build(type, name, payload, debug = false) {
    const opReference = reference++;

    const operation = messages.lookupType('GatewayOperation');
    const opBuffer = operation.encode(operation.create({
        type: messages.GatewayOperation.OperationType[type],
        reference: opReference
    })).finish();

    const command = messages.lookupType(name);
    const cmdBuffer = command.encode(command.create(payload)).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command'  : cmdBuffer,
        'reference': opReference
    };
}

function cmd_ListRegisteredApps(debug = false) {
    return build('ListRegisteredAppsRequestType', 'ListRegisteredAppsRequest', {}, debug);
}

function cmd_KeepAlive(debug = false) {
    return build('KeepAliveType', 'KeepAlive', {}, debug);
}

function cmd_RegisterApp(options, debug = false) {
    return build('RegisterAppRequestType', 'RegisterAppRequest', {
        uuid: Buffer.from(options.uuid, 'hex'),
        pin: options.pin,
        devicename : options.device
    }, debug);
}

// uuid as 32 hex characters (as listed by ListRegisteredApps)
function cmd_DeRegisterApp(uuid, debug = false) {
    return build('DeregisterAppRequestType', 'DeregisterAppRequest', {
        uuid: Buffer.from(uuid, 'hex')
    }, debug);
}

function cmd_StartSession(takeover, debug = false) {
    return build('StartSessionRequestType', 'StartSessionRequest', {
        takeover: takeover
    }, debug);
}

function cmd_RegisterSensor(sensor, debug = false) {
    const sensorData = statics.sensorCodes.find( ({ code }) => code === sensor);
    if (!sensorData) {
        throw new Error('unknown sensor: ' + sensor);
    }

    return build('CnRpdoRequestType', 'CnRpdoRequest', {
        pdid: sensor,
        type: sensorData.kind
    }, debug);
}

// RMI payload of a command from comfoCommands
function rmi_Command(message) {
    const msgData = statics.comfoCommands.find(({ name }) => name === message);
    if (!msgData) {
        throw new Error('unknown command: ' + message);
    }

    return Buffer.from(msgData.code, 'hex');
}

// timeout 0 removes the registration
function cmd_DeregisterSensor(sensor, debug = false) {
    const sensorData = statics.sensorCodes.find( ({ code }) => code === sensor);
    if (!sensorData) {
        throw new Error('unknown sensor: ' + sensor);
    }

    return build('CnRpdoRequestType', 'CnRpdoRequest', {
        pdid: sensor,
        type: sensorData.kind,
        timeout: 0
    }, debug);
}

function cmd_SendCommand(node, message, debug = false) {
    return cmd_RmiRequest(node, rmi_Command(message), debug);
}

function cmd_RmiRequest(node, payload, debug = false) {
    if (debug) {
        console.log(' ** RMI ' + payload.toString('hex'));
    }

    return build('CnRmiRequestType', 'CnRmiRequest', {
        nodeId: node,
        message: payload
    }, debug);
}

// 84 15 <subunit> <type> 00000000 <u32 LE seconds> <value>  (seconds < 0 = unlimited)
function rmi_ScheduleSet(subunit, type, seconds, value) {
    const payload = Buffer.alloc(13);
    payload.writeUInt8(0x84, 0);
    payload.writeUInt8(0x15, 1);
    payload.writeUInt8(subunit, 2);
    payload.writeUInt8(type, 3);
    payload.writeUInt32LE(0, 4);
    payload.writeUInt32LE(seconds < 0 ? 0xffffffff : seconds, 8);
    payload.writeUInt8(value, 12);

    return payload;
}

// 83 15 <subunit> <type>
function rmi_ScheduleGet(subunit, type) {
    return Buffer.from([0x83, 0x15, subunit, type]);
}

// 87 15 <subunit>
function rmi_ScheduleList(subunit) {
    return Buffer.from([0x87, 0x15, subunit]);
}

// 01 <unit> <subunit> <flags> <property>  (flags 0x10 = value, 0x70 = value, min, max, step)
function rmi_PropertyGet(property, flags = 0x10) {
    return Buffer.from([0x01, property.unit, property.subunit, flags, property.property]);
}

// 02 01 <unit> <subunit> <0x10 | count> <property…>  (all properties of the same unit / subunit)
function rmi_PropertyGetMultiple(properties) {
    const first = properties[0];
    if (properties.some((property) => property.unit !== first.unit || property.subunit !== first.subunit)) {
        throw new Error('properties must share unit and subunit');
    }

    return Buffer.from([0x02, 0x01, first.unit, first.subunit, 0x10 | properties.length].concat(properties.map((property) => property.property)));
}

// 03 <unit> <subunit> <property> <value>
function rmi_PropertySet(property, value) {
    let valueBuffer;

    switch (property.kind) {
        case 'uint8':
            valueBuffer = Buffer.alloc(1);
            valueBuffer.writeUInt8(value, 0);
            break;
        case 'uint16':
            valueBuffer = Buffer.alloc(2);
            valueBuffer.writeUInt16LE(value, 0);
            break;
        case 'decimal16':
            valueBuffer = Buffer.alloc(2);
            valueBuffer.writeInt16LE(Math.round(value * 10), 0);
            break;
        case 'string':
            valueBuffer = Buffer.concat([Buffer.from(value, 'latin1'), Buffer.from([0])]);
            break;
        default:
            valueBuffer = Buffer.from(value);
    }

    return Buffer.concat([Buffer.from([0x03, property.unit, property.subunit, property.property]), valueBuffer]);
}

function cmd_CloseSession(debug = false) {
    return build('CloseSessionRequestType', 'CloseSessionRequest', {}, debug);
}

function cmd_VersionRequest(debug = false) {
    return build('VersionRequestType', 'VersionRequest', {}, debug);
}

// the nodes are reported back as CnNodeNotifications
function cmd_NodeRequest(debug = false) {
    return build('CnNodeRequestType', 'CnNodeRequest', {}, debug);
}

// read the time - setTime must not be sent, the unit sets its clock to that value (also to 0)
function cmd_TimeRequest(debug = false) {
    return build('CnTimeRequestType', 'CnTimeRequest', {}, debug);
}

module.exports = {
    cmd_ListRegisteredApps,
    cmd_KeepAlive,
    cmd_RegisterApp,
    cmd_DeRegisterApp,
    cmd_StartSession,
    cmd_RegisterSensor,
    cmd_DeregisterSensor,
    cmd_SendCommand,
    cmd_RmiRequest,
    rmi_Command,
    rmi_ScheduleSet,
    rmi_ScheduleGet,
    rmi_ScheduleList,
    rmi_PropertyGet,
    rmi_PropertyGetMultiple,
    rmi_PropertySet,
    cmd_CloseSession,
    cmd_VersionRequest,
    cmd_NodeRequest,
    cmd_TimeRequest
};
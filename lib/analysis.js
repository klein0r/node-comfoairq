'use strict';

const { Buffer } = require('node:buffer');

const protoBuf = require('protobufjs');
const messages = protoBuf.loadSync(__dirname + '/protocol/zehnder.proto');
const config = require('./const');
const ComfoAirQError = require('./error');

function cmd_GatewayOperation(data) {
    const message = {};
    try {
        const cmd_len = data.readInt16BE(36);
        message.operation = data.slice(38, 38 + cmd_len);
        message.command = data.slice(38 + cmd_len);

        const operation = messages.lookupType('GatewayOperation').decode(message.operation);
        message.reference = operation.reference;
        message.type = operation.type;

        switch (operation.result) {
            case messages.GatewayOperation.GatewayResult.OK:
                message.result = 'OK';
                break;

            case messages.GatewayOperation.GatewayResult.BAD_REQUEST:
                message.result = 'BAD_REQUEST';
                break;

            case messages.GatewayOperation.GatewayResult.INTERNAL_ERROR:
                message.result = 'INTERNAL_ERROR';
                break;

            case messages.GatewayOperation.GatewayResult.NOT_REACHABLE:
                message.result = 'NOT_REACHABLE';
                break;

            case messages.GatewayOperation.GatewayResult.OTHER_SESSION:
                message.result = 'OTHER_SESSION';
                break;

            case messages.GatewayOperation.GatewayResult.NOT_ALLOWED:
                message.result = 'NOT_ALLOWED';
                break;

            case messages.GatewayOperation.GatewayResult.NO_RESOURCES:
                message.result = 'NO_RESOURCES';
                break;

            case messages.GatewayOperation.GatewayResult.NOT_EXIST:
                message.result = 'NOT_EXIST';
                break;

            case messages.GatewayOperation.GatewayResult.RMI_ERROR:
                message.result = 'RMI_ERROR';
                break;

            default:
                message.result = 'UNKNOWN';
                break;
        }
    } catch {
        //
    }

    return message;
}

function cmd_DecodeMessage(message) {
    const result = {
        error: '',
        kind: '',
        data: ''
    };

    try {

        const msgType = config.msgCodes.find( ({ code }) => code === message.type);

        if (message.result == 'OK') {
            const command = messages.lookupType(msgType.name);
            result.kind = msgType.name;
            result.data = command.decode(message.command);

            if (result.kind == 'CloseSessionRequest') {
                result.error = 'OTHER_SESSION';
            } else {
                result.error = 'OK';
            }

        } else {
            result.error = message.result;

            // the message may contain details (e.g. the error code of a CnRmiResponse)
            if (msgType) {
                result.kind = msgType.name;
                try {
                    result.data = messages.lookupType(msgType.name).decode(message.command);
                } catch {
                    // no details
                }
            }
        }
    } catch (error) {
        result.error = error;
    }

    return result;
}

// ComfoAirQError of a response with result != OK
function analyze_Error(error, data) {
    let message = String(error);
    let details;

    if (error == 'RMI_ERROR' && data && data.result) {
        details = { 'rmiError': data.result };
        message += ' ' + data.result + ': ' + (config.rmiErrors[data.result] || 'unknown error');
    }

    return new ComfoAirQError(String(error), message, details);
}

function analyze_ListRegisteredApps(data) {
    return data.apps.map((app) => {
        const uuid = Buffer.from(app.uuid);

        return {
            'uuid'       : uuid.toString('hex'),
            'uuid64'     : uuid.toString('base64'),
            'devicename' : app.devicename
        };
    });
}

function analyze_CnRpdoNotification(data) {
    const sensorData = config.sensorCodes.find( ({ code }) => code === data.pdid);
    const binVal = Buffer.from(data.data, 'base64');
    let value;

    switch (sensorData.kind) {
        case 0 :
            value = binVal.length > 0 && binVal[0] !== 0;
            break;
        case 1 :
            value = binVal.readInt8(0);
            break;
        case 2 :
            value = binVal.readInt16LE(0);
            break;
        case 3 :
            value = binVal.readInt32LE(0);
            break;
        case 4 :
            value = (data.pdid === 230) ? analyze_AirflowConstraints(binVal) : binVal;
            break;
        case 6 :
            value = binVal.readInt16LE(0) / 10;
            break;
        default:
            value = binVal;

    }

    return {
        'pdid': data.pdid,
        'name': sensorData.name,
        'data': value
    };
}

// names of the active airflow constraints, null if not available
function analyze_AirflowConstraints(data) {
    const bits = setBits(data);
    if (!bits.includes(45)) {
        return null;
    }

    return config.airflowConstraints
        .filter((constraint) => constraint.bits.some((bit) => bits.includes(bit)))
        .map(({ name }) => name);
}

// <active u8> <u32 LE> <u32 LE duration> <u32 LE remaining> <value u8>  (0xffffffff = unlimited -> null)
function analyze_ScheduleEntry(data, offset = 0) {
    const toSeconds = (value) => (value === 0xffffffff ? null : value);

    return {
        'active'   : data.readUInt8(offset) === 1,
        'duration' : toSeconds(data.readUInt32LE(offset + 5)),
        'remaining': toSeconds(data.readUInt32LE(offset + 9)),
        'value'    : data.readUInt8(offset + 13)
    };
}

// <count u8> followed by one 14-byte entry per type (type 1 .. count)
function analyze_ScheduleList(data) {
    const result = [];
    const count = data.readUInt8(0);

    for (let idx = 0; idx < count && 1 + (idx + 1) * 14 <= data.length; idx++) {
        result.push(Object.assign({ 'type': idx + 1 }, analyze_ScheduleEntry(data, 1 + idx * 14)));
    }

    return result;
}

function analyze_Property(property, data) {
    switch (property.kind) {
        case 'uint8':
            return data.readUInt8(0);
        case 'uint16':
            return data.readUInt16LE(0);
        case 'decimal16':
            return data.readInt16LE(0) / 10;
        case 'version':
            return decodeVersion(data.readUInt32LE(0));
        case 'string': {
            const end = data.indexOf(0);
            return data.toString('latin1', 0, end >= 0 ? end : data.length);
        }
        default:
            return data;
    }
}

// values of all properties back to back (strings are null-terminated)
function analyze_Properties(properties, data) {
    const result = {};
    let offset = 0;

    for (const property of properties) {
        let size = { 'uint8': 1, 'uint16': 2, 'decimal16': 2, 'version': 4 }[property.kind];
        if (property.kind === 'string') {
            const end = data.indexOf(0, offset);
            size = (end >= 0 ? end : data.length) - offset + 1;
        }
        result[property.name] = analyze_Property(property, data.subarray(offset, offset + size));
        offset += size;
    }

    return result;
}

// <value> <min> <max> <step>, each with the size of the property kind
function analyze_PropertyRange(property, data) {
    const size = { 'uint8': 1, 'uint16': 2, 'decimal16': 2 }[property.kind];
    if (!size) {
        throw new Error('no range for property kind: ' + property.kind);
    }
    const read = (idx) => analyze_Property(property, data.subarray(idx * size, (idx + 1) * size));

    return {
        'value': read(0),
        'min'  : read(1),
        'max'  : read(2),
        'step' : read(3)
    };
}

// firmware version: 2 bit type (U / D / P / R), 10 bit major, minor, patch -> 'R1.4.0'
function decodeVersion(version) {
    return ['U', 'D', 'P', 'R'][(version >>> 30) & 3] + ((version >>> 20) & 1023) + '.' + ((version >>> 10) & 1023) + '.' + (version & 1023);
}

// numbers of the set bits, bit 0 = lowest bit of the first byte
function setBits(data) {
    const bits = [];

    for (let idx = 0; idx < data.length * 8; idx++) {
        if (data[idx >> 3] & (1 << (idx & 7))) {
            bits.push(idx);
        }
    }

    return bits;
}

// active errors of a node: errors = { bit: text }
function analyze_CnAlarmNotification(data) {
    // the error bits changed after firmware 1.4.0 (R1.4.0 = 3222278144)
    const texts = (data.swProgramVersion <= 3222278144) ? config.alarmErrors140 : config.alarmErrors;
    const errors = {};

    for (const bit of setBits(data.errors ? Buffer.from(data.errors) : Buffer.alloc(0))) {
        errors[bit] = texts[bit] || 'unknown error ' + bit;
    }

    return {
        'nodeId'         : data.nodeId,
        'zone'           : data.zone,
        'productId'      : data.productId,
        'serialNumber'   : data.serialNumber,
        'firmwareVersion': data.swProgramVersion ? decodeVersion(data.swProgramVersion) : null,
        'errorId'        : data.errorId,
        'errors'         : errors
    };
}

// node on the ComfoNet bus
function analyze_CnNodeNotification(data) {
    const product = config.productCodes.find(({ code }) => code === data.productId);
    const mode = ['LEGACY', 'OFFLINE', 'NORMAL', 'UPDATE'][data.mode] || 'UNKNOWN';

    return {
        'nodeId'     : data.nodeId,
        'productId'  : data.productId,
        'productName': product ? product.name : 'unknown',
        'zoneId'     : data.zoneId,
        'mode'       : mode,
        // legacy nodes do not report a mode, they are offline without product id
        'offline'    : mode === 'OFFLINE' || (mode === 'LEGACY' && !data.productId)
    };
}

function analyze_CnTimeConfirm(data) {
    // seconds since 2000-01-01 00:00:00
    const baseTime = new Date(2000, 0, 1, 0, 0, 0);
    const result = new Date(baseTime.getTime() + data.currentTime * 1000);

    return {
        'CnTimeRequest': data.currentTime,
        'timestamp': result
    };
}

module.exports = {
    cmd_GatewayOperation,
    cmd_DecodeMessage,
    analyze_Error,
    analyze_ListRegisteredApps,
    analyze_CnRpdoNotification,
    analyze_ScheduleEntry,
    analyze_ScheduleList,
    analyze_Property,
    analyze_PropertyRange,
    analyze_Properties,
    analyze_CnAlarmNotification,
    analyze_CnNodeNotification,
    decodeVersion,
    analyze_CnTimeConfirm
};
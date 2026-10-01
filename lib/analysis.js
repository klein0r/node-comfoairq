'use strict';

const Buffer = require('safe-buffer').Buffer;

const protoBuf = require('protobufjs');
const messages = protoBuf.loadSync(__dirname + '/protocol/zehnder.proto');
const config = require('./const');

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
        }
    } catch (error) {
        result.error = error;
    }

    return result;
}

function analyze_ListRegisteredApps(data) {
    let result = [];

    for (let idx = 0; idx < data.apps.length; idx++) {
        const uuid = Buffer.from(data.apps[idx].uuid, 'base64');

        result += JSON.stringify({
            'uuid'       : uuid.toString('hex'),
            'uuid64'     : uuid.toString('base64'),
            'devicename' : data.apps[idx].devicename
        });
    }

    return result;
}

function analyze_CnRpdoNotification(data) {
    const sensorData = config.sensorCodes.find( ({ code }) => code === data.pdid);
    const binVal = Buffer.from(data.data, 'base64');
    let value;

    switch (sensorData.kind) {
        case 1 :
            value = binVal.readInt8(0);
            break;
        case 2 :
            value = binVal.readInt16LE(0);
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
        case 'string': {
            const end = data.indexOf(0);
            return data.toString('latin1', 0, end >= 0 ? end : data.length);
        }
        default:
            return data;
    }
}

function analyze_CnTimeConfirm(data) {
    const baseTime = new Date(2000,1,1,0,0,0);
    const result = new Date(baseTime.setSeconds(baseTime.getSeconds() + data.currentTime));

    return {
        'CnTimeRequest': data.currentTime,
        'timestamp': result
    };
}

module.exports = {
    cmd_GatewayOperation,
    cmd_DecodeMessage,
    analyze_ListRegisteredApps,
    analyze_CnRpdoNotification,
    analyze_ScheduleEntry,
    analyze_ScheduleList,
    analyze_Property,
    analyze_CnTimeConfirm
};
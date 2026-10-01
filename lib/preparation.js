'use strict';

//const debug = require('debug')('node-zehnder');
const { Buffer } = require('node:buffer');
const protoBuf = require('protobufjs');
const messages = protoBuf.loadSync(__dirname + '/protocol/zehnder.proto');
const statics = require('./const');

let reference = 1;

function cmd_ListRegisteredApps(debug = false) {

    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type: messages.GatewayOperation.OperationType.ListRegisteredAppsRequestType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('ListRegisteredAppsRequest');
    data = command.create({});
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command'  : cmdBuffer
    };

}

function cmd_KeepAlive(debug = false) {

    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type: messages.GatewayOperation.OperationType.KeepAliveType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('KeepAlive');
    data = command.create({});
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command'  : cmdBuffer
    };

}

function cmd_RegisterApp(options, debug = false) {

    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type: messages.GatewayOperation.OperationType.RegisterAppRequestType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('RegisterAppRequest');
    const uuidBuffer = Buffer.from(options.uuid, 'hex');

    data = command.create({
        uuid: uuidBuffer.toString('base64'),
        pin: options.pin,
        devicename : options.device
    });
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log('  register app : ' + JSON.stringify(data));
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command'  : cmdBuffer
    };
}

function cmd_DeRegisterApp(uuid, debug = false) {

    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type : messages.GatewayOperation.OperationType.DeregisterAppRequestType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('DeregisterAppRequest');
    data = command.create({
        uuid: uuid
    });
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command'  : cmdBuffer
    };
}

function cmd_StartSession(takeover, debug = false) {
    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type : messages.GatewayOperation.OperationType.StartSessionRequestType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('StartSessionRequest');
    data = command.create({
        takeover: takeover
    });
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command'  : cmdBuffer
    };

}

function cmd_RegisterSensor(sensor, debug = false) {
    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type : messages.GatewayOperation.OperationType.CnRpdoRequestType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('CnRpdoRequest');
    const sensorData = statics.sensorCodes.find( ({ code }) => code === sensor);
    data = command.create({
        pdid: sensor,
        type: sensorData.kind
    });
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command'  : cmdBuffer
    };
}

function cmd_SendCommand(node, message, debug = false) {
    const msgData = statics.comfoCommands.find(({ name }) => name === message);

    return cmd_RmiRequest(node, Buffer.from(msgData.code, 'hex'), debug);
}

function cmd_RmiRequest(node, payload, debug = false) {
    const operation = messages.lookupType('GatewayOperation');
    const opReference = reference++;
    let data = operation.create({
        type : messages.GatewayOperation.OperationType.CnRmiRequestType,
        reference : opReference
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('CnRmiRequest');
    const cmdData = {
        nodeId: node,
        message: payload
    };
    const reason = command.verify(cmdData);
    if (reason != null && debug) {
        console.log(reason);
    }
    data = command.create(cmdData);
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + payload.toString('hex') + ' - ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command'  : cmdBuffer,
        'reference': opReference
    };
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
    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type : messages.GatewayOperation.OperationType.CloseSessionRequestType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('CloseSessionRequest');
    data = command.create({});
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command':cmdBuffer
    };
}

function cmd_VersionRequest(debug = false) {
    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type : messages.GatewayOperation.OperationType.VersionRequestType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('VersionRequest');
    data = command.create({});
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command':cmdBuffer
    };
}

function cmd_TimeRequest(debug = false) {
    const operation = messages.lookupType('GatewayOperation');
    let data = operation.create({
        type : messages.GatewayOperation.OperationType.CnTimeRequestType,
        reference : reference++
    });
    const opBuffer = operation.encode(data).finish();

    const command = messages.lookupType('CnTimeRequest');
    data = command.create({
        setTime: 0
    });
    const cmdBuffer = command.encode(data).finish();

    if (debug) {
        console.log(' ** ' + opBuffer.toString('hex') + ' - ' + cmdBuffer.toString('hex'));
    }

    return {
        'operation': opBuffer,
        'command':cmdBuffer
    };
}

module.exports = {
    cmd_ListRegisteredApps,
    cmd_KeepAlive,
    cmd_RegisterApp,
    cmd_DeRegisterApp,
    cmd_StartSession,
    cmd_RegisterSensor,
    cmd_SendCommand,
    cmd_RmiRequest,
    rmi_ScheduleSet,
    rmi_ScheduleGet,
    rmi_ScheduleList,
    rmi_PropertyGet,
    rmi_PropertyGetMultiple,
    rmi_PropertySet,
    cmd_CloseSession,
    cmd_VersionRequest,
    cmd_TimeRequest
};
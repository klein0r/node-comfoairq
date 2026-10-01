'use strict';

const { Buffer } = require('node:buffer');
const net = require('node:net');
const path = require('node:path');

const protoBuf = require('protobufjs');
const messages = protoBuf.loadSync(path.join(__dirname, '../../lib/protocol/zehnder.proto'));
const OperationType = messages.GatewayOperation.OperationType;
const GatewayResult = messages.GatewayOperation.GatewayResult;

const typeNames = Object.fromEntries(Object.entries(OperationType).map(([name, value]) => [value, name]));

// minimal ComfoConnect LAN C: handler({ type, reference, msg, reply, notify, socket }) is called for every request
function startDevice(handler) {
    const sockets = new Set();

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});

        let buffer = Buffer.alloc(0);
        socket.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);

            while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE(0) + 4) {
                const frame = buffer.subarray(4, buffer.readUInt32BE(0) + 4);
                buffer = buffer.subarray(buffer.readUInt32BE(0) + 4);

                const opLen = frame.readUInt16BE(32);
                const op = messages.lookupType('GatewayOperation').decode(frame.subarray(34, 34 + opLen));
                const typeName = typeNames[op.type];
                const msg = messages.lookupType(typeName.replace(/Type$/, '')).decode(frame.subarray(34 + opLen));

                const send = (type, payload, result, reference) => {
                    const opBuffer = messages.lookupType('GatewayOperation').encode({
                        type: OperationType[type + 'Type'],
                        reference: reference,
                        result: GatewayResult[result || 'OK']
                    }).finish();
                    const msgBuffer = messages.lookupType(type).encode(payload || {}).finish();
                    const header = Buffer.alloc(38);
                    header.writeUInt32BE(34 + opBuffer.length + msgBuffer.length, 0);
                    header.writeUInt16BE(opBuffer.length, 36);
                    socket.write(Buffer.concat([header, opBuffer, msgBuffer]));
                };

                handler({
                    type: typeName,
                    reference: op.reference,
                    msg: msg,
                    socket: socket,
                    reply: (type, payload, result) => send(type, payload, result, op.reference),
                    notify: (type, payload) => send(type, payload, 'OK', 0)
                });
            }
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.address().port,
                close: () => {
                    sockets.forEach((socket) => socket.destroy());
                    return new Promise((done) => server.close(done));
                }
            });
        });
    });
}

module.exports = { startDevice };

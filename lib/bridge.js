'use strict';

const Buffer = require('safe-buffer').Buffer;
const dgram = require('dgram');
const tcp = require('net');
const events = require('events');

const protoBuf = require('protobufjs');
const messages = protoBuf.loadSync(__dirname + '/protocol/zehnder.proto');
const config = require('./const');

class ComfoAirQBridge extends events {

    constructor(options) {
        super();

        this._settings = options;
        this.logger = this._settings.logger || console.log;

        this.isconnected = false;

        this.txheader = Buffer.alloc(38).fill(0);
        // if comfouuid is already known, the TX header can be prepared
        if (this._settings.comfouuid) {
            if (this._settings.debug) {
                this.logger('bridge constructor: comfouuid already known');
            }
            this._settings.uuid.copy(this.txheader, 4);
            this._settings.comfouuid.copy(this.txheader, 20);
        } else if (this._settings.debug) {
            this.logger('bridge constructor: comfouuid not known');
        }

        this.initSocket();
    }

    initSocket() {
        this.sock = new tcp.Socket();

        this.sock.setNoDelay(true);
        this.sock.setTimeout(10000);
        this.sock.setKeepAlive(true, 15000);

        this.sock.on('connect', () => {
            this.logger('bridge : connected to comfoAir unit -> ' + config.getTimestamp());

            this.isconnected = true;
        });

        this.sock.on('timeout', () => {
            this.logger('bridge : TCP socket timeout -> ' + config.getTimestamp());
            const reason = {
                error: 'timeout'
            };
            if (this.isconnected) {
                this.emit('error', reason);
                this.sock.end('timeout detected');
            }
            //this.sock.destroy('timeout detected');
            this.isconnected = false;
        });

        this.sock.on('data', (data) => {
            let msglen = -1 ;
            let offset = 0;
            const datalen = data.length;

            // search the receive buffer for multiple messages received at the same time
            while (offset < datalen) {
                msglen = data.readInt32BE(offset);
                const buffer = data.slice(offset, offset + msglen + 4);
                const rxdata = {
                    'time': new Date(),
                    'data': buffer,
                    'kind': -1,
                    'msg': null
                };

                if (this._settings.debug) {
                    this.logger(' <- RX : ' + buffer.toString('hex'));
                }
                this.emit('received', rxdata);

                offset += msglen + 4;
            }

        });

        this.sock.on('error', (err) => {
            console.error('bridge : sock error: ' + err + ' -> ' + config.getTimestamp());
            const reason = {
                error: err
            };
            this.sock.end('socket error');
            this.emit('error', reason);
        });

        this.sock.on('close', (had_error) => {

            if (had_error) {
                this.logger('bridge : TCP socket closed with error -> ' + config.getTimestamp());
            } else {
                this.logger('bridge : TCP socket closed -> ' + config.getTimestamp());
            }

            //this.sock.end('socket closed');
            this.isconnected = false;
            this.emit('disconnect');
            this.sock.destroy();

        });

        this.sock.on('end', () => {
            this.logger('bridge : TCP socket ended -> ' + config.getTimestamp());

            // the socket will close
            //this.isconnected = false;
        });

    }

    // discovery of the ventilation unit / LAN C adapter
    async discover(multicastAddr) {
        const client = dgram.createSocket('udp4');

        return new Promise((resolve, reject) => {
            let comfouuid = null;
            let comfoair = null;

            client.on('error', (err) => {
                reject(err);
            });

            client.on('close', () => {
                resolve(
                    {
                        'comfouuid' : comfouuid,
                        'device'    : comfoair,
                        'port'      : this._settings.port
                    }
                );
            });

            client.on('message', (message, remote) => {
                if (this._settings.debug) {
                    this.logger(' <- RX (UDP) : ' + message.toString('hex'));
                    this.logger('         (' + remote.address + ':' + remote.port +  ')');
                }

                if (message.toString('hex') != '0a00') {
                    const protoData = messages.DiscoveryOperation.decode(message);

                    comfoair = protoData.searchGatewayResponse.ipaddress;
                    comfouuid = protoData.searchGatewayResponse.uuid;

                    client.close();
                }
            });

            client.bind(this._settings.port, () => {
                const txdata = Buffer.from('0a00', 'hex');

                if (this._settings.debug) {
                    this.logger(' Dicovering... ' + multicastAddr);
                    this.logger(' -> TX (UDP) : ' + txdata.toString('hex'));
                }

                client.setBroadcast(true);
                //client.addMembership(multicastAddr);

                client.send(txdata, this._settings.port, multicastAddr);
            });
        });
    }

    get settings() {
        return this._settings;
    }

    set settings(value) {
        this._settings = value;
    }

    async transmit(data) {
        if (!this.isconnected) {

            if (this.sock.destroyed) {
                this.initSocket();
            }

            this.sock.connect(this._settings.port, this._settings.comfoair);

            while (!this.isconnected) {
                await config.sleep(25);
            }
        }

        return new Promise((resolve, reject) => {
            const op_len = data.operation.length;
            const msg_len = 16 + 16 + 2 + data.command.length + data.operation.length;
            const txdata = Buffer.concat([this.txheader, data.operation, data.command]);

            txdata.writeInt16BE(op_len, 36);
            txdata.writeInt32BE(msg_len, 0);

            if (this._settings.debug) {
                this.logger(' -> TX : ' + txdata.toString('hex'));
            }

            this.sock.write(txdata, (err) => {
                if (err) {
                    this.logger('bridge : error sending data -> ' + err + ' -> ' + config.getTimestamp());
                    reject(err);
                }

                resolve('OK');
            });
        });
    }
}

module.exports = ComfoAirQBridge;
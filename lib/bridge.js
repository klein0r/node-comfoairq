'use strict';

const { Buffer } = require('node:buffer');
const dgram = require('node:dgram');
const os = require('node:os');
const tcp = require('node:net');
const events = require('node:events');

const protoBuf = require('protobufjs');
const messages = protoBuf.loadSync(__dirname + '/protocol/zehnder.proto');
const config = require('./const');
const ComfoAirQError = require('./error');

class ComfoAirQBridge extends events {

    constructor(options) {
        super();

        this._settings = options;
        this.logger = this._settings.logger || console.log;

        this.isconnected = false;
        this.connecting = null;

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
        // every connection attempt gets a new socket, events of a replaced socket are ignored
        const sock = new tcp.Socket();
        this.sock = sock;
        this.sockUsed = false;

        sock.setNoDelay(true);
        // the socket may be idle for a while (e.g. no sensor value changed),
        // so the timeout must be longer than the KeepAlive interval (sent every 15 s)
        sock.setTimeout(60000);
        sock.setKeepAlive(true, 15000);

        sock.on('connect', () => {
            if (sock !== this.sock) {
                return;
            }
            this.logger('bridge : connected to comfoAir unit -> ' + config.getTimestamp());

            this.isconnected = true;
        });

        sock.on('timeout', () => {
            if (sock !== this.sock) {
                return;
            }
            this.logger('bridge : TCP socket timeout -> ' + config.getTimestamp());
            const reason = {
                error: 'timeout'
            };
            if (this.isconnected) {
                this.emit('error', reason);
                sock.end('timeout detected');
            }
            this.isconnected = false;
        });

        // TCP is a stream: messages may be split across or combined in data events
        this.rxbuffer = Buffer.alloc(0);

        sock.on('data', (data) => {
            if (sock !== this.sock) {
                return;
            }
            this.rxbuffer = Buffer.concat([this.rxbuffer, data]);

            // extract all complete messages, keep an incomplete rest for the next data event
            while (this.rxbuffer.length >= 4) {
                const msglen = this.rxbuffer.readUInt32BE(0);
                if (this.rxbuffer.length < msglen + 4) {
                    break;
                }
                const buffer = this.rxbuffer.subarray(0, msglen + 4);
                this.rxbuffer = this.rxbuffer.subarray(msglen + 4);
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
            }
        });

        sock.on('error', (err) => {
            if (sock !== this.sock) {
                return;
            }
            this.logger('bridge : sock error: ' + err + ' -> ' + config.getTimestamp());
            const reason = {
                error: err
            };
            sock.end('socket error');
            this.emit('error', reason);
        });

        sock.on('close', (had_error) => {
            if (sock !== this.sock) {
                return;
            }

            if (had_error) {
                this.logger('bridge : TCP socket closed with error -> ' + config.getTimestamp());
            } else {
                this.logger('bridge : TCP socket closed -> ' + config.getTimestamp());
            }

            this.isconnected = false;
            this.emit('disconnect');
            sock.destroy();
        });

        sock.on('end', () => {
            if (sock !== this.sock) {
                return;
            }
            this.logger('bridge : TCP socket ended -> ' + config.getTimestamp());

            // the socket will close
        });

    }

    // open the TCP connection, rejects if the device is not reachable within connectTimeout
    connect() {
        if (this.isconnected) {
            return Promise.resolve();
        }

        if (!this.connecting) {
            this.connecting = new Promise((resolve, reject) => {
                if (this.sockUsed) {
                    this.initSocket();
                }
                const sock = this.sock;
                this.sockUsed = true;

                const cleanup = () => {
                    clearTimeout(timer);
                    sock.off('connect', onConnect);
                    sock.off('error', onError);
                    this.connecting = null;
                };
                const onConnect = () => {
                    cleanup();
                    resolve();
                };
                const onError = (err) => {
                    cleanup();
                    reject(new ComfoAirQError('NOT_REACHABLE', 'could not connect to ' + this._settings.comfoair + ':' + this._settings.port + ': ' + err.message));
                };
                const timer = setTimeout(() => {
                    cleanup();
                    sock.destroy();
                    reject(new ComfoAirQError('TIMEOUT', 'timeout connecting to ' + this._settings.comfoair + ':' + this._settings.port));
                }, this._settings.connectTimeout || 5000);

                sock.once('connect', onConnect);
                sock.once('error', onError);
                sock.connect(this._settings.port, this._settings.comfoair);
            });
        }

        return this.connecting;
    }

    // broadcast addresses of all external IPv4 interfaces
    static broadcastAddresses() {
        const result = [];

        for (const addresses of Object.values(os.networkInterfaces())) {
            for (const address of addresses || []) {
                if (address.family !== 'IPv4' && address.family !== 4) {
                    continue;
                }
                if (address.internal || !address.netmask) {
                    continue;
                }
                const ip = address.address.split('.').map(Number);
                const mask = address.netmask.split('.').map(Number);
                const broadcast = ip.map((part, idx) => (part | (~mask[idx] & 0xff))).join('.');

                if (result.indexOf(broadcast) === -1) {
                    result.push(broadcast);
                }
            }
        }

        return result.length > 0 ? result : ['255.255.255.255'];
    }

    // discovery of all ComfoConnect LAN C adapters which answer within the timeout
    // options: address (string or array, default: broadcast of all interfaces), port, timeout (ms), logger, debug
    static discover(options = {}) {
        const port = options.port || 56747;
        const timeout = options.timeout || 3000;
        const addresses = [].concat(options.address || ComfoAirQBridge.broadcastAddresses());
        const logger = options.logger || console.log;
        const devices = [];

        return new Promise((resolve, reject) => {
            const client = dgram.createSocket('udp4');
            let timer = null;

            const finish = (err) => {
                clearTimeout(timer);
                try {
                    client.close();
                } catch {
                    // already closed
                }
                if (err) {
                    reject(err);
                } else {
                    resolve(devices);
                }
            };

            client.on('error', finish);

            client.on('message', (message, remote) => {
                if (options.debug) {
                    logger(' <- RX (UDP) : ' + message.toString('hex') + ' (' + remote.address + ':' + remote.port + ')');
                }

                let response;
                try {
                    response = messages.DiscoveryOperation.decode(message).searchGatewayResponse;
                } catch {
                    return;
                }
                if (!response) {
                    return;     // e.g. our own search request on the broadcast address
                }

                const comfouuid = Buffer.from(response.uuid).toString('hex');
                if (!devices.some((device) => device.comfouuid === comfouuid)) {
                    devices.push({
                        'comfoair' : response.ipaddress,
                        'comfouuid': comfouuid,
                        'port'     : port,
                        'version'  : response.version
                    });
                }
            });

            // random local port - the LAN C answers to the sender port
            client.bind(0, () => {
                const txdata = Buffer.from('0a00', 'hex');     // SearchGatewayRequest

                client.setBroadcast(true);
                addresses.forEach((address) => {
                    if (options.debug) {
                        logger(' -> TX (UDP) : ' + txdata.toString('hex') + ' (' + address + ':' + port + ')');
                    }
                    client.send(txdata, port, address, (err) => {
                        if (err && options.debug) {
                            logger(' discovery send error (' + address + '): ' + err);
                        }
                    });
                });

                timer = setTimeout(() => finish(), timeout);
            });
        });
    }

    // discovery of the first ventilation unit / LAN C adapter (kept for compatibility)
    async discover(multicastAddr) {
        const devices = await ComfoAirQBridge.discover({
            'address': multicastAddr,
            'port'   : this._settings.port,
            'logger' : this.logger,
            'debug'  : this._settings.debug
        });

        if (devices.length === 0) {
            throw new Error('no ComfoConnect LAN C found');
        }

        return {
            'comfouuid' : Buffer.from(devices[0].comfouuid, 'hex'),
            'device'    : devices[0].comfoair,
            'port'      : devices[0].port
        };
    }

    get settings() {
        return this._settings;
    }

    set settings(value) {
        this._settings = value;
    }

    async transmit(data) {
        await this.connect();

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
                    return reject(new ComfoAirQError('NOT_CONNECTED', 'error sending data: ' + err.message));
                }

                resolve('OK');
            });
        });
    }
}

module.exports = ComfoAirQBridge;
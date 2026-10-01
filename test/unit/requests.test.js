'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ComfoAirQ = require('../../lib/comfoconnect');
const { startDevice } = require('./fakeDevice');

function createClient(port, options = {}) {
    return new ComfoAirQ(Object.assign({
        comfoair: '127.0.0.1',
        port: port,
        uuid: '00000000000000000000000000000001',
        comfouuid: '00000000000000000000000000000002',
        pin: 0,
        device: 'test',
        logger: () => {}
    }, options));
}

async function shutdown(client, device) {
    await client.CloseSession().catch(() => {});
    client._bridge.sock.destroy();
    if (device) {
        await device.close();
    }
}

// answers StartSession with OK and everything else with the given handler
function sessionDevice(handler = () => {}) {
    return startDevice((req) => {
        if (req.type === 'StartSessionRequestType') {
            req.reply('StartSessionConfirm', { resumed: false });
        } else {
            handler(req);
        }
    });
}

test('connection refused rejects with NOT_REACHABLE', async () => {
    const device = await startDevice(() => {});
    const port = device.port;
    await device.close();

    const client = createClient(port);
    await assert.rejects(client.StartSession(true), { code: 'NOT_REACHABLE' });
    await shutdown(client);
});

test('StartSession resolves and sets the status', async () => {
    const device = await sessionDevice();
    const client = createClient(device.port);

    assert.deepEqual(await client.StartSession(true), { resumed: false });
    assert.equal(client.status.connected, true);

    await shutdown(client, device);
});

test('StartSession of an unregistered app rejects with NOT_ALLOWED', async () => {
    const device = await startDevice((req) => req.reply('StartSessionConfirm', {}, 'NOT_ALLOWED'));
    const client = createClient(device.port);

    const started = Date.now();
    await assert.rejects(client.StartSession(true), { code: 'NOT_ALLOWED' });
    assert.ok(Date.now() - started < 1000, 'rejects immediately');

    await shutdown(client, device);
});

test('RMI responses are matched by reference', async () => {
    const pending = [];
    const device = await sessionDevice((req) => {
        pending.push(req);
        if (pending.length === 2) {
            // answer in reverse order
            pending[1].reply('CnRmiResponse', { message: Buffer.from([0xaa, 0x00]) });
            pending[0].reply('CnRmiResponse', { message: Buffer.from([0xb4, 0x00]) });
        }
    });
    const client = createClient(device.port);
    await client.StartSession(true);

    const [lifetime, warning] = await Promise.all([
        client.GetProperty(1, 'FILTER_LIFETIME'),
        client.GetProperty(1, 'FILTER_WARNING')
    ]);
    assert.equal(lifetime, 0xb4);
    assert.equal(warning, 0xaa);

    await shutdown(client, device);
});

test('RMI_ERROR rejects with the RMI error code', async () => {
    const device = await sessionDevice((req) => req.reply('CnRmiResponse', { result: 30 }, 'RMI_ERROR'));
    const client = createClient(device.port);
    await client.StartSession(true);

    await assert.rejects(client.SetProperty(1, 'FILTER_LIFETIME', 1), (err) => {
        assert.equal(err.code, 'RMI_ERROR');
        assert.deepEqual(err.details, { rmiError: 30 });
        assert.match(err.message, /value not in range/);
        return true;
    });

    await shutdown(client, device);
});

test('unknown commands reject without sending', async () => {
    const device = await sessionDevice(() => assert.fail('nothing should be sent'));
    const client = createClient(device.port);
    await client.StartSession(true);

    await assert.rejects(client.SendCommand(1, 'NO_SUCH_COMMAND'), /unknown command/);

    await shutdown(client, device);
});

test('pending requests are rejected when the connection is lost', async () => {
    const device = await sessionDevice((req) => req.socket.destroy());
    const client = createClient(device.port);
    await client.StartSession(true);

    const started = Date.now();
    await assert.rejects(client.GetProperty(1, 'FILTER_LIFETIME'), { code: 'NOT_CONNECTED' });
    assert.ok(Date.now() - started < 1000, 'rejects immediately');

    await shutdown(client, device);
});

test('requests without response reject with TIMEOUT', async () => {
    const device = await sessionDevice(() => {});
    const client = createClient(device.port, { requestTimeout: 200 });
    await client.StartSession(true);

    await assert.rejects(client.GetProperty(1, 'FILTER_LIFETIME'), { code: 'TIMEOUT' });
    assert.equal(client.pending.size, 0);

    await shutdown(client, device);
});

test('a session takeover rejects pending requests with OTHER_SESSION', async () => {
    const device = await sessionDevice((req) => req.notify('CloseSessionRequest', {}));
    const client = createClient(device.port);
    await client.StartSession(true);

    const reasons = [];
    client.on('disconnect', (reason) => reasons.push(reason.state));

    await assert.rejects(client.GetProperty(1, 'FILTER_LIFETIME'), { code: 'OTHER_SESSION' });
    assert.deepEqual(reasons, ['OTHER_SESSION']);

    await shutdown(client, device);
});

test('ListRegisteredApps resolves with an array', async () => {
    const device = await sessionDevice((req) => req.reply('ListRegisteredAppsConfirm', {
        apps: [
            { uuid: Buffer.from('00000000000000000000000000000001', 'hex'), devicename: 'one' },
            { uuid: Buffer.from('000000000000000000000000000000ff', 'hex'), devicename: 'two' }
        ]
    }));
    const client = createClient(device.port);
    await client.StartSession(true);

    const apps = await client.ListRegisteredApps();
    assert.deepEqual(apps.map((app) => [app.uuid, app.devicename]), [
        ['00000000000000000000000000000001', 'one'],
        ['000000000000000000000000000000ff', 'two']
    ]);

    await shutdown(client, device);
});

test('DeRegisterApp sends the uuid as bytes', async () => {
    let uuid;
    const device = await sessionDevice((req) => {
        uuid = Buffer.from(req.msg.uuid).toString('hex');
        req.reply('DeregisterAppConfirm', {});
    });
    const client = createClient(device.port);
    await client.StartSession(true);

    await client.DeRegisterApp('0123456789abcdef0123456789abcdef');
    assert.equal(uuid, '0123456789abcdef0123456789abcdef');

    await shutdown(client, device);
});

test('TimeRequest counts from 2000-01-01', async () => {
    const device = await sessionDevice((req) => req.reply('CnTimeConfirm', { currentTime: 86400 }));
    const client = createClient(device.port);
    await client.StartSession(true);

    const result = await client.TimeRequest();
    assert.equal(result.timestamp.getTime(), new Date(2000, 0, 2).getTime());

    await shutdown(client, device);
});

test('an unreachable device rejects within connectTimeout', async () => {
    // not routable: either no answer (TIMEOUT) or an immediate network error (NOT_REACHABLE)
    const client = createClient(0, { comfoair: '10.255.255.1', port: 56747, connectTimeout: 300 });

    const started = Date.now();
    await assert.rejects(client.StartSession(true), (err) => ['TIMEOUT', 'NOT_REACHABLE'].includes(err.code));
    assert.ok(Date.now() - started < 1000, 'rejects within the timeout');

    await shutdown(client);
});

test('reconnect re-registers the sensors one after another', async () => {
    const log = [];
    let open = 0;
    const device = await startDevice((req) => {
        if (req.type === 'StartSessionRequestType') {
            log.push('session takeover=' + req.msg.takeover);
            req.reply('StartSessionConfirm', {});
        } else if (req.type === 'CnRpdoRequestType') {
            log.push('sensor ' + req.msg.pdid);
            assert.equal(open++, 0, 'only one registration at a time');
            setTimeout(() => {
                open--;
                req.reply('CnRpdoConfirm', {});
            }, 20);
        }
    });
    const client = createClient(device.port, { sensorDelay: 0 });
    await client.StartSession(true);
    for (const sensor of [65, 221, 274]) {
        await client.RegisterSensor(sensor);
    }

    const disconnected = new Promise((resolve) => client.once('disconnect', resolve));
    client._bridge.sock.destroy();
    await disconnected;
    log.length = 0;

    client._reconnect();
    while (log.length < 4) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(log, ['session takeover=false', 'sensor 65', 'sensor 221', 'sensor 274']);

    await shutdown(client, device);
});

test('VersionRequest decodes the versions', async () => {
    // values of a ComfoConnect LAN C
    const device = await sessionDevice((req) => req.reply('VersionConfirm', { gatewayVersion: 3222279169, serialNumber: 'DEM0000000000', comfoNetVersion: 3222274048 }));
    const client = createClient(device.port);
    await client.StartSession(true);

    assert.deepEqual(await client.VersionRequest(), { gatewayVersion: 'R1.5.1', serialNumber: 'DEM0000000000', comfoNetVersion: 'R1.0.0' });

    await shutdown(client, device);
});

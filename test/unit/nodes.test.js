'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ComfoAirQ = require('../../lib/comfoconnect');
const { startDevice } = require('./fakeDevice');

function createClient(port) {
    return new ComfoAirQ({
        comfoair: '127.0.0.1',
        port: port,
        uuid: '00000000000000000000000000000001',
        comfouuid: '00000000000000000000000000000002',
        logger: () => {}
    });
}

async function shutdown(client, device) {
    await client.CloseSession().catch(() => {});
    client._bridge.sock.destroy();
    await device.close();
}

// ComfoAir Flex setup: connection board at node 41, ventilation unit at node 45
function announceFlex(req) {
    req.notify('CnNodeNotification', { nodeId: 0x30, productId: 0x05, zoneId: 1, mode: 2 });
    req.notify('CnNodeNotification', { nodeId: 41, productId: 0x09, zoneId: 1, mode: 2 });
    req.notify('CnNodeNotification', { nodeId: 45, productId: 0x08, zoneId: 1, mode: 2 });
}

test('nodes announced after StartSession are tracked', async () => {
    const device = await startDevice((req) => {
        if (req.type === 'StartSessionRequestType') {
            req.reply('StartSessionConfirm', {});
            announceFlex(req);
        }
    });
    const client = createClient(device.port);
    await client.StartSession(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(client.nodes.map(({ nodeId, productName }) => [nodeId, productName]), [
        [0x30, 'ZehnderGateway'],
        [41, 'ComfoAirFlexConnectionBoard'],
        [45, 'ComfoAirFlex']
    ]);
    assert.equal(client.ventilationNode, 45);

    await shutdown(client, device);
});

test('RMI requests without node go to the announced ventilation unit', async () => {
    const rmiNodes = [];
    const device = await startDevice((req) => {
        if (req.type === 'StartSessionRequestType') {
            req.reply('StartSessionConfirm', {});
        } else if (req.type === 'CnNodeRequestType') {
            // only announced on request
            announceFlex(req);
        } else if (req.type === 'CnRmiRequestType') {
            rmiNodes.push(req.msg.nodeId);
            req.reply('CnRmiResponse', { message: Buffer.from([0x96, 0x00]) });
        }
    });
    const client = createClient(device.port);
    await client.StartSession(true);

    assert.equal(await client.GetProperty(null, 'FILTER_LIFETIME'), 150);
    assert.equal(await client.GetProperty(1, 'FILTER_LIFETIME'), 150);
    assert.deepEqual(rmiNodes, [45, 1]);

    await shutdown(client, device);
});

test('an offline node is removed', async () => {
    const device = await startDevice((req) => {
        if (req.type === 'StartSessionRequestType') {
            req.reply('StartSessionConfirm', {});
            req.notify('CnNodeNotification', { nodeId: 1, productId: 0x01, zoneId: 1, mode: 2 });
            req.notify('CnNodeNotification', { nodeId: 1, productId: 0x01, zoneId: 1, mode: 1 });
        }
    });
    const client = createClient(device.port);
    await client.StartSession(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(client.nodes, []);
    assert.equal(client.ventilationNode, null);

    await shutdown(client, device);
});

test('GetVentilationNode rejects if no ventilation unit is announced', async () => {
    const device = await startDevice((req) => {
        if (req.type === 'StartSessionRequestType') {
            req.reply('StartSessionConfirm', {});
        }
    });
    const client = createClient(device.port);
    await client.StartSession(true);

    await assert.rejects(client.GetVentilationNode(200), { code: 'NOT_EXIST' });
    assert.equal(client.nodeWaiters.size, 0);

    await shutdown(client, device);
});

test('alarm notifications are emitted as alarm event', async () => {
    const device = await startDevice((req) => {
        if (req.type === 'StartSessionRequestType') {
            req.reply('StartSessionConfirm', {});
            req.notify('CnAlarmNotification', { nodeId: 1, productId: 1, swProgramVersion: 3222279168, errors: Buffer.from([0, 0, 0x20]) });
        }
    });
    const client = createClient(device.port);
    const alarm = new Promise((resolve) => client.once('alarm', resolve));
    await client.StartSession(true);

    const result = await alarm;
    assert.equal(result.nodeId, 1);
    assert.deepEqual(Object.keys(result.errors), ['21']);

    await shutdown(client, device);
});

test('DeregisterSensor sends timeout 0 and is not re-registered', async () => {
    const requests = [];
    const device = await startDevice((req) => {
        if (req.type === 'StartSessionRequestType') {
            req.reply('StartSessionConfirm', {});
        } else if (req.type === 'CnRpdoRequestType') {
            requests.push([req.msg.pdid, req.msg.timeout]);
            req.reply('CnRpdoConfirm', {});
        }
    });
    const client = createClient(device.port);
    await client.StartSession(true);

    await client.RegisterSensor(221);
    await client.DeregisterSensor(221);

    assert.deepEqual(requests, [[221, 0xffffffff], [221, 0]]);
    assert.deepEqual(client.sensors, []);
    assert.equal(client.sensorHolds.size, 0);

    await shutdown(client, device);
});

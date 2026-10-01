'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const after = require('../../lib/analysis');

test('decodeVersion', () => {
    assert.equal(after.decodeVersion(3222278144), 'R1.4.0');
    assert.equal(after.decodeVersion(0), 'U0.0.0');
});

test('alarm errors depend on the firmware version', () => {
    // bits 21 (base table) and 77
    const errors = Buffer.alloc(10);
    errors[2] = 1 << 5;
    errors[9] = 1 << 5;

    const current = after.analyze_CnAlarmNotification({ nodeId: 1, swProgramVersion: 3222278144 + 1024, errors });
    assert.deepEqual(Object.keys(current.errors), ['21', '77']);
    assert.match(current.errors[77], /filters of the Ventilation Unit must be replaced now/);
    assert.equal(current.firmwareVersion, 'R1.5.0');

    const legacy = after.analyze_CnAlarmNotification({ nodeId: 1, swProgramVersion: 3222278144, errors });
    assert.match(legacy.errors[77], /Preheater has no communication/);
});

test('property kind version', () => {
    const data = Buffer.alloc(4);
    data.writeUInt32LE(3222278144);
    assert.equal(after.analyze_Property({ kind: 'version' }, data), 'R1.4.0');
});

function notification(pdid, bytes) {
    return after.analyze_CnRpdoNotification({ pdid, data: Buffer.from(bytes) }).data;
}

test('sensor values are decoded by kind', () => {
    assert.equal(notification(210, [0x01]), true);                       // kind 0: boolean
    assert.equal(notification(210, [0x00]), false);
    assert.equal(notification(56, [0xff]), -1);                          // kind 1: int8 (0xff = auto)
    assert.equal(notification(119, [0x6e, 0x00]), 110);                  // kind 2
    assert.equal(notification(81, [0x52, 0x02, 0x00, 0x00]), 594);       // kind 3
    assert.equal(notification(86, [0xff, 0xff, 0xff, 0xff]), -1);        // kind 3: 0xffffffff = off
    assert.equal(notification(274, [0xab, 0x00]), 17.1);                 // kind 6
});

test('airflow constraints', () => {
    const data = Buffer.alloc(8);
    data[1] = 1 << 1;               // bit 9: FrostProtection
    data[5] = 1 << 5;               // bit 45: valid
    assert.deepEqual(notification(230, data), ['FrostProtection']);

    assert.equal(notification(230, Buffer.alloc(8)), null);
});

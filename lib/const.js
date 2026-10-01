'use strict';

const msgCodes = [
    {code:   0, name: 'NoOperation'},
    {code:   4, name: 'CloseSessionRequest'},
    {code:   5, name: 'ListRegisteredAppsRequest'},
    {code:   6, name: 'DeRegisterAppRequest'},
    {code:   7, name: 'ChangePinRequest'},
    {code:  15, name: 'DebugRequest'},
    {code:  16, name: 'UpgradeRequest'},
    {code:  18, name: 'VersionRequest'},
    {code:  31, name: 'CnTimeConfirm'},
    {code:  32, name: 'CnNodeNotification'},
    {code:  34, name: 'CnRmiResponse'},
    {code:  35, name: 'CnRmiAsyncRequest'},
    {code:  36, name: 'CnRmiAsyncConfirm'},
    {code:  37, name: 'CnRmiAsyncResponse'},
    {code:  38, name: 'CnRpdoRequest'},
    {code:  39, name: 'CnRpdoConfirm'},
    {code:  40, name: 'CnRpdoNotification'},
    {code:  41, name: 'CnAlarmNotification'},
    {code:  42, name: 'CnNodeRequest'},
    {code:  52, name: 'RegisterAppConfirm'},
    {code:  53, name: 'StartSessionConfirm'},
    {code:  54, name: 'CloseSessionConfirm'},
    {code:  55, name: 'ListRegisteredAppsConfirm'},
    {code:  56, name: 'DeregisterAppConfirm'},
    {code:  57, name: 'ChangePinConfirm'},
    {code:  65, name: 'DebugConfirm'},
    {code:  66, name: 'UpgradeConfirm'},
    {code:  68, name: 'VersionConfirm'},
    {code: 100, name: 'GatewayNotification'},
    {code: 101, name: 'KeepAlive'}
];

// bit numbers of sensor 230 (SENSOR_AIRFLOW_CONSTRAINTS), valid if bit 45 is set
// taken from aiocomfoconnect (MIT License, Copyright (c) 2022 Michaël Arnauts)
const airflowConstraints = [
    {bits: [2, 3],  name: 'Resistance'},
    {bits: [4],     name: 'PreheaterNegative'},
    {bits: [5, 7],  name: 'NoiseGuard'},
    {bits: [6, 8],  name: 'ResistanceGuard'},
    {bits: [9],     name: 'FrostProtection'},
    {bits: [10],    name: 'Bypass'},
    {bits: [12],    name: 'AnalogInput1'},
    {bits: [13],    name: 'AnalogInput2'},
    {bits: [14],    name: 'AnalogInput3'},
    {bits: [15],    name: 'AnalogInput4'},
    {bits: [16],    name: 'Hood'},
    {bits: [18],    name: 'AnalogPreset'},
    {bits: [19],    name: 'ComfoCool'},
    {bits: [22],    name: 'PreheaterPositive'},
    {bits: [23],    name: 'RFSensorFlowPreset'},
    {bits: [24],    name: 'RFSensorFlowProportional'},
    {bits: [25],    name: 'TemperatureComfort'},
    {bits: [26],    name: 'HumidityComfort'},
    {bits: [27],    name: 'HumidityProtection'},
    {bits: [47],    name: 'CO2ZoneX1'},
    {bits: [48],    name: 'CO2ZoneX2'},
    {bits: [49],    name: 'CO2ZoneX3'},
    {bits: [50],    name: 'CO2ZoneX4'},
    {bits: [51],    name: 'CO2ZoneX5'},
    {bits: [52],    name: 'CO2ZoneX6'},
    {bits: [53],    name: 'CO2ZoneX7'},
    {bits: [54],    name: 'CO2ZoneX8'}
];

// error codes of a CnRmiResponse with result RMI_ERROR
const rmiErrors = {
    11: 'unknown command',
    12: 'unknown unit',
    13: 'unknown subunit',
    14: 'unknown property',
    15: 'type can not have a range',
    30: 'value not in range',
    32: 'property not gettable or settable',
    40: 'internal error',
    41: 'internal error (command may be wrong)'
};

// RMI payload layout (node 1 = ComfoAir Q):
// * 84 15 <subunit> <type> 00000000 <u32 LE seconds> <value> : activate schedule entry
// * 83 15 <subunit> <type>                                    : get schedule entry
// * 85 15 <subunit> <type>                                    : end schedule entry
// * 87 15 <subunit>                                           : list all entries of subunit
// * 01 <unit> <subunit> 10 <property>                         : get property (70 instead of 10: value, min, max, step)
// * 02 01 <unit> <subunit> <flags | count> <property…>       : get multiple properties (flags 10 = value, 20 = min + max, 40 = step)
// * 03 <unit> <subunit> <property> <value>                    : set property
// * 80 / 81 / 82 <unit> <subunit>                             : start / complete / abort procedure
// GatewayOperation types 82 / 83 (not in zehnder.proto) are sent by the app with field 1 = 0 on connect
// and = 1 on installer login - meaning unknown, not required to set INSTALLER_MODE
// subunit 01 (fan) types: 01 = manual, 06 = boost, 0b = away
const comfoCommands = [
    // manual fan level 0 - NOT the away mode of the app (see AWAY_END / SetAway)
    {name: 'FAN_MODE_AWAY',    code: '84150101000000000100000000'},
    {name: 'FAN_MODE_LOW',     code: '84150101000000000100000001'},
    {name: 'FAN_MODE_MEDIUM',  code: '84150101000000000100000002'},
    {name: 'FAN_MODE_HIGH',    code: '84150101000000000100000003'},

    {name: 'FAN_BOOST_10M',    code: '84150106000000005802000003'},
    {name: 'FAN_BOOST_20M',    code: '8415010600000000B004000003'},
    {name: 'FAN_BOOST_30M',    code: '84150106000000000807000003'},
    {name: 'FAN_BOOST_60M',    code: '8415010600000000100e000003'},
    {name: 'FAN_BOOST_90M',    code: '84150106000000001815000003'},
    {name: 'FAN_BOOST',        code: '8415010600000000FFFFFFFF03'},
    {name: 'FAN_BOOST_END',    code: '85150106'},

    {name: 'AWAY_END',         code: '8515010b'},

    {name: 'MODE_AUTO',        code: '85150801'},
    {name: 'MODE_MANUAL',      code: '84150801000000000100000001'},

    {name: 'VENTMODE_SUPPLY',  code: '8415060100000000100e000001'},
    {name: 'VENTMODE_BALANCE', code: '85150601'},

    {name: 'VENTMODE_EXTRACT',     code: '8415070100000000100e000001'},
    {name: 'VENTMODE_EXTRACT_OFF', code: '85150701'},

    {name: 'TEMPPROF_NORMAL',  code: '8415030100000000ffffffff00'},
    {name: 'TEMPPROF_COOL',    code: '8415030100000000ffffffff01'},
    {name: 'TEMPPROF_WARM',    code: '8415030100000000ffffffff02'},

    {name: 'BYPASS_ON',        code: '8415020100000000100e000001'},
    {name: 'BYPASS_OFF',       code: '8415020100000000100e000002'},
    {name: 'BYPASS_AUTO',      code: '85150201'},

    {name: 'COMFOCOOL_AUTO',   code: '85150501'},                    // from aiocomfoconnect, not verified
    {name: 'COMFOCOOL_OFF',    code: '8415050100000000ffffffff00'},  // from aiocomfoconnect, not verified

    {name: 'SENSOR_TEMP_OFF',  code: '031d010400'},
    {name: 'SENSOR_TEMP_AUTO', code: '031d010401'},
    {name: 'SENSOR_TEMP_ON',   code: '031d010402'},
    {name: 'SENSOR_HUMC_OFF',  code: '031d010600'},
    {name: 'SENSOR_HUMC_AUTO', code: '031d010601'},
    {name: 'SENSOR_HUMC_ON',   code: '031d010602'},
    {name: 'SENSOR_HUMP_OFF',  code: '031d010700'},
    {name: 'SENSOR_HUMP_AUTO', code: '031d010701'},
    {name: 'SENSOR_HUMP_ON',   code: '031d010702'},

    {name: 'FILTER_CHANGE_START',    code: '801c01'},
    {name: 'FILTER_CHANGE_COMPLETE', code: '811c01'},   // resets SENSOR_DAYS_TO_REPLACE_FILTER to FILTER_LIFETIME
    {name: 'FILTER_CHANGE_ABORT',    code: '821c01'},

    {name: 'ERRORS_RESET',           code: '820301'},   // reset all errors (unit ERROR)

    {name: 'UNIT_TEMP_CELSIUS',       code: '031d010d00'},
    {name: 'UNIT_TEMP_FAHRENHEIT',    code: '031d010d01'},
    {name: 'UNIT_FLOW_LITER_PER_SEC', code: '031e010e02'},
    {name: 'UNIT_FLOW_M3_PER_HOUR',   code: '031e010e03'}
];

// properties for GetProperty / SetProperty (node 1)
// propertycode.kind: 'uint8', 'uint16', 'decimal16' (1/10), 'string' or 'version' (read only)
const comfoProperties = [
    {name: 'INSTALLER_CODE',      unit: 0x20, subunit: 0x01, property: 0x03, kind: 'string'},  // readable without login (default '4210')
    {name: 'INSTALLER_MODE',      unit: 0x20, subunit: 0x01, property: 0x0a, kind: 'uint8'},   // device wide: 0 = off, 2 = on (same as login on the unit display)
    {name: 'ZONES',               unit: 0x01, subunit: 0x01, property: 0x01, kind: 'uint8'},   // installer setting: bitmask of enabled zones (bit 0 = zone 1 ... bit 7 = zone 8)
    {name: 'MODEL_NAME',          unit: 0x01, subunit: 0x01, property: 0x08, kind: 'string'},  // 'ComfoAir Q350 D TR'
    {name: 'ARTICLE_NUMBER',      unit: 0x01, subunit: 0x01, property: 0x0b, kind: 'string'},
    {name: 'COUNTRY',             unit: 0x01, subunit: 0x01, property: 0x0d, kind: 'string'},  // 'DE'
    {name: 'SERIAL_NUMBER',       unit: 0x01, subunit: 0x01, property: 0x04, kind: 'string'},
    {name: 'FIRMWARE_VERSION',    unit: 0x01, subunit: 0x01, property: 0x06, kind: 'version'}, // 'R1.4.0'
    {name: 'DEVICE_NAME',         unit: 0x01, subunit: 0x01, property: 0x14, kind: 'string'},  // 'ComfoAirQ'
    {name: 'FILTER_LIFETIME',     unit: 0x1c, subunit: 0x01, property: 0x03, kind: 'uint16'},  // days
    {name: 'FILTER_WARNING',      unit: 0x1c, subunit: 0x01, property: 0x02, kind: 'uint16'},  // days before filter change to warn ('expect filter change soon')
    {name: 'SENSOR_TEMP_PASSIVE', unit: 0x1d, subunit: 0x01, property: 0x04, kind: 'uint8'},   // 0 = off, 1 = auto, 2 = on
    {name: 'SENSOR_HUMIDITY_COMFORT',    unit: 0x1d, subunit: 0x01, property: 0x06, kind: 'uint8'},   // 0 = off, 1 = auto, 2 = on
    {name: 'SENSOR_HUMIDITY_PROTECTION', unit: 0x1d, subunit: 0x01, property: 0x07, kind: 'uint8'},   // 0 = off, 1 = auto, 2 = on
    {name: 'UNIT_TEMPERATURE',    unit: 0x1d, subunit: 0x01, property: 0x0d, kind: 'uint8'},   // 0 = °C, 1 = °F
    {name: 'UNIT_FLOW',           unit: 0x1e, subunit: 0x01, property: 0x0e, kind: 'uint8'},   // 2 = l/s, 3 = m³/h
    {name: 'FAN_FLOW_AWAY',       unit: 0x1e, subunit: 0x01, property: 0x03, kind: 'uint16'},  // m³/h, installer setting, app level 1 (range 40 .. low)
    {name: 'FAN_FLOW_LOW',        unit: 0x1e, subunit: 0x01, property: 0x04, kind: 'uint16'},  // m³/h, app level 2 (range 40 .. medium)
    {name: 'FAN_FLOW_MEDIUM',     unit: 0x1e, subunit: 0x01, property: 0x05, kind: 'uint16'},  // m³/h, app level 3 (range 40 .. 320)
    {name: 'FAN_FLOW_HIGH',       unit: 0x1e, subunit: 0x01, property: 0x06, kind: 'uint16'},  // m³/h, app level 4 (range medium .. 320)
    {name: 'RMOT_HEATING_LIMIT',  unit: 0x1d, subunit: 0x01, property: 0x02, kind: 'decimal16'}, // °C
    {name: 'RMOT_COOLING_LIMIT',  unit: 0x1d, subunit: 0x01, property: 0x03, kind: 'decimal16'}, // °C
    {name: 'ANALOG_INPUT_1',      unit: 0x25, subunit: 0x01, property: 0x08, kind: 'uint8'},   // 0 = not available
    {name: 'ANALOG_INPUT_2',      unit: 0x25, subunit: 0x02, property: 0x08, kind: 'uint8'},
    {name: 'ANALOG_INPUT_3',      unit: 0x25, subunit: 0x03, property: 0x08, kind: 'uint8'},
    {name: 'ANALOG_INPUT_4',      unit: 0x25, subunit: 0x04, property: 0x08, kind: 'uint8'},
    // from the protocol docs of aiocomfoconnect (docs/PROTOCOL-RMI.md), not verified on a unit
    {name: 'TEMP_PROFILE_MODE',   unit: 0x1d, subunit: 0x01, property: 0x08, kind: 'uint8'},   // 0 = adaptive, 1 = fixed, 2 = external setpoint (?)
    {name: 'TARGET_TEMP_WARM',    unit: 0x1d, subunit: 0x01, property: 0x0a, kind: 'decimal16'}, // °C, temperature profile warm
    {name: 'TARGET_TEMP_NORMAL',  unit: 0x1d, subunit: 0x01, property: 0x0b, kind: 'decimal16'}, // °C, temperature profile normal
    {name: 'TARGET_TEMP_COOL',    unit: 0x1d, subunit: 0x01, property: 0x0c, kind: 'decimal16'}, // °C, temperature profile cool
    {name: 'ALTITUDE',            unit: 0x1e, subunit: 0x01, property: 0x07, kind: 'uint8'},   // height above sea level: 0 = 0-500 m, 1 = 500-1000 m, 2 = 1000-1500 m, 3 = 1500-2000 m
    {name: 'VENTILATION_CONTROL_MODE', unit: 0x1e, subunit: 0x01, property: 0x09, kind: 'uint8'}, // 0 = flow control, 1 = constant flow
    {name: 'BATHROOM_SWITCH_ON_DELAY',  unit: 0x1e, subunit: 0x01, property: 0x0b, kind: 'uint16'}, // seconds
    {name: 'BATHROOM_SWITCH_OFF_DELAY', unit: 0x1e, subunit: 0x01, property: 0x0c, kind: 'uint8'},  // minutes
    {name: 'BATHROOM_SWITCH_MODE',      unit: 0x1e, subunit: 0x01, property: 0x0d, kind: 'uint8'},  // 0 = fixed, 1 = mirrored
    {name: 'UNBALANCE',           unit: 0x1e, subunit: 0x01, property: 0x12, kind: 'decimal16'}, // % (-9.9)
    {name: 'ORIENTATION',         unit: 0x20, subunit: 0x01, property: 0x04, kind: 'uint8'},   // 0 = left, 1 = right
    // unverified - matched to the app unit status page by value only
    {name: 'UNIT_ORIENTATION',    unit: 0x20, subunit: 0x01, property: 0x06, kind: 'uint8'},   // 1 = right (?) - aiocomfoconnect documents the orientation at 0x04, see ORIENTATION
    {name: 'HEAT_RECOVERY_TYPE',  unit: 0x20, subunit: 0x01, property: 0x0d, kind: 'uint8'},   // 0 = HRV (?)
    {name: 'RF_ROOM_SENSORS',     unit: 0x19, subunit: 0x01, property: 0x02, kind: 'uint8'}    // 0 = no sensors connected (?)
];


// sensorcode.kind:
// * 0 : boolean
// * 1 :  8-bit integer value
// * 2 : 16-bit integer value
// * 3 : 32-bit integer value
// * 4 : 64-bit value (230: list of airflow constraints)
// * 6 : 16-bit decimal value
//
// names marked with * belong to accessories that were not installed on the test unit,
// they are assigned by the order of the app's unit status page (= sensor registration order)
// 416 - 418 (ComfoFond) confirmed by https://github.com/klein0r/ioBroker.comfoairq/issues/28
const sensorCodes = [
    {code:  16, kind: 1, name: 'SENSOR_AWAY_INDICATOR'},          // (0x01 = low, medium, high fan speed, 0x02 = filter change, 0x07 = away)
    {code:  18, kind: 1, name: 'SENSOR_FILTER_CHANGE_STATE'},     // (0x01 = normal, 0x02 = filter change in progress)
    {code:  33, kind: 1, name: ''},
    {code:  37, kind: 1, name: ''},
    {code:  42, kind: 1, name: ''},
    {code:  49, kind: 1, name: 'SENSOR_OPERATING_MODE_BIS'},      // (0x01 = limited manual, 0x05 = unlimited manual, 0x06 = boost, 0x0b = away, 0xff = auto)
    {code:  53, kind: 1, name: ''},
    {code:  54, kind: 1, name: 'SENSOR_FAN_MODE_SUPPLY_2'},        // from aiocomfoconnect, not seen in app traffic
    {code:  55, kind: 1, name: 'SENSOR_FAN_MODE_EXHAUST_2'},       // from aiocomfoconnect, not seen in app traffic
    {code:  56, kind: 1, name: 'SENSOR_OPERATING_MODE'},          // (0x01 = unlimited manual, 0xff = auto)
    {code:  57, kind: 1, name: ''},
    {code:  58, kind: 1, name: ''},
    {code:  65, kind: 1, name: 'SENSOR_FAN_SPEED_MODE'},          // (0x00 (away), 0x01 (low), 0x02 (medium) or 0x03 (high))
    {code:  66, kind: 1, name: 'SENSOR_BYPASS_ACTIVATION_MODE'},  // (0x00 = auto, 0x01 = activated, 0x02 = deactivated)
    {code:  67, kind: 1, name: 'SENSOR_TEMPERATURE_PROFILE'},     // (0x00 = normal, 0x01 = cold, 0x02 = warm)
    {code:  70, kind: 1, name: 'SENSOR_FAN_MODE_SUPPLY'},
    {code:  71, kind: 1, name: 'SENSOR_FAN_MODE_EXHAUST'},
    {code:  73, kind: 1, name: ''},
    {code:  74, kind: 1, name: ''},
    {code:  81, kind: 3, name: 'SENSOR_FAN_NEXT_CHANGE'},         // (0x52020000 = 0x00000252 -> 594 seconds)
    {code:  82, kind: 3, name: 'SENSOR_BYPASS_NEXT_CHANGE'},
    {code:  85, kind: 3, name: ''},
    {code:  86, kind: 3, name: 'SENSOR_FAN_MODE_SUPPLY_NEXT_CHANGE'},  // (seconds, 0xffffffff = off)
    {code:  87, kind: 3, name: 'SENSOR_FAN_MODE_EXHAUST_NEXT_CHANGE'}, // (seconds, 0xffffffff = off)
    {code:  89, kind: 3, name: ''},
    {code:  90, kind: 3, name: ''},
    {code: 117, kind: 1, name: 'SENSOR_FAN_EXHAUST_DUTY'},        // (0x1c = 28%)
    {code: 118, kind: 1, name: 'SENSOR_FAN_SUPPLY_DUTY'},         // (0x1d = 29%)
    {code: 119, kind: 2, name: 'SENSOR_FAN_EXHAUST_FLOW'},        // (0x6e00 = 110 m³/h)
    {code: 120, kind: 2, name: 'SENSOR_FAN_SUPPLY_FLOW'},         // (0x6900 = 105 m³/h)
    {code: 121, kind: 2, name: 'SENSOR_FAN_EXHAUST_SPEED'},       // (0x2d04 = 1069 rpm)
    {code: 122, kind: 2, name: 'SENSOR_FAN_SUPPLY_SPEED'},        // (0x5904 = 1113 rpm)
    {code: 128, kind: 2, name: 'SENSOR_POWER_CURRENT'},           // (0x0f00 = 15 W)
    {code: 129, kind: 2, name: 'SENSOR_POWER_TOTAL_YEAR'},        // (0x1700 = 23 kWh)
    {code: 130, kind: 2, name: 'SENSOR_POWER_TOTAL'},             // (0x1700 = 23 kWh)
    {code: 144, kind: 2, name: 'SENSOR_PREHEATER_POWER_TOTAL_YEAR'}, // (0x1700 = 23 kWh)
    {code: 145, kind: 2, name: 'SENSOR_PREHEATER_POWER_TOTAL'},   // (0x1700 = 23 kWh)
    {code: 146, kind: 2, name: 'SENSOR_PREHEATER_POWER_CURRENT'}, // (0x0f00 = 15 W)
    {code: 176, kind: 1, name: 'SENSOR_SETTING_RF_PAIRING'},
    {code: 192, kind: 2, name: 'SENSOR_DAYS_TO_REPLACE_FILTER'},  // (0x8200 = 130 days)
    {code: 208, kind: 1, name: 'SENSOR_UNIT_TEMPERATURE'},          // (0x00 = °C, 0x01 = °F)
    {code: 209, kind: 6, name: 'SENSOR_CURRENT_RMOT'},            // (0x7500 = 117 -> 11.7 °C)
    {code: 210, kind: 0, name: 'SENSOR_HEATING_SEASON'},
    {code: 211, kind: 0, name: 'SENSOR_COOLING_SEASON'},
    {code: 212, kind: 6, name: 'SENSOR_TARGET_TEMPERATURE'},
    {code: 213, kind: 2, name: 'SENSOR_AVOIDED_HEATING_CURRENT'},    // (0xb901 = 441 -> 4.41 W)
    {code: 214, kind: 2, name: 'SENSOR_AVOIDED_HEATING_TOTAL_YEAR'}, // (0xdd01 = 477 kWh)
    {code: 215, kind: 2, name: 'SENSOR_AVOIDED_HEATING_TOTAL'},      // (0xdd01 = 477 kWh)
    {code: 216, kind: 2, name: 'SENSOR_AVOIDED_COOLING_CURRENT'},    // (0xb901 = 441 -> 4.41 W)
    {code: 217, kind: 2, name: 'SENSOR_AVOIDED_COOLING_TOTAL_YEAR'}, // (0xdd01 = 477 kWh)
    {code: 218, kind: 2, name: 'SENSOR_AVOIDED_COOLING_TOTAL'},      //  (0xdd01 = 477 kWh)
    {code: 219, kind: 2, name: 'SENSOR_AVOIDED_COOLING_CURRENT_TARGET'},
    {code: 220, kind: 6, name: 'SENSOR_TEMPERATURE_OUTDOOR_AIR'},    // outdoor air temperature as shown on the app home screen
    {code: 221, kind: 6, name: 'SENSOR_TEMPERATURE_SUPPLY'},
    {code: 224, kind: 1, name: 'SENSOR_UNIT_AIRFLOW'},              // (0x02 = l/s, 0x03 = m³/h)
    {code: 225, kind: 1, name: 'SENSOR_COMFORTCONTROL_MODE'},
    {code: 226, kind: 2, name: 'SENSOR_FAN_SPEED_MODE_MODULATED'},
    {code: 227, kind: 1, name: 'SENSOR_BYPASS_STATE'},               // (0x64 = 100%)
    {code: 228, kind: 1, name: 'SENSOR_FROSTPROTECTION_UNBALANCE'},
    {code: 230, kind: 4, name: 'SENSOR_AIRFLOW_CONSTRAINTS'},     // list of active constraints, e.g. ['FrostProtection'] (null = not available)
    {code: 274, kind: 6, name: 'SENSOR_TEMPERATURE_EXTRACT'},        // (0xab00 = 171 -> 17.1 °C)
    {code: 275, kind: 6, name: 'SENSOR_TEMPERATURE_EXHAUST'},        // (0x5600 = 86 -> 8.6 °C)
    {code: 276, kind: 6, name: 'SENSOR_TEMPERATURE_OUTDOOR'},        // (0x3c00 = 60 -> 6.0 °C) - not used by the app, see 220
    {code: 277, kind: 6, name: 'SENSOR_TEMPERATURE_AFTER_PREHEATER'},
    {code: 278, kind: 6, name: 'SENSOR_TEMPERATURE_SUPPLY_AIR'},     // supply air temperature on the app unit status page (221 is shown on the home screen)
    {code: 290, kind: 1, name: 'SENSOR_HUMIDITY_EXTRACT'},           // (0x31 = 49%)
    {code: 291, kind: 1, name: 'SENSOR_HUMIDITY_EXHAUST'},           // (0x57 = 87%)
    {code: 292, kind: 1, name: 'SENSOR_HUMIDITY_OUTDOOR'},           // (0x43 = 67%)
    {code: 293, kind: 1, name: 'SENSOR_HUMIDITY_AFTER_PREHEATER'},
    {code: 294, kind: 1, name: 'SENSOR_HUMIDITY_SUPPLY'},            // (0x23 = 35%)
    {code: 321, kind: 2, name: ''},
    {code: 325, kind: 2, name: ''},
    {code: 330, kind: 2, name: ''},
    {code: 337, kind: 3, name: 'SENSOR_FAN_ACTIVE_ENTRIES'},        // bitmask (1 << type) of active fan schedule entries (0x02 = manual, 0x40 = boost, 0x800 = away)
    {code: 338, kind: 3, name: 'SENSOR_BYPASS_ACTIVE_ENTRIES'},     // bitmask (1 << type) of active bypass schedule entries (0x02 = manual)
    {code: 341, kind: 3, name: ''},
    {code: 342, kind: 3, name: 'SENSOR_FAN_MODE_SUPPLY_3'},        // from aiocomfoconnect, not seen in app traffic
    {code: 343, kind: 3, name: 'SENSOR_FAN_MODE_EXHAUST_3'},       // from aiocomfoconnect, not seen in app traffic
    {code: 345, kind: 3, name: ''},
    {code: 346, kind: 3, name: ''},
    {code: 369, kind: 1, name: 'SENSOR_ANALOG_INPUT_1'},           // (0.1 V)
    {code: 370, kind: 1, name: 'SENSOR_ANALOG_INPUT_2'},           // (0.1 V)
    {code: 371, kind: 1, name: 'SENSOR_ANALOG_INPUT_3'},           // (0.1 V)
    {code: 372, kind: 1, name: 'SENSOR_ANALOG_INPUT_4'},           // (0.1 V)
    {code: 384, kind: 6, name: 'SENSOR_TEMPERATURE_AFTER_POSTHEATER'},  // * (-40 = not installed)
    {code: 386, kind: 0, name: ''},
    {code: 400, kind: 6, name: 'SENSOR_TEMPERATURE_BEFORE_POSTHEATER'}, // * (-40 = not installed)
    {code: 401, kind: 1, name: ''},
    {code: 402, kind: 0, name: ''},
    {code: 416, kind: 6, name: 'SENSOR_SUBSOIL_TEMPERATURE_OUTDOOR'},   // outdoor air temperature (-40 = not installed)
    {code: 417, kind: 6, name: 'SENSOR_SUBSOIL_TEMPERATURE_GROUND'},    // fluid temperature
    {code: 418, kind: 1, name: 'SENSOR_SUBSOIL_STATE'},                 // running at (%)
    {code: 419, kind: 0, name: 'SENSOR_SUBSOIL_PRESENT'},              // *
    {code: 784, kind: 1, name: 'SENSOR_COMFOCOOL_STATE'},              // *
    {code: 785, kind: 0, name: ''},                                    // from aiocomfoconnect, not seen in app traffic
    {code: 802, kind: 6, name: 'SENSOR_COMFOCOOL_TEMPERATURE_CONDENSOR'}, // *
];

// bit numbers of CnAlarmNotification.errors (firmware > 1.4.0 / <= 1.4.0)
// taken from aiocomfoconnect (MIT License, Copyright (c) 2022 Michaël Arnauts)
const alarmErrorsBase = {
    21: 'DANGER! OVERHEATING! Two or more sensors are detecting an incorrect temperature. Ventilation has stopped.',
    22: 'Temperature too high for ComfoAir Q (TEMP_HRU ERROR)',
    23: 'The extract air temperature sensor has a malfunction (SENSOR_ETA ERROR)',
    24: 'The extract air temperature sensor is detecting an incorrect temperature (TEMP_SENSOR_ETA ERROR)',
    25: 'The exhaust air temperature sensor has a malfunction (SENSOR_EHA ERROR)',
    26: 'The exhaust air temperature sensor is detecting an incorrect temperature (TEMP_SENSOR_EHA ERROR)',
    27: 'The outdoor air temperature sensor has a malfunction (SENSOR_ODA ERROR)',
    28: 'The outdoor air temperature sensor is detecting an incorrect temperature (TEMP_SENSOR_ODA ERROR)',
    29: 'The pre-conditioned outdoor air temperature sensor has a malfunction',
    30: 'The pre-conditioned outdoor air temperature sensor is detecting an incorrect temperature (TEMP_SENSOR_P-ODA ERROR)',
    31: 'The supply air temperature sensor has a malfunction (SENSOR_SUP ERROR)',
    32: 'The supply air temperature sensor is detecting an incorrect temperature (TEMP_SENSOR_SUP ERROR)',
    33: 'The Ventilation Unit has not been commissioned (INIT ERROR)',
    34: 'The front door is open',
    35: 'The Pre-heater is present, but not in the correct position (right/left). (PREHEAT_LOCATION ERROR)',
    37: 'The pre-heater has a malfunction (PREHEAT ERROR)',
    38: 'The pre-heater has a malfunction (PREHEAT ERROR)',
    39: 'The extract air humidity sensor has a malfunction (SENSOR_ETA ERROR)',
    41: 'The exhaust air humidity sensor has a malfunction (SENSOR_EHA ERROR)',
    43: 'The outdoor air humidity sensor has a malfunction (SENSOR_ODA ERROR)',
    45: 'The outdoor air humidity sensor has a malfunction (SENSOR_P-ODA ERROR)',
    47: 'The supply air humidity sensor has a malfunction (SENSOR_SUP ERROR)',
    49: 'The exhaust air flow sensor has a malfunction (SENSOR_EHA ERROR)',
    50: 'The supply air flow sensor has a malfunction (SENSOR_SUP ERROR)',
    51: 'The extract air fan has a malfunction (FAN_EHA ERROR)',
    52: 'The supply air fan has a malfunction (FAN_SUP ERROR)',
    53: 'Exhaust air pressure too high. Check air outlets, ducts and filters for pollution and obstructions. Check valve settings (EXT_PRESSURE_EHA ERROR)',
    54: 'Supply air pressure too high. Check air outlets, ducts and filters for pollution and obstructions. Check valve settings. (EXT_PRESSURE_SUP ERROR)',
    55: 'The extract air fan has a malfunction (FAN_EHA ERROR)',
    56: 'The supply air fan has a malfunction (FAN_SUP ERROR)',
    57: 'The exhaust air flow is not reaching its set point (AIRFLOW_EHA ERROR)',
    58: 'The supply air flow is not reaching its set point (AIRFLOW_SUP ERROR)',
    59: 'Failed to reach required temperature too often for outdoor air after pre-heater (TEMPCONTROL_P-ODA ERROR)',
    60: 'Failed to reach required temperature too often for supply air. The modulating by-pass may have a malfunction. (TEMPCONTROL_SUP ERROR)',
    61: 'Supply air temperature is too low too often (TEMP_SUP_MIN ERROR)',
    62: 'Unbalance occurred too often beyond tolerance levels in past period (UNBALANCE ERROR)',
    63: 'Postheater was present, but is no longer detected (POSTHEAT_CONNECT ERROR)',
    64: 'Temperature sensor value for supply air ComfoCool exceeded limit too often (CCOOL_TEMP ERROR)',
    65: 'Room temperature sensor was present, but is no longer detected (T_ROOM_PRES ERROR)',
    66: 'RF Communication hardware was present, but is no longer detected (RF_PRES ERROR)',
    67: 'Option Box was present, but is no longer detected (OPTION_BOX CONNECT ERROR)',
    68: 'Pre-heater was present, but is no longer detected (PREHEAT_PRES ERROR)',
    69: 'Postheater was present, but is no longer detected (POSTHEAT_CONNECT ERROR)'
};

const alarmErrors = {
    ...alarmErrorsBase,
    70: 'Analog input 1 was present, but is no longer detected (ANALOG_1_PRES ERROR)',
    71: 'Analog input 2 was present, but is no longer detected (ANALOG_2_PRES ERROR)',
    72: 'Analog input 3 was present, but is no longer detected (ANALOG_3_PRES ERROR)',
    73: 'Analog input 4 was present, but is no longer detected (ANALOG_4_PRES ERROR)',
    74: 'ComfoHood was present, but is no longer detected (HOOD_CONNECT ERROR)',
    75: 'ComfoCool was present, but is no longer detected (CCOOL_CONNECT ERROR)',
    76: 'ComfoFond was present, but is no longer detected (GROUND_HEAT_CONNECT ERROR)',
    77: 'The filters of the Ventilation Unit must be replaced now',
    78: 'It is necessary to replace or clean the external filter',
    79: 'Order new filters now, because the remaining filter life time is limited',
    80: 'Service mode is active (SERVICE MODE)',
    81: 'Preheater has no communication with the ComfoAir unit (PREHEAT ERROR , 1081)',
    82: 'ComfoHood temperature error (HOOD_TEMP ERROR)',
    83: 'Postheater temperature error (POSTHEAT_TEMP ERROR)',
    84: 'Outdoor temperature of ComfoFond error (GROUND_HEAT_TEMP ERROR)',
    85: 'Analog input 1 error (ANALOG_1_IN ERROR)',
    86: 'Analog input 2 error (ANALOG_2_IN ERROR)',
    87: 'Analog input 3 error (ANALOG_3_IN ERROR)',
    88: 'Analog input 4 error (ANALOG_4_IN ERROR)',
    89: 'Bypass is in manual mode',
    90: 'ComfoCool is overheating',
    91: 'ComfoCool compressor error (CCOOL_COMPRESSOR ERROR)',
    92: 'ComfoCool room temperature sensor error (CCOOL_TEMP ERROR)',
    93: 'ComfoCool condensor temperature sensor error (CCOOL_TEMP ERROR)',
    94: 'ComfoCool supply air temperature sensor error (CCOOL_TEMP ERROR)',
    95: 'ComfoHood temperature is too high (HOOD_TEMP ERROR)',
    96: 'ComfoHood is activated',
    97: 'QM_Constraint_min_ERR',
    98: 'H_21_qm_min_ERR',
    99: 'Configuration error',
    100: 'Error analysis is in progress…',
    101: 'ComfoNet Error',
    102: 'The number of CO2 sensors has decreased – one or more sensors are no longer detected',
    103: 'More than 8 sensors detected in a zone',
    104: 'CO₂ Sensor C error'
};

const alarmErrors140 = {
    ...alarmErrorsBase,
    70: 'ComfoHood was present, but is no longer detected (HOOD_CONNECT ERROR)',
    71: 'ComfoCool was present, but is no longer detected (CCOOL_CONNECT ERROR)',
    72: 'ComfoFond was present, but is no longer detected (GROUND_HEAT_CONNECT ERROR)',
    73: 'The filters of the Ventilation Unit must be replaced now',
    74: 'It is necessary to replace or clean the external filter',
    75: 'Order new filters now, because the remaining filter life time is limited',
    76: 'Service mode is active (SERVICE MODE)',
    77: 'Preheater has no communication with the ComfoAir unit (PREHEAT ERROR , 1081)',
    78: 'ComfoHood temperature error (HOOD_TEMP ERROR)',
    79: 'Postheater temperature error (POSTHEAT_TEMP ERROR)',
    80: 'Outdoor temperature of ComfoFond error (GROUND_HEAT_TEMP ERROR)',
    81: 'Bypass is in manual mode',
    82: 'ComfoCool is overheating',
    83: 'ComfoCool compressor error (CCOOL_COMPRESSOR ERROR)',
    84: 'ComfoCool room temperature sensor error (CCOOL_TEMP ERROR)',
    85: 'ComfoCool condensor temperature sensor error (CCOOL_TEMP ERROR)',
    86: 'ComfoCool supply air temperature sensor error (CCOOL_TEMP ERROR)'
};

// productId of a CnNodeNotification
const productCodes = [
    {code: 0x01, name: 'ComfoAirQ'},
    {code: 0x02, name: 'ComfoSense'},
    {code: 0x03, name: 'ComfoSwitch'},
    {code: 0x04, name: 'OptionBox'},
    {code: 0x05, name: 'ZehnderGateway'},
    {code: 0x06, name: 'ComfoCool'},
    {code: 0x07, name: 'KNXGateway'},
    {code: 0x08, name: 'ComfoAirFlex'},
    {code: 0x09, name: 'ComfoAirFlexConnectionBoard'},
    {code: 0x0a, name: 'CO2Sensor'},
    {code: 0x0d, name: 'ComfoVarNGMainNode'},
    {code: 0x0e, name: 'ComfoVarNGPeripheralNode'},
    {code: 0x14, name: 'ComfoClime'},
    {code: 0x15, name: 'ComfoDry'},
    {code: 0x16, name: 'ComfoPost'},
    {code: 0xde, name: 'ComfoConnectPro'},
    {code: 0xfd, name: 'ServiceTool'},
    {code: 0xfe, name: 'ProductionTestTool'},
    {code: 0xff, name: 'DesignVerificationTestTool'}
];

// products which answer the RMI requests of the ventilation unit (other nodes reply with RMI_ERROR)
const ventilationProducts = [0x01, 0x08];

/*
 * create timestamp for logging on screen
 */
const getTimestamp = () => {
    const current_datetime = new Date();

    return current_datetime.getFullYear() + '-'
      + (current_datetime.getMonth() + 1).toString().padStart(2, '0') + '-'
      + current_datetime.getDate().toString().padStart(2, '0') + ' '
      + current_datetime.getHours().toString().padStart(2, '0') + ':'
      + current_datetime.getMinutes().toString().padStart(2, '0') + ':'
      + current_datetime.getSeconds().toString().padStart(2, '0');
};

const sleep = (milliseconds) => {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
};

module.exports = {
    msgCodes,
    rmiErrors,
    alarmErrors,
    alarmErrors140,
    sensorCodes,
    airflowConstraints,
    comfoCommands,
    comfoProperties,
    productCodes,
    ventilationProducts,
    getTimestamp,
    sleep
};
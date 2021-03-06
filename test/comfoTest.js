'use strict';

const comfoconnect = require('../lib/comfoconnect');
const settings = require(__dirname + '/settings.json');

const zehnder = new comfoconnect(settings);

const readline = require('readline');
const trmnl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let connected = false;
let reconnect = false;

zehnder.on('receive', (data) => {
    console.log(JSON.stringify(data));
});

zehnder.on('disconnect', (reason) => {
    if (reason.state == 'OTHER_SESSION') {
        console.log('other device became active');
        reconnect = true;
    }
    connected = false;
});

function keepAlive() {
    if (!connected) {
        if (reconnect) {
            setTimeout(restartSession, 15000);
        }
        return;
    }

    zehnder.KeepAlive();

    setTimeout(keepAlive, 5000);
}

async function restartSession() {
    console.log('** attempting reconnect **');

    try {
        const result = await zehnder.StartSession(false);
        console.log(JSON.stringify(result));

        if (result && result[0].error != 'OK') {
            throw new Error(result[0].error);
        }
        connected = true;

        setTimeout(keepAlive, 5000);
    } catch (exc) {
        console.log(exc);
        setTimeout(restartSession, 15000);
    }
}

const waitForCommand = function() {
    trmnl.question('zehnder command to test (? for help)  ', async function(answer) {
        if (answer == '?') {
            console.log('?    -- this help function\n' +
        'srch -- run discovery\n' +
        'lapp -- List Registered Apps\n' +
        'rapp -- Register App\n' +
        'uapp -- UnRegister App\n' +
        'info -- fetch ComfoAir version\n' +
        'conn -- connect to ComfoAir unit\n' +
        'sens -- register to updates on sensors\n' +
        'cmnd -- send command\n' +
        'time -- fetch system time\n' +
        'disc -- disconnect from ComfoAir unit\n' +
        'quit -- close this application\n\n');

        } else if (answer == 'srch') {
            console.log('running discovery\n');

            const result = await zehnder.discover('172.16.255.255');
            console.log(JSON.stringify(result));
        } else if (answer == 'lapp') {
            console.log('list registered apps\n');

            const result = await zehnder.ListRegisteredApps();
            console.log(JSON.stringify(result));

        } else if (answer == 'rapp') {
            console.log('register this app\n');

            const result = await zehnder.RegisterApp();
            console.log(JSON.stringify(result));

        } else if (answer.startsWith('uapp')) {
            console.log('unregister this app\n');

            const uuid = answer.slice(5);
            const result = await zehnder.DeRegisterApp(uuid);
            console.log(JSON.stringify(result));

        } else if (answer == 'info') {
            console.log('fetch ComfoAir info\n');

            const result = await zehnder.VersionRequest();
            console.log(JSON.stringify(result));

        } else if (answer == 'conn') {
            console.log('connect to ComfoAir unit\n');

            try {
                const result = await zehnder.StartSession(true);
                console.log(JSON.stringify(result));
                connected = true;
                /*
        result = await zehnder.RegisterSensor(67); // TEMPERATURE_PROFILE
        console.log(JSON.stringify(result));

        result = await zehnder.RegisterSensor(122); // SENSOR_FAN_SUPPLY_SPEED
        console.log(JSON.stringify(result));

        result = await zehnder.RegisterSensor(227); // SENSOR_BYPASS_STATE
        console.log(JSON.stringify(result));

        result = await zehnder.RegisterSensor(221); // SENSOR_TEMPERATURE_SUPPLY
        console.log(JSON.stringify(result));

        result = await zehnder.RegisterSensor(274); // SENSOR_TEMPERATURE_EXTRACT
        console.log(JSON.stringify(result));

        result = await zehnder.RegisterSensor(275); // SENSOR_TEMPERATURE_EXHAUST
        console.log(JSON.stringify(result));

        result = await zehnder.RegisterSensor(276); // SENSOR_TEMPERATURE_OUTDOOR
        console.log(JSON.stringify(result));
*/
                setTimeout(keepAlive, 5000);
            } catch (exc) {
                console.log(exc);
            }

        } else if (answer.startsWith('sens')) {
            console.log('register to updates on sensors\n');

            const sensID = answer.slice(5);
            if (sensID) {
                const result = await zehnder.RegisterSensor(Number(sensID));
                console.log(JSON.stringify(result));
            } else {
                console.log('Provide sensor id as parameter');
            }
        } else if (answer.startsWith('cmnd')) {
            console.log('Sending custom command\n');

            const cmndName = answer.slice(5);
            if (cmndName) {
                const result = await zehnder.SendCommand(1, cmndName);
                console.log(JSON.stringify(result));
            } else {
                console.log('Provide command name as parameter');
            }
        } else if (answer.startsWith('time')) {
            console.log('Fetching time\n');

            const result = await zehnder.TimeRequest();
            console.log(JSON.stringify(result));

        } else if (answer == 'disc') {
            console.log('disconnect from ComfoAir unit\n');

            await zehnder.CloseSession();
            connected = false;
        } else if (answer == 'quit') {
            console.log('closing down');

            await zehnder.CloseSession();
            connected = false;
            trmnl.close();
        }

        waitForCommand();

    });

};

waitForCommand();

trmnl.on('close', function() {
    console.log('\nBYE BYE !!!');
    process.exit(0);
});
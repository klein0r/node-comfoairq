'use strict';

// error of a request, code is one of
// * the GatewayOperation result of the device: BAD_REQUEST, INTERNAL_ERROR, NOT_REACHABLE, OTHER_SESSION,
//   NOT_ALLOWED, NO_RESOURCES, NOT_EXIST, RMI_ERROR
// * TIMEOUT       : no (TCP connection / response) within the timeout
// * NOT_CONNECTED : connection lost before the response arrived
class ComfoAirQError extends Error {
    constructor(code, message, details) {
        super(message || code);

        this.name = 'ComfoAirQError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
        }
    }
}

module.exports = ComfoAirQError;

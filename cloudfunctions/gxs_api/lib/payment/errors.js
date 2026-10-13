'use strict';

// Only fixed, local messages and numeric provider codes may cross this boundary.
// Never retain an upstream error cause: fetch errors can include signed URLs.
class PaymentProtocolError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'PaymentProtocolError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, details) => { throw new PaymentProtocolError(code, details); };
module.exports = { PaymentProtocolError, fail };

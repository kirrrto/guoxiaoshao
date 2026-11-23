'use strict';
const { COLLECTIONS } = require('../collections');
const { isBoundTestAccount } = require('../rules/membership');

// Revocation takes effect in the transaction that commits the privileged action.
async function testAccountConfigIn(tx, user, config) {
  if (!isBoundTestAccount(user)) return config;
  const current = await tx.get(COLLECTIONS.config, 'runtime');
  return { ...config, adminUserKeys: current?.adminUserKeys };
}

module.exports = { testAccountConfigIn };

// Copyright (c) 2024 Uuriko. All rights reserved.

import { _memberOf } from './bounty-helpers.mjs';

/**
 * @param {Object} members - Room member projection
 * @param {string} rawId - Candidate lane/member ID
 * @throws {Error} if no own-key match exists
 */
function _requireLane(members, rawId) {
  if (!_memberOf(members, rawId)) {
    throw new Error('not_authorized');
  }
}

/**
 * @param {Object} members - Room member projection
 * @param {string} rawId - Candidate agent lane ID
 * @throws {Error} if no own-key match exists
 */
function _requireAgentLane(members, rawId) {
  if (!_memberOf(members, rawId)) {
    throw new Error('not_authorized');
  }
}

/**
 * @param {Object} members - Room member projection
 * @param {string} rawId - Candidate recipient ID
 * @throws {Error} if no own-key match exists
 */
function _requireRecipient(members, rawId) {
  if (!_memberOf(members, rawId)) {
    throw new Error('not_authorized');
  }
}

export {
  _requireLane,
  _requireAgentLane,
  _requireRecipient,
};
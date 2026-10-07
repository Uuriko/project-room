// Every application table that carries a room, identity, or account key, plus
// child tables that point at those rows through a parent. `retain` is only
// used with a reason. Room purge deletes `delete` rows for that room, then
// the room itself. Identity purge revokes the identity and deletes its
// `delete` rows. Account purge runs the account-deletion executor and then
// the account-scoped `delete` rows.

function freezeMatch(match) {
  const out = {};
  for (const kind of ["room", "identity", "account"]) {
    if (match[kind]) out[kind] = Object.freeze([...match[kind]]);
  }
  return Object.freeze(out);
}

function freezeVia(via) {
  if (!via) return undefined;
  const out = {};
  for (const [kind, spec] of Object.entries(via)) out[kind] = Object.freeze({ ...spec });
  return Object.freeze(out);
}

const ROWS = [

  ...["room_trial_tasks", "room_trial_requests", "room_vetting_keys", "room_vetting_receipts", "demigod_offer_profiles", "demigod_offer_requests", "demigod_contracts", "demigod_contract_requests", "buyer_signoff_loops", "buyer_signoff_requests"].map(table => ({ table, key: "room_id", action: "delete", optional: true, match: {room:["room_id"]} })),
  { table: "projection_bodies", key: "room_id", action: "delete", match: { room: ["room_id"] } },
  ...["room_assistant_config", "room_assistant_runs", "room_assistant_ops"].map(table => ({ table, key: "room_id", action: "delete", optional: true, match: { room: ["room_id"] } })),
  // Retired schemas remain in upgraded databases but are never created on a
  // fresh store. Their room-owned rows still belong in confirmed room purge.
  ...[
    "emissary_drops", "emissary_idempotency", "emissary_invite_attribution",
    "emissary_journal", "external_identities", "external_receipts"
  ].map(table => ({ table, key: "room_id", action: "delete", optional: true, match: { room: ["room_id"] } })),
  {
    "table": "access_requests",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "account_access_events",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Security audit rows stay, matching account deletion."
  },
  {
    "table": "account_credentials",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "account_login_methods",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "account_magic_codes",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "account_passkey_credentials",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "account_recovery_codes",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "account_security_events",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "account_session_slots",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "account_setup",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "account_terms",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "activity_events",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_api_keys",
    "key": "identity_id",
    "action": "delete",
    "match": {
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "agent_autonomy_tiers",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_capability_grants",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "spend_grant_terms",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "spend_authorizations",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "spend_room_reservations",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_connection_operations",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_connections",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_directory_cards",
    "key": "agent_id",
    "action": "delete",
    "match": {
      "identity": [
        "agent_id",
        "owner_identity_id"
      ]
    }
  },
  {
    "table": "agent_hosts",
    "key": "agent_id",
    "action": "delete",
    "match": {
      "identity": [
        "agent_id"
      ]
    }
  },
  {
    "table": "agent_identities",
    "key": "identity_id",
    "action": "retain",
    "match": {
      "identity": [
        "identity_id"
      ]
    },
    "reason": "The identity row stays as a revoked tombstone. Its secret no longer authenticates."
  },
  {
    "table": "agent_identity_verification",
    "key": "identity_id",
    "action": "delete",
    "match": {
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "agent_invite_codes",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_key_registry",
    "key": "identity_id",
    "action": "delete",
    "match": {
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "agent_push_configs",
    "key": "agent_id",
    "action": "delete",
    "match": {
      "identity": [
        "agent_id"
      ]
    }
  },
  {
    "table": "agent_room_ownership",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "agent_skill_cards",
    "key": "identity_id",
    "action": "delete",
    "match": {
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "agent_wake_signals",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_wake_polls",
    "key": "agent_id",
    "action": "delete",
    "match": {
      "identity": [
        "agent_id"
      ]
    }
  },
  {
    "table": "agent_webhook_deliveries",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "agent_id"
      ]
    }
  },
  {
    "table": "agent_webhook_subs",
    "key": "agent_id",
    "action": "delete",
    "match": {
      "identity": [
        "agent_id"
      ]
    }
  },
  {
    "table": "agent_work_wake_hosts",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_work_wakes",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_disputes",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_events",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_flakes",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_idempotency",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_journal",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "bounty_records",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_reputation_packets",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_review_packets",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_rubric_versions",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_sequences",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_sybil_flags",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "bounty_watchers",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "collab_approvals",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "collab_assignments",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "collab_draft_locks",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "collab_notes",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "collab_routing_events",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "commands",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "credentials",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "cursors",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "direct_channel_sends",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "dm_consents",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "events",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "gmail_linked_mailboxes",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "gmail_mailboxes",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "gmail_operations",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "gmail_pending",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "guest_invites",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "guest_members",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "guest_selfserve",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "guest_selfserve_idem",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "handoff_envelopes",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "human_push_preferences",
    "key": "room_id",
    "action": "delete",
    "match": { "room": ["room_id"] }
  },
  {
    "table": "human_push_subscriptions",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "identity_link_codes",
    "key": "identity_id",
    "action": "delete",
    "match": {
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "identity_links",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "inbox_attachment_bytes",
    "key": "identity_id",
    "action": "delete",
    "match": {
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "inbox_handoff_rooms",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "inbox_handoffs",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "integrity_room_state",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "jev_shadow_decisions",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "land_queue",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "member_accounts",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "membership_delegation_grants",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "membership_delegation_journal",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "membership_delegation_pending",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "membership_invitation_events",
    "key": "invitation_id",
    "action": "delete",
    "match": {},
    "via": {
      "room": {
        "parent": "membership_invitations",
        "parentKey": "id",
        "childKey": "invitation_id",
        "scope": "room_id"
      }
    }
  },
  {
    "table": "membership_invitation_journal",
    "key": "invitation_id",
    "action": "delete",
    "match": {},
    "via": {
      "room": {
        "parent": "membership_invitations",
        "parentKey": "id",
        "childKey": "invitation_id",
        "scope": "room_id"
      }
    }
  },
  {
    "table": "membership_invitations",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "mention_states",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "message_reports",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "messages",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "room_code_drops",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "room_code_checks",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "agent_wants_work",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "messages_backfill_cursor",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "owner_delegate_grants",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "owner_delegate_journal",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "peer_dm_messages",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "from_identity_id",
        "to_identity_id"
      ]
    }
  },
  {
    "table": "pending_channel_updates",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Channel update rows stay with the retained email connection they reference."
  },
  {
    "table": "private_attention_commands",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "private_attention_prefs",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "private_email_commands",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Email import receipts are append-only and stay with the account tombstone."
  },
  {
    "table": "private_email_connections",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Email connections stay so retained import receipts keep their parent."
  },
  {
    "table": "private_email_folders",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Email folder rows stay with the retained connection they reference."
  },
  {
    "table": "private_inbox_commands",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Inbox receipts are append-only and stay with the account tombstone. Account deletion does not rewrite them."
  },
  {
    "table": "private_inbox_drafts",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Inbox drafts stay with the retained source versions they reference."
  },
  {
    "table": "private_inbox_reads",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Inbox read markers stay with the retained sources they reference."
  },
  {
    "table": "private_inbox_sources",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Inbox sources stay so retained receipt rows keep their parent."
  },
  {
    "table": "private_inbox_versions",
    "key": "account_id",
    "action": "retain",
    "match": {
      "account": [
        "account_id"
      ]
    },
    "reason": "Inbox source versions are append-only and stay with the account tombstone. Account deletion does not rewrite them."
  },
  {
    "table": "private_next_action_dismissals",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "private_next_action_suppressions",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "private_reminder_commands",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "private_reminders",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "private_update_commands",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "private_update_marks",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "project_offer_requests",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "project_offers",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "projection_checkpoints",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "public_directory_entries",
    "key": "identity_id",
    "action": "delete",
    "match": {
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "public_receipts",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id",
        "origin_room_id"
      ]
    }
  },
  {
    "table": "public_rooms",
    "key": "slug",
    "action": "delete",
    "match": {
      "room": [
        "slug"
      ]
    }
  },
  {
    "table": "public_work_receipts",
    "key": "identity_id",
    "action": "delete",
    "match": {
      "identity": [
        "identity_id"
      ]
    }
  },
  {
    "table": "public_work_review_requests",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "public_work_reviews",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "public_work_successor_requests",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "public_work_successors",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "public_work_tasks",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "quarantine_thread_splits",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "read_horizons",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "referral_chain_members",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "referral_invite_keys",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "referral_invites",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "referrals",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "request_runs",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "room_access_auto_approve",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "room_attachments",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "room_directory_settings",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "room_mention_settings",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "room_public_settings",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "room_verification_policy",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "saved_messages",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "share_link_codes",
    "key": "link_id",
    "action": "delete",
    "match": {},
    "via": {
      "room": {
        "parent": "share_links",
        "parentKey": "id",
        "childKey": "link_id",
        "scope": "room_id"
      }
    }
  },
  {
    "table": "share_link_joins",
    "key": "link_id",
    "action": "delete",
    "match": {},
    "via": {
      "room": {
        "parent": "share_links",
        "parentKey": "id",
        "childKey": "link_id",
        "scope": "room_id"
      }
    }
  },
  {
    "table": "share_link_access",
    "key": "link_id",
    "action": "delete",
    "match": {},
    "via": {
      "room": {
        "parent": "share_links",
        "parentKey": "id",
        "childKey": "link_id",
        "scope": "room_id"
      }
    }
  },
  {
    "table": "share_links",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "sla_breach_alerts",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "spam_quarantine",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    // plan-squads: room purge deletes the room's squads; identity purge
    // deletes squads owned by the identity. Member ids inside members_json
    // are filtered to active members at fanout time, so a purged member's
    // id lingering in the JSON never resolves.
    "table": "squads",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ],
      "identity": [
        "owner_id"
      ]
    }
  },
  {
    "table": "stitch_identities",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "stitch_links",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "stitch_receipts",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "stitch_revocations",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "stitch_suggestions",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "telegram_live_status",
    "key": "account_id",
    "action": "delete",
    "match": {
      "account": [
        "account_id"
      ]
    }
  },
  {
    "table": "thread_mutes",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "wake_queue",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "wake_queue_commands",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "wake_queue_pause",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "web_fetch_cache_rooms",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "web_fetch_log",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "web_research_log",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "work_claim_config",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  },
  {
    "table": "work_claims",
    "key": "room_id",
    "action": "delete",
    "match": {
      "room": [
        "room_id"
      ]
    }
  }
];

export const PURGE_TABLES = Object.freeze(ROWS.map(row => Object.freeze({
  table: row.table,
  key: row.key,
  action: row.action,
  match: freezeMatch(row.match),
  ...(row.optional ? { optional: true } : {}),
  ...(row.reason ? { reason: row.reason } : {}),
  ...(row.via ? { via: freezeVia(row.via) } : {})
})));

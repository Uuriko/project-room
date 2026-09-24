// A2A pushNotifications predicate (same as build-capabilities emit).
//
// The card is assembled once at module load, and its capabilities are
// covered by the build-time Ed25519 signature, so this flag cannot count
// live host rows. Hosts are per identity. The flag is true when this tip
// mounts wakeable-host registration (POST /api/agent-heartbeats with
// mode "wakeable" and an HTTPS wakeUrl) and outbound webhook delivery.
export function pushNotificationsSupported(capabilities) {
  return capabilities?.["agent-heartbeats"] === true && capabilities?.webhooks === true;
}

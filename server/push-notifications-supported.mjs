// A2A AgentCard.capabilities.pushNotifications (QA2 finding P2-5).
//
// The A2A flag means Task push-notification config:
// tasks/pushNotificationConfig/set and CreateTaskPushNotificationConfig.
// This server does not implement that protocol, so the flag stays false
// even when custom wake URLs and webhook delivery are mounted. Those stay
// on the agent-heartbeats and webhooks capability families. Declaring the
// A2A flag while the methods are missing is false advertising to the A2A
// TCK. The argument is accepted so callers can pass the capability map
// without a second predicate.
export function pushNotificationsSupported(_capabilities) {
  return false;
}

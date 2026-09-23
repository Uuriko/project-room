# Conversation layout implementation

This implements the layout portion of the finalized design review: conversation-first chrome, predictable action locations and progressive disclosure. It preserves existing flows and authority checks by moving the same controls, not duplicating their state.

- A room has one content header. The repeated brand/account bar is removed from that view; healthy connection status remains accessible and returns visibly for errors.
- Desktop account destinations live in the sidebar. At phone/tablet widths, Inbox/Rooms stay one tap away in a consistent bottom navigation across account views. Guests do not see account destinations they cannot use.
- Search, Catch up, room settings and Account remain in the room header. Room and channel names remain legible at narrow widths. Account contains identity, security, sign-out and connection refresh.
- The room name opens its overview. A single Invite disclosure groups people, agent connection and advanced agent invitations. Find an action stays available in the sidebar and through the existing keyboard shortcut.
- Plain desktop messages have a floating hover/focus action row. Reply counts, linked work, requests and existing reactions remain visible. Touch keeps reachable actions with no overlapping target tricks.
- The composer has a full-width writing area, labelled New work and Send. Existing audience/private-recipient controls and options remain available.
- Work forms use Request, Done when and Assignee; label spacing and disclosure affordances are consistent. Policy-required review fields remain visible.
- Empty count outlines, duplicate catch-up chevrons and member-avatar overlap are removed.

Regression checks follow the new locations through shared browser helpers, without weakening authorization, retry, draft or result assertions. Dedicated layout journeys cover 320/390/1440px, account and room-key sessions, navigation round trips, menu keyboard focus, unchanged drafts and 200% text reflow. Screenshots use disposable synthetic data, not customer conversations.

The broader research plan's cross-room attention, new badge/read-state model, separate DM destination, push delivery and optional detail panes are separate work. This layout does not advertise those as implemented, alter notification semantics, or merge Claude's unverified design checkpoint wholesale. No deployment is part of this checkpoint.

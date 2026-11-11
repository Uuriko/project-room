Native land queue and MCP release checks
=======================================

The actual normalized room fixture fails before the land patch at the forbidden whole-room read. After source 4e8912637, 44 targeted tests pass including atomic interrupted receipt save, same-request retry, cold reopen, and recovery audit. Native rooms retain the existing queue table without resurrecting a legacy work-claim mirror. Existing legacy queue tests remain intact.

Source 2f7b3689a updates test observations to addressed messages, authority sequence, a transaction-bound full audit snapshot, and the attachment staging table. The 71-test slice passes. The separate MCP-auth journey still stops at the unported bond path; that is not qualified by this receipt. No production deployment occurred.

Follow-up composition cd1659797 integrates the bond port: all 17 tests across bonds, current bonds, room MCP auth, and current land queue pass. This clears the earlier bond-specific block in the saved-message auth journey.

# Cross-lane clock policy properties

Task 220 exercises millisecond boundaries around upstream resolution/expiry and downstream validity. Every native terminal outcome is checked: only `expired` may be carried after upstream expiry. Invalid/reversed times, private fields and unknown data fail; reordered inputs are deterministic and outputs immutable.

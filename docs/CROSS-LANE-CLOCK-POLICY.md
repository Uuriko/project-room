# Cross-lane clock policy

`buildCrossLaneClockPolicy` validates downstream observation against explicit upstream resolution/expiry and downstream validity timestamps without reading the wall clock. Non-expired evidence cannot outlive its upstream expiry; an explicitly expired terminal may be carried after expiry. The immutable result rejects reversed windows, invalid times/outcomes, unknown fields, PII and content.

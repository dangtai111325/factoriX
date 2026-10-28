# FactoriX commercial gate

Scored against section 12.2 of the architecture review. This build is the running appliance. It is not Commercial GA and it is not RELEASE-READY.

| Condition | Result | Evidence |
|---|---|---|
| An edge cannot write a signal it does not own | Pass for a foreign resource | Integration test quarantines a resource id that is not the bound signal. Credential must be ENROLLED, the revision must exist, and the binding join must match. |
| A bad point does not erase the last good value, and the socket waits for commit | Pass in code | Latest update is one conditional upsert. Last good is kept when quality is not GOOD. The websocket fan-out runs after commit and only for signals in the caller's tenant. |
| An older point cannot move latest backward | Pass | The same integration flow replays an older timestamp and the latest value stays on the newer point. |
| The edge keeps the last good config when Center is down | Implemented, duration not run | The edge stores a checksummed snapshot and loads it when the config request fails. A 30–60 minute outage was not executed. |
| Config acknowledgement is not a healthy data connection | Pass in code | Acknowledgement sets the connection to UNKNOWN. HEALTHY is set only after a good observation for that connection. |
| Commissioning does not mark stages that did not run | Pass in code | Stages start as NOT_TESTED. A Modbus session alone does not mark the read stage passed, and does not read a stand-in register. |
| Retention stays inside its site or resource | Pass for the predicate | Preview and delete add the scope column. An unknown scope matches nothing. A legal hold on the tenant blocks the purge. |
| MQTT collection stays connected | Pass in code | The collector subscribes and keeps the client, including wildcard topics. A live broker was not used. |
| OPC UA subscribe uses monitored items | Pass in code | Subscribe mode creates a subscription. It does not fall back to a poll and call it a subscription. A live server was not used. |
| Published formulas and output groups run | Pass in code | A published formula is evaluated when an input observation commits. A published output group enqueues a delivery row. Preview is still only a preview. |
| Backup, restore, and CI | Partial | One dump was restored into `factorix_restore_trial` inside the appliance and that database was dropped. The live `factorix` database and the `factorix-data` volume were left in place. The restore contained 1 administrator. `.github/workflows/ci.yml` is in the tree and was not pushed. Unit tests: 31 passed. API flow: passed. |
| 24 hour soak | Blocked | The soak was not run. |
| OT lab in datasource_guide.md | Blocked | The guide names `192.168.2.108`. This pass did not open that host. |

Local checks this pass: `pytest apps/center/tests/unit` (31 passed) and `pytest apps/center/tests/integration/test_api_flow.py` (passed, including the foreign-resource quarantine).

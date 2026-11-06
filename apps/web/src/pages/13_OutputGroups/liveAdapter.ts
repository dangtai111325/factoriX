// Adapter over the shared live-stream module (apps/web/src/lib/liveStream.ts, owned by W1b).
// The Data Model screens import ONLY from this file so the transport can be swapped in one place.
// When the stream is not 'open', consumers fall back to 5 s polling of /preview, /latest, /events
// and /observations/latest.
export { subscribeModels, subscribeSignals, useStreamStatus } from '../../lib/liveStream';
export type { LatestMsg, ModelBodyMsg, ModelEventMsg, StreamStatus } from '../../lib/liveStream';

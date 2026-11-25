/**
 * Deep link from a signal to the Historian explorer with that series pre-selected (R1-12).
 * `source_id` is the query parameter HistorianExplorerPage reads (see v6_contracts.md Q4).
 */
export function historianLinkForSignal(signalId: string, range = '15m'): string {
  const params = new URLSearchParams({ source_id: signalId, kind: 'signal', range });
  return `/historian/historian?${params.toString()}`;
}

/**
 * Net book value at the moment of disposal, in paise.
 *
 * Disposal records gainLoss = disposalProceeds - nbvAtDisposal and then zeroes
 * the asset's nbvPaise, so the additions/disposals register cannot read the
 * (now-zero) nbvPaise. It reconstructs the original NBV by inverting that
 * relation: nbvAtDisposal = disposalProceeds - gainLoss. (A gain means proceeds
 * exceeded NBV, a loss means NBV exceeded proceeds.)
 */
export function nbvAtDisposalPaise(
  disposalProceedsPaise: number,
  gainLossOnDisposalPaise: number,
): number {
  return disposalProceedsPaise - gainLossOnDisposalPaise;
}

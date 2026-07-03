export function ecpm(input: {
  billingEvent: 'cpm' | 'cpc';
  bid: number;
  predictedCtr: number;
}): number {
  if (input.billingEvent === 'cpm') return input.bid;
  return input.predictedCtr * input.bid * 1000;
}

export function score(ecpmValue: number, relevance: number): number {
  return ecpmValue * (0.85 + 0.15 * relevance);
}

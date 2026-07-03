export interface ComponentInput {
  id: string;
  name: string;
  calcMode: 'percent_of_ctc' | 'percent_of_component' | 'fixed' | 'balancing';
  value?: number;
  referenceComponentId?: string;
  includedInCtc: boolean;
  isBasicComponent: boolean;
  sortOrder: number;
}

export interface ComponentOverride {
  componentId: string;
  calcMode?: 'fixed' | 'percent_of_ctc' | 'percent_of_component';
  value?: number;
}

export interface CalculatedComponent {
  componentId: string;
  name: string;
  calculatedAmount: number;
  isBasicComponent: boolean;
  includedInCtc: boolean;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function detectCircularReference(components: ComponentInput[]): boolean {
  const idSet = new Set(components.map((c) => c.id));
  const visited = new Set<string>();
  const inStack = new Set<string>();

  const dfs = (id: string): boolean => {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    const comp = components.find((c) => c.id === id);
    if (
      comp &&
      comp.calcMode === 'percent_of_component' &&
      comp.referenceComponentId
    ) {
      if (idSet.has(comp.referenceComponentId)) {
        if (dfs(comp.referenceComponentId)) return true;
      }
    }
    inStack.delete(id);
    return false;
  };

  for (const comp of components) {
    if (!visited.has(comp.id)) {
      if (dfs(comp.id)) return true;
    }
  }
  return false;
}

function topologicalSort(components: ComponentInput[]): ComponentInput[] {
  const idSet = new Set(components.map((c) => c.id));
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const comp of components) {
    if (!inDegree.has(comp.id)) inDegree.set(comp.id, 0);
    if (!adj.has(comp.id)) adj.set(comp.id, []);
  }

  for (const comp of components) {
    if (comp.calcMode === 'percent_of_component' && comp.referenceComponentId) {
      if (idSet.has(comp.referenceComponentId)) {
        adj.get(comp.referenceComponentId).push(comp.id);
        inDegree.set(comp.id, (inDegree.get(comp.id) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: ComponentInput[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const comp = components.find((c) => c.id === current);
    if (comp) sorted.push(comp);
    for (const neighbor of adj.get(current) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

export function calculateComponents(
  ctcAmount: number,
  components: ComponentInput[],
  overrides?: ComponentOverride[],
): { breakdown: CalculatedComponent[]; baseSalaryValue: number } {
  const sorted = [...components].sort((a, b) => a.sortOrder - b.sortOrder);

  const working = sorted.map((comp) => ({ ...comp }));

  if (overrides && overrides.length > 0) {
    for (const override of overrides) {
      const idx = working.findIndex((c) => c.id === override.componentId);
      if (idx !== -1) {
        if (override.calcMode !== undefined) {
          working[idx].calcMode =
            override.calcMode as ComponentInput['calcMode'];
        }
        if (override.value !== undefined) {
          working[idx].value = override.value;
        }
      }
    }
  }

  if (detectCircularReference(working)) {
    throw new Error('Circular component reference detected');
  }

  const calculated = new Map<string, number>();
  const results: CalculatedComponent[] = [];

  const nonBalancing = working.filter((c) => c.calcMode !== 'balancing');
  const balancingComp = working.find((c) => c.calcMode === 'balancing');

  const topoOrder = topologicalSort(nonBalancing);

  for (const comp of topoOrder) {
    let amount = 0;
    switch (comp.calcMode) {
      case 'percent_of_ctc':
        amount = roundCurrency((ctcAmount * (comp.value ?? 0)) / 100);
        break;
      case 'percent_of_component': {
        const refAmount = calculated.get(comp.referenceComponentId) ?? 0;
        amount = roundCurrency((refAmount * (comp.value ?? 0)) / 100);
        break;
      }
      case 'fixed':
        amount = comp.value ?? 0;
        break;
    }
    calculated.set(comp.id, amount);
    results.push({
      componentId: comp.id,
      name: comp.name,
      calculatedAmount: amount,
      isBasicComponent: comp.isBasicComponent,
      includedInCtc: comp.includedInCtc,
    });
  }

  if (balancingComp) {
    const sumIncluded = results
      .filter((r) => r.includedInCtc)
      .reduce((sum, r) => sum + r.calculatedAmount, 0);
    let balance = roundCurrency(ctcAmount - sumIncluded);
    if (balance < 0) balance = 0;
    calculated.set(balancingComp.id, balance);
    results.push({
      componentId: balancingComp.id,
      name: balancingComp.name,
      calculatedAmount: balance,
      isBasicComponent: balancingComp.isBasicComponent,
      includedInCtc: balancingComp.includedInCtc,
    });
  }

  results.sort((a, b) => {
    const idxA = working.findIndex((c) => c.id === a.componentId);
    const idxB = working.findIndex((c) => c.id === b.componentId);
    return idxA - idxB;
  });

  const basicEntry = results.find((r) => r.isBasicComponent);
  const baseSalaryValue = basicEntry ? basicEntry.calculatedAmount : ctcAmount;

  return { breakdown: results, baseSalaryValue };
}

export function validateComponentDefinitions(components: ComponentInput[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  const basicCount = components.filter((c) => c.isBasicComponent).length;
  if (basicCount !== 1) {
    errors.push('Exactly one component must have isBasicComponent: true');
  }

  const balancingCount = components.filter(
    (c) => c.calcMode === 'balancing',
  ).length;
  if (balancingCount > 1) {
    errors.push('At most one component can have calcMode balancing');
  }

  const idSet = new Set(components.map((c) => c.id));
  for (const comp of components) {
    if (comp.calcMode === 'percent_of_component' && comp.referenceComponentId) {
      if (!idSet.has(comp.referenceComponentId)) {
        errors.push(
          `Component ${comp.name} references non-existent component ${comp.referenceComponentId}`,
        );
      }
    }
  }

  if (detectCircularReference(components)) {
    errors.push('Circular component reference detected');
  }

  const sortOrderSet = new Set(components.map((c) => c.sortOrder));
  if (sortOrderSet.size !== components.length) {
    // Duplicate sortOrders — not an error per spec, but noted
  }

  return { valid: errors.length === 0, errors };
}

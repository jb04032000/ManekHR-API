import {
  calculateComponents,
  validateComponentDefinitions,
  ComponentInput,
} from './component-calculator';

const simpleTemplate: ComponentInput[] = [
  {
    id: 'simple_basic',
    name: 'Basic',
    calcMode: 'percent_of_ctc',
    value: 100,
    includedInCtc: true,
    isBasicComponent: true,
    sortOrder: 0,
  },
];

const standardIndiaTemplate: ComponentInput[] = [
  {
    id: 'std_basic',
    name: 'Basic',
    calcMode: 'percent_of_ctc',
    value: 40,
    includedInCtc: true,
    isBasicComponent: true,
    sortOrder: 0,
  },
  {
    id: 'std_hra',
    name: 'HRA',
    calcMode: 'percent_of_component',
    value: 50,
    referenceComponentId: 'std_basic',
    includedInCtc: true,
    isBasicComponent: false,
    sortOrder: 1,
  },
  {
    id: 'std_da',
    name: 'DA',
    calcMode: 'percent_of_ctc',
    value: 15,
    includedInCtc: true,
    isBasicComponent: false,
    sortOrder: 2,
  },
  {
    id: 'std_special',
    name: 'Special Allowance',
    calcMode: 'balancing',
    includedInCtc: true,
    isBasicComponent: false,
    sortOrder: 3,
  },
];

const ctcWithPfTemplate: ComponentInput[] = [
  {
    id: 'pf_basic',
    name: 'Basic',
    calcMode: 'percent_of_ctc',
    value: 40,
    includedInCtc: true,
    isBasicComponent: true,
    sortOrder: 0,
  },
  {
    id: 'pf_hra',
    name: 'HRA',
    calcMode: 'percent_of_component',
    value: 50,
    referenceComponentId: 'pf_basic',
    includedInCtc: true,
    isBasicComponent: false,
    sortOrder: 1,
  },
  {
    id: 'pf_special',
    name: 'Special Allowance',
    calcMode: 'balancing',
    includedInCtc: true,
    isBasicComponent: false,
    sortOrder: 2,
  },
  {
    id: 'pf_epf',
    name: 'Employer PF',
    calcMode: 'percent_of_component',
    value: 12,
    referenceComponentId: 'pf_basic',
    includedInCtc: false,
    isBasicComponent: false,
    sortOrder: 3,
  },
];

describe('calculateComponents', () => {
  test('Simple template — 100% Basic', () => {
    const result = calculateComponents(50000, simpleTemplate);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0].calculatedAmount).toBe(50000);
    expect(result.breakdown[0].isBasicComponent).toBe(true);
    expect(result.baseSalaryValue).toBe(50000);
  });

  test('Standard India template — Basic 40% + HRA 50% of Basic + DA 15% + Special balancing', () => {
    const result = calculateComponents(100000, standardIndiaTemplate);
    expect(result.breakdown).toHaveLength(4);

    const basic = result.breakdown.find((c) => c.componentId === 'std_basic');
    const hra = result.breakdown.find((c) => c.componentId === 'std_hra');
    const da = result.breakdown.find((c) => c.componentId === 'std_da');
    const special = result.breakdown.find(
      (c) => c.componentId === 'std_special',
    );

    expect(basic.calculatedAmount).toBe(40000);
    expect(hra.calculatedAmount).toBe(20000);
    expect(da.calculatedAmount).toBe(15000);
    expect(special.calculatedAmount).toBe(25000);
    expect(result.baseSalaryValue).toBe(40000);

    const includedSum = result.breakdown
      .filter((c) => c.includedInCtc)
      .reduce((sum, c) => sum + c.calculatedAmount, 0);
    expect(includedSum).toBe(100000);
  });

  test('CTC with employer PF — component outside CTC', () => {
    const result = calculateComponents(100000, ctcWithPfTemplate);

    const basic = result.breakdown.find((c) => c.componentId === 'pf_basic');
    const hra = result.breakdown.find((c) => c.componentId === 'pf_hra');
    const special = result.breakdown.find(
      (c) => c.componentId === 'pf_special',
    );
    const epf = result.breakdown.find((c) => c.componentId === 'pf_epf');

    expect(basic.calculatedAmount).toBe(40000);
    expect(hra.calculatedAmount).toBe(20000);
    expect(special.calculatedAmount).toBe(40000);
    expect(epf.calculatedAmount).toBe(4800);
    expect(result.baseSalaryValue).toBe(40000);

    const includedSum = result.breakdown
      .filter((c) => c.includedInCtc)
      .reduce((sum, c) => sum + c.calculatedAmount, 0);
    expect(includedSum).toBe(100000);
  });

  test('Fixed amount component', () => {
    const components: ComponentInput[] = [
      {
        id: 'basic',
        name: 'Basic',
        calcMode: 'percent_of_ctc',
        value: 40,
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 0,
      },
      {
        id: 'conveyance',
        name: 'Conveyance',
        calcMode: 'fixed',
        value: 1600,
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 1,
      },
      {
        id: 'special',
        name: 'Special Allowance',
        calcMode: 'balancing',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 2,
      },
    ];

    const result = calculateComponents(50000, components);

    const basic = result.breakdown.find((c) => c.componentId === 'basic');
    const conveyance = result.breakdown.find(
      (c) => c.componentId === 'conveyance',
    );
    const special = result.breakdown.find((c) => c.componentId === 'special');

    expect(basic.calculatedAmount).toBe(20000);
    expect(conveyance.calculatedAmount).toBe(1600);
    expect(special.calculatedAmount).toBe(28400);
    expect(result.baseSalaryValue).toBe(20000);
  });

  test('Override — employee has fixed HRA override', () => {
    const overrides = [
      { componentId: 'std_hra', calcMode: 'fixed' as const, value: 15000 },
    ];

    const result = calculateComponents(
      100000,
      standardIndiaTemplate,
      overrides,
    );

    const basic = result.breakdown.find((c) => c.componentId === 'std_basic');
    const hra = result.breakdown.find((c) => c.componentId === 'std_hra');
    const da = result.breakdown.find((c) => c.componentId === 'std_da');
    const special = result.breakdown.find(
      (c) => c.componentId === 'std_special',
    );

    expect(basic.calculatedAmount).toBe(40000);
    expect(hra.calculatedAmount).toBe(15000);
    expect(da.calculatedAmount).toBe(15000);
    expect(special.calculatedAmount).toBe(30000);
    expect(result.baseSalaryValue).toBe(40000);
  });

  test('Override — changes percent_of_ctc value', () => {
    const overrides = [
      {
        componentId: 'std_basic',
        calcMode: 'percent_of_ctc' as const,
        value: 50,
      },
    ];

    const result = calculateComponents(
      100000,
      standardIndiaTemplate,
      overrides,
    );

    const basic = result.breakdown.find((c) => c.componentId === 'std_basic');
    const hra = result.breakdown.find((c) => c.componentId === 'std_hra');
    const da = result.breakdown.find((c) => c.componentId === 'std_da');
    const special = result.breakdown.find(
      (c) => c.componentId === 'std_special',
    );

    expect(basic.calculatedAmount).toBe(50000);
    expect(hra.calculatedAmount).toBe(25000);
    expect(da.calculatedAmount).toBe(15000);
    expect(special.calculatedAmount).toBe(10000);
    expect(result.baseSalaryValue).toBe(50000);
  });

  test('Rounding — CTC that creates fractional components', () => {
    const result = calculateComponents(33333, standardIndiaTemplate);

    const basic = result.breakdown.find((c) => c.componentId === 'std_basic');
    const hra = result.breakdown.find((c) => c.componentId === 'std_hra');
    const da = result.breakdown.find((c) => c.componentId === 'std_da');
    const special = result.breakdown.find(
      (c) => c.componentId === 'std_special',
    );

    expect(basic.calculatedAmount).toBe(13333.2);
    expect(hra.calculatedAmount).toBe(6666.6);
    expect(da.calculatedAmount).toBe(4999.95);

    const includedSum = result.breakdown
      .filter((c) => c.includedInCtc)
      .reduce((sum, c) => sum + c.calculatedAmount, 0);
    expect(includedSum).toBe(33333);

    for (const comp of result.breakdown) {
      expect(comp.calculatedAmount * 100).toBe(
        Math.round(comp.calculatedAmount * 100),
      );
    }
  });

  test('Zero CTC', () => {
    const result = calculateComponents(0, standardIndiaTemplate);

    expect(result.breakdown.every((c) => c.calculatedAmount === 0)).toBe(true);
    expect(result.baseSalaryValue).toBe(0);
  });

  test('Balancing goes negative', () => {
    const components: ComponentInput[] = [
      {
        id: 'basic',
        name: 'Basic',
        calcMode: 'fixed',
        value: 8000,
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 0,
      },
      {
        id: 'bonus',
        name: 'Bonus',
        calcMode: 'fixed',
        value: 5000,
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 1,
      },
      {
        id: 'balancing',
        name: 'Balancing',
        calcMode: 'balancing',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 2,
      },
    ];

    const result = calculateComponents(10000, components);

    const basic = result.breakdown.find((c) => c.componentId === 'basic');
    const balancing = result.breakdown.find(
      (c) => c.componentId === 'balancing',
    );

    expect(basic.calculatedAmount).toBe(8000);
    expect(balancing.calculatedAmount).toBe(0);
    expect(result.baseSalaryValue).toBe(8000);
  });

  test('Circular reference detection', () => {
    const components: ComponentInput[] = [
      {
        id: 'a',
        name: 'A',
        calcMode: 'percent_of_component',
        value: 50,
        referenceComponentId: 'b',
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 0,
      },
      {
        id: 'b',
        name: 'B',
        calcMode: 'percent_of_component',
        value: 50,
        referenceComponentId: 'a',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 1,
      },
    ];

    expect(() => calculateComponents(100000, components)).toThrow(
      'Circular component reference detected',
    );
  });

  test('No isBasicComponent — defaults to ctcAmount', () => {
    const components: ComponentInput[] = [
      {
        id: 'flat',
        name: 'Flat Salary',
        calcMode: 'percent_of_ctc',
        value: 100,
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 0,
      },
    ];

    const result = calculateComponents(50000, components);
    expect(result.baseSalaryValue).toBe(50000);
  });

  test('percent_of_component chain — A → B → C', () => {
    const components: ComponentInput[] = [
      {
        id: 'chain_basic',
        name: 'Basic',
        calcMode: 'percent_of_ctc',
        value: 50,
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 0,
      },
      {
        id: 'chain_hra',
        name: 'HRA',
        calcMode: 'percent_of_component',
        value: 50,
        referenceComponentId: 'chain_basic',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 1,
      },
      {
        id: 'chain_metro',
        name: 'Metro Allowance',
        calcMode: 'percent_of_component',
        value: 20,
        referenceComponentId: 'chain_hra',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 2,
      },
      {
        id: 'chain_special',
        name: 'Special Allowance',
        calcMode: 'balancing',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 3,
      },
    ];

    const result = calculateComponents(100000, components);

    const basic = result.breakdown.find((c) => c.componentId === 'chain_basic');
    const hra = result.breakdown.find((c) => c.componentId === 'chain_hra');
    const metro = result.breakdown.find((c) => c.componentId === 'chain_metro');
    const special = result.breakdown.find(
      (c) => c.componentId === 'chain_special',
    );

    expect(basic.calculatedAmount).toBe(50000);
    expect(hra.calculatedAmount).toBe(25000);
    expect(metro.calculatedAmount).toBe(5000);
    expect(special.calculatedAmount).toBe(20000);
    expect(result.baseSalaryValue).toBe(50000);

    const includedSum = result.breakdown
      .filter((c) => c.includedInCtc)
      .reduce((sum, c) => sum + c.calculatedAmount, 0);
    expect(includedSum).toBe(100000);
  });
});

describe('validateComponentDefinitions', () => {
  test('Valid standard template', () => {
    const result = validateComponentDefinitions(standardIndiaTemplate);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('No isBasicComponent', () => {
    const components: ComponentInput[] = [
      {
        id: 'flat',
        name: 'Flat',
        calcMode: 'percent_of_ctc',
        value: 100,
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 0,
      },
    ];

    const result = validateComponentDefinitions(components);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Exactly one component must have isBasicComponent: true',
    );
  });

  test('Multiple isBasicComponent', () => {
    const components: ComponentInput[] = [
      {
        id: 'a',
        name: 'A',
        calcMode: 'percent_of_ctc',
        value: 50,
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 0,
      },
      {
        id: 'b',
        name: 'B',
        calcMode: 'percent_of_ctc',
        value: 50,
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 1,
      },
    ];

    const result = validateComponentDefinitions(components);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Exactly one component must have isBasicComponent: true',
    );
  });

  test('Multiple balancing components', () => {
    const components: ComponentInput[] = [
      {
        id: 'a',
        name: 'A',
        calcMode: 'balancing',
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 0,
      },
      {
        id: 'b',
        name: 'B',
        calcMode: 'balancing',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 1,
      },
    ];

    const result = validateComponentDefinitions(components);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'At most one component can have calcMode balancing',
    );
  });

  test('Dangling referenceComponentId', () => {
    const components: ComponentInput[] = [
      {
        id: 'a',
        name: 'A',
        calcMode: 'percent_of_ctc',
        value: 50,
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 0,
      },
      {
        id: 'b',
        name: 'B',
        calcMode: 'percent_of_component',
        value: 50,
        referenceComponentId: 'nonexistent',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 1,
      },
    ];

    const result = validateComponentDefinitions(components);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes('references non-existent component'),
      ),
    ).toBe(true);
  });

  test('Circular reference', () => {
    const components: ComponentInput[] = [
      {
        id: 'a',
        name: 'A',
        calcMode: 'percent_of_component',
        value: 50,
        referenceComponentId: 'b',
        includedInCtc: true,
        isBasicComponent: true,
        sortOrder: 0,
      },
      {
        id: 'b',
        name: 'B',
        calcMode: 'percent_of_component',
        value: 50,
        referenceComponentId: 'a',
        includedInCtc: true,
        isBasicComponent: false,
        sortOrder: 1,
      },
    ];

    const result = validateComponentDefinitions(components);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Circular component reference detected');
  });
});

export type BuiltInComponentDef = {
  id: string;
  name: string;
  calcMode: 'percent_of_ctc' | 'percent_of_component' | 'fixed' | 'balancing';
  value?: number;
  referenceComponentId?: string;
  includedInCtc?: boolean;
  isBasicComponent?: boolean;
  isTaxable?: boolean;
  sortOrder: number;
};

export type BuiltInTemplate = {
  key: string;
  name: string;
  components: BuiltInComponentDef[];
};

export const BUILT_IN_TEMPLATES: Record<string, BuiltInTemplate> = {
  simple: {
    key: 'simple',
    name: 'Simple',
    components: [
      {
        id: 'simple_basic',
        name: 'Basic',
        calcMode: 'percent_of_ctc',
        value: 100,
        includedInCtc: true,
        isBasicComponent: true,
        isTaxable: true,
        sortOrder: 0,
      },
    ],
  },
  standard_india: {
    key: 'standard_india',
    name: 'Standard India',
    components: [
      {
        id: 'std_basic',
        name: 'Basic',
        calcMode: 'percent_of_ctc',
        value: 40,
        includedInCtc: true,
        isBasicComponent: true,
        isTaxable: true,
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
        isTaxable: false,
        sortOrder: 1,
      },
      {
        id: 'std_da',
        name: 'DA',
        calcMode: 'percent_of_ctc',
        value: 15,
        includedInCtc: true,
        isBasicComponent: false,
        isTaxable: true,
        sortOrder: 2,
      },
      {
        id: 'std_special',
        name: 'Special Allowance',
        calcMode: 'balancing',
        includedInCtc: true,
        isBasicComponent: false,
        isTaxable: true,
        sortOrder: 3,
      },
    ],
  },
  ctc_with_pf: {
    key: 'ctc_with_pf',
    name: 'CTC with Employer PF',
    components: [
      {
        id: 'pf_basic',
        name: 'Basic',
        calcMode: 'percent_of_ctc',
        value: 40,
        includedInCtc: true,
        isBasicComponent: true,
        isTaxable: true,
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
        isTaxable: false,
        sortOrder: 1,
      },
      {
        id: 'pf_special',
        name: 'Special Allowance',
        calcMode: 'balancing',
        includedInCtc: true,
        isBasicComponent: false,
        isTaxable: true,
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
        isTaxable: false,
        sortOrder: 3,
      },
    ],
  },
};

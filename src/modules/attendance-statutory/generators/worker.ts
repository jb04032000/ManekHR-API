/**
 * PERF-04 worker_threads entry point (H6-CONTEXT D-09/D-10/D-11).
 *
 * CPU-bound PDF/XLSX generation is offloaded from the main NestJS event loop
 * into this worker. The main thread fetches rows + meta (Mongoose queries stay
 * on main per D-11), then posts { template, rows, meta } as workerData. This
 * worker dispatches to one of the five pure generator functions and returns
 * the Buffer to the parent via postMessage with a transferable ArrayBuffer
 * (avoids copying large PDF buffers across the thread boundary).
 *
 * DO NOT import Mongoose, NestJS, or anything requiring DI here — workerData
 * must be structurally cloneable plain objects only.
 */

import { workerData, parentPort } from 'worker_threads';
import { generateMhFormT } from './mh-form-t.generator';
import { generateForm25Ot } from './form-25-ot.generator';
import { generateLopAudit } from './lop-audit.generator';
import { generatePfEsiWage } from './pf-esi-wage.generator';
import { generateGjFormD } from './gj-form-d.generator';

interface WorkerInput {
  template: 'mh_form_t' | 'form_25_ot' | 'lop_audit' | 'pf_esi_wage' | 'gj_form_d';
  rows: unknown;
  meta: unknown;
}

if (!parentPort) {
  throw new Error('statutory-generator worker must be spawned as a worker_threads child');
}

const { template, rows, meta } = workerData as WorkerInput;

let buffer: Buffer;
switch (template) {
  case 'mh_form_t':
    buffer = generateMhFormT(rows as Parameters<typeof generateMhFormT>[0], meta as Parameters<typeof generateMhFormT>[1]);
    break;
  case 'form_25_ot':
    buffer = generateForm25Ot(rows as Parameters<typeof generateForm25Ot>[0], meta as Parameters<typeof generateForm25Ot>[1]);
    break;
  case 'lop_audit':
    buffer = generateLopAudit(rows as Parameters<typeof generateLopAudit>[0], meta as Parameters<typeof generateLopAudit>[1]);
    break;
  case 'pf_esi_wage':
    buffer = generatePfEsiWage(rows as Parameters<typeof generatePfEsiWage>[0], meta as Parameters<typeof generatePfEsiWage>[1]);
    break;
  case 'gj_form_d':
    buffer = generateGjFormD(rows as Parameters<typeof generateGjFormD>[0], meta as Parameters<typeof generateGjFormD>[1]);
    break;
  default: {
    const exhaustive: never = template;
    throw new Error(`Unknown statutory template in worker: ${String(exhaustive)}`);
  }
}

// Transfer the underlying ArrayBuffer so the large PDF/XLSX buffer is moved
// (not copied) across the thread boundary (H6-RESEARCH §Pattern 3).
parentPort.postMessage(buffer, [buffer.buffer]);

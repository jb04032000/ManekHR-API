// Vitest global setup — imported before any test file runs.
// reflect-metadata MUST be loaded before NestJS SchemaFactory.createForClass
// is called, so that TypeScript decorator metadata is available at runtime.
// Without this import, @Prop() decorators without explicit { type } options
// will throw "Cannot determine a type for field X" under the SWC transform.
import 'reflect-metadata';

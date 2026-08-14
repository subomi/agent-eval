/**
 * Contract for the LLM-judge layer. Phase 2 implements this on
 * `@earendil-works/pi-ai` (structured JSON output, disk cache keyed by
 * prompt+model, bounded concurrency). Metrics only ever see this interface.
 */

/** A raw JSON Schema object used to constrain provider output. */
export type JsonSchemaObject = Record<string, unknown>;

/** Anything with a zod-style `parse` method (zod schemas satisfy this). */
export interface SchemaLike<T> {
  parse(input: unknown): T;
}

export interface JudgeInput<T> {
  /** Full prompt text, including any rendered session excerpt. */
  prompt: string;
  /**
   * Validates/parses the model's JSON output into `T`. The judge must run
   * this before returning; it throws on malformed output.
   */
  schema: SchemaLike<T>;
  /**
   * Optional raw JSON Schema forwarded to the provider for constrained
   * decoding. When omitted, implementations must instruct the model to emit
   * JSON via the prompt and rely on `schema` for validation.
   */
  jsonSchema?: JsonSchemaObject;
}

export interface Judge {
  /** Ask the judge model for a structured response conforming to `schema`. */
  evaluate<T>(input: JudgeInput<T>): Promise<T>;
}

export interface JudgeConfig {
  /**
   * Model identifier (pi-ai model string). When omitted, implementations
   * pick a default from the first provider with an API key in env.
   */
  model?: string;
  /** Maximum concurrent judge calls. */
  concurrency?: number;
  /** Enable the on-disk response cache. Default true. */
  cache?: boolean;
  temperature?: number;
}

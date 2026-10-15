/** The shape `scripts/sync-schema.mjs` writes: a compact JSON Schema per field. */
export interface FieldSchema {
  readonly type?: string;
  readonly format?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly pattern?: string;
  readonly deprecated?: boolean;
  readonly default?: unknown;
  readonly description?: string;
  readonly items?: FieldSchema;
  readonly oneOf?: readonly FieldSchema[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, FieldSchema>>;
}

export interface RouterSchema {
  readonly endpoint: string;
  readonly required: readonly string[];
  readonly fields: Readonly<Record<string, FieldSchema>>;
}

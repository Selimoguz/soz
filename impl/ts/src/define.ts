// define.ts — Declare an operation and its implementation in one place, with TypeScript checking
// both: the arguments `run` receives are typed from the parameters, `key` may only name parameters,
// and what `run` returns must fit the declared result. No schema library: `t` is enough for soz types.

import { Rational, type Json, type HostValue, nameFold } from "./exact.ts";
import { type Type, type Operation, type Operations, LABEL } from "./checker.ts";
import type { Implementation, Implementations } from "./run.ts";

/** A soz type (SPEC 6), carrying the TypeScript type of its values and whether it is optional. */
export class Schema<T, Optional extends boolean = false> {
  readonly type: Type;
  readonly required: boolean;
  readonly allowModel: boolean;
  readonly allowStep: boolean;
  declare readonly _value: T;            // type-level only
  declare readonly _optional: Optional;  // type-level only
  constructor(type: Type, required = true, allowModel = false, fromStep = false) {
    this.type = type; this.required = required; this.allowModel = allowModel; this.allowStep = fromStep;
  }
  /** As a parameter: it may be left out. */
  optional(): Schema<T, true> { return new Schema<T, true>(this.type, false, this.allowModel, this.allowStep); }
  /** As a parameter: the model may fill it with its own text (a note, a reason). */
  modelAllowed(): Schema<T, Optional> { return new Schema<T, Optional>(this.type, this.required, true, this.allowStep); }
  /** As a parameter: it may take what an earlier step returns (a new record's id) without a second
   * approval once it is known (SPEC 6, 10.3). Not for a value that decides what is approved. */
  fromStep(): Schema<T, Optional> { return new Schema<T, Optional>(this.type, this.required, this.allowModel, true); }
}

type AnySchema = Schema<any, boolean>;
type Fields = { [name: string]: AnySchema };

export const t = {
  text: () => new Schema<string>("text"),
  /** Exact numbers: values are Rational. */
  number: () => new Schema<Rational>("number"),
  bool: () => new Schema<boolean>("bool"),
  any: () => new Schema<Json>("any"),
  list: <T>(item: Schema<T, boolean>) => new Schema<T[]>({ kind: "list", item: item.type }),
  record: <F extends Fields>(fields: F) => new Schema<{ [K in keyof F]: F[K]["_value"] }>({
    kind: "record",
    fields: Object.entries(fields).map(([k, s]) => [nameFold(k), s.type] as [string, Type]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  }),
  /** Text that takes only these values (SPEC 6 enum; plans may compare with them, SPEC 5.1). */
  enum: <const V extends string[]>(...values: V) => new Schema<V[number]>({ kind: "enum", base: "text", values }),
};

type RequiredKeys<P extends Fields> = { [K in keyof P]: P[K]["_optional"] extends true ? never : K }[keyof P];
type OptionalKeys<P extends Fields> = { [K in keyof P]: P[K]["_optional"] extends true ? K : never }[keyof P];

/** What `run` receives. */
export type Args<P extends Fields> =
  { [K in RequiredKeys<P>]: P[K]["_value"] } & { [K in OptionalKeys<P>]?: P[K]["_value"] };

/** What `run` may return: the declared type, with numbers also as bigint or JS numbers. */
export type HostOut<T> =
  T extends Rational ? Rational | bigint | number
  : T extends string | boolean | null ? T
  : T extends (infer U)[] ? HostOut<U>[]
  : T extends Json ? HostValue
  : T extends object ? { [K in keyof T]: HostOut<T[K]> }
  : T;

export type OperationSpec<P extends Fields, R> = {
  name: string;
  /** read, write, external, money, or your own (e.g. "erp.post"); default write. */
  effect?: string;
  params: P;
  returns?: Schema<R, boolean>;
  /** The parameters that make up the idempotency key (SPEC 10.3); default all. */
  key?: (keyof P & string)[];
  /** The system its results come from, for policies (SPEC 5.2): their source is tool:LABEL. */
  label?: string;
  /** Its result type comes from `returns` only (NoInfer): what run returns cannot widen the declaration. */
  run: (args: Args<P>) => NoInfer<HostOut<R>> | Promise<NoInfer<HostOut<R>>>;
};

export type Defined = { operation: Operation; implementation: Implementation };

export function defineOperation<P extends Fields, R = Json>(spec: OperationSpec<P, R>): Defined {
  const effect = spec.effect ?? "write";
  if (!/^[a-z][a-z0-9._-]*$/.test(effect)) throw new Error(`bad effect name ${JSON.stringify(effect)} in operation ${spec.name}`);
  if (spec.label !== undefined && !LABEL.test(spec.label)) throw new Error(`bad label ${JSON.stringify(spec.label)} in operation ${spec.name}`);
  const operation: Operation = {
    name: spec.name, effect,
    params: Object.entries(spec.params).map(([name, s]) => ({ name, type: s.type, required: s.required, modelAllowed: s.allowModel, fromStep: s.allowStep })),
    returns: spec.returns?.type ?? "any",
    key: spec.key ?? null,
    label: spec.label ?? null,
  };
  const implementation: Implementation = args => spec.run(args as unknown as Args<P>) as HostValue | Promise<HostValue>;
  return { operation, implementation };
}

/** The operations and implementations for preview, execute and the gateway. */
export function defineOperations(...defs: Defined[]): { operations: Operations; implementations: Implementations } {
  const operations: Operations = new Map(), implementations: Implementations = new Map();
  for (const d of defs) {
    const k = nameFold(d.operation.name);
    if (operations.has(k)) throw new Error(`operation ${d.operation.name} is defined twice`);
    operations.set(k, d.operation);
    implementations.set(k, d.implementation);
  }
  return { operations, implementations };
}

/**
 * This module defines nodes used to define types and validations for objects and interfaces.
 */
// tslint:disable:no-shadowed-variable prefer-for-of

import { IContext, NoopContext } from "./util";

export type CheckerFunc = (value: any, ctx: IContext) => boolean;

/** Node that represents a type. */
export abstract class TType {
  // allowedProps is used for intersections and inheritance, since strict checks require member
  // types to share properties.
  public abstract getChecker(suite: ITypeSuite, strict: boolean, isPartial?: boolean, allowedProps?: Set<string>): CheckerFunc;
}

/**
 * Descriptor from which TType may be build (by parseSpec()). A plain string is equivalent to
 * name(string).
 */
export type TypeSpec = TType | string;

/** Parses a type spec into a TType node. */
function parseSpec(typeSpec: TypeSpec): TType {
  return typeof typeSpec === "string" ? name(typeSpec) : typeSpec;
}

/**
 * Represents a suite of named types. Suites are used to resolve type names.
 */
export interface ITypeSuite {
  [name: string]: TType;
}

function getNamedType(suite: ITypeSuite, name: string): TType {
  const ttype = suite[name];
  if (!ttype) { throw new Error(`Unknown type ${name}`); }
  return ttype;
}

/**
 * Defines a type name, either built-in, or defined in this suite. It can typically be included in
 * the specs as just a plain string.
 */
export function name(value: string): TName { return new TName(value); }
export class TName extends TType {
  private _checkerBeingBuilt: CheckerFunc | undefined;
  private _failMsg: string;

  constructor(public name: string) { super(); this._failMsg = `is not a ${name}`; }

  public getChecker(suite: ITypeSuite, strict: boolean, isPartial: boolean = false, allowedProps?: Set<string>): CheckerFunc {
    // Using names, we can reference a type recursively in its own definition. To avoid an
    // infinite recursion in getChecker() calls, we cache and reuse the checker that's being built
    // when it references its own TName node. Note that it's important to reuse the result only
    // when getChecker() is called with the same arguments, but that's already guaranteed because
    // we are caching only for the current call and only for the same TName object (not another
    // instance of name() call for the same name).
    //
    // Note also that this is about handling recursive types; it does NOT help validating data
    // with circular references.
    let checkerFunc = this._checkerBeingBuilt;
    if (!checkerFunc) {
      this._checkerBeingBuilt = (value, ctx) => checkerFunc!(value, ctx);
      try {
        checkerFunc = this._getChecker(suite, strict, isPartial, allowedProps);
      } finally {
        this._checkerBeingBuilt = undefined;
      }
    }
    return checkerFunc;
  }

  private _getChecker(suite: ITypeSuite, strict: boolean, isPartial: boolean, allowedProps?: Set<string>): CheckerFunc {
    const ttype = getNamedType(suite, this.name);
    const checker = ttype.getChecker(suite, strict, isPartial, allowedProps);
    if (ttype instanceof BasicType || ttype instanceof TName) { return checker; }
    // For complex types, add an additional "is not a <Type>" message on failure.
    return (value: any, ctx: IContext) => checker(value, ctx) ? true : ctx.fail(null, this._failMsg, 0);
  }
}

/**
 * Defines a literal value, e.g. lit('hello') or lit(123).
 */
export function lit(value: any): TLiteral { return new TLiteral(value); }
export class TLiteral extends TType {
  public name: string;
  private _failMsg: string;
  constructor(public value: any) {
    super();
    this.name = JSON.stringify(value);
    this._failMsg = `is not ${this.name}`;
  }

  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    return (value: any, ctx: IContext) => (value === this.value) ? true : ctx.fail(null, this._failMsg, -1);
  }
}

/**
 * Defines an array type, e.g. array('number').
 */
export function array(typeSpec: TypeSpec): TArray { return new TArray(parseSpec(typeSpec)); }
export class TArray extends TType {
  public name?: string;
  constructor(public ttype: TType) {
    super();
    const elementTypeName = getTypeName(ttype)
    if (elementTypeName) {
      this.name = `${elementTypeName}[]`
    }
  }

  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    const itemChecker = this.ttype.getChecker(suite, strict);
    return (value: any, ctx: IContext) => {
      if (!Array.isArray(value)) { return ctx.fail(null, "is not an array", 0); }
      for (let i = 0; i < value.length; i++) {
        const ok = itemChecker(value[i], ctx);
        if (!ok) { return ctx.fail(i, null, 1); }
      }
      return true;
    };
  }
}

/**
 * Defines a rest type, e.g. tuple('string', rest(array('number'))).
 */
export function rest(typeSpec: TypeSpec): RestType {
  return new RestType(typeSpec);
}
export class RestType extends TType {
  private _start?: number;
  constructor(public typeSpec: TypeSpec) { super(); }

  setStart(start: number) {
    this._start = start;
  }

  getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    const arrType = typeof this.typeSpec === "string" ? getNamedType(suite, this.typeSpec) : this.typeSpec;
    if (!(arrType instanceof TArray)) {
      throw new Error("Rest type must be an array");
    }
    const itemChecker = arrType.ttype.getChecker(suite, strict);
    const start = this._start!;
    return (value: any, ctx: IContext) => {
      for (let i = start; i < value.length; i++) {
        if (!itemChecker(value[i], ctx)) {
          return ctx.fail(i, null, 1);
        }
      }
      return true;
    }
  }
}

/**
 * Defines a tuple type, e.g. tuple('string', 'number').
 */
export function tuple(...typeSpec: TypeSpec[]): TTuple {
  return new TTuple(typeSpec.map((t) => parseSpec(t)));
}
export class TTuple extends TType {

  private _restType?: RestType;

  constructor(public ttypes: TType[]) {
    super();
    const last = ttypes[ttypes.length - 1];
    if (last instanceof RestType) {
      ttypes.pop();
      this._restType = last;
      this._restType.setStart(ttypes.length);
    }
  }

  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    const itemCheckers = this.ttypes.map((t) => t.getChecker(suite, strict));
    const checker = (value: any, ctx: IContext) => {
      if (!Array.isArray(value)) { return ctx.fail(null, "is not an array", 0); }
      for (let i = 0; i < itemCheckers.length; i++) {
        const ok = itemCheckers[i](value[i], ctx);
        if (!ok) { return ctx.fail(i, null, 1); }
      }
      return true;
    };

    if (this._restType) {
      const restChecker = this._restType.getChecker(suite, strict);
      return (value: any, ctx: IContext) => {
        return checker(value, ctx) && restChecker(value, ctx);
      }
    }

    if (!strict) { return checker; }

    return (value: any, ctx: IContext) => {
      if (!checker(value, ctx)) { return false; }
      return value.length <= itemCheckers.length ? true :
        ctx.fail(itemCheckers.length, "is extraneous", 2);
    };
  }
}

/**
 * Defines a union type, e.g. union('number', 'null').
 */
export function union(...typeSpec: TypeSpec[]): TUnion {
  return new TUnion(typeSpec.map((t) => parseSpec(t)));
}
export class TUnion extends TType {
  private _failMsg: string;
  constructor(public ttypes: TType[]) {
    super();
    const names = ttypes.map(getTypeName)
      .filter((n) => n);
    const otherTypes: number = ttypes.length - names.length;
    if (names.length) {
      if (otherTypes > 0) {
        names.push(`${otherTypes} more`);
      }
      this._failMsg = `is none of ${names.join(", ")}`;
    } else {
      this._failMsg = `is none of ${otherTypes} types`;
    }
  }

  public getChecker(suite: ITypeSuite, strict: boolean, isPartial: boolean = false, allowedProps?: Set<string>): CheckerFunc {
    const itemCheckers = this.ttypes.map((t) => t.getChecker(suite, strict, isPartial, allowedProps));
    return (value: any, ctx: IContext) => {
      const ur = ctx.unionResolver();
      for (let i = 0; i < itemCheckers.length; i++) {
        const ok = itemCheckers[i](value, ur.createContext());
        if (ok) { return true; }
      }
      ctx.resolveUnion(ur);
      return ctx.fail(null, this._failMsg, 0);
    };
  }
}

/**
 * Defines an intersection type, e.g. intersection('number', 'null').
 */
export function intersection(...typeSpec: TypeSpec[]): TIntersection {
  return new TIntersection(typeSpec.map((t) => parseSpec(t)));
}
export class TIntersection extends TType {
  constructor(public ttypes: TType[]) {
    super();
  }

  public getChecker(suite: ITypeSuite, strict: boolean, isPartial: boolean = false, allowedProps: Set<string> = new Set()): CheckerFunc {
    const itemCheckers = this.ttypes.map((t) => t.getChecker(suite, strict, isPartial, allowedProps));
    return (value: any, ctx: IContext) => {
      return itemCheckers.every(checker => {
        checker(value, ctx.fork());
        return ctx.completeFork();
      }) && !ctx.failed();
    };
  }
}

/**
 * Defines a partial type.
 */
export function partial(typeSpec: TypeSpec): TPartial { return new TPartial(parseSpec(typeSpec)); }
export class TPartial extends TType {
  constructor(public ttype: TType) {
    super();
  }

  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    const itemChecker = this.ttype.getChecker(suite, strict, true);
    return (value: any, ctx: IContext) => {
      return value === undefined || itemChecker(value, ctx);
    };
  }
}

/**
 * Defines an enum type, e.g. enum({'A': 1, 'B': 2}).
 */
export function enumtype(values: { [name: string]: string | number }): TEnumType {
  return new TEnumType(values);
}
export class TEnumType extends TType {
  public readonly validValues: Set<string | number> = new Set();
  private _failMsg: string = "is not a valid enum value";

  constructor(public members: { [name: string]: string | number }) {
    super();
    this.validValues = new Set(Object.keys(members).map((name) => members[name]));
  }
  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    return (value: any, ctx: IContext) =>
      (this.validValues.has(value) ? true : ctx.fail(null, this._failMsg, 0));
  }
}

/**
 * Defines a literal enum value, such as Direction.Up, specified as enumlit("Direction", "Up").
 */
export function enumlit(name: string, prop: string): TEnumLiteral {
  return new TEnumLiteral(name, prop);
}
export class TEnumLiteral extends TType {
  private _failMsg: string;
  constructor(public enumName: string, public prop: string) {
    super();
    this._failMsg = `is not ${enumName}.${prop}`;
  }
  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    const ttype = getNamedType(suite, this.enumName);
    if (!(ttype instanceof TEnumType)) {
      throw new Error(`Type ${this.enumName} used in enumlit is not an enum type`);
    }
    const val = ttype.members[this.prop];
    if (!ttype.members.hasOwnProperty(this.prop)) {
      throw new Error(`Unknown value ${this.enumName}.${this.prop} used in enumlit`);
    }
    return (value: any, ctx: IContext) => (value === val) ? true : ctx.fail(null, this._failMsg, -1);
  }
}

function makeIfaceProps(props: { [name: string]: TOptional | TypeSpec }): TProp[] {
  return Object.keys(props)
    .filter((name: string | typeof indexKey) => (name !== indexKey))
    .map((name: string) => makeIfaceProp(name, props[name]));
}

function makeIfaceProp(name: string, prop: TOptional | TypeSpec): TProp {
  return prop instanceof TOptional ?
    new TProp(name, prop.ttype, true) :
    new TProp(name, parseSpec(prop), false);
}

/**
 * indexKey is a special key that indicates an index signature when used as a key in an interface.
 * E.g. {[key: string]: number} becomes t.iface([], {[t.indexKey]: "number"}).
 *
 * We don't distinguish between string- and number-type index signatures, and don't support
 * multiple index signatures.
 */
export const indexKey: unique symbol = Symbol();

/**
 * Defines an interface. The first argument is an array of interfaces that it extends, and the
 * second is an array of properties.
 */
export function iface(bases: string[], props: { [name: string]: TOptional | TypeSpec }): TIface {
  return new TIface(bases, makeIfaceProps(props), props[indexKey as any]);
}
export class TIface extends TType {
  public indexType?: TType;
  private propSet: Set<string>;

  constructor(public bases: string[], public props: TProp[], indexType?: TOptional | TypeSpec) {
    super();
    this.indexType = indexType ? parseSpec(indexType) : undefined;
    this.propSet = new Set(props.map((p) => p.name));
  }

  public getChecker(suite: ITypeSuite, strict: boolean, isPartial: boolean = false, allowedProps: Set<string> = new Set()): CheckerFunc {
    this.propSet.forEach((prop) => allowedProps.add(prop));

    const baseCheckers = this.bases.map((b) => getNamedType(suite, b).getChecker(suite, strict, isPartial, allowedProps));
    const propCheckers = this.props.map((prop) => prop.ttype.getChecker(suite, strict, isPartial));
    const indexTypeChecker = this.indexType?.getChecker(suite, strict, isPartial);
    const testCtx = new NoopContext();

    // Consider a prop required if it's not optional AND does not allow for undefined as a value.
    const isPropRequired: boolean[] = this.props.map((prop, i) =>
      !prop.isOpt && !propCheckers[i](undefined, testCtx));

    return (value: any, ctx: IContext) => {
      if (typeof value !== "object" || value === null) { return ctx.fail(null, "is not an object", 0); }
      for (let i = 0; i < baseCheckers.length; i++) {
        baseCheckers[i](value, ctx.fork());
        if (!ctx.completeFork()) {
          return false;
        }
      }
      for (let i = 0; i < propCheckers.length; i++) {
        const name = this.props[i].name;
        const v = value[name];
        if (v === undefined) {
          if (isPropRequired[i] && !isPartial) {
            ctx.fork().fail(name, "is missing", 1);
            if (!ctx.completeFork()) {
              return false;
            }
          }
        } else {
          const fork = ctx.fork();
          const ok = propCheckers[i](v, fork);
          if (!ok) { fork.fail(name, null, 1); }
          if (!ctx.completeFork()) {
            return false;
          }
        }
      }
      if (indexTypeChecker) {
        for (const prop in value) {
          const fork = ctx.fork();
          if (!indexTypeChecker(value[prop], fork)) {
            fork.fail(prop, null, 1);
          }
          if (!ctx.completeFork()) {
            return false;
          }
        }
      } else if (strict) {
        // In strict mode, check also for unknown enumerable properties.
        for (const prop in value) {
          if (!allowedProps.has(prop)) {
            ctx.fork().fail(prop, "is extraneous", 2);
            if (!ctx.completeFork()) {
              return false;
            }
          }
        }
      }
      return !ctx.failed();
    };
  }
}

/**
 * Defines an optional property on an interface.
 */
export function opt(typeSpec: TypeSpec): TOptional { return new TOptional(parseSpec(typeSpec)); }
export class TOptional extends TType {
  constructor(public ttype: TType) {
    super();
  }

  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    const itemChecker = this.ttype.getChecker(suite, strict);
    return (value: any, ctx: IContext) => {
      return value === undefined || itemChecker(value, ctx);
    };
  }
}

/**
 * Defines a property in an interface.
 */
export class TProp {
  constructor(public name: string, public ttype: TType, public isOpt: boolean) { }
}

/**
 * Defines a function. The first argument declares the function's return type, the rest declare
 * its parameters.
 */
export function func(resultSpec: TypeSpec, ...params: TParam[]): TFunc {
  return new TFunc(new TParamList(params), parseSpec(resultSpec));
}
export class TFunc extends TType {
  constructor(public paramList: TParamList, public result: TType) { super(); }

  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    return (value: any, ctx: IContext) => {
      return typeof value === "function" ? true : ctx.fail(null, "is not a function", 0);
    };
  }
}

/**
 * Defines a function parameter.
 */
export function param(name: string, typeSpec: TypeSpec, isOpt?: boolean): TParam {
  return new TParam(name, parseSpec(typeSpec), Boolean(isOpt));
}
export class TParam {
  constructor(public name: string, public ttype: TType, public isOpt: boolean) { }
}

/**
 * Defines a function parameter list.
 */
export class TParamList extends TType {
  constructor(public params: TParam[]) { super(); }

  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    const itemCheckers = this.params.map((t) => t.ttype.getChecker(suite, strict));
    const testCtx = new NoopContext();
    const isParamRequired: boolean[] = this.params.map((param, i) =>
      !param.isOpt && !itemCheckers[i](undefined, testCtx));

    const checker = (value: any, ctx: IContext) => {
      if (!Array.isArray(value)) { return ctx.fail(null, "is not an array", 0); }
      for (let i = 0; i < itemCheckers.length; i++) {
        const p = this.params[i];
        if (value[i] === undefined) {
          if (isParamRequired[i]) { return ctx.fail(p.name, "is missing", 1); }
        } else {
          const ok = itemCheckers[i](value[i], ctx);
          if (!ok) { return ctx.fail(p.name, null, 1); }
        }
      }
      return true;
    };

    if (!strict) { return checker; }

    return (value: any, ctx: IContext) => {
      if (!checker(value, ctx)) { return false; }
      return value.length <= itemCheckers.length ? true :
        ctx.fail(itemCheckers.length, "is extraneous", 2);
    };
  }
}

/**
 * Single TType implementation for all basic built-in types.
 */
export class BasicType extends TType {
  constructor(public validator: (value: any) => boolean, private message: string) { super(); }

  public getChecker(suite: ITypeSuite, strict: boolean): CheckerFunc {
    return (value: any, ctx: IContext) => this.validator(value) ? true : ctx.fail(null, this.message, 0);
  }
}

/**
 * Defines the suite of basic types.
 */
export const basicTypes: ITypeSuite = {
  any: new BasicType((v) => true, "is invalid"),
  unknown: new BasicType((v) => true, "is invalid"),
  number: new BasicType((v) => (typeof v === "number"), "is not a number"),
  object: new BasicType((v) => (typeof v === "object" && v), "is not an object"),
  boolean: new BasicType((v) => (typeof v === "boolean"), "is not a boolean"),
  string: new BasicType((v) => (typeof v === "string"), "is not a string"),
  symbol: new BasicType((v) => (typeof v === "symbol"), "is not a symbol"),
  void: new BasicType((v) => (v == null), "is not void"),
  undefined: new BasicType((v) => (v === undefined), "is not undefined"),
  null: new BasicType((v) => (v === null), "is not null"),
  never: new BasicType((v) => false, "is unexpected"),

  Date: new BasicType(getIsNativeChecker("[object Date]"), "is not a Date"),
  RegExp: new BasicType(getIsNativeChecker("[object RegExp]"), "is not a RegExp"),
};

// This approach for checking native object types mirrors that of lodash. Its advantage over
// `isinstance` is that it can still return true for native objects created in different JS
// execution environments.
const nativeToString = Object.prototype.toString;
function getIsNativeChecker(tag: string) {
  return (v: any) => typeof v === "object" && v && nativeToString.call(v) === tag;
}

// Support `Buffer` as type as well, but only if available (it is in nodejs, not in browsers).
declare abstract class Buffer {
  public static isBuffer(value: any): boolean;
}
if (typeof Buffer !== "undefined") {
  basicTypes.Buffer = new BasicType((v) => Buffer.isBuffer(v), "is not a Buffer");
}

// Support typed arrays of various flavors
for (const array of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer]) {
  basicTypes[array.name] = new BasicType((v) => (v instanceof array), `is not a ${array.name}`);
}

function getTypeName(t: TType): string | undefined {
  if (t instanceof TName || t instanceof TLiteral || t instanceof TArray) {
    return t.name
  }
}

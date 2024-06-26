import { basicTypes, CheckerFunc, ITypeSuite, TFunc, TIface, TType } from "./types";
import { DetailContext, IErrorDetail, NoopContext } from "./util";

/**
 * Export functions used to define interfaces.
 */
export {
  TArray, TEnumType, TEnumLiteral, TFunc, TIface, TLiteral, TName, TOptional, TParam, TParamList,
  TProp, TTuple, TType, TUnion, TIntersection, TPartial,
  array, enumlit, enumtype, func, iface, lit, name, opt, param, tuple, union, intersection, partial, rest,
  indexKey,
  BasicType, ITypeSuite,
} from "./types";

export { VError, IErrorDetail } from './util';

export interface ICheckerSuite {
  [name: string]: Checker;
}

/**
 * Takes one of more type suites (e.g. a module generated by `ts-interface-builder`), and combines
 * them into a suite of interface checkers. If a type is used by name, that name should be present
 * among the passed-in type suites.
 *
 * The returned object maps type names to Checker objects.
 */
export function createCheckers(...typeSuite: ITypeSuite[]): ICheckerSuite {
  const fullSuite: ITypeSuite = Object.assign({}, basicTypes, ...typeSuite);
  const checkers: ICheckerSuite = {};
  for (const suite of typeSuite) {
    for (const name of Object.keys(suite)) {
      checkers[name] = new Checker(fullSuite, suite[name]);
    }
  }
  return checkers;
}

/**
 * Checker implements validation of objects, and also includes accessors to validate method calls.
 * Checkers should be created using `createCheckers()`.
 */
export class Checker {
  private props: Map<string, TType> = new Map();
  private checkerPlain: CheckerFunc;
  private checkerStrict: CheckerFunc;

  // Create checkers by using `createCheckers()` function.
  constructor(private suite: ITypeSuite, private ttype: TType, private _path: string = 'value') {
    if (ttype instanceof TIface) {
      for (const p of ttype.props) {
        this.props.set(p.name, p.ttype);
      }
    }
    this.checkerPlain = this.ttype.getChecker(suite, false);
    this.checkerStrict = this.ttype.getChecker(suite, true);
  }

  /**
   * Set the path to report in errors, instead of the default "value". (E.g. if the Checker is for
   * a "person" interface, set path to "person" to report e.g. "person.name is not a string".)
   */
  public setReportedPath(path: string) {
    this._path = path;
  }

  /**
   * Check that the given value satisfies this checker's type, or throw Error.
   */
  public check(value: any): void { return this._doCheck(this.checkerPlain, value); }

  /**
   * A fast check for whether or not the given value satisfies this Checker's type. This returns
   * true or false, does not produce an error message, and is fast both on success and on failure.
   */
  public test(value: any): boolean {
    return this.checkerPlain(value, new NoopContext());
  }

  /**
   * Returns a non-empty array of error objects describing the errors if the given value does not satisfy this
   * Checker's type, or null if it does.
   */
  public validate(value: any): IErrorDetail[] | null {
    return this._doValidate(this.checkerPlain, value);
  }

  /**
   * Check that the given value satisfies this checker's type strictly. This checks that objects
   * and tuples have no extra members. Note that this prevents backward compatibility, so usually
   * a plain check() is more appropriate.
   */
  public strictCheck(value: any): void { return this._doCheck(this.checkerStrict, value); }

  /**
   * A fast strict check for whether or not the given value satisfies this Checker's type. Returns
   * true or false, does not produce an error message, and is fast both on success and on failure.
   */
  public strictTest(value: any): boolean {
    return this.checkerStrict(value, new NoopContext());
  }

  /**
   * Returns a non-empty array of error objects describing the errors if the given value does not satisfy this
   * Checker's type strictly, or null if it does.
   */
  public strictValidate(value: any): IErrorDetail[] | null {
    return this._doValidate(this.checkerStrict, value);
  }

  /**
   * If this checker is for an interface, returns a Checker for the type required for the given
   * property of this interface.
   */
  public getProp(prop: string): Checker {
    const ttype = this.props.get(prop);
    if (!ttype) { throw new Error(`Type has no property ${prop}`); }
    return new Checker(this.suite, ttype, `${this._path}.${prop}`);
  }

  /**
   * If this checker is for an interface, returns a Checker for the argument-list required to call
   * the given method of this interface. E.g. if this Checker is for the interface:
   *    interface Foo {
   *      find(s: string, pos?: number): number;
   *    }
   * Then methodArgs("find").check(...) will succeed for ["foo"] and ["foo", 3], but not for [17].
   */
  public methodArgs(methodName: string): Checker {
    const tfunc: TFunc = this._getMethod(methodName);
    return new Checker(this.suite, tfunc.paramList);
  }

  /**
   * If this checker is for an interface, returns a Checker for the return value of the given
   * method of this interface.
   */
  public methodResult(methodName: string): Checker {
    const tfunc = this._getMethod(methodName);
    return new Checker(this.suite, tfunc.result);
  }

  /**
   * If this checker is for a function, returns a Checker for its argument-list.
   */
  public getArgs(): Checker {
    if (!(this.ttype instanceof TFunc)) { throw new Error("getArgs() applied to non-function"); }
    return new Checker(this.suite, this.ttype.paramList);
  }

  /**
   * If this checker is for a function, returns a Checker for its result.
   */
  public getResult(): Checker {
    if (!(this.ttype instanceof TFunc)) { throw new Error("getResult() applied to non-function"); }
    return new Checker(this.suite, this.ttype.result);
  }

  /**
   * Return the type for which this is a checker.
   */
  public getType(): TType {
    return this.ttype;
  }

  /**
   * Actual implementation of check() and strictCheck().
   */
  private _doCheck(checkerFunc: CheckerFunc, value: any): void {
    const noopCtx = new NoopContext();
    if (!checkerFunc(value, noopCtx)) {
      const detailCtx = new DetailContext();
      checkerFunc(value, detailCtx);
      throw detailCtx.getError(this._path);
    }
  }

  private _doValidate(checkerFunc: CheckerFunc, value: any): IErrorDetail[] | null {
    const noopCtx = new NoopContext();
    if (checkerFunc(value, noopCtx)) {
      return null;
    }
    const detailCtx = new DetailContext();
    checkerFunc(value, detailCtx);
    return detailCtx.getErrorDetails(this._path);
  }

  private _getMethod(methodName: string): TFunc {
    const ttype = this.props.get(methodName);
    if (!ttype) { throw new Error(`Type has no property ${methodName}`); }
    if (!(ttype instanceof TFunc)) { throw new Error(`Property ${methodName} is not a method`); }
    return ttype;
  }
}

/**
 * Typed checker interface. Adds type guard functionality to a normal `Checker`.
 * 
 * To use, cast a `Checker` to a `CheckerT<>` using the appropriate type.
 * 
 * eg.
 *   import { MyInterface } from './my-interface';
 *   import MyInterfaceTi from './my-interface-ti';
 * 
 *   const checkers = createCheckers(MyInterfaceTi) as {
 *     MyInterface: CheckerT<MyInterface>
 *   };
 * 
 * TODO:
 * - Enable `check()` and `strictCheck()` type assertion definitions once the functionality
 *   is correctly working in TypeScript. (https://github.com/microsoft/TypeScript/issues/36931)
 */
export interface CheckerT<T> extends Checker {
  //check(value: any): asserts value is T;
  test(value: any): value is T;
  //strictCheck(value: any): asserts value is T;
  strictTest(value: any): value is T;
}

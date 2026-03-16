/** YAML Engine — condition evaluator and contract compiler. */

// Evaluator
export {
  BUILTIN_OPERATOR_NAMES,
  BUILTIN_SELECTOR_PREFIXES,
  evaluateExpression,
  MAX_REGEX_INPUT,
  _MISSING,
  _coerceEnvValue,
  _resolveNested,
  PolicyError,
  resolveSelector,
} from "./evaluator.js";
export type {
  CustomOperator,
  CustomSelector,
  EvaluateOptions,
  Missing,
} from "./evaluator.js";

// Operators
export { OPERATORS } from "./operators.js";
export type { OperatorFn } from "./operators.js";

// Selectors (direct access for advanced usage)
export { resolveNested, coerceEnvValue } from "./selectors.js";

// Compiler
export { compileContracts } from "./compiler.js";
export type { CompiledBundle, CompileOptions } from "./compiler.js";

// Compiler utilities
export {
  expandMessage,
  extractOutputPatterns,
  precompileRegexes,
  validateOperators,
} from "./compiler-utils.js";

// Contract compilation (direct access for advanced usage)
export {
  compilePre,
  compilePost,
  compileSession,
  mergeSessionLimits,
} from "./compile-contracts.js";

// Loader
export {
  loadBundle,
  loadBundleString,
  computeHash,
  MAX_BUNDLE_SIZE,
  validateSchema,
  validateUniqueIds,
  validateRegexes,
  validatePreSelectors,
  validateSandboxContracts,
} from "./loader.js";
export type { BundleHash } from "./loader.js";

// Sandbox compiler
export {
  tokenizeCommand,
  extractPaths,
  extractCommand,
  extractUrls,
  extractHostname,
  domainMatches,
} from "./sandbox-compiler.js";
export { compileSandbox } from "./sandbox-compile-fn.js";

// Composer
export { composeBundles } from "./composer.js";
export type {
  ComposedBundle,
  CompositionOverride,
  CompositionReport,
  ObserveContract,
} from "./composer.js";

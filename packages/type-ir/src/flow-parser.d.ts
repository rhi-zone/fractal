// Ambient declaration for `flow-parser` — Facebook's own Flow parser
// compiled to WASM (see from-flow.ts's top comment). Ships no published TS
// type defs of its own (only Flow (`.flow`) type files alongside the
// compiled JS — see its README, which documents the `parse()` call signature
// and options in prose, not a `.d.ts`), so this file supplies just enough of
// a surface for `from-flow.ts` to import against: the single `parse`
// function, returning an unstructured AST that `from-flow.ts` narrows itself
// (see that file's own "Minimal structural typing" section) rather than this
// declaration attempting to model flow-parser's full ESTree-ish output shape.
declare module "flow-parser" {
  export interface FlowParserOptions {
    readonly babel?: boolean;
    readonly allowReturnOutsideFunction?: boolean;
    readonly assertOperator?: boolean;
    readonly flow?: "all" | "detect";
    readonly enableExperimentalComponentSyntax?: boolean;
    readonly enableExperimentalFlowMatchSyntax?: boolean;
    readonly enableExperimentalFlowRecordSyntax?: boolean;
    readonly reactRuntimeTarget?: "18" | "19";
    readonly sourceFilename?: string | null;
    readonly sourceType?: "module" | "script" | "unambiguous";
    readonly throwOnParseErrors?: boolean;
    readonly tokens?: boolean;
    readonly types?: boolean;
    readonly transformOptions?: Record<string, unknown>;
  }

  export function parse(
    code: string,
    options?: FlowParserOptions,
  ): { readonly type: "Program"; readonly body: readonly unknown[] };
}

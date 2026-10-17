/**
 * Types for the vendored `htm/preact/standalone` build (Preact + hooks + htm in one
 * ES module), bundled into dist/admin-ui/app.js by scripts/build-admin-ui.mjs.
 */
export interface VNode {
  readonly type: unknown;
  readonly props: unknown;
}
export type Child = VNode | string | number | boolean | null | undefined | readonly Child[];
export declare function html(strings: TemplateStringsArray, ...values: unknown[]): VNode;
export declare function render(tree: VNode, parent: Element): void;
export declare function useState<S>(initial: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void];
export declare function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
export declare function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
export declare function useRef<T>(initial: T): { current: T };
export declare function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;

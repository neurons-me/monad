/**
 * Describes one documented test group in the NRP suite.
 *
 * The catalog is exported so TypeDoc can publish the test taxonomy alongside
 * the runtime APIs. It is not used by Vitest at runtime.
 */
export type NrpTestCatalogEntry = {
    /** Test file path relative to the package root. */
    file: string;
    /** Functional area covered by the file. */
    category: "parsing" | "index" | "selection" | "scoring" | "observability" | "learning";
    /** Whether this test group protects a production invariant. */
    invariant: boolean;
    /** Short description of the behavior under test. */
    covers: string[];
};
/**
 * Public documentation catalog for `tests/NRP`.
 *
 * This lets the generated API docs explain what is covered without coupling the
 * production package to Vitest internals.
 */
export declare const NRP_TEST_CATALOG: NrpTestCatalogEntry[];

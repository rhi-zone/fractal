// A `.d.ts` file — always excluded from `findEntryFiles`'s (discover.ts)
// candidate scan regardless of the `extensions` filter, even though its
// declared shape looks tree-like. Content here is never actually type-
// checked as a tree by this fixture's own test (the point is the file is
// filtered out before `hasTreeExport` would ever run on it).

export declare const tree: { readonly meta: object };

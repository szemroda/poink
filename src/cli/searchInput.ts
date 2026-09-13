import * as z from "zod/v4";

const retrievalOptions = {
  limit: z.number().int().positive().default(10),
  tag: z.string().optional(),
  fts: z.boolean().default(false),
  expand: z.number().int().min(0).max(4000).default(0),
};

// CLI and MCP normalize their inputs here before executing a search.
export const SearchInputSchema = z.object({
  query: z.string(),
  ...retrievalOptions,
  docsOnly: z.boolean().default(false),
  conceptsOnly: z.boolean().default(false),
  includeClusters: z.boolean().default(false),
});

export const SearchPackInputSchema = z.object({
  queries: z.array(z.string()).min(1),
  ...retrievalOptions,
  withContent: z.boolean().default(false),
  globalLimit: z.number().int().positive().optional(),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;
export type SearchPackInput = z.infer<typeof SearchPackInputSchema>;

export type SearchRequest =
  | { command: "search"; input: SearchInput }
  | { command: "search-pack"; input: SearchPackInput };

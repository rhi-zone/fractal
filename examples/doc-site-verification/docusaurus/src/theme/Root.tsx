import React from "react";
import { createFetch, toDropInFetch } from "@rhi-zone/fractal-http-api-projector/presets";
import { ApiExplorerFetchProvider } from "@rhi-zone/fractal-api-explorer";
import { api } from "../fixture-tree.ts";

const dropInFetch = toDropInFetch(createFetch(api));

export default function Root({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ApiExplorerFetchProvider fetch={dropInFetch}>{children}</ApiExplorerFetchProvider>;
}

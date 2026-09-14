import { useQuery } from "@tanstack/react-query";
import { instanceQuery } from "./queries.ts";

export function useInstance() {
  return useQuery(instanceQuery);
}

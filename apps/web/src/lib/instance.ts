import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./api.ts";

export function useInstance() {
  return useQuery({
    queryKey: ["instance"],
    queryFn: async () => unwrap(await api.GET("/api/instance")),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

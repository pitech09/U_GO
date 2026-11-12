import { fetch } from "expo/fetch";
import { QueryClient, QueryFunction } from "@tanstack/react-query";

/**
 * Gets the base URL for the Express API server (e.g., "http://localhost:3000")
 * @returns {string} The API base URL
 */

export function getApiUrl(): string {
  const configuredHost = process.env.EXPO_PUBLIC_DOMAIN;
  const browserHost = typeof window !== "undefined" ? window.location.hostname : "";
  const browserIsHosted =
    browserHost !== "" &&
    !/^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/i.test(browserHost);

  // Expo's web export can carry the local .env value into production. In a
  // hosted browser, a local API host points back to the user's own machine;
  // use the same origin so /api/rides reaches the deployed server instead.
  const host =
    browserIsHosted &&
    (!configuredHost || /^(https?:\/\/)?(localhost|127(?:\.\d{1,3}){3})(?::\d+)?$/i.test(configuredHost))
      ? window.location.origin
      : configuredHost;

  if (!host) {
    throw new Error("EXPO_PUBLIC_DOMAIN is not set");
  }

  const isLocalHost =
    /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?$/i.test(host);

  const normalizedHost = /^https?:\/\//i.test(host)
    ? host
    : `${isLocalHost ? "http" : "https"}://${host}`;

  const apiUrl = new URL(normalizedHost).href;

  console.log("U-GO API URL:", apiUrl);

  return apiUrl;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  route: string,
  data?: unknown | undefined,
): Promise<Response> {
  const baseUrl = getApiUrl();
  const url = new URL(route, baseUrl);

  const res = await fetch(url.toString(), {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const baseUrl = getApiUrl();
    const url = new URL(queryKey.join("/") as string, baseUrl);

    const res = await fetch(url.toString(), {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

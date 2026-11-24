import { useCallback, useEffect, useState } from "react";

// Same base URL the rest of the site uses (set REACT_APP_API_URL at build time).
export const API = process.env.REACT_APP_API_URL || "http://localhost:5001/api";

export async function getJson(path, signal) {
  const res = await fetch(`${API}${path}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// { data, error, loading, reload }: error.status is the HTTP status (undefined when the network failed).
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true, path: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    const ctl = new AbortController();
    setState((s) => ({ data: s.path === path ? s.data : null, error: null, loading: true, path: s.path }));
    getJson(path, ctl.signal)
      .then((data) => setState({ data, error: null, loading: false, path }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ data: null, error, loading: false, path });
      });
    return () => ctl.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const fresh = state.path === path;
  return { data: fresh ? state.data : null, error: fresh ? state.error : null, loading: !fresh || state.loading, reload };
}

// Path segments for a make or model: a model may itself contain "/".
export const seg = (s) => encodeURIComponent(s);
export const marketPath = (make, model) =>
  `/market/${seg(make)}${model ? `/${model.split("/").map(seg).join("/")}` : ""}`;

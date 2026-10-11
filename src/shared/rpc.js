/* Odoo Import Export: JSON-RPC client using the tab's own Odoo session.
 *
 * Every call goes to /web/dataset/call_kw with the user's context (lang, tz, current
 * companies), so access rights and record rules apply as in the web client.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  class RpcError extends Error {
    constructor(title, message, extra = {}) {
      super(message || title);
      this.title = title;
      Object.assign(this, extra);
    }
  }

  // Firefox content scripts must use content.fetch to send the page's cookies/origin.
  /* global content */
  const pageFetch =
    typeof content !== "undefined" && content && typeof content.fetch === "function"
      ? content.fetch.bind(content)
      : globalThis.fetch.bind(globalThis);

  function cookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  const READS = new Set(["search", "search_read", "search_count", "read", "name_search", "fields_get", "default_get", "get_views", "has_access", "check_access_rights", "export_data"]);

  function cancelled() {
    return new RpcError("Cancelled", "Stopped before it finished.", { aborted: true });
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw cancelled();
  }

  function createClient(origin = location.origin) {
    let seq = 0;
    let session = null;

    // `signal` aborts the request (the panel's Cancel button); see bind().
    async function rpc(route, params, signal = null) {
      throwIfAborted(signal);
      let res;
      try {
        res = await pageFetch(new URL(route, origin).href, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: ++seq, params }),
          signal: signal || undefined,
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw cancelled();
        throw new RpcError("Network error", String(e && e.message ? e.message : e));
      }
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const hint = res.status === 404 ? "This page doesn't look like an Odoo instance." : text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
        throw new RpcError(`HTTP ${res.status}`, hint);
      }
      if (data.error) {
        const d = data.error.data || {};
        const expired = data.error.code === 100 || /SessionExpired/.test(d.name || "");
        throw new RpcError(
          expired ? "Session expired" : (d.name || "").split(".").pop() || "Server error",
          expired ? "Log in to Odoo in this tab and try again." : d.message || data.error.message,
          { name: d.name, debug: d.debug, expired },
        );
      }
      return data.result;
    }

    function userContext() {
      const ctx = { ...((session && session.user_context) || {}) };
      // The web client keeps the selected companies in the `cids` cookie ("1-3" or "1,3").
      const cids = cookie("cids");
      if (cids) {
        const ids = cids.split(/[-,]/).map(Number).filter(Number.isInteger);
        if (ids.length) ctx.allowed_company_ids = ids;
      }
      return ctx;
    }

    async function connect() {
      const info = await rpc("/web/session/get_session_info", {});
      if (!info || !info.uid) throw new RpcError("Not logged in", "Log in to Odoo in this tab, then open Odoo Import Export again.");
      session = info;
      return info;
    }

    async function callWith(signal, model, method, args = [], kwargs = {}, context = {}) {
      const params = {
        model,
        method,
        args,
        kwargs: { ...kwargs, context: { ...userContext(), ...(kwargs.context || {}), ...context } },
      };
      const route = `/web/dataset/call_kw/${model}/${method}`;
      // A connection dropped before the server answered ("Failed to fetch": typically a
      // keep-alive connection the server had just closed) is retried, for reads only:
      // a write must never run twice.
      for (let attempt = 0; ; attempt++) {
        try {
          return await rpc(route, params, signal);
        } catch (e) {
          if (!(e.title === "Network error" && READS.has(method) && attempt < 2)) throw e;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }

    const client = {
      connect,
      rpc,
      call: (...a) => callWith(null, ...a),
      // The same client whose every call can be aborted with `signal` (one per operation,
      // so cancelling one never affects the next).
      bind(signal) {
        return { ...client, call: (...a) => callWith(signal, ...a), rpc: (route, params) => rpc(route, params, signal) };
      },
      get session() {
        return session;
      },
    };
    return client;
  }

  // Supported Odoo versions: 16 to 20, intermediate releases included (17.2, 18.3, 19.5…).
  const SUPPORTED = { min: 16, max: 20 };

  /* Version of the server from get_session_info: server_version_info is [17, 0, ...] for a
   * major release and ["saas~17", 2, ...] (or a "17.2" style string) for intermediate ones. */
  function version(info) {
    const vi = (info && info.server_version_info) || [];
    const text = String((info && info.server_version) || "");
    let major = typeof vi[0] === "number" ? vi[0] : parseInt(String(vi[0] ?? "").replace(/^\D+/, ""), 10);
    let minor = typeof vi[1] === "number" ? vi[1] : parseInt(vi[1], 10);
    if (!Number.isFinite(major)) {
      const m = /(\d+)\.(\d+)/.exec(text);
      major = m ? Number(m[1]) : NaN;
      minor = m ? Number(m[2]) : NaN;
    }
    if (!Number.isFinite(minor)) minor = 0;
    const label = Number.isFinite(major) ? `${major}.${minor}` : text || "unknown";
    let support = "yes";
    if (!Number.isFinite(major)) support = "unknown";
    else if (major < SUPPORTED.min) support = "old";
    else if (major > SUPPORTED.max) support = "new";
    return { major, minor, label, support };
  }

  NS.rpc = { createClient, RpcError, cancelled, throwIfAborted, version, SUPPORTED };
})();

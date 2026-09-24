// Strict stand-ins for the Cloudflare bindings this Worker actually uses.
// Unknown methods throw. A catch-all stub that returns success for every
// call hides a missing RPC method, which is how the cron tick passed the
// suite while workerd rejected it in production.
//
// These are not workerd. Miniflare checks remain the owner for real
// Durable Object construction. Use this module when a unit test has to
// call into worker code without a workerd isolate.

const RPC_MISSING = name => new TypeError(`The RPC receiver does not implement the method "${name}".`);

function rejectUnknown(target, allowed, label) {
  return new Proxy(target, {
    get(receiver, prop, proxy) {
      if (prop === "then") return undefined;
      if (typeof prop !== "string") return Reflect.get(receiver, prop, proxy);
      if (!allowed.has(prop)) throw new TypeError(`${label} has no method "${prop}".`);
      const value = Reflect.get(receiver, prop, proxy);
      return typeof value === "function" ? value.bind(receiver) : value;
    }
  });
}

function methodNames(instance) {
  const names = new Set();
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (typeof desc?.value === "function") names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

// Wrap a real object so only its own methods are callable. Anything else
// throws the workerd missing-RPC error instead of returning a made-up result.
export function strictDurableObjectStub(instance) {
  const allowed = methodNames(instance);
  const invoked = [];
  const stub = new Proxy(instance, {
    get(target, prop, proxy) {
      if (prop === "then") return undefined;
      if (typeof prop !== "string") return Reflect.get(target, prop, proxy);
      if (!allowed.has(prop)) throw RPC_MISSING(prop);
      const value = Reflect.get(target, prop, proxy);
      if (typeof value !== "function") throw RPC_MISSING(prop);
      return (...args) => {
        invoked.push(prop);
        return value.apply(target, args);
      };
    }
  });
  return { stub, invoked, allowed };
}

// getByName returns the instance registered for that name, wrapped so
// unknown RPC throws. An unregistered name throws rather than handing back
// a stub that accepts every method. Other namespace methods throw too.
export function strictBinding(methods, label) {
  return rejectUnknown(methods, new Set(Object.keys(methods)), label);
}

export function strictDurableObjectNamespace(objects) {
  const entries = objects instanceof Map ? objects : new Map(Object.entries(objects));
  const names = [];
  const namespace = strictBinding({
    getByName(name) {
      names.push(name);
      if (!entries.has(name)) throw new Error(`Durable Object name "${name}" is not registered on this strict namespace.`);
      return strictDurableObjectStub(entries.get(name)).stub;
    }
  }, "DurableObjectNamespace");
  return { namespace, names };
}

function requireKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw new TypeError("Key must be a string of 1 to 512 bytes.");
  }
  return key;
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  throw new TypeError("Strict KV/R2 fake accepts string or Uint8Array values.");
}

// In-memory KV with the methods Room code would call. expirationTtl follows
// the platform minimum of 60 seconds. Missing keys read back as null.
export function strictKvNamespace({ now = () => Date.now() } = {}) {
  const rows = new Map();
  const live = key => {
    const row = rows.get(key);
    if (!row) return null;
    if (row.expiration !== null && row.expiration * 1000 <= now()) {
      rows.delete(key);
      return null;
    }
    return row;
  };
  const api = {
    async get(key, options = {}) {
      const row = live(requireKey(key));
      if (!row) return null;
      const type = options.type ?? "text";
      if (type === "text") return row.text;
      if (type === "json") return JSON.parse(row.text);
      if (type === "arrayBuffer") return new TextEncoder().encode(row.text).buffer;
      throw new TypeError(`Unsupported KV get type "${type}".`);
    },
    async getWithMetadata(key, options) {
      const row = live(requireKey(key));
      const value = row ? await api.get(key, options) : null;
      return { value, metadata: row?.metadata ?? null, cacheStatus: null };
    },
    async put(key, value, options = {}) {
      requireKey(key);
      const text = textOf(value);
      let expiration = null;
      if (options.expiration !== undefined && options.expirationTtl !== undefined) {
        throw new TypeError("KV put accepts expiration or expirationTtl, not both.");
      }
      if (options.expirationTtl !== undefined) {
        if (!Number.isFinite(options.expirationTtl) || options.expirationTtl < 60) {
          throw new TypeError("KV expirationTtl must be at least 60 seconds.");
        }
        expiration = Math.floor(now() / 1000) + options.expirationTtl;
      }
      if (options.expiration !== undefined) expiration = options.expiration;
      rows.set(key, { text, metadata: options.metadata ?? null, expiration });
    },
    async delete(key) { rows.delete(requireKey(key)); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const keys = [...rows.keys()].filter(key => key.startsWith(prefix) && live(key)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = keys.slice(start, start + limit);
      return {
        keys: slice.map(name => ({ name, expiration: rows.get(name)?.expiration ?? undefined, metadata: rows.get(name)?.metadata })),
        list_complete: start + slice.length >= keys.length,
        cursor: start + slice.length >= keys.length ? undefined : String(start + slice.length)
      };
    }
  };
  return rejectUnknown(api, new Set(["get", "getWithMetadata", "put", "delete", "list"]), "KVNamespace");
}

function metaOf(key, text, customMetadata) {
  return { key, size: new TextEncoder().encode(text).byteLength, uploaded: new Date(), httpMetadata: {}, customMetadata };
}

function objectBody(key, text, customMetadata = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    key,
    size: bytes.byteLength,
    uploaded: new Date(),
    httpMetadata: {},
    customMetadata,
    arrayBuffer: async () => bytes.buffer,
    text: async () => text,
    json: async () => JSON.parse(text),
    body: bytes
  };
}

// In-memory R2. get/head return null for a missing key. Multipart is a
// declared platform method that this fake refuses, rather than pretending
// the upload succeeded.
export function strictR2Bucket() {
  const rows = new Map();
  const api = {
    async put(key, value, options = {}) {
      requireKey(key);
      const text = textOf(value);
      const customMetadata = options.customMetadata ?? {};
      rows.set(key, { text, customMetadata });
      return metaOf(key, text, customMetadata);
    },
    async get(key) {
      const row = rows.get(requireKey(key));
      return row ? objectBody(key, row.text, row.customMetadata) : null;
    },
    async head(key) {
      const row = rows.get(requireKey(key));
      return row ? metaOf(key, row.text, row.customMetadata) : null;
    },
    async delete(key) { rows.delete(requireKey(key)); },
    async list({ prefix = "", limit = 1000 } = {}) {
      const objects = [...rows.keys()].filter(key => key.startsWith(prefix)).sort().slice(0, limit)
        .map(key => ({ key, size: new TextEncoder().encode(rows.get(key).text).byteLength }));
      return { objects, truncated: false };
    },
    async createMultipartUpload() { throw new Error("Strict R2 fake does not implement multipart upload."); },
    async resumeMultipartUpload() { throw new Error("Strict R2 fake does not implement multipart upload."); }
  };
  return rejectUnknown(api, new Set(["put", "get", "head", "delete", "list", "createMultipartUpload", "resumeMultipartUpload"]), "R2Bucket");
}

// A service binding such as env.ASSETS. Only fetch exists.
export function strictServiceBinding(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("Service binding fetch implementation required.");
  return rejectUnknown({ fetch: fetchImpl }, new Set(["fetch"]), "Fetcher");
}

// Base class for the maintenance fixture, which has to construct ProjectRoom
// with a hostile context inside workerd. Production still extends the real
// DurableObject; this only replaces the parent for that one local entrypoint
// so super(ctx, env) can run against a stand-in state. It stores ctx and env
// the way DurableObject does and does not invent RPC methods.
export class TestDurableObjectBase {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

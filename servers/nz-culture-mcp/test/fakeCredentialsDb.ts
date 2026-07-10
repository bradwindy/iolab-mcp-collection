import type { D1LikeDatabase, D1LikeStatement } from "@nz-mcp/credentials";

/**
 * A minimal in-memory stand-in for the shared D1 credentials table, satisfying
 * @nz-mcp/credentials' D1LikeDatabase/D1LikeStatement structural interfaces (imported here so a
 * drift in those interfaces fails this fake at compile time rather than silently). Generic enough
 * that setCredential/getCredential/deleteCredential (which drive it with real SQL text) work
 * against it without this fake needing to parse SQL — it just keys a Map by the (server, key_name)
 * bind values every statement in that package happens to use as its first two parameters.
 *
 * D1LikeStatement is recursive (`bind()` returns another D1LikeStatement), so every level —
 * including the freshly-`prepare()`d, not-yet-`bind()`ed statement — must itself expose
 * run/first/all. The real code always binds before calling one of those, so the unbound-level
 * implementations below (bound with no values) are never exercised, just present for the type.
 */
export function createFakeCredentialsDb(): D1LikeDatabase {
  const store = new Map<string, string>();

  function keyOf(server: string, keyName: string): string {
    return `${server} ${keyName}`;
  }

  function statementFor(query: string, values: unknown[]): D1LikeStatement {
    const isSelect = /^\s*SELECT/i.test(query);
    const isInsert = /^\s*INSERT/i.test(query);

    return {
      bind(...nextValues: unknown[]): D1LikeStatement {
        return statementFor(query, nextValues);
      },
      async run(): Promise<unknown> {
        if (isInsert) {
          const [server, keyName, value] = values as [string, string, string, string];
          store.set(keyOf(server, keyName), value);
        }
        return {};
      },
      async first<T = unknown>(): Promise<T | null> {
        if (isSelect) {
          const [server, keyName] = values as [string, string];
          const value = store.get(keyOf(server, keyName));
          return value ? ({ value } as T) : null;
        }
        return null;
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        return { results: [] };
      },
    };
  }

  return {
    prepare(query: string): D1LikeStatement {
      return statementFor(query, []);
    },
  };
}

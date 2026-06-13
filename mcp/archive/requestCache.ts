export interface RequestCacheScope {
  rootDir: string;
  id: string;
}

type CacheRecord<T> =
  | {
      state: "ready";
      value: T;
    }
  | {
      state: "pending";
      promise: Promise<T>;
    };

export class RequestScopedMemoryCache {
  private readonly groups = new Map<string, Map<string, CacheRecord<unknown>>>();

  async getOrCompute<T>(
    scope: RequestCacheScope,
    key: string,
    compute: () => Promise<T>,
    cacheable: (value: T) => boolean = () => true,
  ): Promise<T> {
    const group = this.group(scope);
    const existing = group.get(key) as CacheRecord<T> | undefined;
    if (existing?.state === "ready") {
      return existing.value;
    }
    if (existing?.state === "pending") {
      return existing.promise;
    }

    const promise = compute();
    group.set(key, { state: "pending", promise });
    try {
      const value = await promise;
      if (cacheable(value)) {
        group.set(key, { state: "ready", value });
      } else {
        group.delete(key);
      }
      return value;
    } catch (error) {
      group.delete(key);
      throw error;
    }
  }

  invalidate(scope: RequestCacheScope): void {
    this.groups.delete(this.groupKey(scope));
  }

  clear(): void {
    this.groups.clear();
  }

  private group(scope: RequestCacheScope): Map<string, CacheRecord<unknown>> {
    const key = this.groupKey(scope);
    let group = this.groups.get(key);
    if (group === undefined) {
      group = new Map<string, CacheRecord<unknown>>();
      this.groups.set(key, group);
    }
    return group;
  }

  private groupKey(scope: RequestCacheScope): string {
    return `${scope.rootDir}\0${scope.id}`;
  }
}

export const requestScopedCache = new RequestScopedMemoryCache();

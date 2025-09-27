// index.d.ts

export interface Schema {
  table: string;
  createSQL: string;
  extraSQL?: string[];
  version?: number;
  onUpgrade?(db: any, from: number, to: number): void | Promise<void>;
}

export interface InitOptions {
  dbName?: string;
  autoSaveMs?: number;
  wasmLocateFile?(file: string): string;
  schemas?: Schema[];
  /** Modules that default-export a Schema (useful for tree-shaking/auto-collect). */
  schemaModules?: Record<string, { default: Schema }>;
}

export type Row = Record<string, any>;

export interface TableHelper<T extends Row = Row> {
  insert(obj: Partial<T>): Promise<void>;
  upsert(obj: Partial<T>): Promise<void>;
  update(id: any, patch: Partial<T>): Promise<void>;
  /** Soft delete (tries `deletedAt`; falls back to `deleted_at`) */
  deleteSoft(id: any, ts?: string): Promise<void>;
  remove(id: any): Promise<void>;
  findById(id: any): Promise<T | null>;
  searchLike(q: string, columns: (keyof T | string)[], limit?: number): Promise<T[]>;
}

export class AllezORM {
  constructor(SQL: any, db: any, opts: InitOptions);
  /** Initialize an AllezORM instance (loads sql.js, restores from IndexedDB, applies schemas). */
  static init(opts?: InitOptions): Promise<AllezORM>;

  /** Persist DB to IndexedDB immediately. */
  saveNow(): Promise<void>;

  /** Execute DDL/DML; returns true on success (compat helper). */
  exec(sql: string, params?: any[]): Promise<boolean>;
  /** Alias of exec for ergonomics. */
  run(sql: string, params?: any[]): Promise<boolean>;

  /** Execute DDL/DML; resolves when finished. */
  execute(sql: string, params?: any[]): Promise<void>;
  /** Run a SELECT and return rows as plain objects. */
  query<T = Row>(sql: string, params?: any[]): Promise<T[]>;
  /** Run a SELECT and return the first row or null. */
  get<T = Row>(sql: string, params?: any[]): Promise<T | null>;

  /** Convenience table helper. */
  table<T extends Row = Row>(table: string): TableHelper<T>;

  /** Register/upgrade schemas. */
  registerSchemas(schemas: Schema[]): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Browser-friendly convenience exports (compat with Angular consumer) */
/* ------------------------------------------------------------------ */

/**
 * Open (or reuse) a browser DB by name and return an AllezORM instance.
 * Equivalent to `AllezORM.init({ dbName: name, ...opts })` with caching.
 */
export function openBrowserDb(name: string, opts?: InitOptions): Promise<AllezORM>;

/** Alias for compatibility with consumers that call `openDb`. */
export const openDb: typeof openBrowserDb;

/** Apply an array of Schema objects on an opened AllezORM instance. */
export function applySchemas(db: AllezORM, schemas: Schema[]): Promise<void>;

/** Run a SELECT and return rows (compat free functions). */
export function query<TRow = Row>(db: AllezORM, sql: string, params?: any[]): Promise<TRow[]>;

/** Execute DDL/DML (compat free function). */
export function exec(db: AllezORM, sql: string, params?: any[]): Promise<void>;

/** Keep a default export for ESM consumers. */
export default AllezORM;

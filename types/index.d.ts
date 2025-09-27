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
  schemaModules?: Record<string, { default: Schema }>;
}

export type Row = Record<string, any>;

export interface TableHelper<T extends Row = Row> {
  insert(obj: Partial<T>): Promise<void>;
  upsert(obj: Partial<T>): Promise<void>;
  update(id: any, patch: Partial<T>): Promise<void>;
  deleteSoft(id: any, ts?: string): Promise<void>;
  remove(id: any): Promise<void>;
  findById(id: any): Promise<T | undefined>;
  searchLike(q: string, columns: (keyof T | string)[], limit?: number): Promise<T[]>;
}

export class AllezORM {
  constructor(SQL: any, db: any, opts: InitOptions);

  /** Initialize (loads sql.js, restores from IndexedDB, applies schemas). */
  static init(opts?: InitOptions): Promise<AllezORM>;

  /** Persist the current database to IndexedDB immediately. */
  saveNow(): Promise<void>;

  /** Execute arbitrary SQL and auto-save (convenience, returns true). */
  exec(sql: string, params?: any[]): Promise<boolean>;

  /** Alias for exec. */
  run(sql: string, params?: any[]): Promise<boolean>;

  /** Low-level execute; schedules a debounced save. */
  execute(sql: string, params?: any[]): Promise<void>;

  /** SELECT helper returning plain objects. */
  query<T = Row>(sql: string, params?: any[]): Promise<T[]>;

  /** SELECT one row (undefined if no row). */
  get<T = Row>(sql: string, params?: any[]): Promise<T | undefined>;

  /** Table-scoped helpers. */
  table<T extends Row = Row>(table: string): TableHelper<T>;

  /** Register / upgrade schemas. */
  registerSchemas(schemas: Schema[]): Promise<void>;
}

/** Open (or reuse) a browser DB by name. */
export function openBrowserDb(name: string, opts?: InitOptions): Promise<AllezORM>;

/** Alias for openBrowserDb. */
export const openDb: typeof openBrowserDb;

/** Apply an array of schemas to an opened AllezORM instance. */
export function applySchemas(db: AllezORM, schemas?: Schema[]): Promise<void>;

/** Convenience helpers that operate on an AllezORM instance. */
export function query<T = Row>(db: AllezORM, sql: string, params?: any[]): Promise<T[]>;
export function exec(db: AllezORM, sql: string, params?: any[]): Promise<void>;

export default AllezORM;

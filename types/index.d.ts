// types/index.d.ts

// ===== Public model types =====
export interface Schema {
  /** table name */
  table: string;
  /** CREATE TABLE IF NOT EXISTS ... */
  createSQL: string;
  /** indexes / triggers / FTS setup */
  extraSQL?: string[];
  /** defaults to 1 */
  version?: number;
  /** run when schema version increases */
  onUpgrade?(
    db: any,        // low-level sql.js Database (same instance you construct in init)
    from: number,
    to: number
  ): void | Promise<void>;
}

export interface InitOptions {
  dbName?: string;
  autoSaveMs?: number;
  /**
   * Returns the URL for the sql.js wasm file (e.g. f => `https://sql.js.org/dist/${f}`)
   */
  wasmLocateFile?(file: string): string;
  /** schema list to create/upgrade */
  schemas?: Schema[];
  /**
   * For bundlers (e.g. Vite import.meta.glob results):
   *   { "./schemas/user.js": { default: Schema }, ... }
   */
  schemaModules?: Record<string, { default: Schema }>;
}

/** Result rows are plain objects from sql.js getAsObject() */
export type Row = Record<string, any>;

/** Helper interface returned by table('<name>') */
export interface TableHelper<T extends Row = Row> {
  insert(obj: Partial<T>): Promise<void>;
  upsert(obj: Partial<T>): Promise<void>;
  update(id: any, patch: Partial<T>): Promise<void>;
  /** soft-delete: sets deleted_at */
  deleteSoft(id: any, ts?: string): Promise<void>;
  /** hard delete */
  remove(id: any): Promise<void>;
  findById(id: any): Promise<T | null>;
  /** WHERE col LIKE ? OR ... LIMIT ? */
  searchLike(q: string, columns: (keyof T | string)[], limit?: number): Promise<T[]>;
}

// ===== Main class =====
export class AllezORM {
  /** Constructed by `init`, but exported for advanced usage */
  constructor(SQL: any, db: any, opts: InitOptions);

  // ---- lifecycle ----
  static init(opts?: InitOptions): Promise<AllezORM>;
  saveNow(): Promise<void>;

  // ---- SQL helpers ----
  /** run arbitrary SQL (DDL/DML). Returns true on success. */
  exec(sql: string, params?: any[]): Promise<boolean>;
  /** alias of exec */
  run(sql: string, params?: any[]): Promise<boolean>;
  /** prepared exec that schedules persistence */
  execute(sql: string, params?: any[]): Promise<void>;
  /** SELECT ... -> array of objects */
  query<T = Row>(sql: string, params?: any[]): Promise<T[]>;
  /** SELECT ... LIMIT 1 -> single row or null */
  get<T = Row>(sql: string, params?: any[]): Promise<T | null>;

  // ---- tables & schemas ----
  /** convenience helpers bound to a single table */
  table<T extends Row = Row>(table: string): TableHelper<T>;
  /** create/upgrade all schemas; persists versions in allez_meta */
  registerSchemas(schemas: Schema[]): Promise<void>;
}

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
  /** Soft delete; implementation will try `deletedAt` then `deleted_at`. */
  deleteSoft(id: any, ts?: string): Promise<void>;
  remove(id: any): Promise<void>;
  findById(id: any): Promise<T | null>;
  searchLike(q: string, columns: (keyof T | string)[], limit?: number): Promise<T[]>;
}

export class AllezORM {
  constructor(SQL: any, db: any, opts: InitOptions);
  static init(opts?: InitOptions): Promise<AllezORM>;
  saveNow(): Promise<void>;
  exec(sql: string, params?: any[]): Promise<boolean>;
  run(sql: string, params?: any[]): Promise<boolean>;
  execute(sql: string, params?: any[]): Promise<void>;
  query<T = Row>(sql: string, params?: any[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: any[]): Promise<T | null>;
  table<T extends Row = Row>(table: string): TableHelper<T>;
  registerSchemas(schemas: Schema[]): Promise<void>;
}

/** Browser helpers + Angular-friendly surface */
export function openBrowserDb(name: string, opts?: InitOptions): Promise<AllezORM>;
export const openDb: typeof openBrowserDb;
export function applySchemas(db: AllezORM, schemas?: Schema[]): Promise<void>;
export function query<T = Row>(db: AllezORM, sql: string, params?: any[]): Promise<T[]>;
export function exec(db: AllezORM, sql: string, params?: any[]): Promise<void>;

export default AllezORM;

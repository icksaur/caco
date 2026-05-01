declare module 'sql.js' {
  interface Database {
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    close(): void;
  }
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }
  export default function initSqlJs(): Promise<SqlJsStatic>;
}

import { z } from 'zod';

// Belt-and-suspenders: reject anything that isn't a single read-only statement,
// even though the DB role itself is already SELECT-only / read-only-transaction.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|reindex|refresh|call|do|merge|comment|listen|notify|prepare|execute)\b/i;

export function assertReadOnlySql(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    throw new Error('Only a single statement is allowed.');
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Only SELECT (or WITH ... SELECT) statements are allowed.');
  }
  if (FORBIDDEN.test(trimmed)) {
    throw new Error('Statement contains a disallowed keyword.');
  }
  return trimmed;
}

export function registerReadTools(server, { pool, config }) {
  const { MAX_ROWS } = config;

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description: 'List tables and views in the health_pi database (public schema), with approximate row counts.',
      inputSchema: {},
    },
    async () => {
      const { rows } = await pool.query(`
        SELECT c.relname AS name,
               CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind,
               COALESCE(s.n_live_tup, 0) AS approx_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v')
        ORDER BY name;
      `);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description: 'Show column names, types, and nullability for a table or view in the public schema.',
      inputSchema: { table: z.string().describe('Table or view name (public schema)') },
    },
    async ({ table }) => {
      const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position;`,
        [table]
      );
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `No such table/view: ${table}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'query',
    {
      title: 'Read-only SQL query',
      description:
        `Run a single read-only SQL SELECT statement against the health_pi database and return the rows. ` +
        `Results are capped at ${MAX_ROWS} rows. Writes and multi-statement input are rejected.`,
      inputSchema: { sql: z.string().describe('A single SELECT statement') },
    },
    async ({ sql }) => {
      let safeSql;
      try {
        safeSql = assertReadOnlySql(sql);
      } catch (err) {
        return { content: [{ type: 'text', text: `Rejected: ${err.message}` }], isError: true };
      }
      const wrapped = `SELECT * FROM (${safeSql}) AS _q LIMIT ${Number(MAX_ROWS)}`;
      try {
        const { rows } = await pool.query(wrapped);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Query error: ${err.message}` }], isError: true };
      }
    }
  );
}

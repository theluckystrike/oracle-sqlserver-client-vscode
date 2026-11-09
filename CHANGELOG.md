# Changelog

## 0.1.0

- In Restricted Mode, a workspace's settings can no longer switch off the confirmation before DELETE or UPDATE without WHERE, switch off Oracle auto-commit, or raise the row limits.
- Oracle INTERVAL DAY TO SECOND and INTERVAL YEAR TO MONTH columns show as Oracle text (+3 04:05:06.7, +1-02). Before, any query that returned one failed with NJS-119.
- First release: SQL Server, Azure SQL and Oracle Database connections with pure JavaScript drivers (tedious, node-oracledb Thin mode).
- SQL login, Windows (NTLM) login and Azure AD access tokens; Oracle Easy Connect, tnsnames.ora aliases and wallets.
- Explorer with databases, schemas, tables, views, procedures, functions and packages, and Script as CREATE.
- T-SQL `GO` batches and Oracle `/` blocks, every result set in its own tab, PRINT and DBMS_OUTPUT in Messages, error markers in the editor. SQL*Plus `REM` lines count as comments.
- A `USE` in one file changes that file's database (shown in the status bar). Other files and tables opened from the explorer keep their own database.
- Cancel, streamed export to CSV, JSON and SQL INSERT, server-side read-only connections, confirmation before risky statements (`UPDATE STATISTICS` is not one), query history and autocomplete.
- Execution plan, schema compare, ER diagram, schema DDL export and a query library, free in this version.
- "More free viewers" starts with the Zovo extensions most related to this one. The README has a "Support Zovo" section and "More tools by Zovo".

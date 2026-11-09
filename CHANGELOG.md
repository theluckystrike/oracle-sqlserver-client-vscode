# Changelog

## 0.1.0

- First release: SQL Server, Azure SQL and Oracle Database connections with pure JavaScript drivers (tedious, node-oracledb Thin mode).
- SQL login, Windows (NTLM) login and Azure AD access tokens; Oracle Easy Connect, tnsnames.ora aliases and wallets.
- Explorer with databases, schemas, tables, views, procedures, functions and packages, and Script as CREATE.
- T-SQL `GO` batches and Oracle `/` blocks, every result set in its own tab, PRINT and DBMS_OUTPUT in Messages, error markers in the editor. SQL*Plus `REM` lines count as comments.
- A `USE` in one file changes that file's database (shown in the status bar). Other files and tables opened from the explorer keep their own database.
- Cancel, streamed export to CSV, JSON and SQL INSERT, server-side read-only connections, confirmation before risky statements (`UPDATE STATISTICS` is not one), query history and autocomplete.
- Execution plan, schema compare, ER diagram, schema DDL export and a query library, free in this version.
- "More free viewers" starts with the Zovo extensions most related to this one. The README has a "Support Zovo" section and "More tools by Zovo".

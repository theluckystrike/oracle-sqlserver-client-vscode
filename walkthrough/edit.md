# Export and stay safe

- "Export" writes every row of a result or a table, not only the loaded ones, to CSV, JSON or SQL INSERT. Rows stream to the file, so a table with millions of rows is fine.
- Copy selected rows as CSV, TSV, JSON or Markdown from the grid.
- Large text, CLOB and binary cells show a short preview in the grid. Click one to open the full value in an editor tab, so the grid never freezes.
- UPDATE or DELETE without WHERE, TRUNCATE and DROP ask before they run.
- Tables opened from the explorer can be edited in the grid when they have a primary key. You review the exact SQL, and it runs in one transaction.

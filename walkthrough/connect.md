# Add a connection

- SQL Server and Azure SQL: paste an ADO.NET string such as `Server=myhost,1433;Database=Sales;User Id=app;Encrypt=True`, a JDBC URL, or `sqlserver://user@host:1433/db`. Pick SQL login, Windows login (NTLM, with the domain) or an Azure AD access token. Turn on "Trust the server certificate" for a local server with a self-signed certificate.
- Oracle: paste an Easy Connect string such as `localhost:1521/FREEPDB1`, `hr@dbhost:1521/ORCLPDB1` or `jdbc:oracle:thin:@dbhost:1521/ORCLPDB1`. Or pick the folder that holds `tnsnames.ora` and choose an alias. For Autonomous Database, unzip the wallet and pick its folder: Thin mode reads `ewallet.pem`.

Click "Test connection" first. It shows how long the connection took. The password goes to VS Code's secret storage, never to settings.

Turn on "Read-only" for production databases. Oracle then opens the session read-only, and SQL Server rolls back each batch, so the server refuses or undoes every change.

Nothing connects when VS Code starts. A connection opens when you expand it or run a query.

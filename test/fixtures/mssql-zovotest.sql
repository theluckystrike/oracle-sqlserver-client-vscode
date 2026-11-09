-- Zovo gate data for SQL Server (generated, no third-party content)
IF DB_ID('zovotest') IS NULL CREATE DATABASE zovotest;
GO
USE zovotest;
GO
CREATE TABLE dbo.big_rows (id int NOT NULL PRIMARY KEY, label nvarchar(40) NOT NULL, amount decimal(12,2) NOT NULL, created datetime2(0) NOT NULL);
GO
WITH n AS (SELECT TOP (1000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS k FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.big_rows WITH (TABLOCK) (id, label, amount, created)
SELECT (a.k - 1) * 1000 + b.k, CONCAT(N'row ', (a.k - 1) * 1000 + b.k), (((a.k - 1) * 1000 + b.k) * 7919 % 100000) / 100.0, DATEADD(day, b.k % 365, '2026-01-01')
FROM n a CROSS JOIN n b;
GO
CREATE TABLE dbo.big_text (id int NOT NULL PRIMARY KEY, note nvarchar(100) NULL, body nvarchar(max) NULL, blob varbinary(max) NULL);
GO
DECLARE @piece nvarchar(max) = REPLICATE(CAST(N'Zovo large text line. abcdefghij ' AS nvarchar(max)), 330000);
DECLARE @i int = 1;
WHILE @i <= 5 BEGIN
  INSERT INTO dbo.big_text (id, note, body) VALUES (@i, CONCAT(N'text of about 10 MB #', @i), @piece);
  SET @i += 1;
END;
INSERT INTO dbo.big_text (id, note, body, blob) VALUES (6, N'small', N'short text', 0x89504E470D0A1A0A0000000D49484452);
INSERT INTO dbo.big_text (id, note, body) VALUES (7, N'null body', NULL);
GO
CREATE TABLE dbo.[Ünïcödé_表] ([名前] nvarchar(50), [émoji] nvarchar(50), [עברית] nvarchar(50));
INSERT INTO dbo.[Ünïcödé_表] VALUES (N'東京', N'🎉🚀', N'שלום'), (N'Zürich', N'👍', N'مرحبا');
GO
CREATE OR ALTER PROCEDURE dbo.print_lines @n int = 1000 AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @i int = 1;
  WHILE @i <= @n BEGIN PRINT CONCAT('message ', @i, ' of ', @n); SET @i += 1; END
END
GO
CREATE OR ALTER PROCEDURE dbo.twenty_sets AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @i int = 1;
  WHILE @i <= 20 BEGIN SELECT TOP (@i) @i AS set_no, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n, CONCAT('set ', @i) AS label FROM sys.all_objects; SET @i += 1; END
END
GO
CREATE OR ALTER PROCEDURE dbo.write_row AS
BEGIN
  INSERT INTO dbo.big_text (id, note, body) VALUES (900, N'written by a procedure', N'x');
END
GO
CREATE TABLE dbo.no_pk (a int, b nvarchar(10));
INSERT INTO dbo.no_pk VALUES (1, N'one');
GO

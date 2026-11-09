-- Zovo gate data for Oracle (generated, no third-party content)
SET SERVEROUTPUT ON
CREATE TABLE big_rows (id NUMBER PRIMARY KEY, label VARCHAR2(40), amount NUMBER(12,2), created DATE);
INSERT /*+ APPEND */ INTO big_rows SELECT (a.n - 1) * 1000 + b.n, 'row ' || ((a.n - 1) * 1000 + b.n), MOD(((a.n - 1) * 1000 + b.n) * 7919, 100000) / 100, DATE '2026-01-01' + MOD(b.n, 365)
  FROM (SELECT level n FROM dual CONNECT BY level <= 1000) a CROSS JOIN (SELECT level n FROM dual CONNECT BY level <= 1000) b;
COMMIT;
CREATE TABLE big_text (id NUMBER PRIMARY KEY, note VARCHAR2(100), body CLOB);
DECLARE
  c CLOB;
  piece VARCHAR2(32767) := RPAD('Zovo large CLOB line. ', 32000, 'abcdefghij');
BEGIN
  FOR r IN 1..5 LOOP
    DBMS_LOB.CREATETEMPORARY(c, TRUE);
    FOR i IN 1..330 LOOP DBMS_LOB.WRITEAPPEND(c, LENGTH(piece), piece); END LOOP;
    INSERT INTO big_text VALUES (r, 'clob of about 10 MB #' || r, c);
    DBMS_LOB.FREETEMPORARY(c);
  END LOOP;
  INSERT INTO big_text VALUES (6, 'small', 'short text');
  INSERT INTO big_text VALUES (7, 'null body', NULL);
  COMMIT;
END;
/
CREATE TABLE "Ünïcödé_表" ("名前" NVARCHAR2(50), "émoji" NVARCHAR2(50), "עברית" NVARCHAR2(50));
INSERT INTO "Ünïcödé_表" VALUES ('東京', '🎉🚀', 'שלום');
INSERT INTO "Ünïcödé_表" VALUES ('Zürich', '👍', 'مرحبا');
COMMIT;
CREATE OR REPLACE PROCEDURE print_lines(n IN NUMBER DEFAULT 1000) AS
BEGIN
  FOR i IN 1..n LOOP DBMS_OUTPUT.PUT_LINE('message ' || i || ' of ' || n); END LOOP;
END;
/
CREATE OR REPLACE PROCEDURE twenty_sets AS
  c SYS_REFCURSOR;
BEGIN
  FOR i IN 1..20 LOOP
    OPEN c FOR SELECT i AS set_no, level AS n, 'set ' || i AS label FROM dual CONNECT BY level <= i;
    DBMS_SQL.RETURN_RESULT(c);
  END LOOP;
END;
/
CREATE OR REPLACE PROCEDURE write_row AS
BEGIN
  INSERT INTO big_text (id, note, body) VALUES (900, 'written by a procedure', 'x');
  COMMIT;
END;
/
CREATE TABLE no_pk (a NUMBER, b VARCHAR2(10));
INSERT INTO no_pk VALUES (1, 'one');
COMMIT;

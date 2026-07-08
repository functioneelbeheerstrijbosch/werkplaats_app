import "dotenv/config";
import mysql from "mysql2/promise";

async function testDatabaseConnection() {
  try {
    console.log("DB_HOST:", process.env.DB_HOST);
    console.log("DB_USER:", process.env.DB_USER);
    console.log("DB_NAME:", process.env.DB_NAME);
    console.log("DB_PORT:", process.env.DB_PORT);

    console.log("Probeer verbinding te maken met MySQL...");

    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT || 3306),
    });

    console.log("Verbinding met MySQL gelukt.");

    console.log("Probeer testquery uit te voeren...");
    const [rows] = await connection.execute("SELECT 1 AS test");

    console.log("Testquery gelukt:", rows);

    await connection.end();
  } catch (error) {
    console.error("Databasefout:", error.message);
    console.error("Code:", error.code);
    console.error("Errno:", error.errno);
    console.error("SQL state:", error.sqlState);
    console.error("Volledige fout:", error);
  }
}

testDatabaseConnection();
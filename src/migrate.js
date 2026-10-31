import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from './config.js';

export async function migrate() {
  const sql = await fs.readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true, charset: 'utf8mb4' });
  try {
    await conn.query(sql);
    // для баз, созданных старой версией: добавить недостающие колонки в broadcasts
    const [cols] = await conn.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'broadcasts'",
    );
    const have = new Set(cols.map((r) => r.c));
    if (!have.has('text')) await conn.query('ALTER TABLE broadcasts ADD COLUMN text TEXT NULL');
    if (!have.has('parse_mode')) await conn.query('ALTER TABLE broadcasts ADD COLUMN parse_mode VARCHAR(16) NULL');
    if (!have.has('title')) await conn.query('ALTER TABLE broadcasts ADD COLUMN title VARCHAR(255) NULL');

    // язык пользователя бота
    const [ucols] = await conn.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tg_users'",
    );
    if (!ucols.some((r) => r.c === 'lang')) await conn.query('ALTER TABLE tg_users ADD COLUMN lang VARCHAR(5) NULL');

    // время регистрации привязки; для старых записей точного времени нет — берём дату первого запуска бота пользователем
    const [lcols] = await conn.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tg_links'",
    );
    if (!lcols.some((r) => r.c === 'created_at')) {
      await conn.query('ALTER TABLE tg_links ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD KEY idx_link_created (created_at)');
      await conn.query('UPDATE tg_links l JOIN tg_users u ON u.id = l.tg_user_id SET l.created_at = u.created_at');
    }

    // коины ученика; после добавления колонки следующая синхронизация будет полной, чтобы заполнить коины и ответственных
    const [scols] = await conn.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students'",
    );
    if (!scols.some((r) => r.c === 'coins')) {
      await conn.query('ALTER TABLE students ADD COLUMN coins DECIMAL(12,2) NULL AFTER email');
      await conn.query("DELETE FROM sync_state WHERE k = 'students_last_now'");
    }

    // отдельное сообщение на каждого ученика: broadcast_recipients теперь уникальна по (рассылка, чат, ученик)
    const [rcols] = await conn.query(
      "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'broadcast_recipients'",
    );
    const rhave = new Set(rcols.map((r) => r.c));
    if (!rhave.has('student_client_id')) {
      await conn.query('ALTER TABLE broadcast_recipients ADD COLUMN student_client_id INT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (!rhave.has('student_name')) await conn.query('ALTER TABLE broadcast_recipients ADD COLUMN student_name VARCHAR(255) NULL');
    const [idx] = await conn.query(
      "SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'broadcast_recipients'",
    );
    const ihave = new Set(idx.map((r) => r.n));
    if (!ihave.has('uq_bc_chat_student')) {
      await conn.query('ALTER TABLE broadcast_recipients ADD UNIQUE KEY uq_bc_chat_student (broadcast_id, chat_id, student_client_id)');
    }
    if (ihave.has('uq_bc_chat')) await conn.query('ALTER TABLE broadcast_recipients DROP INDEX uq_bc_chat');
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => { console.log('Схема БД применена'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
